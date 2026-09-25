import "./widget.css";
import "./i18n.css";
import { createClientChannel, ensureCore } from "./channel.js";
import { installCustomCss } from "./custom-css.js";
import { headsetIcon } from "./icons.js";
import { partitionRetainedMessages } from "../../src/message-retention.js";
import { observeMessageVisibility } from "../../src/message-visibility.js";
import { initLocale, onLocaleChange, t } from "../../src/i18n.js";

await initLocale();

const standalone = window.parent === window;
const app = document.querySelector("#app");
let state = { roomId: "", status: "未连接", peers: [], messages: [], canSend: false };
let expanded = standalone;
let selectedPeer = "";
let codeMode = false;
let selectedFile = null;
let emojiOpen = false;
let drawer = "";
let notice = "";
let channel;
let draftText = "";
let renderedDisplayName = "";
let sending = false;
let pageMessagesVisible = standalone && document.visibilityState === "visible" && document.hasFocus();
const urls = new Map();
const emojis = [..."😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤢 🤮 🤧 😷 🤒 🤕 👍 👎 👏 🙏 💪 👌 ✌️ 🤞 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🔥 🎉 ✅ ❌ 💡 📌 📎 🖼️ 📄 🔒 🔑 🚀 ☕ 🍻".split(" ")];

await installCustomCss();

function esc(value) { const node = document.createElement("span"); node.textContent = String(value || ""); return node.innerHTML; }
function peerName(id) { return state.peers.find((peer) => peer.id === id)?.name || (id === state.deviceId ? state.displayName : shortId(id)); }
function shortId(id) { return id?.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "-"; }
function fileBytes(file) { if (typeof file.data !== "string") return file.data; const raw = atob(file.data); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); }
function fileUrl(message) { if (urls.has(message.id)) return urls.get(message.id); const url = URL.createObjectURL(new Blob([fileBytes(message.file)], { type: message.file.type })); urls.set(message.id, url); return url; }
function syncUrls() { const ids = new Set(state.messages.filter((message) => message.file).map((message) => message.id)); for (const [id, url] of urls) if (!ids.has(id)) { URL.revokeObjectURL(url); urls.delete(id); } }

function render() {
  const oldDraft = document.querySelector("#draft");
  if (oldDraft) draftText = oldDraft.value;
  const oldName = document.querySelector("#displayName");
  const nameDraft = oldName && oldName.value !== renderedDisplayName ? oldName.value : null;
  const focused = document.activeElement?.id;
  const focusedInput = focused === "displayName" ? oldName : oldDraft;
  const selection = focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd] : [0, 0];
  document.title = state.roomId || t("ext.brand");
  if (!expanded) {
    app.innerHTML = `<section class="widget collapsed"><button class="launcher-button" id="expand" title="${t("ext.brand")}" aria-label="${t("ext.brand")}">${headsetIcon("launcher-icon")}</button></section>`;
    document.querySelector("#expand").onclick = () => setExpanded(true);
    return;
  }
  syncUrls();
  app.innerHTML = `<section class="widget" id="widget">
    ${standalone ? "" : '<div class="resize-handle" id="resize"></div>'}
    <header class="header">
      <strong class="room-title">${state.roomId ? esc(state.roomId) : t("ext.brand")}</strong>
      <button id="members">${t("ext.widget.members")}</button><button id="details">${t("ext.widget.details")}</button><button id="collapse" title="${t("ext.widget.collapse")}" aria-label="${t("ext.widget.collapse")}">—</button>
    </header>
    ${notice ? `<div class="notice-bar"><span>${esc(t(notice))}</span><button id="closeNotice" aria-label="${t("ext.widget.close")}">×</button></div>` : ""}
    <main class="messages" id="messages">${renderMessages()}</main>
    ${selectedFile ? `<div class="file-chip">📎 ${esc(selectedFile.name)}（${formatBytes(selectedFile.size)}） <button id="clearFile">×</button></div>` : ""}
    <footer class="composer">
      <div class="tools"><button id="file" aria-label="${t("web.chooseFile")}">📎</button><button id="emoji" aria-label="${t("web.insertEmoji")}" class="${emojiOpen ? "active" : ""}">😀</button><button id="code" aria-label="${t("web.toggleCode")}" class="${codeMode ? "active" : ""}">&lt;/&gt;</button><button id="purge" aria-label="${t("web.purge")}">🦤</button></div>
      <div class="input-row"><textarea id="draft" maxlength="10000" placeholder="${selectedPeer ? t("ext.widget.privateTo", { name: esc(peerName(selectedPeer)) }) : t("ext.widget.messagePlaceholder")}"></textarea><button class="primary send" id="send" ${state.canSend ? "" : "disabled"}>${selectedPeer ? t("ext.widget.sendPrivate") : t("ext.widget.sendGroup")}</button></div>
    </footer>
    <input id="fileInput" type="file" hidden>
    ${emojiOpen ? `<div class="emoji-panel" id="emojiPanel">${emojis.map((emoji) => `<button data-emoji="${emoji}">${emoji}</button>`).join("")}</div>` : ""}
    ${drawer ? renderDrawer() : ""}
  </section>`;
  bind();
  const input = document.querySelector("#draft");
  input.value = draftText;
  input.disabled = sending;
  if (focused === "draft" && !sending) { input.focus(); input.setSelectionRange(...selection); }
  const nameInput = document.querySelector("#displayName");
  if (nameInput) {
    renderedDisplayName = state.displayName || "";
    nameInput.value = nameDraft ?? renderedDisplayName;
    if (focused === "displayName") { nameInput.focus(); nameInput.setSelectionRange(...selection); }
  }
  const messages = document.querySelector("#messages");
  messages.scrollTop = messages.scrollHeight;
}

function renderMessages() {
  if (!state.roomId) return `<div class="empty"><p>${t("ext.widget.notInRoom")}</p><button id="openLauncher">${t("ext.widget.openLauncher")}</button><button id="openSettings">${t("ext.widget.configure")}</button></div>`;
  if (!pageMessagesVisible) return `<div class="empty">${t("ext.widget.hiddenUnfocused")}</div>`;
  if (!state.messages.length) return `<div class="empty">${esc(t(state.status))}<br><span class="muted">${t("ext.widget.sameRoom")}</span></div>`;
  return state.messages.map((message) => {
    const privateClass = message.privateTo ? "private" : "";
    const failed = message.status === "failed" ? "failed" : "";
    const label = message.mine ? state.displayName : peerName(message.from);
    const target = message.privateTo ? (message.mine ? ` ${t("ext.widget.privateTo", { name: peerName(message.privateTo) })}` : ` ${t("ext.widget.privateToMe")}`) : ` ${t("ext.widget.groupChat")}`;
    const body = message.kind === "code" ? `<pre>${esc(message.text)}</pre>` : `<div class="message-text">${esc(message.text)}</div>`;
    const file = message.file ? renderFile(message) : "";
    const statusKey = { pending: "web.sending", failed: "web.sendFailed", sent: "i18n.sent", delivered: "i18n.delivered" }[message.status];
    return `<article class="message ${message.mine ? "mine" : ""} ${privateClass} ${failed}" data-retry="${failed ? esc(message.id) : ""}"><div class="meta">${esc(label)}${esc(target)}${statusKey ? ` · ${esc(t(statusKey))}` : ""}${failed ? ` · ${t("ext.widget.retry")}` : ""}</div>${body}${file}</article>`;
  }).join("");
}

function renderFile(message) {
  const url = fileUrl(message);
  const image = String(message.file.type || "").startsWith("image/");
  return image
    ? `<img class="thumb" src="${url}" data-preview="${esc(message.id)}" alt="${esc(message.file.name)}"><a class="file-link" href="${url}" download="${esc(message.file.name)}">${t("ext.widget.downloadImage")}</a>`
    : `<a class="file-link" href="${url}" download="${esc(message.file.name)}">📄 ${esc(message.file.name)} (${formatBytes(message.file.size)})</a>`;
}

function renderDrawer() {
  if (drawer === "members") return `<aside class="drawer"><h3>${t("ext.widget.onlineMembers")}</h3><button data-peer="">${t("ext.widget.groupChat")}</button>${state.peers.map((peer) => `<button class="${selectedPeer === peer.id ? "active" : ""}" data-peer="${esc(peer.id)}">${esc(peer.name)}<br><span class="muted">${esc(shortId(peer.id))}</span></button>`).join("")}</aside>`;
  return `<aside class="drawer"><h3>${t("ext.widget.roomDetails")}</h3><p>${t("ext.widget.status")}: ${esc(t(state.status))}</p><p>${t("ext.widget.transport")}: ${esc(state.transportMode || "-")}</p><p>${t("ext.widget.device")}: ${esc(shortId(state.deviceId))}</p><label>${t("ext.name")}<input id="displayName" maxlength="24"></label><button id="saveName">${t("ext.widget.saveName")}</button><button id="copyInvite">${t("ext.widget.copyInvite")}</button><button id="settingsButton">${t("ext.settings")}</button></aside>`;
}

function bind() {
  document.querySelector("#collapse").onclick = () => setExpanded(false);
  document.querySelector("#members").onclick = () => { drawer = drawer === "members" ? "" : "members"; render(); };
  document.querySelector("#details").onclick = () => { drawer = drawer === "details" ? "" : "details"; render(); };
  document.querySelector("#closeNotice")?.addEventListener("click", () => { notice = ""; render(); });
  document.querySelector("#openSettings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.querySelector("#openLauncher")?.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-launcher" }));
  document.querySelector("#file").onclick = () => document.querySelector("#fileInput").click();
  document.querySelector("#fileInput").onchange = (event) => { selectedFile = event.target.files?.[0] || null; render(); };
  document.querySelector("#clearFile")?.addEventListener("click", () => { selectedFile = null; render(); });
  document.querySelector("#emoji").onclick = () => { emojiOpen = !emojiOpen; render(); };
  document.querySelector("#code").onclick = () => { codeMode = !codeMode; render(); };
  document.querySelector("#purge").onclick = () => channel.request("purge").catch(showError);
  document.querySelector("#send").onclick = send;
  document.querySelector("#draft").onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } };
  document.querySelectorAll("[data-emoji]").forEach((button) => button.onclick = () => { const draft = document.querySelector("#draft"); draft.value += button.dataset.emoji; draft.focus(); });
  document.querySelectorAll("[data-peer]").forEach((button) => button.onclick = () => { selectedPeer = button.dataset.peer; drawer = ""; render(); });
  document.querySelectorAll("[data-retry]").forEach((item) => item.onclick = () => channel.request("retry", { messageId: item.dataset.retry }).catch(showError));
  document.querySelectorAll("[data-preview]").forEach((item) => item.onclick = () => openPreview(item.dataset.preview));
  document.querySelector("#copyInvite")?.addEventListener("click", async () => { await navigator.clipboard.writeText(state.invitePath || ""); notice = t("web.inviteCopied"); render(); });
  document.querySelector("#settingsButton")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.querySelector("#saveName")?.addEventListener("click", () => channel.request("set-name", { displayName: document.querySelector("#displayName").value }).catch(showError));
  const widget = document.querySelector("#widget");
  widget.ondragover = (event) => { event.preventDefault(); widget.classList.add("drop-active"); };
  widget.ondragleave = () => widget.classList.remove("drop-active");
  widget.ondrop = (event) => { event.preventDefault(); widget.classList.remove("drop-active"); selectedFile = event.dataTransfer.files?.[0] || null; render(); };
  bindResize();
}

async function send() {
  if (sending) return;
  const draft = document.querySelector("#draft");
  const text = draft.value;
  if (!text.trim() && !selectedFile) return;
  draft.disabled = true;
  sending = true;
  try {
    await channel.request("send", { text, codeMode, file: selectedFile, to: selectedPeer });
    selectedFile = null;
    codeMode = false;
    draftText = "";
    const currentDraft = document.querySelector("#draft");
    if (currentDraft) currentDraft.value = "";
  } catch (error) { showError(error); }
  finally { sending = false; render(); }
}

function setExpanded(value) {
  expanded = Boolean(value);
  if (!standalone) parent.postMessage({ source: "e2ee-chat-widget", type: "expanded", value: expanded }, "*");
  render();
}

function setPageFocus(value) {
  const focused = Boolean(value) && document.visibilityState === "visible";
  if (!focused) document.querySelectorAll(".preview").forEach((overlay) => overlay.remove());
  if (focused) {
    const { retained } = partitionRetainedMessages(state.messages, Date.now());
    state = { ...state, messages: retained };
    channel?.send("heartbeat");
  }
  pageMessagesVisible = focused;
  // Focus/pointer transitions must not replace the composer (and erase its
  // draft or interrupt the click that is about to send it).
  const messages = document.querySelector("#messages");
  if (messages) {
    syncUrls();
    messages.innerHTML = renderMessages();
    messages.querySelectorAll("[data-retry]").forEach((item) => item.onclick = () => channel.request("retry", { messageId: item.dataset.retry }).catch(showError));
    messages.querySelectorAll("[data-preview]").forEach((item) => item.onclick = () => openPreview(item.dataset.preview));
    messages.scrollTop = messages.scrollHeight;
  }
}

function bindResize() {
  const handle = document.querySelector("#resize");
  if (!handle) return;
  handle.onpointerdown = (event) => {
    handle.setPointerCapture(event.pointerId);
    const startX = event.screenX, startY = event.screenY, startW = innerWidth, startH = innerHeight;
    handle.onpointermove = (move) => parent.postMessage({ source: "e2ee-chat-widget", type: "resize", width: startW + startX - move.screenX, height: startH + startY - move.screenY }, "*");
    handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null; };
  };
}

function openPreview(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message?.file) return;
  let scale = 1, x = 0, y = 0, pan;
  const overlay = document.createElement("div");
  overlay.className = "preview";
  overlay.innerHTML = `<div class="preview-head"><strong class="grow">${esc(message.file.name)}</strong><button id="zoomOut">−</button><span id="zoomValue">100%</span><button id="zoomIn">＋</button><button id="resetZoom">${t("ext.widget.reset")}</button><button id="closePreview">${t("ext.widget.close")}</button></div><div class="preview-stage"><img src="${fileUrl(message)}"></div>`;
  document.body.append(overlay);
  const image = overlay.querySelector("img"), stage = overlay.querySelector(".preview-stage"), value = overlay.querySelector("#zoomValue");
  const apply = () => { image.style.transform = `translate(${x}px,${y}px) scale(${scale})`; value.textContent = `${Math.round(scale * 100)}%`; };
  const zoom = (delta) => { scale = Math.max(.5, Math.min(5, scale + delta)); if (scale <= 1) x = y = 0; apply(); };
  overlay.querySelector("#zoomOut").onclick = () => zoom(-.25); overlay.querySelector("#zoomIn").onclick = () => zoom(.25);
  overlay.querySelector("#resetZoom").onclick = () => { scale = 1; x = y = 0; apply(); };
  overlay.querySelector("#closePreview").onclick = () => overlay.remove();
  stage.onwheel = (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? .25 : -.25); };
  stage.onpointerdown = (event) => { if (scale <= 1) return; stage.setPointerCapture(event.pointerId); pan = { sx: event.clientX, sy: event.clientY, x, y }; };
  stage.onpointermove = (event) => { if (!pan) return; x = pan.x + event.clientX - pan.sx; y = pan.y + event.clientY - pan.sy; apply(); };
  stage.onpointerup = () => { pan = null; };
}

function formatBytes(value) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function showError(error) { notice = error.message || String(error); render(); }

addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.source !== "e2ee-chat-host") return;
  if (event.data.type === "set-expanded") setExpanded(event.data.value);
  if (event.data.type === "page-focus") setPageFocus(event.data.value);
});
if (standalone) {
  observeMessageVisibility(window, document, setPageFocus);
} else {
  // Parent focus events are not sufficient while its iframe owns focus.
  addEventListener("blur", () => setPageFocus(false));
  const refreshHostVisibility = () => {
    if (document.visibilityState !== "visible") setPageFocus(false);
    parent.postMessage({ source: "e2ee-chat-widget", type: "request-page-focus" }, "*");
  };
  addEventListener("focus", refreshHostVisibility);
  document.addEventListener("visibilitychange", refreshHostVisibility);
}
onLocaleChange(() => {
  document.querySelectorAll(".preview").forEach((overlay) => overlay.remove());
  render();
  if (!standalone) parent.postMessage({ source: "e2ee-chat-widget", type: "title", value: t("ext.brand") }, "*");
});
addEventListener("pagehide", () => { channel?.close(); for (const url of urls.values()) URL.revokeObjectURL(url); });

await ensureCore();
channel = createClientChannel("widget", (message) => {
  if (message.type === "state") { state = message.state; if (selectedPeer && !state.peers.some((peer) => peer.id === selectedPeer)) selectedPeer = ""; render(); }
  if (message.type === "error") showError(new Error(message.error));
});
chrome.runtime.sendMessage({ type: "widget-active" });
render();
if (!standalone) parent.postMessage({ source: "e2ee-chat-widget", type: "ready" }, "*");
