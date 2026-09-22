import "./base.css";
import { normalizeChatOrigin, permissionPattern, validateChatOrigin } from "./origin.js";
import { validateCustomCss } from "./custom-css.js";

import { initLocale, getLocalePreference, localeOptions, onLocaleChange, setLocale, t } from "../../src/i18n.js";

await initLocale();
const app = document.querySelector("#app");
app.innerHTML = `
  <section class="card" style="max-width:680px;margin:40px auto">
    <label>${t("ext.language")}<select id="language">${localeOptions.map(({ value, label }) => `<option value="${value}">${label}</option>`).join("")}</select></label>
    <h1>${t("ext.options.title")}</h1>
    <p class="muted">${t("ext.options.intro")}</p>
    <div id="notice" class="notice hidden"></div>
    <label>${t("ext.options.origin")}
      <input id="origin" inputmode="url" autocomplete="url" placeholder="https://chat.example.com">
    </label>
    <div class="row">
      <button id="save" class="primary">${t("ext.options.save")}</button>
      <button id="clear" class="danger">${t("ext.options.clear")}</button>
    </div>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>${t("ext.options.shortcuts")}</h2>
    <p><span>${t("ext.brand")}</span>: <strong id="showShortcut">${t("ext.options.unbound")}</strong></p>
    <p><span>${t("ext.options.panicShortcut")}</span>: <strong id="shortcut">${t("ext.options.unbound")}</strong></p>
    <button id="shortcuts">${t("ext.options.openShortcuts")}</button>
    <label>${t("ext.options.panicAction")}
      <select id="panicAction"><option value="wipe">${t("ext.options.panicWipe")}</option><option value="uninstall">${t("ext.options.panicUninstall")}</option></select>
    </label>
    <p class="muted">${t("ext.options.panicHint")}</p>
    <button id="panic" class="danger">${t("ext.options.panicClear")}</button>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>${t("ext.options.dnsTitle")}</h2>
    <p class="muted">${t("ext.options.dnsHint")}</p>
    <button id="secureDns">${t("ext.options.openDns")}</button>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>${t("ext.options.cssTitle")}</h2>
    <p class="muted">${t("ext.options.cssHint")}</p>
    <input id="cssFile" type="file" accept=".css,text/css">
    <p id="cssStatus" class="muted">${t("ext.options.notImported")}</p>
    <button id="clearCss">${t("ext.options.clearCss")}</button>
    <label style="display:flex;grid-template-columns:auto 1fr;align-items:center;margin-top:22px">
      <input id="notifications" type="checkbox" style="width:auto"> ${t("ext.options.notifications")}
    </label>
  </section>`;

const originInput = document.querySelector("#origin");
const notice = document.querySelector("#notice");
const notifications = document.querySelector("#notifications");
const panicAction = document.querySelector("#panicAction");
const panicButton = document.querySelector("#panic");
let noticeSource = "";
let showShortcut = "", panicShortcut = "", customCssName = "", customCssBytes = 0;
function refreshMetadata() {
  document.querySelector("#showShortcut").textContent = showShortcut || t("ext.options.unbound");
  document.querySelector("#shortcut").textContent = panicShortcut || t("ext.options.unbound");
  document.querySelector("#cssStatus").textContent = customCssName ? `${customCssName} (${customCssBytes} bytes)` : t("ext.options.notImported");
}
const show = (text, error = false) => {
  noticeSource = text;
  notice.textContent = t(text);
  notice.classList.toggle("hidden", !text);
  notice.style.background = error ? "#fff0f2" : "#e9f8f1";
  notice.style.color = error ? "#a51d36" : "#116343";
};

async function load() {
  const sync = await chrome.storage.sync.get("chatOrigin");
  const local = await chrome.storage.local.get(["notificationsEnabled", "panicAction", "customCssName", "customCssBytes"]);
  originInput.value = sync.chatOrigin || "";
  notifications.checked = Boolean(local.notificationsEnabled);
  panicAction.value = local.panicAction === "uninstall" ? "uninstall" : "wipe";
  updatePanicLabel();
  customCssName = local.customCssName || "";
  customCssBytes = local.customCssBytes || 0;
  const commands = await chrome.commands.getAll();
  showShortcut = commands.find((item) => item.name === "_execute_action")?.shortcut || "";
  panicShortcut = commands.find((item) => item.name === "panic-action")?.shortcut || "";
  refreshMetadata();
}

function updatePanicLabel() {
  panicButton.textContent = panicAction.value === "uninstall" ? t("ext.options.panicUninstallButton") : t("ext.options.panicClear");
}

document.querySelector("#save").addEventListener("click", async () => {
  show("");
  try {
    const chatOrigin = normalizeChatOrigin(originInput.value);
    const pattern = permissionPattern(chatOrigin);
    const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
    const granted = alreadyGranted || await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error(t("ext.errors.permissionDenied"));
    try {
      const { info } = await validateChatOrigin(chatOrigin, 5000);
      await chrome.storage.sync.set({ chatOrigin, chatOriginValidation: { extensionApi: info.extensionApi, protocol: info.protocol, build: info.build, checkedAt: Date.now() } });
      originInput.value = chatOrigin;
      show(t("ext.options.validated", { build: info.build }));
    } catch (error) {
      if (!alreadyGranted) await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
      throw error;
    }
  } catch (error) {
    show(error.message || String(error), true);
  }
});
document.querySelector("#clear").addEventListener("click", async () => {
  await chrome.storage.sync.remove(["chatOrigin", "chatOriginValidation"]);
  originInput.value = "";
  show(t("ext.options.cleared"));
});
document.querySelector("#shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: navigator.userAgent.includes("Edg/") ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts" });
});
notifications.addEventListener("change", () => chrome.storage.local.set({ notificationsEnabled: notifications.checked }));
panicAction.addEventListener("change", async () => {
  await chrome.storage.local.set({ panicAction: panicAction.value === "uninstall" ? "uninstall" : "wipe" });
  await chrome.storage.session.remove("panicConfirmation");
  updatePanicLabel();
});
panicButton.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "trigger-panic" });
    if (!response?.ok) throw new Error(response?.error || t("ext.errors.panicFailed"));
    if (response.armed) {
      panicButton.textContent = response.action === "uninstall" ? t("ext.options.confirmUninstall") : t("ext.options.confirmClear");
      setTimeout(updatePanicLabel, 3100);
    } else {
      originInput.value = "";
      panicAction.value = "wipe";
      updatePanicLabel();
      show(t("ext.options.panicDone"));
    }
  } catch (error) {
    show(error.message || String(error), true);
  }
});
document.querySelector("#secureDns").addEventListener("click", async () => {
  const edge = navigator.userAgent.includes("Edg/");
  const target = edge ? "edge://settings/privacy" : "chrome://settings/security";
  try {
    await chrome.tabs.create({ url: target });
  } catch {
    show(t("ext.errors.internalPage", { target }), true);
  }
});
document.querySelector("#cssFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const css = validateCustomCss(await file.text(), file.size, file.name);
    await chrome.storage.local.set({ customCss: css, customCssName: file.name, customCssBytes: file.size });
    customCssName = file.name;
    customCssBytes = file.size;
    refreshMetadata();
    show(t("ext.options.cssApplied"));
  } catch (error) {
    show(error.message || String(error), true);
  } finally {
    event.target.value = "";
  }
});
document.querySelector("#clearCss").addEventListener("click", async () => {
  await chrome.storage.local.remove(["customCss", "customCssName", "customCssBytes"]);
  customCssName = "";
  customCssBytes = 0;
  refreshMetadata();
  show(t("ext.options.cssCleared"));
});
load().catch((error) => show(error.message || String(error), true));

const languageSelect = document.querySelector("#language");
const staticText = [];
const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
  const node = walker.currentNode;
  if (!node.parentElement.closest("#notice, #cssStatus, #showShortcut, #shortcut, #panic, #language") && node.nodeValue.trim()) {
    staticText.push([node, node.nodeValue]);
  }
}
languageSelect.value = getLocalePreference();
languageSelect.addEventListener("change", (event) => setLocale(event.target.value));
function refreshLanguage() {
  document.title = t("ext.options.title");
  languageSelect.value = getLocalePreference();
  languageSelect.querySelector('option[value="auto"]').textContent = `🌐 ${t("i18n.auto")}`;
  // Update labels in place so unsaved settings, file inputs, focus and handlers survive.
  for (const [node, original] of staticText) node.nodeValue = original.replace(original.trim(), t(original.trim()));
  notice.textContent = t(noticeSource);
  for (const node of app.querySelectorAll("[placeholder], [aria-label], [title]")) {
    for (const attr of ["placeholder", "aria-label", "title"]) {
      if (node.hasAttribute(attr)) node.setAttribute(attr, t(node.getAttribute(attr)));
    }
  }
  updatePanicLabel();
  refreshMetadata();
}
onLocaleChange(refreshLanguage);
refreshLanguage();
