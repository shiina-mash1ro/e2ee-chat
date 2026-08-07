import { decode, encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";
import { asBytes, createProtocolV4, PROTOCOL_VERSION } from "../../src/protocol-v4.js";
import { partitionRetainedMessages } from "../../src/message-retention.js";
import { authenticatedEventReplayKey, signingIdentityForEvent } from "../../src/authenticated-events.js";
import { CHANNEL_NAME } from "./channel.js";
import { validateChatOrigin } from "./origin.js";

const channel = new BroadcastChannel(CHANNEL_NAME);
const widgets = new Map();
const peers = new Map();
const messages = [];
const pendingAcks = new Map();
const incomingTransfers = new Map();
const epochKeys = new Map();
const pendingEpochKeys = new Map();
const boxKeyHistory = new Map();
const seenEvents = new Set();
const peerIdentityPins = new Map();
const pendingAuthenticatedPeerEvents = new Map();
const pendingAuthenticatedPeerEventIds = new Set();
const maxPendingAuthenticatedPeerEvents = 128;
const maxPendingAuthenticatedPeerEventsPerPeer = 32;
const pendingAuthenticatedPeerEventTtlMs = 15000;
let pendingAuthenticatedPeerEventCount = 0;
const retryDelays = [5000, 10000, 20000, 40000, 80000, 120000];
const maxFileBytes = 20 * 1024 * 1024;
const fallbackMaxFileBytes = 5 * 1024 * 1024;
const chunkSize = 256 * 1024;
const maxIncomingTransfers = 32;
const maxChunkCount = 128;
const maxEncryptedTransferBytes = maxFileBytes + 64 * 1024;
let origin = "";
let roomId = "";
let invitePath = "";
let secret = null;
let roomKey = null;
let authKey = null;
let deviceId = "";
let displayName = "";
let keyPair = null;
let signingKeyPair = null;
let senderKeyId = "";
let connectionToken = "";
let transport = null;
let transportMode = "";
let connectionGeneration = 0;
let status = "未连接";
let currentEpoch = 0;
let epochMessageCount = 0;
let epochStartedAt = 0;
let activeRotation = null;
let keyGeneration = 0;
let rotationTimer = null;
let closeTimer = null;
let retryTimer = null;
let retryFailures = 0;
let lastProbeAt = 0;
let probe = null;
let messageSeq = 0;
let hadWidget = false;
let switching = false;
let protocol;

await sodium.ready;
protocol = createProtocolV4(sodium);
await restoreSession();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "emergency-leave-core") return false;
  leaveAndDestroy(false).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error.message || String(error) }),
  );
  return true;
});

channel.onmessage = (event) => {
  const message = event.data;
  if (!message || message.source !== "ui" || !message.instanceId) return;
  if (message.type === "hello" || message.type === "heartbeat") {
    if (message.kind === "widget") {
      widgets.set(message.instanceId, Date.now());
      hadWidget = true;
      cancelLastWindowClose();
    }
    sendState(message.instanceId);
    return;
  }
  if (message.type === "bye") {
    widgets.delete(message.instanceId);
    considerLastWindowClose();
    return;
  }
  if (message.type === "action") {
    handleAction(message).then(
      (result) => respond(message, true, result),
      (error) => respond(message, false, null, error.message || String(error)),
    );
  }
};

setInterval(() => {
  const cutoff = Date.now() - 35000;
  for (const [id, seenAt] of widgets) if (seenAt < cutoff) widgets.delete(id);
  considerLastWindowClose();
  pruneMessages();
}, 10000);

function respond(request, ok, result, error = "") {
  channel.postMessage({ source: "core", target: request.instanceId, requestId: request.requestId, ok, result, error });
}

function broadcast(type, payload = {}) {
  channel.postMessage({ source: "core", type, ...payload });
}

function publicState() {
  return {
    roomId,
    invitePath,
    deviceId,
    displayName,
    status,
    transportMode,
    canSend: Boolean(transport && roomKey),
    switching,
    peers: [...peers.entries()].map(([id, peer]) => ({ id, name: peer.name, keyId: peer.keyId })),
    messages: messages.map(cloneMessage),
  };
}

function cloneMessage(message) {
  return {
    ...message,
    file: message.file ? { ...message.file, data: message.file.data } : null,
  };
}

function sendState(target = "") {
  channel.postMessage({ source: "core", target, type: "state", state: publicState() });
}

function publishState() {
  broadcast("state", { state: publicState() });
}

async function handleAction({ action, payload = {} }) {
  switch (action) {
    case "create-strong": return createStrong(payload);
    case "create-code": return createCode(payload, false);
    case "join-code": return createCode(payload, true);
    case "send": return sendPayload(payload);
    case "retry": return retryMessage(payload.messageId);
    case "purge": return purgeSelf();
    case "copy-state": return { invitePath };
    case "set-name": return updateName(payload.displayName);
    case "leave": return leaveAndDestroy(false);
    default: throw new Error("未知操作");
  }
}

async function configuredOrigin() {
  const result = await storageGet("sync", "chatOrigin");
  if (!result.chatOrigin) throw new Error("请先配置聊天服务地址");
  return (await validateChatOrigin(result.chatOrigin, 3000)).origin;
}

async function createStrong(payload) {
  const targetOrigin = await configuredOrigin();
  const targetRoom = base64Url(sodium.randombytes_buf(12));
  const targetSecret = sodium.randombytes_buf(32);
  const response = await fetch(`${targetOrigin}/api/rooms/${encodeURIComponent(targetRoom)}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_clients: normalizeMax(payload.maxClients) }),
  });
  if (!response.ok) throw new Error(`创建房间失败：HTTP ${response.status}`);
  await switchRoom({ targetOrigin, targetRoom, targetSecret, targetInvite: `r/${targetRoom}#k=${base64Url(targetSecret)}`, displayName: payload.displayName });
  return { roomId: targetRoom };
}

async function createCode(payload, joining) {
  const targetOrigin = await configuredOrigin();
  const code = normalizeCode(payload.code);
  if (code && !validCode(code)) throw new Error("群聊码可用 4-32 位 A-Z 和 0-9");
  if (joining && !validCode(code)) throw new Error("请输入有效群聊码");
  const pow = await solvePow(targetOrigin);
  const response = await fetch(`${targetOrigin}/api/code-room`, {
    method: joining ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, max_clients: normalizeMax(payload.maxClients), ...pow }),
  });
  if (!response.ok) throw new Error(`群聊码请求失败：HTTP ${response.status}`);
  const result = await response.json();
  const targetUrl = new URL(result.url, targetOrigin);
  const targetRoom = targetUrl.pathname.split("/").filter(Boolean).pop();
  const roomCode = normalizeCode(new URLSearchParams(targetUrl.hash.slice(1)).get("p") || targetRoom);
  if (!validCode(roomCode)) throw new Error("服务端返回了无效群聊码");
  await switchRoom({ targetOrigin, targetRoom, targetSecret: deriveCodeSecret(roomCode), targetInvite: `r/${targetRoom}#p=${roomCode}`, displayName: payload.displayName });
  return { roomId: targetRoom };
}

async function solvePow(targetOrigin) {
  const response = await fetch(`${targetOrigin}/api/pow-challenge`);
  if (!response.ok) throw new Error(`获取计算挑战失败：HTTP ${response.status}`);
  const challenge = await response.json();
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < 100000000; nonce += 1) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.challenge}:${nonce}`)));
    if (leadingZeroBits(digest, Number(challenge.difficulty))) return { challenge: challenge.challenge, nonce };
    if (nonce % 2000 === 0) await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error("计算挑战失败");
}

function leadingZeroBits(bytes, bits) {
  for (let index = 0; index < bits; index += 1) if (bytes[Math.floor(index / 8)] & (0x80 >> (index % 8))) return false;
  return true;
}

async function switchRoom({ targetOrigin, targetRoom, targetSecret, targetInvite, displayName: nextName }) {
  switching = true;
  publishState();
  if (roomId) await leaveCurrent().catch(() => {});
  resetMemory();
  origin = targetOrigin;
  roomId = targetRoom;
  secret = targetSecret;
  invitePath = targetInvite;
  displayName = cleanName(nextName) || `访客${randomDigits(4)}`;
  roomKey = sodium.crypto_generichash(32, secret, sodium.from_string("e2ee-chat-room-encryption-v4"));
  authKey = sodium.crypto_generichash(32, secret, sodium.from_string("e2ee-chat-room-auth-v4"));
  epochKeys.set(0, roomKey);
  epochStartedAt = Date.now();
  deviceId = `dev_${base64Url(sodium.randombytes_buf(12))}`;
  keyPair = sodium.crypto_box_keypair();
  signingKeyPair = sodium.crypto_sign_keypair();
  senderKeyId = base64Url(sodium.crypto_generichash(12, keyPair.publicKey));
  keyGeneration = 0;
  connectionToken = `conn_${base64Url(sodium.randombytes_buf(18))}`;
  await persistSession();
  switching = false;
  connect();
  rotationTimer = setInterval(() => maybeRotate().catch(reportError), 30000);
  broadcast("room-ready", { roomId });
  publishState();
}

function resetMemory() {
  transport?.close();
  transport = null;
  transportMode = "";
  clearTimeout(retryTimer);
  retryTimer = null;
  probe?.close?.();
  probe = null;
  clearInterval(rotationTimer);
  rotationTimer = null;
  peers.clear();
  messages.length = 0;
  pendingAcks.clear();
  incomingTransfers.clear();
  epochKeys.clear();
  pendingEpochKeys.clear();
  boxKeyHistory.clear();
  seenEvents.clear();
  peerIdentityPins.clear();
  clearPendingAuthenticatedPeerEvents();
  currentEpoch = 0;
  epochMessageCount = 0;
  activeRotation = null;
  status = "未连接";
}

async function persistSession() {
  if (!roomId) return;
  await storageSet("session", { chatSession: {
    origin, roomId, invitePath, secret: b64(secret), deviceId, displayName,
    currentEpoch, epochStartedAt, epochKeys: [...epochKeys.entries()].map(([epoch, key]) => ({ epoch, key: b64(key) })),
    keyGeneration,
    boxPublic: b64(keyPair.publicKey), boxPrivate: b64(keyPair.privateKey),
    signPublic: b64(signingKeyPair.publicKey), signPrivate: b64(signingKeyPair.privateKey),
    boxHistory: [...boxKeyHistory.entries()].map(([id, pair]) => ({ id, publicKey: b64(pair.publicKey), privateKey: b64(pair.privateKey) })),
    peerPins: [...peerIdentityPins.entries()].map(([id, pin]) => ({ id, publicKey: b64(pin.publicKey), signPublicKey: b64(pin.signPublicKey), keyId: pin.keyId, keyGeneration: pin.keyGeneration })),
  } });
}

async function restoreSession() {
  const { chatSession } = await storageGet("session", "chatSession");
  if (!chatSession?.origin || !chatSession?.roomId || !chatSession?.secret) return;
  try {
    origin = chatSession.origin;
    roomId = chatSession.roomId;
    invitePath = chatSession.invitePath;
    secret = fromB64(chatSession.secret);
    deviceId = chatSession.deviceId;
    displayName = cleanName(chatSession.displayName);
    keyPair = { publicKey: fromB64(chatSession.boxPublic), privateKey: fromB64(chatSession.boxPrivate) };
    signingKeyPair = { publicKey: fromB64(chatSession.signPublic), privateKey: fromB64(chatSession.signPrivate) };
    senderKeyId = base64Url(sodium.crypto_generichash(12, keyPair.publicKey));
    connectionToken = `conn_${base64Url(sodium.randombytes_buf(18))}`;
    currentEpoch = Math.max(0, Number(chatSession.currentEpoch) || 0);
    keyGeneration = Math.max(0, Number(chatSession.keyGeneration) || 0);
    epochKeys.clear();
    for (const item of chatSession.epochKeys || []) {
      const epoch = Number(item?.epoch);
      const key = fromB64(item?.key || "");
      if (Number.isInteger(epoch) && epoch >= 0 && key.length === 32) epochKeys.set(epoch, key);
    }
    if (!epochKeys.has(currentEpoch)) throw new Error("invalid saved epoch state");
    roomKey = epochKeys.get(currentEpoch);
    authKey = sodium.crypto_generichash(32, secret, sodium.from_string("e2ee-chat-room-auth-v4"));
    for (const item of chatSession.boxHistory || []) {
      if (item?.id && item.publicKey && item.privateKey) boxKeyHistory.set(item.id, { publicKey: fromB64(item.publicKey), privateKey: fromB64(item.privateKey) });
    }
    for (const item of chatSession.peerPins || []) {
      const publicKey = fromB64(item?.publicKey || "");
      const signPublicKey = fromB64(item?.signPublicKey || "");
      if (validDeviceId(item?.id) && publicKey.length === 32 && signPublicKey.length === 32) peerIdentityPins.set(item.id, { publicKey, signPublicKey, keyId: String(item.keyId || ""), keyGeneration: Math.max(0, Number(item.keyGeneration) || 0) });
    }
    epochStartedAt = Math.max(Date.now() - 15 * 60 * 1000, Number(chatSession.epochStartedAt) || Date.now());
    connect();
    rotationTimer = setInterval(() => maybeRotate().catch(reportError), 30000);
  } catch {
    await storageRemove("session", "chatSession");
    resetMemory();
    roomId = "";
  }
}

function connect() {
  if (!roomId || !origin) return;
  const generation = ++connectionGeneration;
  transport?.close();
  transport = null;
  transportMode = "";
  status = "连接中";
  publishState();
  let settled = false;
  const candidate = createWebSocketTransport(generation, () => {
    if (settled || generation !== connectionGeneration) return;
    settled = true;
    clearTimeout(timeout);
    transport = candidate;
    transportMode = "ws";
    status = "已连接";
    retryFailures = 0;
    sendHello().catch(reportError);
    publishState();
  }, () => {
    if (settled || generation !== connectionGeneration) return;
    settled = true;
    clearTimeout(timeout);
    candidate.close();
    startSSE(generation);
  }, dispatchEvent);
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      candidate.close();
      startSSE(generation);
    }
  }, 3000);
}

function wsUrl() {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = new URLSearchParams({ client_id: deviceId });
  return url.href;
}

function createWebSocketTransport(generation, onReady, onFailure, onEvent) {
  const socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";
  let ready = false;
  let clientClosed = false;
  socket.onmessage = (message) => {
    if (generation !== connectionGeneration) return;
    try {
      const event = protocol.normalizeWireEvent(decode(new Uint8Array(message.data)));
      if (event.type === "welcome") {
        ready = true;
        onReady();
      } else if (event.type !== "ping") {
        onEvent(event);
      }
    } catch (error) {
      reportError(error);
    }
  };
  socket.onerror = () => { if (!ready) onFailure(); };
  socket.onclose = () => {
    if (clientClosed || generation !== connectionGeneration) return;
    if (!ready) onFailure();
    else startSSE(generation);
  };
  return {
    mode: "ws",
    send(event) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket 未连接");
      socket.send(encode(protocol.toWireEvent(event, "ws")));
    },
    bufferedAmount: () => socket.bufferedAmount,
    close() { clientClosed = true; socket.close(); },
  };
}

function startSSE(generation) {
  if (generation !== connectionGeneration) return;
  transport?.close();
  const abort = new AbortController();
  const sse = {
    mode: "sse",
    async send(event) {
      const response = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Connection-Token": connectionToken },
        body: JSON.stringify(protocol.toWireEvent(event, "sse")),
      });
      if (!response.ok) throw new Error(`发送失败：HTTP ${response.status}`);
    },
    close() { abort.abort(); },
  };
  transport = sse;
  transportMode = "sse";
  status = "已连接（兼容模式）";
  publishState();
  consumeSSE(generation, abort.signal).catch((error) => {
    if (generation !== connectionGeneration || abort.signal.aborted) return;
    status = `兼容模式重连中：${error.message || error}`;
    publishState();
    setTimeout(() => startSSE(generation), 2000);
  });
  sendHello().catch(reportError);
  scheduleWSProbe(retryDelays[0], generation);
}

async function consumeSSE(generation, signal) {
  const url = `${origin}/api/rooms/${encodeURIComponent(roomId)}/events?${new URLSearchParams({ client_id: deviceId, connection_token: connectionToken })}`;
  const response = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (generation === connectionGeneration && !signal.aborted) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE 已断开");
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const event = protocol.normalizeWireEvent(JSON.parse(data));
      if (event.type !== "ping") dispatchEvent(event);
      wakeWSProbe();
    }
  }
}

function scheduleWSProbe(delay, generation = connectionGeneration) {
  if (transportMode !== "sse" || generation !== connectionGeneration) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => attemptWSProbe(generation), delay);
}

function wakeWSProbe() {
  if (transportMode !== "sse" || probe) return;
  scheduleWSProbe(Math.max(0, 5000 - (Date.now() - lastProbeAt)));
}

function attemptWSProbe(generation) {
  if (transportMode !== "sse" || generation !== connectionGeneration || probe) return;
  lastProbeAt = Date.now();
  status = "已连接（兼容模式，正在尝试 WebSocket）";
  publishState();
  let settled = false;
  let candidate;
  const fail = () => {
    if (settled || probe !== candidate) return;
    settled = true;
    clearTimeout(candidate.timeout);
    candidate.close();
    probe = null;
    retryFailures += 1;
    status = "已连接（兼容模式）";
    publishState();
    scheduleWSProbe(retryDelays[Math.min(retryFailures, retryDelays.length - 1)], generation);
  };
  candidate = createWebSocketTransport(generation, () => {
    if (settled || probe !== candidate || generation !== connectionGeneration) return;
    settled = true;
    clearTimeout(probe.timeout);
    const old = transport;
    transport = candidate;
    transportMode = "ws";
    probe = null;
    retryFailures = 0;
    status = "已连接";
    old?.close();
    sendHello().catch(reportError);
    publishState();
  }, fail, dispatchEvent);
  candidate.timeout = setTimeout(fail, 3000);
  probe = candidate;
}

function dispatchEvent(event) {
  handleEvent(event).catch(reportError);
}

async function sendHello() {
  const event = {
    type: "hello", room: roomId, from: deviceId, protocol: PROTOCOL_VERSION,
    features: ["v4", "epoch_rotation", "binary_ws"], event_id: nextEventId(), key_generation: keyGeneration,
    public_key: keyPair.publicKey, sign_public_key: signingKeyPair.publicKey,
    sender_key_id: senderKeyId, display_name: displayName,
  };
  event.hello_mac = sodium.crypto_auth(protocol.canonicalEventBytes(event), authKey);
  event.signature = sodium.crypto_sign_detached(protocol.canonicalEventBytes(event), signingKeyPair.privateKey);
  await sendEvent(event);
}

async function handleEvent(event) {
  if (event.room && event.room !== roomId) return;
  if (event.type === "hello" || event.type === "peer_hello") {
    if (!verifyHello(event)) return;
  } else if (requiresSignature(event.type)) {
    const verification = verifyPeerEvent(event);
    if (verification === "pending") {
      queuePendingAuthenticatedPeerEvent(event);
      return;
    }
    if (!verification) return;
  }
  switch (event.type) {
    case "hello":
      if (event.from === deviceId) break;
      if (!rememberPeer(event)) break;
      await flushPendingAuthenticatedPeerEvents(event.from);
      await sendSigned({ type: "peer_hello", room: roomId, from: deviceId, to: event.from, public_key: keyPair.publicKey, sign_public_key: signingKeyPair.publicKey, sender_key_id: senderKeyId, display_name: displayName });
      await offerEpoch(event.from);
      break;
    case "peer_hello":
      if (event.to === deviceId && event.from !== deviceId && rememberPeer(event)) await flushPendingAuthenticatedPeerEvents(event.from);
      break;
    case "peer_leave": {
      const removed = peers.delete(event.from);
      clearPendingAuthenticatedPeerEvents(event.from);
      if (removed && activeRotation) abortRotation(activeRotation.id).catch(reportError);
      publishState();
      break;
    }
    case "peer_purge": purgeMessages(event.from); break;
    case "room_expired": leaveAndDestroy(true).catch(reportError); break;
    case "server_ack": case "chunk_ack": resolveAck(event.ack_id); break;
    case "recipient_ack": markDelivered(event.ack_id); break;
    case "group_msg": await receiveGroup(event); break;
    case "private_msg": await receivePrivate(event); break;
    case "chunk": await receiveChunk(event); break;
    case "key_prepare": case "key_offer": case "key_ready": case "key_commit": case "key_abort": case "join_key_offer": case "join_key_ready": case "device_key_update": await handleKeyEvent(event); break;
  }
}

function rememberPeer(event) {
  if (!validDeviceId(event.from)) return false;
  const wasOnline = peers.has(event.from);
  const existing = peers.get(event.from) || peerIdentityPins.get(event.from);
  const signPublicKey = protocol.decodeWireBytes(event.sign_public_key);
  const publicKey = protocol.decodeWireBytes(event.public_key);
  const generation = Math.max(0, Number(event.key_generation) || 0);
  if (publicKey.length !== 32 || signPublicKey.length !== 32 || event.sender_key_id !== keyIdFor(publicKey)) return false;
  if (existing?.signPublicKey && !sodium.memcmp(existing.signPublicKey, signPublicKey)) return false;
  if (existing && generation < Number(existing.keyGeneration || 0)) return false;
  if (existing && generation === Number(existing.keyGeneration || 0) && (!sodium.memcmp(existing.publicKey, publicKey) || existing.keyId !== event.sender_key_id)) return false;
  const peer = {
    name: cleanName(event.display_name) || shortId(event.from),
    publicKey, signPublicKey, keyId: event.sender_key_id, keyGeneration: generation,
    ready: currentEpoch === 0,
  };
  peers.set(event.from, peer);
  peerIdentityPins.set(event.from, { publicKey, signPublicKey, keyId: peer.keyId, keyGeneration: generation });
  if (!wasOnline && activeRotation) abortRotation(activeRotation.id).catch(reportError);
  persistSession().catch(reportError);
  publishState();
  return true;
}

async function sendPayload(payload) {
  if (!transport || !roomKey) throw new Error("当前未连接");
  const text = payload.codeMode ? String(payload.text || "") : String(payload.text || "").trim();
  const file = payload.file || null;
  if (!text && !file) return;
  const target = payload.to || "";
  if (target && !peers.has(target)) throw new Error("私聊对象已离线");
  const active = { transport, mode: transport.mode, epoch: currentEpoch, key: epochKeys.get(currentEpoch) };
  const limit = active.mode === "sse" ? fallbackMaxFileBytes : maxFileBytes;
  if (file?.size > limit) throw new Error(`当前连接最多发送 ${formatBytes(limit)} 文件`);
  const messagePayload = {
    kind: payload.codeMode && !file ? "code" : file ? "file" : "text",
    text,
    sent_at: Date.now(),
    file: file ? {
      name: cleanFileName(file.name), type: file.type || "application/octet-stream",
      size: file.size, data: active.mode === "sse" ? b64(new Uint8Array(await file.arrayBuffer())) : new Uint8Array(await file.arrayBuffer()),
    } : null,
  };
  const msgId = nextMessageId();
  messages.push({ id: msgId, msgId, from: deviceId, mine: true, privateTo: target, status: "pending", receivedAt: Date.now(), ...messagePayload });
  pruneMessages();
  publishState();
  try {
    const event = target
      ? encryptPrivate(target, messagePayload, msgId, active.mode)
      : encryptGroup(messagePayload, msgId, active);
    await sendEncrypted(event, msgId, Boolean(file), active);
    if (!target) {
      epochMessageCount += 1;
      if (epochMessageCount >= 100) maybeRotate().catch(reportError);
    }
  } catch (error) {
    updateMessage(msgId, "failed", error.message || String(error));
    throw error;
  }
  wakeWSProbe();
  return { messageId: msgId };
}

async function retryMessage(messageId) {
  const old = messages.find((item) => item.id === messageId && item.mine && item.status === "failed");
  if (!old) throw new Error("找不到可重试的消息");
  const index = messages.indexOf(old);
  messages.splice(index, 1);
  publishState();
  const file = old.file ? new File([fileBytes(old.file)], old.file.name, { type: old.file.type }) : null;
  return sendPayload({ text: old.text, codeMode: old.kind === "code", file, to: old.privateTo });
}

function encryptGroup(payload, msgId, active) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const event = { type: "group_msg", room: roomId, from: deviceId, protocol: PROTOCOL_VERSION, event_id: nextEventId(), msg_id: msgId, epoch: active.epoch, sender_key_id: senderKeyId, key_generation: keyGeneration, nonce };
  const plaintext = active.mode === "ws" ? encode(payload) : sodium.from_string(JSON.stringify(payload));
  event.ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, protocol.canonicalMessageAAD(event), null, nonce, active.key);
  event.signature = sodium.crypto_sign_detached(protocol.canonicalEventBytes(event), signingKeyPair.privateKey);
  return event;
}

function encryptPrivate(to, payload, msgId, mode) {
  const peer = peers.get(to);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const plaintext = mode === "ws" ? encode(payload) : sodium.from_string(JSON.stringify(payload));
  const event = {
    type: "private_msg", room: roomId, from: deviceId, to, protocol: PROTOCOL_VERSION, event_id: nextEventId(), msg_id: msgId,
    nonce, ciphertext: sodium.crypto_box_easy(plaintext, nonce, peer.publicKey, keyPair.privateKey),
    epoch: currentEpoch, sender_key_id: senderKeyId, recipient_key_id: peer.keyId, key_generation: keyGeneration, public_key: keyPair.publicKey,
  };
  event.signature = sodium.crypto_sign_detached(protocol.canonicalEventBytes(event), signingKeyPair.privateKey);
  return event;
}

async function sendEncrypted(event, msgId, hasFile, active) {
  if (active.mode === "ws" && hasFile) await sendChunked(event, active.transport);
  else {
    const ack = active.mode === "ws" ? waitAck(msgId, 5000) : null;
    await active.transport.send(event);
    if (ack) await ack;
  }
  updateMessage(msgId, event.to ? "sent" : "delivered");
}

async function sendChunked(event, activeTransport) {
  const ciphertext = asBytes(event.ciphertext);
  const total = Math.max(1, Math.ceil(ciphertext.length / chunkSize));
  for (let seq = 0; seq < total; seq += 1) {
    while (activeTransport.bufferedAmount() > chunkSize * 2) await new Promise((resolve) => setTimeout(resolve, 25));
    const chunkId = `${event.msg_id}:${seq}`;
    const ack = waitAck(chunkId, 15000);
    await sendSigned({
      type: "chunk", room: roomId, from: deviceId, to: event.to || "", msg_id: chunkId,
      event_id: event.event_id,
      transfer_id: event.msg_id, message_type: event.type, seq, total,
      nonce: event.nonce, ciphertext: ciphertext.slice(seq * chunkSize, (seq + 1) * chunkSize),
      epoch: event.epoch, sender_key_id: event.sender_key_id, recipient_key_id: event.recipient_key_id || "",
      key_generation: event.key_generation, public_key: event.public_key,
    }, activeTransport);
    await ack;
  }
}

function waitAck(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingAcks.delete(id); reject(new Error("服务端未确认消息")); }, timeoutMs);
    pendingAcks.set(id, { resolve: () => { clearTimeout(timer); resolve(); } });
  });
}

function resolveAck(id) {
  const job = pendingAcks.get(id);
  if (!job) return;
  pendingAcks.delete(id);
  job.resolve();
}

function updateMessage(id, statusValue, failureReason = "") {
  const message = messages.find((item) => item.id === id || item.msgId === id);
  if (!message) return;
  message.status = statusValue;
  message.failureReason = failureReason;
  publishState();
}

function markDelivered(id) { updateMessage(id, "delivered"); }

async function receiveGroup(event) {
  if (event.from === deviceId) return;
  const peer = peers.get(event.from);
  if (!peer) return;
  const key = epochKeys.get(Number(event.epoch));
  if (!key) throw new Error("未知群聊密钥代次");
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, asBytes(event.ciphertext), protocol.canonicalMessageAAD(event), asBytes(event.nonce), key);
  const payload = decodePayload(plaintext);
  addIncoming(event, payload, false);
  if (Number(event.epoch) === currentEpoch) {
    epochMessageCount += 1;
    if (epochMessageCount >= 100) maybeRotate().catch(reportError);
  }
}

async function receivePrivate(event) {
  if (event.from === deviceId || event.to !== deviceId) return;
  const peer = peers.get(event.from);
  if (!peer) return;
  const recipient = event.recipient_key_id === senderKeyId ? keyPair : boxKeyHistory.get(event.recipient_key_id);
  if (!recipient) throw new Error("未知私聊接收密钥");
  const senderPublicKey = event.public_key ? asBytes(event.public_key) : peer.publicKey;
  const plaintext = sodium.crypto_box_open_easy(asBytes(event.ciphertext), asBytes(event.nonce), senderPublicKey, recipient.privateKey);
  addIncoming(event, decodePayload(plaintext), true);
  await sendSigned({ type: "recipient_ack", room: roomId, from: deviceId, to: event.from, ack_id: event.msg_id });
}

function decodePayload(plaintext) {
  try { return decode(plaintext); } catch { return JSON.parse(sodium.to_string(plaintext)); }
}

function addIncoming(event, payload, privateMessage) {
  if (messages.some((item) => item.msgId === event.msg_id && item.from === event.from)) return;
  messages.push({
    id: `${event.from}:${event.msg_id}`, msgId: event.msg_id, from: event.from, mine: false,
    privateTo: privateMessage ? deviceId : "", status: "delivered", kind: payload.kind,
    text: payload.text || "", file: normalizeFile(payload.file), sent_at: payload.sent_at, receivedAt: Date.now(),
  });
  pruneMessages();
  publishState();
  storageGet("local", "notificationsEnabled").then(({ notificationsEnabled }) => {
    if (notificationsEnabled) chrome.runtime.sendMessage({ type: "notify", message: privateMessage ? "新的私聊消息" : "新的群聊消息" });
  });
  wakeWSProbe();
}

async function receiveChunk(event) {
  const transferId = event.transfer_id;
  const seq = Number(event.seq);
  const total = Number(event.total);
  if (!transferId || total < 1 || total > maxChunkCount || seq < 0 || seq >= total) return;
  let transfer = incomingTransfers.get(transferId);
  if (!transfer) {
    if (incomingTransfers.size >= maxIncomingTransfers) return;
    transfer = { event: { ...event }, chunks: new Array(total), count: 0, receivedBytes: 0, timer: setTimeout(() => incomingTransfers.delete(transferId), 30000) };
    incomingTransfers.set(transferId, transfer);
  }
  if (transfer.chunks.length !== total || transfer.event.from !== event.from || transfer.event.event_id !== event.event_id || transfer.event.message_type !== event.message_type) return;
  if (!transfer.chunks[seq]) {
    const chunk = asBytes(event.ciphertext);
    if (transfer.receivedBytes + chunk.length > maxEncryptedTransferBytes) { clearTimeout(transfer.timer); incomingTransfers.delete(transferId); return; }
    transfer.chunks[seq] = chunk; transfer.count += 1; transfer.receivedBytes += chunk.length;
  }
  if (transfer.count !== total) return;
  clearTimeout(transfer.timer);
  incomingTransfers.delete(transferId);
  const complete = { ...transfer.event, type: transfer.event.message_type, msg_id: transferId, ciphertext: concatBytes(transfer.chunks) };
  if (complete.type === "group_msg") await receiveGroup(complete);
  if (complete.type === "private_msg") await receivePrivate(complete);
}

async function purgeSelf() {
  if (!transport) throw new Error("当前未连接");
  await sendSigned({ type: "purge_self", room: roomId, from: deviceId });
  purgeMessages(deviceId);
}

function purgeMessages(sender) {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].from === sender && messages[index].kind !== "system") messages.splice(index, 1);
  publishState();
}

function pruneMessages(now = Date.now()) {
  const { retained, removed } = partitionRetainedMessages(messages, now);
  if (!removed.length) return;
  messages.splice(0, messages.length, ...retained);
  publishState();
}

async function updateName(value) {
  displayName = cleanName(value) || displayName;
  await persistSession();
  if (transport) await sendHello();
  publishState();
}

async function leaveCurrent() {
  if (!roomId || !transport) return;
  await sendSigned({ type: "leave_room", room: roomId, from: deviceId }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function leaveAndDestroy(closeDocument = true) {
  await leaveCurrent();
  resetMemory();
  origin = ""; roomId = ""; invitePath = ""; secret = null; roomKey = null; authKey = null;
  deviceId = ""; keyPair = null; signingKeyPair = null; senderKeyId = "";
  await storageRemove("session", "chatSession");
  publishState();
  if (closeDocument) chrome.runtime.sendMessage({ type: "close-offscreen" });
}

function considerLastWindowClose() {
  if (!roomId || !hadWidget || widgets.size || closeTimer) return;
  closeTimer = setTimeout(() => leaveAndDestroy(true).catch(() => {}), 30000);
}

function cancelLastWindowClose() { clearTimeout(closeTimer); closeTimer = null; }

function verifyHello(event) {
  try {
    if (event.protocol !== PROTOCOL_VERSION || !event.event_id || !Number.isInteger(Number(event.key_generation)) || Number(event.key_generation) < 0) return false;
    const signPublicKey = asBytes(event.sign_public_key);
    const expected = event.from === deviceId ? signingKeyPair?.publicKey : peerIdentityPins.get(event.from)?.signPublicKey;
    if (expected && !sodium.memcmp(expected, signPublicKey)) return false;
    if (event.sender_key_id !== keyIdFor(asBytes(event.public_key))) return false;
    const unsigned = { ...event, signature: undefined, hello_mac: undefined };
    if (!sodium.crypto_auth_verify(asBytes(event.hello_mac), protocol.canonicalEventBytes(unsigned), authKey)) return false;
    if (!sodium.crypto_sign_verify_detached(asBytes(event.signature), protocol.canonicalEventBytes({ ...event, signature: undefined }), signPublicKey)) return false;
    return rememberEvent(event);
  } catch { return false; }
}

function requiresSignature(type) {
  return ["group_msg", "private_msg", "recipient_ack", "chunk", "purge_self", "leave_room", "key_prepare", "key_offer", "key_ready", "key_commit", "key_abort", "join_key_offer", "join_key_ready", "device_key_update"].includes(type);
}

function verifyPeerEvent(event) {
  const pinnedPeer = peers.get(event.from) || peerIdentityPins.get(event.from);
  const peer = signingIdentityForEvent(event, { ownDeviceId: deviceId, ownSignPublicKey: signingKeyPair?.publicKey, ownKeyGeneration: keyGeneration, peer: pinnedPeer });
  if (!peer) {
    const generation = Number(event.key_generation);
    if (event.protocol !== PROTOCOL_VERSION || !pinnedPeer?.signPublicKey || !event.signature || !event.event_id ||
        !Number.isInteger(generation) || generation <= Number(pinnedPeer.keyGeneration || 0) ||
        !sodium.crypto_sign_verify_detached(asBytes(event.signature), protocol.canonicalEventBytes({ ...event, signature: undefined }), pinnedPeer.signPublicKey)) {
      return false;
    }
    return "pending";
  }
  if (!sodium.crypto_sign_verify_detached(asBytes(event.signature), protocol.canonicalEventBytes({ ...event, signature: undefined }), peer.signPublicKey)) return false;
  return rememberEvent(event);
}

function queuePendingAuthenticatedPeerEvent(event) {
  const replayId = authenticatedEventReplayKey(event);
  if (!replayId || seenEvents.has(replayId) || pendingAuthenticatedPeerEventIds.has(replayId)) return;
  prunePendingAuthenticatedPeerEvents();
  const pending = pendingAuthenticatedPeerEvents.get(event.from) || [];
  if (pending.length >= maxPendingAuthenticatedPeerEventsPerPeer || pendingAuthenticatedPeerEventCount >= maxPendingAuthenticatedPeerEvents) return;
  pending.push({ event, replayId, receivedAt: Date.now() });
  pendingAuthenticatedPeerEvents.set(event.from, pending);
  pendingAuthenticatedPeerEventIds.add(replayId);
  pendingAuthenticatedPeerEventCount += 1;
}

async function flushPendingAuthenticatedPeerEvents(peerId) {
  const pending = pendingAuthenticatedPeerEvents.get(peerId) || [];
  pendingAuthenticatedPeerEvents.delete(peerId);
  for (const item of pending) {
    pendingAuthenticatedPeerEventIds.delete(item.replayId);
    pendingAuthenticatedPeerEventCount -= 1;
    if (Date.now() - item.receivedAt <= pendingAuthenticatedPeerEventTtlMs) await handleEvent(item.event);
  }
}

function prunePendingAuthenticatedPeerEvents(now = Date.now()) {
  for (const [peerId, pending] of pendingAuthenticatedPeerEvents) {
    const retained = pending.filter((item) => {
      if (now - item.receivedAt <= pendingAuthenticatedPeerEventTtlMs) return true;
      pendingAuthenticatedPeerEventIds.delete(item.replayId);
      pendingAuthenticatedPeerEventCount -= 1;
      return false;
    });
    if (retained.length) pendingAuthenticatedPeerEvents.set(peerId, retained);
    else pendingAuthenticatedPeerEvents.delete(peerId);
  }
}

function clearPendingAuthenticatedPeerEvents(peerId = "") {
  const peerIds = peerId ? [peerId] : [...pendingAuthenticatedPeerEvents.keys()];
  for (const id of peerIds) {
    for (const item of pendingAuthenticatedPeerEvents.get(id) || []) {
      pendingAuthenticatedPeerEventIds.delete(item.replayId);
      pendingAuthenticatedPeerEventCount -= 1;
    }
    pendingAuthenticatedPeerEvents.delete(id);
  }
  if (!peerId) pendingAuthenticatedPeerEventCount = 0;
}

function rememberEvent(event) {
  const replayId = authenticatedEventReplayKey(event);
  if (!replayId) return false;
  if (seenEvents.has(replayId)) return false;
  seenEvents.add(replayId);
  if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value);
  return true;
}

function applyDeviceKeyUpdate(event) {
  const current = peers.get(event.from) || peerIdentityPins.get(event.from);
  const generation = Number(event.key_generation);
  const publicKey = asBytes(event.public_key);
  if (!current || generation !== Number(current.keyGeneration || 0) + 1 || !sodium.memcmp(asBytes(event.sign_public_key), current.signPublicKey) || event.sender_key_id !== keyIdFor(publicKey)) return false;
  return rememberPeer(event);
}

async function sendSigned(event, activeTransport = transport) {
  const complete = { ...event, protocol: PROTOCOL_VERSION, event_id: event.event_id || nextEventId(), epoch: event.epoch ?? currentEpoch, sender_key_id: event.sender_key_id || senderKeyId, key_generation: event.key_generation ?? keyGeneration };
  if (complete.type === "peer_hello") complete.hello_mac = sodium.crypto_auth(protocol.canonicalEventBytes(complete), authKey);
  complete.signature = sodium.crypto_sign_detached(protocol.canonicalEventBytes(complete), signingKeyPair.privateKey);
  await sendEvent(complete, activeTransport);
  return complete;
}

async function sendEvent(event, activeTransport = transport) {
  if (!activeTransport) throw new Error("当前未连接");
  await activeTransport.send(event);
}

function roster() { return [deviceId, ...peers.keys()].filter(Boolean).sort(); }
function rosterHash(value = roster()) { return sodium.crypto_generichash(32, sodium.from_string(value.join("\n"))); }

async function offerEpoch(id) {
  if (currentEpoch === 0 || roster()[0] !== deviceId) return;
  const peer = peers.get(id);
  const key = epochKeys.get(currentEpoch);
  if (!peer?.publicKey || !key) return;
  const rotationId = `join_${base64Url(sodium.randombytes_buf(12))}`;
  await sendSigned({
    type: "join_key_offer", room: roomId, from: deviceId, to: id,
    rotation_id: rotationId,
    epoch: currentEpoch - 1, next_epoch: currentEpoch, roster_hash: rosterHash(),
    recipient_key_id: peer.keyId, sealed_key: sodium.crypto_box_seal(key, peer.publicKey),
  });
  if (peers.has(id)) peers.set(id, { ...peers.get(id), ready: false, joinRotationId: rotationId });
}

async function maybeRotate() {
  if (!transport || activeRotation || pendingEpochKeys.size || (currentEpoch > 0 && epochKeys.size > 1)) return;
  if (Date.now() - epochStartedAt < 15 * 60 * 1000 && epochMessageCount < 100) return;
  const members = roster();
  if (members[0] !== deviceId) return;
  const rotationId = `rot_${base64Url(sodium.randombytes_buf(12))}`;
  const nextEpoch = currentEpoch + 1;
  const key = sodium.randombytes_buf(32);
  const hash = rosterHash(members);
  activeRotation = { role: "coordinator", coordinator: deviceId, id: rotationId, epoch: currentEpoch, nextEpoch, key, hash, members, ready: new Set([deviceId]), timer: null };
  await sendSigned({ type: "key_prepare", room: roomId, from: deviceId, rotation_id: rotationId, epoch: currentEpoch, next_epoch: nextEpoch, roster_hash: hash });
  for (const id of members.slice(1)) {
    const peer = peers.get(id);
    if (!peer?.publicKey) continue;
    await sendSigned({ type: "key_offer", room: roomId, from: deviceId, to: id, rotation_id: rotationId, epoch: currentEpoch, next_epoch: nextEpoch, roster_hash: hash, recipient_key_id: peer.keyId, sealed_key: sodium.crypto_box_seal(key, peer.publicKey) });
  }
  activeRotation.timer = setTimeout(() => abortRotation(rotationId), 30000);
  if (members.length === 1) await commitRotation();
}

async function handleKeyEvent(event) {
  if (event.type === "key_prepare") {
    const members = roster();
    const epoch = Number(event.epoch);
    const nextEpoch = Number(event.next_epoch);
    if (activeRotation || pendingEpochKeys.size || event.from !== members[0] || epoch !== currentEpoch || nextEpoch !== currentEpoch + 1 || !sodium.memcmp(asBytes(event.roster_hash), rosterHash(members))) return;
    activeRotation = { role: "participant", coordinator: event.from, id: event.rotation_id, epoch, nextEpoch, hash: asBytes(event.roster_hash), members, ready: new Set(), timer: setTimeout(() => abortRotation(event.rotation_id), 30000) };
    return;
  }
  if (event.type === "key_offer") {
    const rotation = activeRotation;
    if (!rotation || rotation.role !== "participant" || event.from !== rotation.coordinator || event.rotation_id !== rotation.id || event.to !== deviceId || event.recipient_key_id !== senderKeyId || Number(event.epoch) !== rotation.epoch || Number(event.next_epoch) !== rotation.nextEpoch || !sodium.memcmp(asBytes(event.roster_hash), rotation.hash)) return;
    const key = sodium.crypto_box_seal_open(asBytes(event.sealed_key), keyPair.publicKey, keyPair.privateKey);
    pendingEpochKeys.set(rotation.nextEpoch, { key, rotationId: rotation.id, coordinator: rotation.coordinator, rosterHash: rotation.hash });
    await sendSigned({ type: "key_ready", room: roomId, from: deviceId, to: rotation.coordinator, rotation_id: rotation.id, epoch: rotation.epoch, next_epoch: rotation.nextEpoch, roster_hash: rotation.hash });
    return;
  }
  if (event.type === "join_key_offer") {
    const nextEpoch = Number(event.next_epoch);
    const members = roster();
    if (event.to !== deviceId || event.from !== members[0] || event.recipient_key_id !== senderKeyId || nextEpoch <= currentEpoch || Number(event.epoch) !== nextEpoch - 1 || asBytes(event.roster_hash).length !== 32) return;
    const key = sodium.crypto_box_seal_open(asBytes(event.sealed_key), keyPair.publicKey, keyPair.privateKey);
    await sendSigned({ type: "join_key_ready", room: roomId, from: deviceId, to: event.from, rotation_id: event.rotation_id, epoch: Number(event.epoch), next_epoch: nextEpoch, roster_hash: asBytes(event.roster_hash) });
    activateEpoch(nextEpoch, key);
    return;
  }
  if (event.type === "key_ready") {
    const rotation = activeRotation;
    if (!rotation || rotation.role !== "coordinator" || event.to !== deviceId || event.rotation_id !== rotation.id || !rotation.members.includes(event.from) || Number(event.epoch) !== rotation.epoch || Number(event.next_epoch) !== rotation.nextEpoch || !sodium.memcmp(asBytes(event.roster_hash), rotation.hash) || !sameRoster(rotation.members, roster())) return;
    rotation.ready.add(event.from);
    if (rotation.members.every((id) => rotation.ready.has(id))) await commitRotation();
    return;
  }
  if (event.type === "join_key_ready") {
    const peer = peers.get(event.from);
    if (event.to !== deviceId || !peer || peer.joinRotationId !== event.rotation_id || Number(event.next_epoch) !== currentEpoch) return;
    peers.set(event.from, { ...peer, ready: true, joinRotationId: "" });
    publishState();
    return;
  }
  if (event.type === "key_commit") {
    const rotation = activeRotation;
    const nextEpoch = Number(event.next_epoch);
    const pending = pendingEpochKeys.get(nextEpoch);
    if (!rotation || rotation.role !== "participant" || event.from !== rotation.coordinator || event.rotation_id !== rotation.id || Number(event.epoch) !== rotation.epoch || nextEpoch !== rotation.nextEpoch || !sameRoster(rotation.members, roster()) || !sodium.memcmp(asBytes(event.roster_hash), rotation.hash) || pending?.rotationId !== rotation.id || pending.coordinator !== rotation.coordinator) return;
    clearTimeout(rotation.timer);
    activateEpoch(nextEpoch, pending.key);
    activeRotation = null;
    return;
  }
  if (event.type === "key_abort") {
    const rotation = activeRotation;
    if (!rotation || event.rotation_id !== rotation.id || !rotation.members.includes(event.from) || Number(event.epoch) !== rotation.epoch || Number(event.next_epoch) !== rotation.nextEpoch || !sodium.memcmp(asBytes(event.roster_hash), rotation.hash)) return;
    clearTimeout(rotation.timer);
    for (const [epoch, pending] of pendingEpochKeys) if (pending.rotationId === event.rotation_id) pendingEpochKeys.delete(epoch);
    activeRotation = null;
    return;
  }
  if (event.type === "device_key_update" && applyDeviceKeyUpdate(event)) {
    await flushPendingAuthenticatedPeerEvents(event.from);
  }
}

async function commitRotation() {
  if (!activeRotation || activeRotation.role !== "coordinator" || !sameRoster(activeRotation.members, roster()) || !activeRotation.members.every((id) => activeRotation.ready.has(id))) return;
  const rotation = activeRotation;
  clearTimeout(rotation.timer);
  await sendSigned({ type: "key_commit", room: roomId, from: deviceId, rotation_id: rotation.id, epoch: currentEpoch, next_epoch: rotation.nextEpoch, roster_hash: rotation.hash });
  activateEpoch(rotation.nextEpoch, rotation.key);
  activeRotation = null;
}

async function abortRotation(id) {
  if (activeRotation?.id !== id) return;
  const rotation = activeRotation;
  clearTimeout(rotation.timer);
  await sendSigned({ type: "key_abort", room: roomId, from: deviceId, rotation_id: id, epoch: rotation.epoch, next_epoch: rotation.nextEpoch, roster_hash: rotation.hash }).catch(() => {});
  for (const [epoch, pending] of pendingEpochKeys) if (pending.rotationId === id) pendingEpochKeys.delete(epoch);
  activeRotation = null;
}

function sameRoster(left, right) { return left.length === right.length && left.every((id, index) => id === right[index]); }

function activateEpoch(epoch, key) {
  if (epoch <= currentEpoch) return;
  epochKeys.set(epoch, key);
  pendingEpochKeys.delete(epoch);
  currentEpoch = epoch;
  roomKey = key;
  epochStartedAt = Date.now();
  epochMessageCount = 0;
  const oldKeyId = senderKeyId;
  boxKeyHistory.set(oldKeyId, keyPair);
  keyPair = sodium.crypto_box_keypair();
  senderKeyId = keyIdFor(keyPair.publicKey);
  keyGeneration += 1;
  sendSigned({ type: "device_key_update", room: roomId, from: deviceId, public_key: keyPair.publicKey, sign_public_key: signingKeyPair.publicKey, sender_key_id: senderKeyId, key_generation: keyGeneration }).catch(reportError);
  persistSession().catch(reportError);
  setTimeout(() => {
    if (incomingTransfers.size || pendingAcks.size) return;
    for (const oldEpoch of [...epochKeys.keys()].sort((a, b) => a - b)) if (oldEpoch < currentEpoch && epochKeys.size > 1) epochKeys.delete(oldEpoch);
    boxKeyHistory.delete(oldKeyId);
  }, 120000);
}

function normalizeFile(file) {
  if (!file) return null;
  return { ...file, data: typeof file.data === "string" ? file.data : asBytes(file.data) };
}
function fileBytes(file) { return typeof file.data === "string" ? fromB64(file.data) : asBytes(file.data); }
function concatBytes(parts) { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
function nextMessageId() { return `msg_${++messageSeq}_${base64Url(sodium.randombytes_buf(8))}`; }
function nextEventId() { return `evt_${base64Url(sodium.randombytes_buf(16))}`; }
function keyIdFor(publicKey) { return base64Url(sodium.crypto_generichash(12, asBytes(publicKey))); }
function b64(value) { return sodium.to_base64(asBytes(value), sodium.base64_variants.ORIGINAL); }
function fromB64(value) { return sodium.from_base64(value, sodium.base64_variants.ORIGINAL); }
function base64Url(value) { return sodium.to_base64(asBytes(value), sodium.base64_variants.URLSAFE_NO_PADDING); }
function deriveCodeSecret(code) { return sodium.crypto_generichash(32, sodium.from_string(`e2ee-chat-short-code-v1:${normalizeCode(code)}`)); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[\s_-]+/g, ""); }
function validCode(value) { return /^[A-Z0-9]{4,32}$/.test(normalizeCode(value)); }
function normalizeMax(value) { return Math.max(2, Math.min(100, Math.trunc(Number(value) || 4))); }
function cleanName(value) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 24); }
function cleanFileName(value) { return (String(value || "file").replace(/[\\/:*?"<>|]/g, "_").trim() || "file").slice(0, 120); }
function validDeviceId(value) { return /^[A-Za-z0-9_-]{8,96}$/.test(value); }
function randomDigits(length) { let value = ""; while (value.length < length) value += sodium.randombytes_uniform(10); return value; }
function shortId(value) { return value?.length > 14 ? `${value.slice(0, 10)}...${value.slice(-4)}` : value || "-"; }
function formatBytes(value) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function reportError(error) { broadcast("error", { error: error.message || String(error) }); }

async function storageGet(area, keys) {
  const response = await chrome.runtime.sendMessage({ type: "storage-get", area, keys });
  if (!response?.ok) throw new Error(response?.error || "读取扩展会话失败");
  return response.value || {};
}
async function storageSet(area, value) {
  const response = await chrome.runtime.sendMessage({ type: "storage-set", area, value });
  if (!response?.ok) throw new Error(response?.error || "保存扩展会话失败");
}
async function storageRemove(area, keys) {
  const response = await chrome.runtime.sendMessage({ type: "storage-remove", area, keys });
  if (!response?.ok) throw new Error(response?.error || "清除扩展会话失败");
}
