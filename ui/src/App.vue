<template>
  <n-config-provider :theme="naiveTheme">
    <n-message-provider>
      <n-layout class="shell">
        <n-layout-content class="content">
          <n-modal v-model:show="nameModalVisible" :mask-closable="false" preset="card" class="name-modal">
            <template #header>进入房间</template>
            <n-space vertical :size="14">
              <n-input
                v-model:value="pendingName"
                maxlength="24"
                placeholder="给自己起个名字"
                @keydown.enter.prevent="confirmName"
              />
              <n-button type="primary" block :disabled="!cleanName(pendingName)" @click="confirmName">进入聊天</n-button>
            </n-space>
          </n-modal>

          <n-card v-if="!roomId" class="home" :bordered="true">
            <n-space vertical :size="18">
              <div>
                <h1>临时群聊</h1>
                <p>链接即权限，服务端只负责转发消息。</p>
              </div>
              <div class="theme-control">
                <span>深色模式</span>
                <n-switch v-model:value="darkMode" size="small">
                  <template #checked>开</template>
                  <template #unchecked>关</template>
                </n-switch>
              </div>
              <n-space>
                <n-button type="primary" size="large" @click="createRoom">创建大力房间</n-button>
                <n-button size="large" :loading="codeBusy" @click="createCodeRoom">创建随机码房间</n-button>
              </n-space>

              <n-divider />

              <n-form class="join-code-form" @submit.prevent="createCodeRoom">
                <n-input
                  v-model:value="customCode"
                  maxlength="32"
                  placeholder="自定义群聊码，可留空随机生成"
                  clearable
                  @keydown.enter.prevent="createCodeRoom"
                />
                <n-button attr-type="submit" :loading="codeBusy" :disabled="Boolean(customCode.trim()) && !validCustomCode">用自定义码创建</n-button>
              </n-form>

              <n-form class="join-code-form" @submit.prevent="joinCodeRoom">
                <n-input
                  v-model:value="joinCode"
                  maxlength="32"
                  placeholder="输入群聊码"
                  clearable
                  @keydown.enter.prevent="joinCodeRoom"
                />
                <n-button type="primary" attr-type="submit" :loading="codeBusy" :disabled="!validJoinCode">用群聊码加入</n-button>
              </n-form>
              <p class="weak-note">群聊码支持旧数字码，或 4-32 位 A-Z 和 2-9 自定义码。</p>
            </n-space>
          </n-card>

          <section v-else class="chat">
            <header class="room-header">
              <div class="room-heading">
                <strong>{{ roomId }}</strong>
                <span class="desktop-only">房间</span>
              </div>
              <div class="room-actions">
                <n-button class="mobile-only" size="small" @click="memberDrawerVisible = true">成员</n-button>
                <n-button class="mobile-only" size="small" @click="detailVisible = true">详情</n-button>
                <n-button size="small" :type="notificationsEnabled ? 'primary' : 'default'" @click="toggleNotifications">
                  {{ notificationButtonText }}
                </n-button>
                <n-switch v-model:value="darkMode" size="small">
                  <template #checked>暗</template>
                  <template #unchecked>亮</template>
                </n-switch>
                <n-button class="desktop-only" size="small" @click="copyInvite">复制邀请链接</n-button>
                <n-button class="desktop-only" size="small" @click="copySafety">复制唯一码</n-button>
              </div>
            </header>

            <n-alert v-if="notice" class="notice" type="error" :bordered="false">
              {{ notice }}
            </n-alert>
            <n-alert v-if="weakCodeMode" class="notice" type="warning" :bordered="false">
              群聊码模式只适合临时闲聊。
            </n-alert>

            <div class="meta">
              <div class="name-control">
                <label class="meta-label">我的名字</label>
                <n-input
                  v-model:value="displayName"
                  maxlength="24"
                  size="small"
                  placeholder="我的名字"
                  :disabled="!deviceId"
                  @blur="updateDisplayName"
                  @keydown.enter.prevent="updateDisplayName"
                />
              </div>
              <div class="meta-pill">
                <span>设备</span>
                <strong>{{ shortId(deviceId) }}</strong>
              </div>
              <div class="meta-pill">
                <span>唯一码</span>
                <strong>{{ safetyCode || "-" }}</strong>
              </div>
              <div class="meta-pill status">
                <span>状态</span>
                <strong>{{ connectionState }}</strong>
              </div>
            </div>

            <section v-if="detailVisible" class="room-detail">
              <div class="detail-head">
                <h2>{{ roomId }}</h2>
                <n-button size="small" @click="detailVisible = false">返回聊天</n-button>
              </div>
              <div class="detail-list">
                <label>我的名字</label>
                <n-input
                  v-model:value="displayName"
                  maxlength="24"
                  size="small"
                  placeholder="我的名字"
                  :disabled="!deviceId"
                  @blur="updateDisplayName"
                  @keydown.enter.prevent="updateDisplayName"
                />
                <label>我的设备</label>
                <strong>{{ shortId(deviceId) }}</strong>
                <label>群聊唯一码</label>
                <strong>{{ safetyCode || "-" }}</strong>
                <label>连接状态</label>
                <strong>{{ connectionState }}</strong>
              </div>
              <div class="detail-actions">
                <n-button @click="copyInvite">复制邀请链接</n-button>
                <n-button @click="copySafety">复制唯一码</n-button>
              </div>
              <p v-if="weakCodeMode" class="detail-note">
                群聊码模式只适合临时闲聊。
              </p>
            </section>

            <div v-else class="chat-grid">
              <aside class="members">
                <div class="members-head">
                  <h2>在线成员</h2>
                  <n-button size="small" :type="selectedPeer ? 'default' : 'primary'" @click="selectPeer('')">
                    群聊
                  </n-button>
                </div>
                <n-scrollbar class="peer-scroll">
                  <n-list hoverable clickable>
                    <n-list-item>
                      <n-thing :title="`${displayName || shortId(deviceId)}（我）`" :description="`设备 ${shortId(deviceId)}`">
                        <template #avatar>
                          <span class="avatar" :style="userVisual(deviceId).avatarStyle">{{ userVisual(deviceId).avatar }}</span>
                        </template>
                      </n-thing>
                    </n-list-item>
                    <n-list-item
                      v-for="peer in sortedPeers"
                      :key="peer.id"
                      :class="{ active: selectedPeer === peer.id }"
                      @click="selectPeer(peer.id)"
                    >
                      <n-thing :title="peer.name || shortId(peer.id)" :description="`设备 ${shortId(peer.id)} · 私发唯一码 ${pairSafetyNumber(peer.publicKey)}`">
                        <template #avatar>
                          <span class="avatar" :style="userVisual(peer.id).avatarStyle">{{ userVisual(peer.id).avatar }}</span>
                        </template>
                      </n-thing>
                    </n-list-item>
                  </n-list>
                </n-scrollbar>
              </aside>

              <section class="conversation">
                <n-scrollbar ref="messageScrollRef" class="messages">
                  <div class="message-stack">
                    <article
                      v-for="message in messages"
                      :key="message.id"
                      class="message"
                      :class="{ mine: message.mine, private: message.privateTo, system: message.system }"
                      :style="message.system ? null : messageStyle(message)"
                    >
                      <template v-if="message.system">
                        {{ message.text }}
                      </template>
                      <template v-else>
                        <span class="avatar message-avatar" :style="userVisual(message.from).avatarStyle">{{ userVisual(message.from).avatar }}</span>
                        <div class="message-bubble">
                          <div class="byline">{{ messageLabel(message) }}</div>
                          <div v-if="message.text" class="text">{{ message.text }}</div>
                          <div v-if="message.file" class="attachment">
                            <img
                              v-if="isImageFile(message.file)"
                              class="attachment-image"
                              :src="fileDataUrl(message.file)"
                              :alt="message.file.name"
                            />
                            <a class="attachment-link" :href="fileDataUrl(message.file)" :download="message.file.name">
                              <span>{{ isImageFile(message.file) ? "查看/下载图片" : "下载文件" }}</span>
                              <strong>{{ message.file.name }}</strong>
                              <em>{{ formatBytes(message.file.size) }}</em>
                            </a>
                          </div>
                        </div>
                      </template>
                    </article>
                  </div>
                </n-scrollbar>

                <div v-if="selectedFile" class="selected-file">
                  <img
                    v-if="selectedFileUrl && isImageLike(selectedFile.type)"
                    class="selected-file-preview"
                    :src="selectedFileUrl"
                    :alt="selectedFile.name"
                  />
                  <span>{{ selectedFile.name }} · {{ formatBytes(selectedFile.size) }}</span>
                  <n-button size="tiny" @click="clearSelectedFile">移除</n-button>
                </div>

                <n-form class="composer" @submit.prevent="sendMessage">
                  <input ref="fileInputRef" class="file-input" type="file" @change="onFileSelected" />
                  <n-button attr-type="button" :disabled="!canSend" aria-label="选择图片或文件" @click="chooseFile">📎</n-button>
                  <n-popover trigger="click" placement="top-start">
                    <template #trigger>
                      <n-button attr-type="button" :disabled="!canSend" aria-label="插入 emoji">😀</n-button>
                    </template>
                    <div class="emoji-grid">
                      <button v-for="emoji in emojiList" :key="emoji" type="button" @click="insertEmoji(emoji)">
                        {{ emoji }}
                      </button>
                    </div>
                  </n-popover>
                  <n-input
                    v-model:value="draft"
                    :disabled="!canSend"
                    maxlength="4096"
                    placeholder="输入消息"
                    clearable
                    @paste="onMessagePaste"
                    @keydown.enter.prevent="sendMessage"
                  />
                  <n-button type="primary" attr-type="submit" :disabled="!canSubmit">
                    {{ selectedPeer ? `私发给 ${displayNameFor(selectedPeer)}` : "发送群聊" }}
                  </n-button>
                </n-form>
              </section>
            </div>

            <n-drawer v-model:show="memberDrawerVisible" placement="left" :width="300">
              <n-drawer-content title="在线成员" closable>
                <div class="drawer-members">
                  <n-button block :type="selectedPeer ? 'default' : 'primary'" @click="selectPeer('')">
                    群聊
                  </n-button>
                  <n-list hoverable clickable>
                    <n-list-item>
                      <n-thing :title="`${displayName || shortId(deviceId)}（我）`" :description="`设备 ${shortId(deviceId)}`">
                        <template #avatar>
                          <span class="avatar" :style="userVisual(deviceId).avatarStyle">{{ userVisual(deviceId).avatar }}</span>
                        </template>
                      </n-thing>
                    </n-list-item>
                    <n-list-item
                      v-for="peer in sortedPeers"
                      :key="peer.id"
                      :class="{ active: selectedPeer === peer.id }"
                      @click="selectPeer(peer.id)"
                    >
                      <n-thing :title="peer.name || shortId(peer.id)" :description="`设备 ${shortId(peer.id)} · 私发唯一码 ${pairSafetyNumber(peer.publicKey)}`">
                        <template #avatar>
                          <span class="avatar" :style="userVisual(peer.id).avatarStyle">{{ userVisual(peer.id).avatar }}</span>
                        </template>
                      </n-thing>
                    </n-list-item>
                  </n-list>
                </div>
              </n-drawer-content>
            </n-drawer>
          </section>
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import sodium from "libsodium-wrappers";
import { darkTheme } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const roomId = ref("");
const roomSecret = ref(null);
const roomKey = ref(null);
const deviceId = ref("");
const keyPair = ref(null);
const peers = ref(new Map());
const selectedPeer = ref("");
const source = ref(null);
const notice = ref("");
const safetyCode = ref("");
const connectionState = ref("未连接");
const messages = ref([]);
const draft = ref("");
const messageScrollRef = ref(null);
const fileInputRef = ref(null);
const selectedFile = ref(null);
const selectedFileUrl = ref("");
const cryptoReady = ref(false);
const joinCode = ref("");
const customCode = ref("");
const weakCodeMode = ref(false);
const displayName = ref("");
const pendingName = ref("");
const nameModalVisible = ref(false);
const codeBusy = ref(false);
const memberDrawerVisible = ref(false);
const detailVisible = ref(false);
const darkMode = ref(readInitialDarkMode());
const notificationsEnabled = ref(notificationSupported() && localStorage.getItem("e2ee-chat-notifications") === "1" && Notification.permission === "granted");
const notificationPermission = ref(notificationSupported() ? Notification.permission : "unsupported");
const windowFocused = ref(typeof document === "undefined" ? true : document.hasFocus());
let messageSeq = 0;
const maxFileBytes = 20 * 1024 * 1024;
const userPalette = [
  { color: "#176b87", background: "#e7f5f8", border: "#9ed7e1" },
  { color: "#7a4e10", background: "#fff2d8", border: "#e9c46a" },
  { color: "#8f3f63", background: "#fbe8f0", border: "#e7a1bd" },
  { color: "#2f6f3e", background: "#e8f5ec", border: "#9bd0a7" },
  { color: "#6f4bb8", background: "#f0ebff", border: "#c4b5fd" },
  { color: "#a4431e", background: "#ffede5", border: "#f0aa83" },
  { color: "#29639f", background: "#e8f1fb", border: "#9bbfe5" },
  { color: "#5d6b12", background: "#f2f5d8", border: "#c5d36c" },
  { color: "#0f766e", background: "#e1f5f2", border: "#8bd4ca" },
  { color: "#9a3412", background: "#fff0df", border: "#f2b279" },
];
const darkUserPalette = [
  { color: "#7dd3fc", background: "#102837", border: "#1e7496" },
  { color: "#facc6b", background: "#302613", border: "#8c661c" },
  { color: "#f0a6c8", background: "#351c2a", border: "#9d4d72" },
  { color: "#91d6a4", background: "#183021", border: "#3f8f55" },
  { color: "#c4b5fd", background: "#28223f", border: "#7461c9" },
  { color: "#f6ad86", background: "#351f16", border: "#a85c35" },
  { color: "#9dccf5", background: "#172838", border: "#4f85b7" },
  { color: "#d3dd7c", background: "#2a2f15", border: "#7f8d2a" },
  { color: "#8de0d6", background: "#14302d", border: "#3b948b" },
  { color: "#f7b981", background: "#352313", border: "#aa6a2a" },
];
const emojiList = [
  "😀", "😄", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😭", "😅", "😡",
  "👍", "👎", "🙏", "👏", "🙌", "🤝", "👀", "💪", "👌", "✌️", "🤞", "🫡",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "✨", "⭐", "🔥", "🎉", "✅", "❌",
  "💡", "📌", "📎", "📷", "🖼️", "📄", "🔒", "🔑", "🚀", "☕", "🍻", "❓",
];

const canSend = computed(() => Boolean(cryptoReady.value && roomKey.value && source.value));
const canSubmit = computed(() => canSend.value && (Boolean(draft.value.trim()) || Boolean(selectedFile.value)));
const validJoinCode = computed(() => isValidCode(joinCode.value));
const validCustomCode = computed(() => isValidCode(customCode.value));
const sortedPeers = computed(() => [...peers.value.entries()].sort().map(([id, peer]) => ({ id, ...peer })));
const naiveTheme = computed(() => (darkMode.value ? darkTheme : null));
const notificationButtonText = computed(() => {
  if (!notificationSupported()) return "通知不可用";
  return notificationsEnabled.value ? "通知开" : "通知关";
});

watch(darkMode, applyTheme, { immediate: true });

sodium.ready.then(() => {
  cryptoReady.value = true;
  boot();
}).catch(showError);

onBeforeUnmount(() => {
  source.value?.close();
  revokeSelectedFileUrl();
  window.removeEventListener("focus", updateWindowFocus);
  window.removeEventListener("blur", updateWindowFocus);
  document.removeEventListener("visibilitychange", updateWindowFocus);
});

onMounted(() => {
  updateWindowFocus();
  window.addEventListener("focus", updateWindowFocus);
  window.addEventListener("blur", updateWindowFocus);
  document.addEventListener("visibilitychange", updateWindowFocus);
});

function boot() {
  const parsedRoomId = parseRoomId(location.pathname);
  if (!parsedRoomId) return;

  roomId.value = parsedRoomId;
  document.title = parsedRoomId;
  const secret = readRoomSecret(parsedRoomId);
  if (!secret) {
    notice.value = "缺少房间信息，无法进入聊天。请使用包含 #k=... 的完整邀请链接，或从首页输入群聊码加入。";
    return;
  }

  roomSecret.value = secret;
  roomKey.value = sodium.crypto_generichash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    secret,
    sodium.from_string("e2ee-chat-room-key-v1"),
  );
  safetyCode.value = safetyNumber(secret, 18);

  const savedName = cleanName(sessionStorage.getItem("e2ee-chat-display-name") || "");
  pendingName.value = savedName || `访客${randomDigits(4)}`;
  if (savedName) {
    displayName.value = savedName;
    startChatSession();
  } else {
    nameModalVisible.value = true;
  }
}

function confirmName() {
  const name = cleanName(pendingName.value);
  if (!name) return;
  displayName.value = name;
  sessionStorage.setItem("e2ee-chat-display-name", name);
  nameModalVisible.value = false;
  if (!deviceId.value) startChatSession();
}

function startChatSession() {
  deviceId.value = `dev_${base64Url(sodium.randombytes_buf(12))}`;
  keyPair.value = sodium.crypto_box_keypair();
  connectEvents();
}

function createRoom() {
  if (!cryptoReady.value) return;
  const newRoomId = base64Url(sodium.randombytes_buf(12));
  const secret = sodium.randombytes_buf(32);
  location.href = `/r/${newRoomId}#k=${base64Url(secret)}`;
}

function createCodeRoom() {
  if (!cryptoReady.value) return;
  const code = normalizeCode(customCode.value);
  if (customCode.value.trim() && !isValidCode(code)) {
    notice.value = "群聊码可用 4/6 位数字，或 4-32 位 A-Z 和 2-9，字母码不能包含 0/1/I/L/O。";
    return;
  }
  requestCodeRoom("POST", code).catch(showError);
}

function joinCodeRoom() {
  const code = normalizeCode(joinCode.value);
  if (!isValidCode(code)) {
    notice.value = "群聊码可用 4/6 位数字，或 4-32 位 A-Z 和 2-9，字母码不能包含 0/1/I/L/O。";
    return;
  }
  requestCodeRoom("PUT", code).catch(showError);
}

async function requestCodeRoom(method, code = "") {
  if (codeBusy.value) return;
  codeBusy.value = true;
  try {
    const pow = await solvePowChallenge();
    const response = await fetch("/api/code-room", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(code ? { code, pow } : { pow }),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") || 60);
      throw new Error(`群聊码请求太频繁，请约 ${Math.max(1, Math.ceil(retryAfter))} 秒后再试。`);
    }
    if (!response.ok) throw new Error(`群聊码请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    location.href = payload.url;
  } finally {
    codeBusy.value = false;
  }
}

async function solvePowChallenge() {
  const response = await fetch("/api/pow-challenge?purpose=code");
  if (!response.ok) throw new Error(`PoW challenge 失败：HTTP ${response.status}`);
  const payload = await response.json();
  const encoder = new TextEncoder();
  let counter = 0;
  while (true) {
    const solution = `${Date.now().toString(36)}_${counter.toString(36)}`;
    const input = `${payload.challenge}:${solution}`;
    const hash = await sha256Bytes(input, encoder);
    if (hasLeadingZeroBits(hash, payload.difficulty)) {
      return { challenge: payload.challenge, solution };
    }
    counter += 1;
    if (counter % 500 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function sha256Bytes(input, encoder = new TextEncoder()) {
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(input)));
  }
  return sodium.crypto_hash_sha256(sodium.from_string(input));
}

function hasLeadingZeroBits(bytes, bits) {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return (bytes[fullBytes] & mask) === 0;
}

function parseRoomId(pathname) {
  if (pathname === "/") return "";
  const match = pathname.match(/^\/r\/([A-Za-z0-9_-]{3,64})$/);
  return match ? match[1] : "";
}

function readRoomSecret(currentRoomId) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const encoded = params.get("k");
  if (!encoded) {
    const passcode = params.get("p");
    if (!passcode || normalizeCode(passcode) !== currentRoomId || !isValidCode(passcode)) return null;
    weakCodeMode.value = true;
    return deriveCodeSecret(passcode);
  }
  try {
    const secret = fromBase64Url(encoded);
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}

function deriveCodeSecret(code) {
  return sodium.crypto_generichash(32, sodium.from_string(`e2ee-chat-short-code-v1:${normalizeCode(code)}`));
}

function connectEvents() {
  const url = `/api/rooms/${encodeURIComponent(roomId.value)}/events?client_id=${encodeURIComponent(deviceId.value)}`;
  source.value = new EventSource(url);
  source.value.addEventListener("open", () => {
    connectionState.value = "已连接";
    postEvent({
      type: "hello",
      room: roomId.value,
      from: deviceId.value,
      public_key: b64(keyPair.value.publicKey),
      display_name: displayName.value,
    }).catch(showError);
  });
  source.value.addEventListener("error", () => {
    connectionState.value = "重连中";
  });
  source.value.addEventListener("ping", () => {
    connectionState.value = "已连接";
  });
  source.value.addEventListener("message", (event) => {
    handleWireEvent(JSON.parse(event.data)).catch((err) => {
      addSystemMessage(`无法处理一条消息：${err.message || err}`);
    });
  });
}

async function handleWireEvent(event) {
  if (event.room && event.room !== roomId.value) return;

  switch (event.type) {
    case "hello":
      if (event.from === deviceId.value) return;
      rememberPeer(event.from, event.public_key, event.display_name);
      await postEvent({
        type: "peer_hello",
        room: roomId.value,
        from: deviceId.value,
        to: event.from,
        public_key: b64(keyPair.value.publicKey),
        display_name: displayName.value,
      });
      break;
    case "peer_hello":
      if (event.to !== deviceId.value || event.from === deviceId.value) return;
      rememberPeer(event.from, event.public_key, event.display_name);
      break;
    case "peer_leave":
      forgetPeer(event.from);
      break;
    case "group_msg":
      receiveGroupMessage(event);
      break;
    case "private_msg":
      receivePrivateMessage(event);
      break;
  }
}

function rememberPeer(id, publicKeyText, nameText = "") {
  if (!validDeviceId(id) || !publicKeyText) return;
  const publicKey = sodium.from_base64(publicKeyText, sodium.base64_variants.ORIGINAL);
  const next = new Map(peers.value);
  next.set(id, { publicKey, name: cleanName(nameText), lastSeen: Date.now() });
  peers.value = next;
}

function forgetPeer(id) {
  const next = new Map(peers.value);
  next.delete(id);
  peers.value = next;
  if (selectedPeer.value === id) selectPeer("");
}

async function sendMessage() {
  const text = draft.value.trim();
  const file = selectedFile.value;
  if (!text && !file) return;

  try {
    const payload = await makeMessagePayload(text, file);
    if (selectedPeer.value) {
      await sendPrivateMessage(selectedPeer.value, payload);
    } else {
      await sendGroupMessage(payload);
    }
    draft.value = "";
    clearSelectedFile();
  } catch (err) {
    showError(err);
  }
}

async function makeMessagePayload(text, file) {
  if (!file) return { kind: "text", text, sent_at: Date.now() };
  if (file.size > maxFileBytes) {
    throw new Error(`文件不能超过 ${formatBytes(maxFileBytes)}。`);
  }
  return {
    kind: "file",
    text,
    sent_at: Date.now(),
    file: await readFilePayload(file),
  };
}

function readFilePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      resolve({
        name: cleanFileName(file.name),
        type: file.type || "application/octet-stream",
        size: file.size,
        data: b64(bytes),
      });
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsArrayBuffer(file);
  });
}

async function sendGroupMessage(payload) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = sodium.from_string(JSON.stringify(payload));
  const additionalData = sodium.from_string(`room:${roomId.value}`);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    additionalData,
    null,
    nonce,
    roomKey.value,
  );
  await postEvent({
    type: "group_msg",
    room: roomId.value,
    from: deviceId.value,
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
  });
}

async function sendPrivateMessage(to, payload) {
  const peer = peers.value.get(to);
  if (!peer) {
    throw new Error("未找到该成员的公钥，暂时不能私发。");
  }
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(payload));
  const ciphertext = sodium.crypto_box_easy(plaintext, nonce, peer.publicKey, keyPair.value.privateKey);
  await postEvent({
    type: "private_msg",
    room: roomId.value,
    from: deviceId.value,
    to,
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
  });
  addMessage({ from: deviceId.value, text: payload.text || "", file: payload.file, privateTo: to, mine: true });
}

function receiveGroupMessage(event) {
  const nonce = sodium.from_base64(event.nonce, sodium.base64_variants.ORIGINAL);
  const ciphertext = sodium.from_base64(event.ciphertext, sodium.base64_variants.ORIGINAL);
  const additionalData = sodium.from_string(`room:${roomId.value}`);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    additionalData,
    nonce,
    roomKey.value,
  );
  const payload = JSON.parse(sodium.to_string(plaintext));
  addMessage({ from: event.from, text: payload.text || "", file: payload.file, mine: event.from === deviceId.value });
  if (event.from !== deviceId.value) notifyIncomingMessage();
}

function receivePrivateMessage(event) {
  if (event.from === deviceId.value) return;
  if (event.to !== deviceId.value) {
    return;
  }
  const peer = peers.value.get(event.from);
  if (!peer) {
    addSystemMessage(`收到 ${shortId(event.from)} 的私信，但缺少对方公钥`);
    return;
  }
  const nonce = sodium.from_base64(event.nonce, sodium.base64_variants.ORIGINAL);
  const ciphertext = sodium.from_base64(event.ciphertext, sodium.base64_variants.ORIGINAL);
  const plaintext = sodium.crypto_box_open_easy(ciphertext, nonce, peer.publicKey, keyPair.value.privateKey);
  const payload = JSON.parse(sodium.to_string(plaintext));
  addMessage({ from: event.from, text: payload.text || "", file: payload.file, privateTo: deviceId.value, mine: false });
  notifyIncomingMessage();
}

async function postEvent(payload) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId.value)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`发送失败：HTTP ${response.status}`);
}

function selectPeer(id) {
  selectedPeer.value = id;
  memberDrawerVisible.value = false;
}

function updateDisplayName() {
  const name = cleanName(displayName.value);
  if (!name) {
    displayName.value = sessionStorage.getItem("e2ee-chat-display-name") || `访客${randomDigits(4)}`;
    return;
  }
  displayName.value = name;
  sessionStorage.setItem("e2ee-chat-display-name", name);
  if (!deviceId.value || !keyPair.value) return;
  postEvent({
    type: "hello",
    room: roomId.value,
    from: deviceId.value,
    public_key: b64(keyPair.value.publicKey),
    display_name: displayName.value,
  }).catch(showError);
}

function displayNameFor(id) {
  if (id === deviceId.value) return displayName.value || shortId(id);
  return peers.value.get(id)?.name || shortId(id);
}

function insertEmoji(emoji) {
  draft.value = `${draft.value}${emoji}`;
}

function chooseFile() {
  fileInputRef.value?.click();
}

function onFileSelected(event) {
  const file = event.target.files?.[0] || null;
  if (!file) return;
  setSelectedFile(file);
}

function onMessagePaste(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (!file) return;
  event.preventDefault();
  const ext = imageExtension(file.type);
  const namedFile = new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type });
  setSelectedFile(namedFile);
}

function setSelectedFile(file) {
  if (file.size > maxFileBytes) {
    showError(new Error(`文件不能超过 ${formatBytes(maxFileBytes)}。`));
    if (fileInputRef.value) fileInputRef.value.value = "";
    return;
  }
  revokeSelectedFileUrl();
  selectedFile.value = file;
  selectedFileUrl.value = isImageLike(file.type) ? URL.createObjectURL(file) : "";
}

function clearSelectedFile() {
  revokeSelectedFileUrl();
  selectedFile.value = null;
  if (fileInputRef.value) fileInputRef.value.value = "";
}

function revokeSelectedFileUrl() {
  if (selectedFileUrl.value) URL.revokeObjectURL(selectedFileUrl.value);
  selectedFileUrl.value = "";
}

function addMessage(message) {
  messages.value.push({ id: nextMessageId(), ...message });
  scrollMessages();
}

function addSystemMessage(text) {
  messages.value.push({ id: nextMessageId(), text, system: true });
  scrollMessages();
}

function scrollMessages() {
  nextTick(() => {
    messageScrollRef.value?.scrollTo({ top: 999999 });
  });
}

function messageLabel(message) {
  if (message.privateTo) {
    return `${displayNameFor(message.from)} 私信${message.mine ? `给 ${displayNameFor(message.privateTo)}` : ""}`;
  }
  return `${displayNameFor(message.from)} 群聊`;
}

function messageStyle(message) {
  const visual = userVisual(message.from);
  return {
    "--user-color": visual.color,
    "--user-bg": visual.background,
    "--user-border": visual.border,
  };
}

function userVisual(id) {
  const hash = hashString(id || "unknown");
  const palette = paletteForUser(id, hash);
  return {
    ...palette,
    avatar: avatarLabel(id),
    avatarStyle: {
      color: "#fff",
      background: palette.color,
      borderColor: palette.border,
    },
  };
}

function avatarLabel(id) {
  const name = cleanName(displayNameFor(id));
  const first = Array.from(name || shortId(id) || "?")[0] || "?";
  return /^[a-z]$/i.test(first) ? first.toUpperCase() : first;
}

function paletteForUser(id, fallbackHash) {
  const palette = darkMode.value ? darkUserPalette : userPalette;
  const knownIds = [deviceId.value, ...peers.value.keys()].filter(Boolean).sort();
  const index = knownIds.indexOf(id);
  if (index < 0) return palette[fallbackHash % palette.length];
  if (index < palette.length) return palette[index];
  return generatedUserColor(index);
}

function generatedUserColor(index) {
  const hue = Math.round((index * 137.508 + 23) % 360);
  if (darkMode.value) {
    return {
      color: `hsl(${hue} 78% 76%)`,
      background: `hsl(${hue} 38% 18%)`,
      border: `hsl(${hue} 44% 42%)`,
    };
  }
  return {
    color: `hsl(${hue} 64% 28%)`,
    background: `hsl(${hue} 76% 94%)`,
    border: `hsl(${hue} 62% 72%)`,
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function copyInvite() {
  await navigator.clipboard.writeText(location.href);
  addSystemMessage("已复制邀请链接");
}

async function copySafety() {
  await navigator.clipboard.writeText(safetyCode.value);
  addSystemMessage("已复制唯一码");
}

async function toggleNotifications() {
  if (!notificationSupported()) {
    notice.value = "当前浏览器不支持系统通知。";
    return;
  }
  if (notificationsEnabled.value) {
    notificationsEnabled.value = false;
    localStorage.removeItem("e2ee-chat-notifications");
    return;
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  notificationPermission.value = permission;
  if (permission !== "granted") {
    notificationsEnabled.value = false;
    localStorage.removeItem("e2ee-chat-notifications");
    notice.value = "系统通知权限未开启，无法发送浏览器通知。";
    return;
  }
  notificationsEnabled.value = true;
  localStorage.setItem("e2ee-chat-notifications", "1");
}

function notifyIncomingMessage() {
  if (!notificationsEnabled.value || !notificationSupported() || Notification.permission !== "granted") return;
  if (!document.hidden && windowFocused.value) return;
  try {
    new Notification("您收到一条信息", {
      tag: `e2ee-chat-${roomId.value}`,
      body: "",
    });
  } catch {
    notificationsEnabled.value = false;
    localStorage.removeItem("e2ee-chat-notifications");
  }
}

function updateWindowFocus() {
  windowFocused.value = typeof document === "undefined" ? true : document.hasFocus();
}

function notificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function readInitialDarkMode() {
  if (typeof window === "undefined") return false;
  const saved = localStorage.getItem("e2ee-chat-theme");
  if (saved) return saved === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
}

function applyTheme(enabled) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = enabled ? "dark" : "light";
  localStorage.setItem("e2ee-chat-theme", enabled ? "dark" : "light");
}

function showError(err) {
  const text = err.message || String(err);
  notice.value = text;
}

function safetyNumber(bytes, length) {
  const digest = sodium.crypto_generichash(16, bytes, sodium.from_string("e2ee-chat-safety-v1"));
  return decimalCode(digest).slice(0, length).replace(/(\d{3})(?=\d)/g, "$1 ");
}

function pairSafetyNumber(peerPublicKey) {
  const mine = b64(keyPair.value.publicKey);
  const peer = b64(peerPublicKey);
  const sorted = [mine, peer].sort().join(".");
  return safetyNumber(sodium.from_string(sorted), 12);
}

function decimalCode(bytes) {
  return [...bytes].map((byte) => String(byte % 1000).padStart(3, "0")).join("");
}

function validDeviceId(id) {
  return /^[A-Za-z0-9_-]{8,96}$/.test(id);
}

function b64(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function base64Url(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function fromBase64Url(text) {
  return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function randomDigits(length) {
  let out = "";
  while (out.length < length) {
    out += String(sodium.randombytes_uniform(10));
  }
  return out;
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[\s_-]+/g, "");
}

function isValidCode(value) {
  const code = normalizeCode(value);
  return /^(?:\d{4}|\d{6}|[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4,32})$/.test(code);
}

function cleanFileName(value) {
  const name = String(value || "file").replace(/[\\/:*?"<>|]/g, "_").trim();
  return (name || "file").slice(0, 120);
}

function isImageFile(file) {
  return isImageLike(file?.type);
}

function isImageLike(type) {
  return String(type || "").startsWith("image/");
}

function fileDataUrl(file) {
  return `data:${file.type || "application/octet-stream"};base64,${file.data}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function imageExtension(type) {
  switch (type) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    default:
      return "png";
  }
}

function nextMessageId() {
  messageSeq += 1;
  const suffix = cryptoReady.value ? base64Url(sodium.randombytes_buf(8)) : String(Date.now());
  return `msg_${messageSeq}_${suffix}`;
}

function shortId(id) {
  if (!id) return "-";
  return id.length <= 14 ? id : `${id.slice(0, 10)}...${id.slice(-4)}`;
}
</script>

<style scoped>
.shell {
  height: 100vh;
  background: var(--page-bg);
  overflow: hidden;
}

.content {
  width: min(1120px, calc(100vw - 32px));
  height: calc(100vh - 32px);
  margin: 16px auto;
}

.home {
  max-width: 560px;
  margin: 16vh auto 0;
}

.home h1 {
  margin: 0 0 10px;
  font-size: 30px;
}

.home p {
  margin: 0;
  color: var(--muted);
}

.theme-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
}

.join-code-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
}

.weak-note {
  font-size: 13px;
}

.chat {
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}

.room-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 18px;
  min-height: 56px;
  border-bottom: 1px solid var(--border);
}

.room-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.room-heading strong {
  font-size: 24px;
  line-height: 1.1;
}

.room-heading span {
  color: var(--muted);
}

.room-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.mobile-only {
  display: none;
}

.notice {
  margin: 8px 18px 0;
}

.name-modal {
  max-width: min(420px, calc(100vw - 32px));
}

.meta {
  display: flex;
  align-items: center;
  gap: 14px;
  overflow-x: auto;
  padding: 8px 18px;
  border-bottom: 1px solid var(--border);
}

.name-control {
  flex: 0 0 190px;
}

.meta-label {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 12px;
}

.meta-pill {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 0;
  color: var(--muted);
}

.meta-pill span {
  flex: 0 0 auto;
  font-size: 12px;
}

.meta-pill strong {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
}

.meta-pill.status strong {
  color: var(--status);
}

.chat-grid {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}

.members {
  border-right: 1px solid var(--border);
  padding: 16px;
  background: var(--surface-subtle);
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.members-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.members-head h2 {
  margin: 0;
  font-size: 16px;
}

.peer-scroll {
  min-height: 0;
}

.members :deep(.n-list-item) {
  border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
}

.members :deep(.n-list-item.active) {
  box-shadow: inset 3px 0 0 var(--accent);
  background: var(--active-bg);
}

.drawer-members {
  display: grid;
  gap: 12px;
}

.drawer-members :deep(.n-list-item) {
  border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
}

.drawer-members :deep(.n-list-item.active) {
  box-shadow: inset 3px 0 0 var(--accent);
  background: var(--active-bg);
}

.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.member-row :deep(.n-thing) {
  min-width: 0;
}

.avatar {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 2px solid;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0;
  user-select: none;
}

.room-detail {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.detail-head h2 {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 22px;
}

.detail-list {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 12px 16px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}

.detail-list label {
  color: var(--muted);
  font-size: 13px;
}

.detail-list strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 15px;
}

.detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.detail-note {
  margin: 14px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.conversation {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
}

.messages {
  min-height: 0;
}

.message-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
}

.message {
  max-width: min(680px, 92%);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  overflow-wrap: anywhere;
}

.message.mine {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message-bubble {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--user-border, var(--border));
  border-left-width: 4px;
  border-radius: 8px;
  background: var(--user-bg, var(--surface));
}

.message.mine .message-bubble {
  border-right-width: 4px;
  border-left-width: 1px;
}

.message.private .message-bubble {
  background: linear-gradient(0deg, var(--private-overlay), var(--private-overlay)), var(--user-bg, var(--surface));
  box-shadow: inset 0 0 0 1px var(--private-border);
}

.message-avatar {
  margin-top: 2px;
}

.message.system {
  align-self: center;
  display: block;
  max-width: 100%;
  color: var(--muted);
  background: transparent;
  border: 0;
  padding: 4px;
  font-size: 13px;
}

.byline {
  color: var(--user-color, var(--muted));
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}

.attachment {
  margin-top: 8px;
  display: grid;
  gap: 8px;
}

.attachment-image {
  display: block;
  max-width: min(360px, 100%);
  max-height: 260px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: contain;
  background: var(--surface-strong);
}

.attachment-link {
  display: grid;
  gap: 2px;
  color: inherit;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 10px;
  background: var(--surface-subtle);
}

.attachment-link span,
.attachment-link em {
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
}

.selected-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  background: var(--surface-subtle);
  font-size: 13px;
}

.selected-file-preview {
  width: 56px;
  height: 56px;
  border: 1px solid var(--border);
  border-radius: 8px;
  object-fit: cover;
  background: var(--surface);
}

.composer {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  gap: 10px;
  padding: 14px;
  border-top: 1px solid var(--border);
}

.file-input {
  display: none;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(8, 34px);
  gap: 5px;
  max-width: 307px;
  max-height: 236px;
  overflow-y: auto;
}

.emoji-grid button {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 19px;
  line-height: 1;
}

.emoji-grid button:hover {
  background: var(--surface-strong);
}

@media (max-width: 640px) {
  .content {
    width: 100%;
    height: 100vh;
    margin: 0;
  }

  .chat {
    border: 0;
    border-radius: 0;
  }

  .chat-grid {
    grid-template-columns: 1fr;
  }

  .room-header {
    min-height: 50px;
    padding: 8px 10px 8px 12px;
    gap: 8px;
  }

  .room-heading {
    min-width: 0;
  }

  .room-heading strong {
    display: block;
    max-width: calc(100vw - 228px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 20px;
  }

  .room-actions {
    flex-wrap: nowrap;
    flex: 0 0 auto;
  }

  .desktop-only {
    display: none !important;
  }

  .mobile-only {
    display: inline-flex;
  }

  .meta {
    display: none;
  }

  .members {
    display: none;
  }

  .messages {
    min-height: 0;
  }

  .composer {
    grid-template-columns: auto auto minmax(0, 1fr);
    gap: 8px;
    padding: 10px;
  }

  .composer :deep(.n-button[type="submit"]) {
    grid-column: 1 / -1;
  }

  .message-stack {
    padding: 12px;
  }

  .message {
    max-width: 94%;
  }

  .selected-file {
    align-items: flex-start;
    padding: 8px 10px;
  }

  .selected-file-preview {
    width: 48px;
    height: 48px;
  }

  .join-code-form {
    grid-template-columns: 1fr;
  }

  .home {
    min-height: 100vh;
    margin: 0;
    border-radius: 0;
  }

  .room-detail {
    padding: 14px 12px;
  }

  .detail-list {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .detail-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
