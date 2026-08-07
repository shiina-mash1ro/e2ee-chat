import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/extension");
const baseURL = process.env.BASE_URL || "http://127.0.0.1:8080";
const screenshotDir = process.env.SCREENSHOT_DIR ? path.resolve(process.env.SCREENSHOT_DIR) : "";
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });
const manifestPath = path.join(extensionPath, "manifest.json");
const originalManifest = await fs.readFile(manifestPath, "utf8");
const testManifest = JSON.parse(originalManifest);
const base = new URL(baseURL);
testManifest.host_permissions = [`${base.protocol}//${base.hostname}/*`];
await fs.writeFile(manifestPath, `${JSON.stringify(testManifest, null, 2)}\n`);
const context = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  if (testManifest.name !== "显示客服" || testManifest.action?.default_popup) throw new Error("extension action was not configured to show the customer-service widget");

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  if (await options.locator("#origin").inputValue() !== "") throw new Error("extension unexpectedly shipped with a default origin");
  if ((await options.locator("#shortcut").textContent()) !== "未绑定") throw new Error("extension unexpectedly shipped with a default shortcut");
  if (await options.locator("#panicAction").inputValue() !== "wipe") throw new Error("panic action did not default to wipe");
  await options.locator("#cssFile").setInputFiles({
    name: "smoke-theme.css",
    mimeType: "text/css",
    buffer: Buffer.from(".room-title { letter-spacing: 1px; }"),
  });
  await options.locator("#notice").filter({ hasText: "自定义 CSS 已应用" }).waitFor();

  const unconfiguredPopup = await context.newPage();
  await unconfiguredPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  if (!await unconfiguredPopup.locator("#roomActions").evaluate((node) => node.classList.contains("hidden"))) throw new Error("room actions were visible before origin validation");
  await unconfiguredPopup.close();

  await options.locator("#origin").fill("https://example.com/path");
  await options.locator("#save").click();
  await options.locator("#notice").filter({ hasText: "只能填写" }).waitFor();
  await options.locator("#origin").fill(baseURL);
  await options.locator("#save").click();
  await options.locator("#notice:not(.hidden)").waitFor({ timeout: 10000 });
  const validationNotice = await options.locator("#notice").textContent();
  if (!validationNotice?.includes("服务验证成功")) throw new Error(`extension origin validation failed: ${validationNotice || "no notice"}`);
  const validated = await options.evaluate(() => chrome.storage.sync.get(["chatOrigin", "chatOriginValidation"]));
  if (validated.chatOrigin !== baseURL || validated.chatOriginValidation?.protocol !== 4) throw new Error("validated origin metadata was not stored");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#roomActions:not(.hidden)").waitFor({ timeout: 10000 });
  await popup.locator("#strong").click();
  await Promise.race([popup.waitForEvent("close"), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => {});
  if (!popup.isClosed()) {
    const popupNotice = await popup.locator("#notice").textContent();
    throw new Error(`extension room creation did not finish: ${popupNotice || "no notice"}`);
  }

  const host = await context.newPage();
  await host.goto(baseURL);
  await host.bringToFront();
  const hostTabId = await options.evaluate(async (origin) => (await chrome.tabs.query({ url: `${new URL(origin).origin}/*` })).find((tab) => !String(tab.url || "").includes("chrome-extension://"))?.id, baseURL);
  if (hostTabId == null) throw new Error("could not resolve host tab for widget injection");
  await options.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "widget-expand" });
  }, hostTabId);
  const injected = { embedded: true };
  await options.waitForTimeout(500);
  const embeddedContexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["TAB"] }));
  if (injected.embedded === false && !embeddedContexts.some((item) => item.documentUrl?.includes("/standalone.html"))) throw new Error("restricted-page fallback did not open a standalone chat window");
  if ((await host.locator("body").textContent()).includes("#k=")) throw new Error("host page could read room secret");
  if (injected.embedded) {
    const widgetFrame = host.frames().find((frame) => new URL(frame.url()).pathname.endsWith("/widget.html"));
    if (!widgetFrame) throw new Error("embedded customer-service frame was not created");
    await widgetFrame.locator(".widget:not(.collapsed)").waitFor({ timeout: 5000 });
    await widgetFrame.locator("#collapse").click();
    await widgetFrame.locator('.launcher-icon[data-icon="headset"]').waitFor();
    if (screenshotDir) await widgetFrame.locator(".widget.collapsed").screenshot({ path: path.join(screenshotDir, "customer-service-launcher.png") });
    await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "widget-expand" }), hostTabId);
    await widgetFrame.locator(".widget:not(.collapsed)").waitFor({ timeout: 5000 });
    if (screenshotDir) await widgetFrame.locator(".widget:not(.collapsed)").screenshot({ path: path.join(screenshotDir, "customer-service-expanded.png") });
  }

  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/standalone.html`),
    second.goto(`chrome-extension://${extensionId}/standalone.html`),
  ]);
  await first.locator(".room-title").filter({ hasNotText: "显示客服" }).waitFor({ timeout: 15000 });
  if (await first.locator(".room-title").evaluate((node) => getComputedStyle(node).letterSpacing) !== "1px") throw new Error("custom CSS was not applied to chat windows");
  if (screenshotDir) {
    await first.locator("#collapse").click();
    await first.locator('.launcher-icon[data-icon="headset"]').waitFor();
    await first.locator(".widget.collapsed").screenshot({ path: path.join(screenshotDir, "customer-service-launcher.png") });
    await first.locator("#expand").click();
    await first.locator(".widget:not(.collapsed)").screenshot({ path: path.join(screenshotDir, "customer-service-expanded.png") });
  }
  const room = await first.locator(".room-title").textContent();
  if (!room || await second.locator(".room-title").textContent() !== room) throw new Error("extension windows did not share one room");

  await first.locator("#draft").fill("来自第一个扩展窗口\n保留换行");
  await first.locator("#send").click();
  await second.locator(".message-text").filter({ hasText: "来自第一个扩展窗口" }).waitFor({ timeout: 10000 });
  const rendered = await second.locator(".message-text").last().textContent();
  if (rendered !== "来自第一个扩展窗口\n保留换行") throw new Error("message newline was not preserved");

  await first.close();
  await second.locator("#draft").fill("第二个窗口仍然在线");
  await second.locator("#send").click();
  await second.locator(".message-text").filter({ hasText: "第二个窗口仍然在线" }).waitFor();

  for (const page of context.pages()) {
    if (/\/(standalone|widget)\.html$/.test(new URL(page.url()).pathname)) await page.close();
  }
  await host.close();
  await options.waitForTimeout(32000);
  const remainingOffscreen = await options.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
  const session = await options.evaluate(() => chrome.storage.session.get("chatSession"));
  if (remainingOffscreen.length || session.chatSession) throw new Error("last-window cleanup did not destroy the shared chat session");

  await options.locator("#panic").click();
  if (!(await options.evaluate(() => chrome.storage.sync.get("chatOrigin"))).chatOrigin) throw new Error("first panic click unexpectedly cleared storage");
  await options.locator("#panic").click();
  await options.locator("#notice").filter({ hasText: "已清除" }).waitFor({ timeout: 5000 });
  const cleared = await options.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    sync: await chrome.storage.sync.get(null),
    session: await chrome.storage.session.get(null),
  }));
  if (Object.keys(cleared.local).length || Object.keys(cleared.sync).length || Object.keys(cleared.session).length) throw new Error("panic wipe left extension storage behind");
  console.log("extension smoke passed", { extensionId, room });
} finally {
  await context.close();
  await fs.writeFile(manifestPath, originalManifest);
}
