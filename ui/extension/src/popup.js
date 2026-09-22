import "./base.css";
import { createClientChannel, ensureCore } from "./channel.js";
import { validateChatOrigin } from "./origin.js";
import { initLocale, onLocaleChange, t } from "../../src/i18n.js";

await initLocale();

const app = document.querySelector("#app");
app.innerHTML = `
  <section class="card" style="width:370px;min-height:520px;border:0;border-radius:0;box-shadow:none">
    <div class="row"><h1 class="grow" style="margin:0">${t("ext.brand")}</h1><button id="settings">${t("ext.settings")}</button></div>
    <div id="unconfigured" class="notice hidden" style="margin-top:16px"><span id="availability">${t("ext.popup.configureHint")}</span><div class="row" style="margin-top:8px"><button id="retry">${t("ext.retry")}</button><button id="configure">${t("ext.configure")}</button></div></div>
    <div id="notice" class="notice hidden" style="margin-top:16px"></div>
    <div id="current" class="muted" style="margin:14px 0">${t("ext.popup.noRoom")}</div>
    <div id="roomActions" class="hidden">
      <label>${t("ext.name")}<input id="name" maxlength="24"></label>
      <label>${t("ext.popup.maxClients")}<input id="max" type="number" min="2" max="100" value="4"></label>
      <div class="stack">
        <button id="strong" class="primary">${t("ext.popup.createStrong")}</button>
        <button id="random">${t("ext.popup.createRandom")}</button>
        <div class="row"><input id="custom" maxlength="32" placeholder="${t("ext.popup.customCode")}"><button id="customCreate">${t("ext.create")}</button></div>
        <div class="row"><input id="join" maxlength="32" placeholder="${t("ext.popup.enterCode")}"><button id="joinButton">${t("ext.join")}</button></div>
      </div>
    </div>
  </section>`;

const notice = document.querySelector("#notice");
const actionButtons = [...document.querySelectorAll("#roomActions button")];
let channel;
let configured = false;
let chatOrigin = "";
let currentState;
let availabilityMessage = "ext.popup.configureHint";
let noticeSource = "";
const show = (text) => { noticeSource = text; notice.textContent = t(text); notice.classList.toggle("hidden", !text); };
const setBusy = (busy) => actionButtons.forEach((button) => { button.disabled = busy || !configured; });

function showAvailability(message = "") {
  if (message) availabilityMessage = message;
  document.querySelector("#unconfigured").classList.toggle("hidden", configured);
  document.querySelector("#roomActions").classList.toggle("hidden", !configured);
  if (message) document.querySelector("#availability").textContent = message;
}

async function checkService() {
  configured = false;
  showAvailability(chatOrigin ? t("ext.popup.checking") : t("ext.popup.configureHint"));
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
    if (!await checkService()) throw new Error(t("ext.errors.serviceUnavailable"));
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
  document.querySelector("#name").value = displayName || t("web.guest", { digits: String(Math.floor(Math.random() * 10000)).padStart(4, "0") });
  setBusy(true);
  if (!await checkService()) { setBusy(false); return; }
  await ensureCore();
  channel = createClientChannel("launcher", async (message) => {
    if (message.type === "state") { currentState = message.state; renderCurrent(); }
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
function renderCurrent() {
  document.querySelector("#current").textContent = currentState?.roomId ? t("ext.popup.currentRoom", { room: currentState.roomId, status: t(currentState.status) }) : t("ext.popup.noRoom");
}
function refreshLocale() {
  document.title = t("ext.brand");
  notice.textContent = t(noticeSource);
  document.querySelector("h1").textContent = t("ext.brand");
  for (const [id, key] of [["name", "ext.name"], ["max", "ext.popup.maxClients"]]) {
    document.querySelector(`#${id}`).parentElement.firstChild.textContent = t(key);
  }
  document.querySelector("#availability").textContent = t(availabilityMessage);
  renderCurrent();
  const set = (selector, key) => { const node = document.querySelector(selector); if (node) node.textContent = t(key); };
  set("#settings", "ext.settings"); set("#retry", "ext.retry"); set("#configure", "ext.configure"); set("#strong", "ext.popup.createStrong"); set("#random", "ext.popup.createRandom"); set("#customCreate", "ext.create"); set("#joinButton", "ext.join");
  const custom = document.querySelector("#custom"), join = document.querySelector("#join"); if (custom) custom.placeholder = t("ext.popup.customCode"); if (join) join.placeholder = t("ext.popup.enterCode");
}
onLocaleChange(refreshLocale);
refreshLocale();
