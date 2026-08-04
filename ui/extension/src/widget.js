import "./widget.css";
import { createClientChannel, ensureCore } from "./channel.js";
import { installCustomCss } from "./custom-css.js";
import { headsetIcon } from "./icons.js";

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
  if (!expanded) {
    app.innerHTML = `<section class="widget collapsed"><button class="launcher-button" id="expand" title="显示客服" aria-label="显示客服">${headsetIcon("launcher-icon")}</button></section>`;
    document.querySelector("#expand").onclick = () => setExpanded(true);
    return;
  }
  syncUrls();
  app.innerHTML = `<section class="widget" id="widget">
    ${standalone ? "" : '<div class="resize-handle" id="resize"></div>'}
    <header class="header">
      <strong class="room-title">${state.roomId ? esc(state.roomId) : "显示客服"}</strong>
      <button id="members">成员</button><button id="details">详情</button><button id="collapse" title="折叠">—</button>
    </header>
    ${notice ? `<div class="notice-bar"><span>${esc(notice)}</span><button id="closeNotice">×</button></div>` : ""}
    <main class="messages" id="messages">${renderMessages()}</main>
    ${selectedFile ? `<div class="file-chip">📎 ${esc(selectedFile.name)}（${formatBytes(selectedFile.size)}） <button id="clearFile">×</button></div>` : ""}
    <footer class="composer">
      <div class="tools"><button id="file">📎</button><button id="emoji" class="${emojiOpen ? "active" : ""}">😀</button><button id="code" class="${codeMode ? "active" : ""}">&lt;/&gt;</button><button id="purge">🦤</button></div>
      <div class="input-row"><textarea id="draft" maxlength="10000" placeholder="${selectedPeer ? `私聊给 ${esc(peerName(selectedPeer))}` : "输入消息"}"></textarea><button class="primary send" id="send" ${state.canSend ? "" : "disabled"}>${selectedPeer ? "发送私聊" : "发送群聊"}</button></div>
    </footer>
    <input id="fileInput" type="file" hidden>
    ${emojiOpen ? `<div class="emoji-panel" id="emojiPanel">${emojis.map((emoji) => `<button data-emoji="${emoji}">${emoji}</button>`).join("")}</div>` : ""}
    ${drawer ? renderDrawer() : ""}
  </section>`;
  bind();
  const messages = document.querySelector("#messages");
  messages.scrollTop = messages.scrollHeight;
}

function renderMessages() {
  if (!state.roomId) return `<div class="empty"><p>尚未进入聊天室</p><button id="openLauncher">新建或加入房间</button><button id="openSettings">配置服务地址</button></div>`;
  if (!state.messages.length) return `<div class="empty">${esc(state.status)}<br><span class="muted">所有窗口将显示同一聊天室</span></div>`;
  return state.messages.map((message) => {
    const privateClass = message.privateTo ? "private" : "";
    const failed = message.status === "failed" ? "failed" : "";
    const label = message.mine ? state.displayName : peerName(message.from);
    const target = message.privateTo ? (message.mine ? ` 私聊给 ${peerName(message.privateTo)}` : " 私聊给你") : " 群聊";
    const body = message.kind === "code" ? `<pre>${esc(message.text)}</pre>` : `<div class="message-text">${esc(message.text)}</div>`;
    const file = message.file ? renderFile(message) : "";
    return `<article class="message ${message.mine ? "mine" : ""} ${privateClass} ${failed}" data-retry="${failed ? esc(message.id) : ""}"><div class="meta">${esc(label)}${esc(target)} · ${esc(message.status || "")}${failed ? " · 点击重试" : ""}</div>${body}${file}</article>`;
  }).join("");
}

function renderFile(message) {
  const url = fileUrl(message);
  const image = String(message.file.type || "").startsWith("image/");
  return image
    ? `<img class="thumb" src="${url}" data-preview="${esc(message.id)}" alt="${esc(message.file.name)}"><a class="file-link" href="${url}" download="${esc(message.file.name)}">下载原图</a>`
    : `<a class="file-link" href="${url}" download="${esc(message.file.name)}">📄 ${esc(message.file.name)}（${formatBytes(message.file.size)}）</a>`;
}

function renderDrawer() {
  if (drawer === "members") return `<aside class="drawer"><h3>在线成员</h3><button data-peer="">群聊</button>${state.peers.map((peer) => `<button class="${selectedPeer === peer.id ? "active" : ""}" data-peer="${esc(peer.id)}">${esc(peer.name)}<br><span class="muted">${esc(shortId(peer.id))}</span></button>`).join("")}</aside>`;
  return `<aside class="drawer"><h3>房间详情</h3><p>状态：${esc(state.status)}</p><p>传输：${esc(state.transportMode || "-")}</p><p>设备：${esc(shortId(state.deviceId))}</p><label>我的名字<input id="displayName" value="${esc(state.displayName)}" maxlength="24"></label><button id="saveName">保存名字</button><button id="copyInvite">复制邀请</button><button id="settingsButton">扩展设置</button></aside>`;
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
  document.querySelector("#draft").onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } };
  document.querySelectorAll("[data-emoji]").forEach((button) => button.onclick = () => { const draft = document.querySelector("#draft"); draft.value += button.dataset.emoji; draft.focus(); });
  document.querySelectorAll("[data-peer]").forEach((button) => button.onclick = () => { selectedPeer = button.dataset.peer; drawer = ""; render(); });
  document.querySelectorAll("[data-retry]").forEach((item) => item.onclick = () => channel.request("retry", { messageId: item.dataset.retry }).catch(showError));
  document.querySelectorAll("[data-preview]").forEach((item) => item.onclick = () => openPreview(item.dataset.preview));
  document.querySelector("#copyInvite")?.addEventListener("click", async () => { await navigator.clipboard.writeText(state.invitePath || ""); notice = "已复制邀请路径"; render(); });
  document.querySelector("#settingsButton")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.querySelector("#saveName")?.addEventListener("click", () => channel.request("set-name", { displayName: document.querySelector("#displayName").value }).catch(showError));
  const widget = document.querySelector("#widget");
  widget.ondragover = (event) => { event.preventDefault(); widget.classList.add("drop-active"); };
  widget.ondragleave = () => widget.classList.remove("drop-active");
  widget.ondrop = (event) => { event.preventDefault(); widget.classList.remove("drop-active"); selectedFile = event.dataTransfer.files?.[0] || null; render(); };
  bindResize();
}

async function send() {
  const draft = document.querySelector("#draft");
  const text = draft.value;
  if (!text.trim() && !selectedFile) return;
  draft.disabled = true;
  try {
    await channel.request("send", { text, codeMode, file: selectedFile, to: selectedPeer });
    selectedFile = null;
    codeMode = false;
  } catch (error) { showError(error); }
}

function setExpanded(value) {
  expanded = Boolean(value);
  if (!standalone) parent.postMessage({ source: "e2ee-chat-widget", type: "expanded", value: expanded }, "*");
  render();
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
  overlay.innerHTML = `<div class="preview-head"><strong class="grow">${esc(message.file.name)}</strong><button id="zoomOut">−</button><span id="zoomValue">100%</span><button id="zoomIn">＋</button><button id="resetZoom">重置</button><button id="closePreview">关闭</button></div><div class="preview-stage"><img src="${fileUrl(message)}"></div>`;
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

addEventListener("message", (event) => { if (event.source === parent && event.data?.source === "e2ee-chat-host" && event.data.type === "set-expanded") setExpanded(event.data.value); });
addEventListener("pagehide", () => { channel?.close(); for (const url of urls.values()) URL.revokeObjectURL(url); });

await ensureCore();
channel = createClientChannel("widget", (message) => {
  if (message.type === "state") { state = message.state; if (selectedPeer && !state.peers.some((peer) => peer.id === selectedPeer)) selectedPeer = ""; render(); }
  if (message.type === "error") showError(new Error(message.error));
});
chrome.runtime.sendMessage({ type: "widget-active" });
render();
if (!standalone) parent.postMessage({ source: "e2ee-chat-widget", type: "ready" }, "*");
