import "./base.css";
import { normalizeChatOrigin, permissionPattern, validateChatOrigin } from "./origin.js";
import { MAX_CUSTOM_CSS_BYTES, validateCustomCss } from "./custom-css.js";

const app = document.querySelector("#app");
app.innerHTML = `
  <section class="card" style="max-width:680px;margin:40px auto">
    <h1>显示客服 · 设置</h1>
    <p class="muted">首次使用必须填写聊天服务地址。扩展不会预置服务器。</p>
    <div id="notice" class="notice hidden"></div>
    <label>聊天服务地址
      <input id="origin" inputmode="url" autocomplete="url" placeholder="https://chat.example.com">
    </label>
    <div class="row">
      <button id="save" class="primary">验证、保存并授权</button>
      <button id="clear" class="danger">清除地址</button>
    </div>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>快捷键</h2>
    <p>显示客服：<strong id="showShortcut">未绑定</strong></p>
    <p>绿色出口：<strong id="shortcut">未绑定</strong></p>
    <button id="shortcuts">打开浏览器快捷键设置</button>
    <label>绿色出口执行内容
      <select id="panicAction"><option value="wipe">紧急清除（默认）</option><option value="uninstall">静默卸载扩展</option></select>
    </label>
    <p class="muted">绿色出口快捷键或下方按钮都需要在 3 秒内触发两次。卸载前也会尽力退出房间并清除临时数据。</p>
    <button id="panic" class="danger">绿色出口：清除临时数据</button>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>浏览器安全 DNS</h2>
    <p class="muted">聊天连接遵循浏览器或操作系统的 DNS 设置。扩展无法读取或强制指定 DoH/DoT 状态。</p>
    <button id="secureDns">打开浏览器安全 DNS 设置</button>
    <hr style="margin:24px 0;border:0;border-top:1px solid #dce3ec">
    <h2>聊天界面 CSS</h2>
    <p class="muted">导入的 CSS 只作用于聊天组件和独立聊天窗口，最大 100 KiB。设置页始终保持默认样式，便于恢复。</p>
    <input id="cssFile" type="file" accept=".css,text/css">
    <p id="cssStatus" class="muted">未导入</p>
    <button id="clearCss">恢复默认聊天样式</button>
    <label style="display:flex;grid-template-columns:auto 1fr;align-items:center;margin-top:22px">
      <input id="notifications" type="checkbox" style="width:auto"> 每条收到的消息显示系统通知
    </label>
  </section>`;

const originInput = document.querySelector("#origin");
const notice = document.querySelector("#notice");
const notifications = document.querySelector("#notifications");
const panicAction = document.querySelector("#panicAction");
const panicButton = document.querySelector("#panic");
const show = (text, error = false) => {
  notice.textContent = text;
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
  document.querySelector("#cssStatus").textContent = local.customCssName ? `${local.customCssName}（${local.customCssBytes || 0} bytes）` : "未导入";
  const commands = await chrome.commands.getAll();
  document.querySelector("#showShortcut").textContent = commands.find((item) => item.name === "_execute_action")?.shortcut || "未绑定";
  document.querySelector("#shortcut").textContent = commands.find((item) => item.name === "panic-action")?.shortcut || "未绑定";
}

function updatePanicLabel() {
  panicButton.textContent = panicAction.value === "uninstall" ? "绿色出口：静默卸载" : "绿色出口：清除临时数据";
}

document.querySelector("#save").addEventListener("click", async () => {
  show("");
  try {
    const chatOrigin = normalizeChatOrigin(originInput.value);
    const pattern = permissionPattern(chatOrigin);
    const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
    const granted = alreadyGranted || await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("未授予该服务地址的访问权限");
    try {
      const { info } = await validateChatOrigin(chatOrigin, 5000);
      await chrome.storage.sync.set({ chatOrigin, chatOriginValidation: { extensionApi: info.extensionApi, protocol: info.protocol, build: info.build, checkedAt: Date.now() } });
      originInput.value = chatOrigin;
      show(`服务验证成功（${info.build}）。当前聊天室继续使用原地址，下次进入房间时生效。`);
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
  show("已清除服务地址。当前临时会话不会被强制中断。");
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
    if (!response?.ok) throw new Error(response?.error || "绿色出口执行失败");
    if (response.armed) {
      panicButton.textContent = response.action === "uninstall" ? "3 秒内再次点击以卸载" : "3 秒内再次点击以清除";
      setTimeout(updatePanicLabel, 3100);
    } else {
      originInput.value = "";
      panicAction.value = "wipe";
      updatePanicLabel();
      show("临时会话、扩展存储、缓存和站点权限已清除。");
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
    show(`浏览器阻止了内部设置页，请手动打开 ${target}`, true);
  }
});
document.querySelector("#cssFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const css = validateCustomCss(await file.text(), file.size, file.name);
    await chrome.storage.local.set({ customCss: css, customCssName: file.name, customCssBytes: file.size });
    document.querySelector("#cssStatus").textContent = `${file.name}（${file.size} bytes）`;
    show("自定义 CSS 已应用到所有聊天窗口。");
  } catch (error) {
    show(error.message || String(error), true);
  } finally {
    event.target.value = "";
  }
});
document.querySelector("#clearCss").addEventListener("click", async () => {
  await chrome.storage.local.remove(["customCss", "customCssName", "customCssBytes"]);
  document.querySelector("#cssStatus").textContent = "未导入";
  show("聊天界面已恢复默认样式。");
});
load().catch((error) => show(error.message || String(error), true));
