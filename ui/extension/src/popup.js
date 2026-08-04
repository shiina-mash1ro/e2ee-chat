import "./base.css";
import { createClientChannel, ensureCore } from "./channel.js";
import { validateChatOrigin } from "./origin.js";

const app = document.querySelector("#app");
app.innerHTML = `
  <section class="card" style="width:370px;min-height:520px;border:0;border-radius:0;box-shadow:none">
    <div class="row"><h1 class="grow" style="margin:0">显示客服</h1><button id="settings">设置</button></div>
    <div id="unconfigured" class="notice hidden" style="margin-top:16px"><span id="availability">请先配置并验证聊天服务地址。</span><div class="row" style="margin-top:8px"><button id="retry">重试</button><button id="configure">去配置</button></div></div>
    <div id="notice" class="notice hidden" style="margin-top:16px"></div>
    <div id="current" class="muted" style="margin:14px 0">当前没有聊天室</div>
    <div id="roomActions" class="hidden">
      <label>我的名字<input id="name" maxlength="24"></label>
      <label>最大人数<input id="max" type="number" min="2" max="100" value="4"></label>
      <div class="stack">
        <button id="strong" class="primary">创建大力房间</button>
        <button id="random">创建随机群聊码房间</button>
        <div class="row"><input id="custom" maxlength="32" placeholder="自定义群聊码"><button id="customCreate">创建</button></div>
        <div class="row"><input id="join" maxlength="32" placeholder="输入群聊码"><button id="joinButton">加入</button></div>
      </div>
    </div>
  </section>`;

const notice = document.querySelector("#notice");
const actionButtons = [...document.querySelectorAll("#roomActions button")];
let channel;
let configured = false;
let chatOrigin = "";
const show = (text) => { notice.textContent = text; notice.classList.toggle("hidden", !text); };
const setBusy = (busy) => actionButtons.forEach((button) => { button.disabled = busy || !configured; });

function showAvailability(message = "") {
  document.querySelector("#unconfigured").classList.toggle("hidden", configured);
  document.querySelector("#roomActions").classList.toggle("hidden", !configured);
  if (message) document.querySelector("#availability").textContent = message;
}

async function checkService() {
  configured = false;
  showAvailability(chatOrigin ? "正在检查聊天服务…" : "请先配置并验证聊天服务地址。");
  if (!chatOrigin) return false;
  try {
    await validateChatOrigin(chatOrigin, 3000);
    configured = true;
    showAvailability();
    return true;
  } catch (error) {
    showAvailability(error.message || String(error));
    return false;
  }
}

async function action(actionName, payload = {}) {
  show("");
  setBusy(true);
  try {
    if (!await checkService()) throw new Error("聊天服务当前不可用");
    await channel.request(actionName, { ...payload, displayName: document.querySelector("#name").value.trim(), maxClients: Number(document.querySelector("#max").value) || 4 });
  } catch (error) {
    show(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function init() {
  ({ chatOrigin = "" } = await chrome.storage.sync.get("chatOrigin"));
  const { displayName } = await chrome.storage.local.get("displayName");
  document.querySelector("#name").value = displayName || `访客${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  setBusy(true);
  if (!await checkService()) { setBusy(false); return; }
  await ensureCore();
  channel = createClientChannel("launcher", async (message) => {
    if (message.type === "state") document.querySelector("#current").textContent = message.state.roomId ? `当前房间：${message.state.roomId} · ${message.state.status}` : "当前没有聊天室";
    if (message.type === "room-ready") {
      await chrome.storage.local.set({ displayName: document.querySelector("#name").value.trim() });
      await chrome.runtime.sendMessage({ type: "show-widget", expand: true });
      window.close();
    }
    if (message.type === "error") show(message.error);
  });
  setBusy(false);
}

document.querySelector("#settings").onclick = document.querySelector("#configure").onclick = () => chrome.runtime.openOptionsPage();
document.querySelector("#retry").onclick = async () => { setBusy(true); await checkService(); setBusy(false); };
document.querySelector("#strong").onclick = () => action("create-strong");
document.querySelector("#random").onclick = () => action("create-code", { code: "" });
document.querySelector("#customCreate").onclick = () => action("create-code", { code: document.querySelector("#custom").value });
document.querySelector("#joinButton").onclick = () => action("join-code", { code: document.querySelector("#join").value });
addEventListener("pagehide", () => channel?.close());
init().catch((error) => show(error.message || String(error)));
