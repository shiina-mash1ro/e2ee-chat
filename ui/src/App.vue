<template>
  <n-config-provider :theme="naiveTheme">
    <n-message-provider>
      <n-layout class="shell">
        <n-layout-content class="content">
          <n-modal
            v-model:show="nameModalVisible"
            :mask-closable="false"
            preset="card"
            class="name-modal"
            :style="{ width: 'min(420px, calc(100vw - 32px))' }"
          >
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
              </div>
              <div class="theme-control">
                <span>深色模式</span>
                <n-switch v-model:value="darkMode" size="small">
                  <template #checked>开</template>
                  <template #unchecked>关</template>
                </n-switch>
              </div>
              <div class="room-limit-control">
                <span>最大人数</span>
                <n-input-number v-model:value="roomMaxClients" :min="2" :max="100" :precision="0" size="small" />
                <small>包含创建者，默认 4 人</small>
              </div>
              <n-space>
                <n-button type="primary" size="large" :loading="roomCreateBusy" @click="createRoom">创建大力房间</n-button>
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
                          <div class="byline">
                            <span>{{ messageLabel(message) }}</span>
                            <span v-if="isMessageBusy(message)" class="message-spinner" title="发送中"></span>
                            <span v-else-if="message.status === 'failed'" class="message-status" :title="message.failureReason || '发送失败'">!</span>
                          </div>
                          <div v-if="message.kind === 'code'" class="code-block">
                            <div class="code-block-head">
                              <span>代码</span>
                              <n-button size="tiny" quaternary @click="copyCodeBlock(message.text)">复制</n-button>
                            </div>
                            <pre><code>{{ message.text }}</code></pre>
                          </div>
                          <div v-else-if="message.text" class="text">{{ message.text }}</div>
                          <div v-if="message.file" class="attachment">
                            <img
                              v-if="isImageFile(message.file)"
                              class="attachment-image"
                              :src="fileObjectUrl(message.file)"
                              :alt="message.file.name"
                              role="button"
                              tabindex="0"
                              @click="openImagePreview(message.file)"
                              @keydown.enter.prevent="openImagePreview(message.file)"
                            />
                            <a class="attachment-link" :href="fileObjectUrl(message.file)" :download="message.file.name">
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
                  <div class="composer-input-row">
                    <n-input
                      v-model:value="draft"
                      :disabled="!canSend"
                      type="textarea"
                      :autosize="{ minRows: 1, maxRows: 6 }"
                      maxlength="4096"
                      placeholder="输入消息"
                      clearable
                      @paste="onMessagePaste"
                      @keydown.enter.exact.prevent="sendMessage"
                    />
                    <n-button class="composer-send" type="primary" attr-type="submit" :disabled="!canSubmit" :title="sendDisabledReason">
                      {{ selectedPeer ? `私发给 ${displayNameFor(selectedPeer)}` : "发送群聊" }}
                    </n-button>
                  </div>
                  <div class="composer-tools">
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
                    <n-button
                      attr-type="button"
                      :type="codeMode ? 'primary' : 'default'"
                      :disabled="!canToggleCodeMode"
                      :aria-pressed="codeMode"
                      aria-label="切换代码模式"
                      @click="codeMode = !codeMode"
                    >&lt;/&gt;</n-button>
                    <n-popconfirm positive-text="确认" negative-text="取消" @positive-click="purgeOwnMessages">
                      <template #trigger>
                        <n-button attr-type="button" :loading="roomActionBusy" aria-label="一键鸵鸟">🦤</n-button>
                      </template>
                      删除你在所有在线成员聊天区中的消息，但继续留在房间？
                    </n-popconfirm>
                  </div>
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
            <n-modal v-model:show="imagePreviewVisible" class="image-preview-modal" :mask-closable="true" @after-leave="finalizeImagePreviewClose">
              <div class="image-preview-card">
                <div
                  ref="imagePreviewStageRef"
                  class="image-preview-stage"
                  :class="{ pannable: imagePreviewScale > 1, dragging: imagePreviewDragging }"
                  @wheel.prevent="onImagePreviewWheel"
                  @pointerdown="startImagePreviewPan"
                  @pointermove="moveImagePreviewPan"
                  @pointerup="endImagePreviewPan"
                  @pointercancel="endImagePreviewPan"
                  @dblclick="resetImagePreviewTransform"
                >
                  <img
                    :src="imagePreviewUrl"
                    :alt="imagePreviewName"
                    :style="imagePreviewTransform"
                    draggable="false"
                  />
                </div>
                <div class="image-preview-actions">
                  <strong>{{ imagePreviewName }}</strong>
                  <div class="image-preview-zoom" aria-label="图片缩放控制">
                    <n-button size="small" aria-label="缩小图片" :disabled="imagePreviewScale <= 0.5" @click="zoomImagePreview(-0.25)">−</n-button>
                    <span>{{ Math.round(imagePreviewScale * 100) }}%</span>
                    <n-button size="small" aria-label="放大图片" :disabled="imagePreviewScale >= 5" @click="zoomImagePreview(0.25)">＋</n-button>
                    <n-button size="small" @click="resetImagePreviewTransform">重置</n-button>
                  </div>
                  <a :href="imagePreviewUrl" :download="imagePreviewName">下载原图</a>
                  <n-button size="small" @click="closeImagePreview">关闭</n-button>
                </div>
              </div>
            </n-modal>
          </section>
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { decode, encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";
import { darkTheme } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const roomId = ref("");
const roomSecret = ref(null);
const roomKey = ref(null);
const authKey = ref(null);
const deviceId = ref("");
const keyPair = ref(null);
const signingKeyPair = ref(null);
const senderKeyId = ref("");
const peers = ref(new Map());
const selectedPeer = ref("");
const offlinePrivatePeers = ref(new Map());
const transport = ref(null);
const transportMode = ref("");
const notice = ref("");
const safetyCode = ref("");
const connectionState = ref("未连接");
const messages = ref([]);
const draft = ref("");
const codeMode = ref(false);
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
const roomCreateBusy = ref(false);
const roomMaxClients = ref(4);
const memberDrawerVisible = ref(false);
const detailVisible = ref(false);
const darkMode = ref(readInitialDarkMode());
const notificationsEnabled = ref(notificationSupported() && localStorage.getItem("e2ee-chat-notifications") === "1" && Notification.permission === "granted");
const notificationPermission = ref(notificationSupported() ? Notification.permission : "unsupported");
const roomActionBusy = ref(false);
const imagePreviewVisible = ref(false);
const imagePreviewUrl = ref("");
const imagePreviewName = ref("");
const imagePreviewStageRef = ref(null);
const imagePreviewScale = ref(1);
const imagePreviewOffsetX = ref(0);
const imagePreviewOffsetY = ref(0);
const imagePreviewDragging = ref(false);
let messageSeq = 0;
let notificationSeq = 0;
let sessionEpoch = 0;
let connectionToken = "";
let activeSendOperations = 0;
let pendingWSUpgrade = null;
let imagePreviewPan = null;
let cryptoWorker = null;
let cryptoJobSeq = 0;
const maxFileBytes = 20 * 1024 * 1024;
const fallbackMaxFileBytes = 5 * 1024 * 1024;
const wsConnectTimeoutMs = 3000;
const wsActivityCooldownMs = 5000;
const wsRetryDelaysMs = [5000, 10000, 20000, 40000, 80000, 120000];
const textAckTimeoutMs = 5000;
const chunkAckTimeoutMs = 15000;
const chunkSize = 256 * 1024;
const pendingMessages = new Map();
const pendingServerAcks = new Map();
const incomingTransfers = new Map();
const fileUrlCache = new WeakMap();
const createdFileUrls = new Set();
const cryptoJobs = new Map();
const binaryEventFields = ["public_key", "sign_public_key", "hello_mac", "signature", "nonce", "ciphertext", "roster_hash", "sealed_key"];
const epochKeys = new Map();
const boxKeyHistory = new Map();
const pendingEpochKeys = new Map();
const seenAuthenticatedEvents = new Set();
let currentEpoch = 0;
let epochMessageCount = 0;
let epochStartedAt = 0;
let rotationTimer = null;
let activeRotation = null;
const wsRecovery = {
  timer: null,
  probeTimeout: null,
  probe: null,
  failures: 0,
  lastAttemptAt: 0,
  nextAttemptAt: 0,
  epoch: 0,
};
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

const canSend = computed(() => Boolean(cryptoReady.value && roomKey.value && transport.value));
const selectedPeerOffline = computed(() => Boolean(selectedPeer.value && !peers.value.has(selectedPeer.value)));
const canSubmit = computed(() => canSend.value && !selectedPeerOffline.value && (Boolean(draft.value.trim()) || Boolean(selectedFile.value)));
const canToggleCodeMode = computed(() => canSend.value && !selectedPeerOffline.value && !selectedFile.value);
const sendDisabledReason = computed(() => (selectedPeerOffline.value ? "私聊对象已断开，请重新选择私聊对象或切回群聊" : ""));
const validJoinCode = computed(() => isValidCode(joinCode.value));
const validCustomCode = computed(() => isValidCode(customCode.value));
const sortedPeers = computed(() => [...peers.value.entries()].sort().map(([id, peer]) => ({ id, ...peer })));
const naiveTheme = computed(() => (darkMode.value ? darkTheme : null));
const notificationButtonText = computed(() => {
  if (!notificationSupported()) return "通知不可用";
  return notificationsEnabled.value ? "通知开" : "通知关";
});
const imagePreviewTransform = computed(() => ({
  transform: `translate(${imagePreviewOffsetX.value}px, ${imagePreviewOffsetY.value}px) scale(${imagePreviewScale.value})`,
}));

watch(darkMode, applyTheme, { immediate: true });

sodium.ready.then(() => {
  cryptoReady.value = true;
  boot();
}).catch(showError);

onBeforeUnmount(() => {
  sessionEpoch += 1;
  cancelWSRecovery();
  transport.value?.close();
  clearPendingTimers();
  cryptoWorker?.terminate();
  cryptoWorker = null;
  revokeSelectedFileUrl();
  revokeFileObjectUrls();
  if (rotationTimer) clearInterval(rotationTimer);
  window.removeEventListener("online", wakeWSRecovery);
  document.removeEventListener("visibilitychange", handleVisibilityRecovery);
});

window.addEventListener("online", wakeWSRecovery);
document.addEventListener("visibilitychange", handleVisibilityRecovery);

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
    sodium.from_string("e2ee-chat-room-encryption-v3"),
  );
  authKey.value = sodium.crypto_generichash(32, secret, sodium.from_string("e2ee-chat-room-auth-v3"));
  currentEpoch = 0;
  epochKeys.clear();
  epochKeys.set(0, roomKey.value);
  epochStartedAt = Date.now();
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
  const storageKey = `e2ee-chat-device:${roomId.value}`;
  const savedDeviceId = sessionStorage.getItem(storageKey) || "";
  deviceId.value = validDeviceId(savedDeviceId) ? savedDeviceId : `dev_${base64Url(sodium.randombytes_buf(12))}`;
  sessionStorage.setItem(storageKey, deviceId.value);
  connectionToken = `conn_${base64Url(sodium.randombytes_buf(18))}`;
  const identityKey = `e2ee-chat-identity-v3:${roomId.value}`;
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem(identityKey) || "null"); } catch { stored = null; }
  if (stored?.box_public && stored?.box_private && stored?.sign_public && stored?.sign_private) {
    keyPair.value = { publicKey: fromB64(stored.box_public), privateKey: fromB64(stored.box_private) };
    signingKeyPair.value = { publicKey: fromB64(stored.sign_public), privateKey: fromB64(stored.sign_private) };
  } else {
    keyPair.value = sodium.crypto_box_keypair();
    signingKeyPair.value = sodium.crypto_sign_keypair();
    sessionStorage.setItem(identityKey, JSON.stringify({
      box_public: b64(keyPair.value.publicKey), box_private: b64(keyPair.value.privateKey),
      sign_public: b64(signingKeyPair.value.publicKey), sign_private: b64(signingKeyPair.value.privateKey),
    }));
  }
  senderKeyId.value = base64Url(sodium.crypto_generichash(12, keyPair.value.publicKey));
  rotationTimer = setInterval(() => maybeStartKeyRotation(), 30000);
  getCryptoWorker();
  connectEvents();
}

async function createRoom() {
  if (!cryptoReady.value || roomCreateBusy.value) return;
  roomCreateBusy.value = true;
  const newRoomId = base64Url(sodium.randombytes_buf(12));
  const secret = sodium.randombytes_buf(32);
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(newRoomId)}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_clients: normalizedRoomMaxClients() }),
    });
    if (!response.ok) throw new Error(`创建房间失败：HTTP ${response.status}`);
    location.href = `/r/${newRoomId}#k=${base64Url(secret)}`;
  } catch (err) {
    showError(err);
  } finally {
    roomCreateBusy.value = false;
  }
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
      body: JSON.stringify(method === "POST"
        ? { ...(code ? { code } : {}), max_clients: normalizedRoomMaxClients(), pow }
        : { code, pow }),
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

function normalizedRoomMaxClients() {
  const value = Math.round(Number(roomMaxClients.value) || 4);
  return Math.min(100, Math.max(2, value));
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
  const epoch = ++sessionEpoch;
  cancelWSRecovery();
  transport.value?.close();
  transport.value = null;
  transportMode.value = "";
  connectionState.value = "连接中";

  let settled = false;
  let wsTransport = null;
  const fallbackTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    wsTransport?.close();
    startSSETransport(epoch);
  }, wsConnectTimeoutMs);

  wsTransport = createWebSocketTransport({
    epoch,
    onReady: () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      cancelWSRecovery(false);
      transport.value = wsTransport;
      transportMode.value = "ws";
      connectionState.value = "已连接";
      sendHello().catch(showError);
    },
    onFallback: () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      wsTransport?.close();
      startSSETransport(epoch);
    },
    onEvent: dispatchWireEvent,
    onState: (state) => {
      if (!settled) connectionState.value = state;
    },
  });
}

function startSSETransport(epoch = sessionEpoch, resetRecovery = true) {
  if (epoch !== sessionEpoch) return;
  if (transport.value?.mode === "sse") {
    if (resetRecovery) startWSRecovery(epoch);
    return;
  }
  transport.value?.close();
  let sseTransport = null;
  sseTransport = createSSETransport({
    epoch,
    onOpen: () => {
      if (epoch !== sessionEpoch) return;
      transport.value = sseTransport;
      transportMode.value = "sse";
      connectionState.value = "已连接（兼容模式）";
      sendHello().catch(showError);
      if (resetRecovery) startWSRecovery(epoch);
    },
    onEvent: dispatchWireEvent,
    onState: (state) => {
      if (transport.value === sseTransport) connectionState.value = state;
    },
  });
}

function startWSRecovery(epoch = sessionEpoch) {
  cancelWSRecovery();
  wsRecovery.epoch = epoch;
  wsRecovery.failures = 0;
  wsRecovery.lastAttemptAt = 0;
  scheduleWSRecovery(wsRetryDelaysMs[0], epoch);
}

function scheduleWSRecovery(delayMs, epoch = wsRecovery.epoch) {
  if (epoch !== sessionEpoch || transportMode.value !== "sse") return;
  if (wsRecovery.timer) clearTimeout(wsRecovery.timer);
  if (navigator.onLine === false) {
    wsRecovery.timer = null;
    wsRecovery.nextAttemptAt = 0;
    return;
  }
  const delay = Math.max(0, delayMs);
  wsRecovery.nextAttemptAt = Date.now() + delay;
  wsRecovery.timer = setTimeout(() => {
    wsRecovery.timer = null;
    attemptWSRecovery(epoch);
  }, delay);
}

function attemptWSRecovery(epoch = wsRecovery.epoch) {
  if (epoch !== sessionEpoch || transportMode.value !== "sse" || wsRecovery.probe || pendingWSUpgrade) return;
  if (navigator.onLine === false) return;
  wsRecovery.lastAttemptAt = Date.now();
  connectionState.value = "已连接（兼容模式，正在尝试 WebSocket）";

  const probe = { epoch, transport: null, settled: false };
  const fail = () => finishWSProbeFailure(probe);
  probe.transport = createWebSocketTransport({
    epoch,
    onReady: () => {
      if (probe.settled || wsRecovery.probe !== probe || epoch !== sessionEpoch) return;
      probe.settled = true;
      clearTimeout(wsRecovery.probeTimeout);
      wsRecovery.probeTimeout = null;
      wsRecovery.probe = null;
      if (activeSendOperations > 0) {
        pendingWSUpgrade = probe;
        connectionState.value = "已连接（兼容模式，WebSocket 就绪）";
        return;
      }
      promoteWSProbe(probe);
    },
    onFallback: fail,
    onEvent: dispatchWireEvent,
    onState: () => {},
  });
  wsRecovery.probe = probe;
  wsRecovery.probeTimeout = setTimeout(fail, wsConnectTimeoutMs);
}

function finishWSProbeFailure(probe) {
  if (probe.settled || wsRecovery.probe !== probe) return;
  probe.settled = true;
  clearTimeout(wsRecovery.probeTimeout);
  wsRecovery.probeTimeout = null;
  wsRecovery.probe = null;
  probe.transport?.close();
  if (probe.epoch !== sessionEpoch || transportMode.value !== "sse") return;
  connectionState.value = "已连接（兼容模式）";
  wsRecovery.failures += 1;
  const delay = wsRetryDelaysMs[Math.min(wsRecovery.failures, wsRetryDelaysMs.length - 1)];
  scheduleWSRecovery(delay, probe.epoch);
}

function promoteWSProbe(probe) {
  if (probe.epoch !== sessionEpoch || transportMode.value !== "sse") {
    probe.transport?.close();
    return;
  }
  pendingWSUpgrade = null;
  const oldTransport = transport.value;
  transport.value = probe.transport;
  transportMode.value = "ws";
  connectionState.value = "已连接";
  cancelWSRecovery(false);
  oldTransport?.close();
  sendHello().catch(showError);
}

function wakeWSRecovery() {
  if (transportMode.value !== "sse" || wsRecovery.probe || pendingWSUpgrade) return;
  const cooldown = Math.max(0, wsActivityCooldownMs - (Date.now() - wsRecovery.lastAttemptAt));
  scheduleWSRecovery(cooldown, sessionEpoch);
}

function handleVisibilityRecovery() {
  if (document.visibilityState === "visible") wakeWSRecovery();
}

function cancelWSRecovery(closeProbe = true) {
  if (wsRecovery.timer) clearTimeout(wsRecovery.timer);
  if (wsRecovery.probeTimeout) clearTimeout(wsRecovery.probeTimeout);
  wsRecovery.timer = null;
  wsRecovery.probeTimeout = null;
  wsRecovery.nextAttemptAt = 0;
  if (closeProbe) {
    wsRecovery.probe?.transport?.close();
    pendingWSUpgrade?.transport?.close();
  }
  wsRecovery.probe = null;
  pendingWSUpgrade = null;
}

function createWebSocketTransport({ epoch, onReady, onFallback, onEvent, onState }) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/api/rooms/${encodeURIComponent(roomId.value)}/ws?client_id=${encodeURIComponent(deviceId.value)}`;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let ready = false;
  let closedByClient = false;

  socket.addEventListener("open", () => onState("连接中"));
  socket.addEventListener("error", () => {
    if (!ready) onFallback();
  });
  socket.addEventListener("close", () => {
    if (epoch !== sessionEpoch) return;
    if (!ready) {
      onFallback();
      return;
    }
    if (!closedByClient) {
      transport.value = null;
      transportMode.value = "";
      onState("重连中");
      startSSETransport(epoch);
    }
  });
  socket.addEventListener("message", (event) => {
    if (epoch !== sessionEpoch) return;
    try {
      const wireEvent = decode(new Uint8Array(event.data));
      if (wireEvent.type === "welcome") {
        ready = true;
        onReady();
        return;
      }
      onEvent(normalizeWireEvent(wireEvent));
    } catch (err) {
      addSystemMessage(`Could not process a WebSocket message: ${err.message || err}`);
    }
  });

  return {
    mode: "ws",
    send(event) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not connected");
      socket.send(encode(toWireEvent(event, "ws")));
    },
    bufferedAmount() {
      return socket.bufferedAmount;
    },
    close() {
      closedByClient = true;
      socket.close();
    },
  };
}

function createSSETransport({ epoch, onOpen, onEvent, onState }) {
  const url = `/api/rooms/${encodeURIComponent(roomId.value)}/events?client_id=${encodeURIComponent(deviceId.value)}&connection_token=${encodeURIComponent(connectionToken)}`;
  const source = new EventSource(url);
  source.addEventListener("open", () => epoch === sessionEpoch && onOpen());
  source.addEventListener("error", () => epoch === sessionEpoch && onState("重连中（兼容模式）"));
  source.addEventListener("ping", () => epoch === sessionEpoch && onState("已连接（兼容模式）"));
  source.addEventListener("message", (event) => {
    if (epoch !== sessionEpoch) return;
    try {
      onEvent(normalizeWireEvent(JSON.parse(event.data)));
    } catch (err) {
      addSystemMessage(`Could not process an SSE message: ${err.message || err}`);
    }
  });
  return {
    mode: "sse",
    async send(event) {
      await postEvent(toWireEvent(event, "sse"));
    },
    close() {
      source.close();
    },
  };
}

function dispatchWireEvent(event) {
  handleWireEvent(event).catch((err) => {
    addSystemMessage(`Could not process a message: ${err.message || err}`);
  });
}

async function sendHello() {
  const event = {
    type: "hello",
    room: roomId.value,
    from: deviceId.value,
    protocol: 3,
    features: ["v3", "epoch_rotation", "binary_ws"],
    public_key: keyPair.value.publicKey,
    sign_public_key: signingKeyPair.value.publicKey,
    sender_key_id: senderKeyId.value,
    display_name: displayName.value,
  };
  event.hello_mac = sodium.crypto_auth(canonicalEventBytes(event), authKey.value);
  event.signature = sodium.crypto_sign_detached(canonicalEventBytes(event), signingKeyPair.value.privateKey);
  await sendEvent(event);
}

async function handleWireEvent(event) {
  if (event.room && event.room !== roomId.value) return;

  if (event.type === "hello" || event.type === "peer_hello") {
    if (!verifyHelloEvent(event)) return;
  } else if (requiresPeerSignature(event.type)) {
    if (!verifyPeerEvent(event)) return;
  }

  switch (event.type) {
    case "hello":
      if (event.from === deviceId.value) return;
      rememberPeer(event.from, event.public_key, event.display_name, event.sign_public_key, event.sender_key_id);
      await sendSignedEvent({
        type: "peer_hello",
        room: roomId.value,
        from: deviceId.value,
        to: event.from,
        protocol: 3,
        public_key: keyPair.value.publicKey,
        sign_public_key: signingKeyPair.value.publicKey,
        sender_key_id: senderKeyId.value,
        display_name: displayName.value,
      });
      await offerCurrentEpochToPeer(event.from);
      break;
    case "peer_hello":
      if (event.to !== deviceId.value || event.from === deviceId.value) return;
      rememberPeer(event.from, event.public_key, event.display_name, event.sign_public_key, event.sender_key_id);
      break;
    case "peer_leave":
      forgetPeer(event.from);
      break;
    case "peer_purge":
      purgeMessagesFrom(event.from);
      break;
    case "server_ack":
    case "chunk_ack":
      handleServerAck(event.ack_id);
      break;
    case "recipient_ack":
      handleRecipientAck(event);
      break;
    case "chunk":
      await receiveChunk(event);
      break;
    case "group_msg":
      await receiveGroupMessage(event);
      break;
    case "private_msg":
      await receivePrivateMessage(event);
      break;
    case "key_prepare": case "key_offer": case "key_ready": case "key_commit": case "key_abort":
    case "join_key_offer": case "join_key_ready": case "device_key_update":
      await handleKeyEvent(event);
      break;
  }
}

function rememberPeer(id, publicKeyText, nameText = "", signPublicKeyText = null, keyId = "") {
  if (!validDeviceId(id) || !publicKeyText) return;
  const publicKey = typeof publicKeyText === "string" ? sodium.from_base64(publicKeyText, sodium.base64_variants.ORIGINAL) : asBytes(publicKeyText);
  const next = new Map(peers.value);
  const signPublicKey = signPublicKeyText ? decodeWireBytes(signPublicKeyText) : next.get(id)?.signPublicKey;
  const old = next.get(id);
  if (old?.signPublicKey && signPublicKey && !sodium.memcmp(old.signPublicKey, signPublicKey)) return;
  next.set(id, { ...old, publicKey, signPublicKey, keyId, name: cleanName(nameText), lastSeen: Date.now(), ready: currentEpoch === 0 });
  peers.value = next;
  const offline = new Map(offlinePrivatePeers.value);
  offline.delete(id);
  offlinePrivatePeers.value = offline;
}

function forgetPeer(id) {
  const known = peers.value.get(id);
  const next = new Map(peers.value);
  next.delete(id);
  peers.value = next;
  if (selectedPeer.value === id) {
    const offline = new Map(offlinePrivatePeers.value);
    offline.set(id, known || offline.get(id) || { name: shortId(id) });
    offlinePrivatePeers.value = offline;
    addSystemMessage(`${displayNameFor(id)} 已断开，当前私聊已暂停。请重新选择私聊对象或切回群聊。`);
  }
}

async function sendMessage() {
  const text = codeMode.value ? draft.value : draft.value.trim();
  const file = selectedFile.value;
  if (!text && !file) return;

  let sendContext = null;
  try {
    sendContext = beginSendOperation();
    const payload = codeMode.value && !file
      ? { kind: "code", text, sent_at: Date.now() }
      : await makeMessagePayload(text, file, sendContext.mode);
    await sendPayload(payload, sendContext);
  } catch (err) {
    showError(err);
  } finally {
    if (sendContext) finishSendOperation();
  }
}

function beginSendOperation() {
  const activeTransport = transport.value;
  if (!activeTransport) throw new Error("Not connected");
  activeSendOperations += 1;
  return { transport: activeTransport, mode: activeTransport.mode, epoch: currentEpoch, epochKey: epochKeys.get(currentEpoch) };
}

function finishSendOperation() {
  activeSendOperations = Math.max(0, activeSendOperations - 1);
  if (activeSendOperations === 0 && pendingWSUpgrade) promoteWSProbe(pendingWSUpgrade);
  wakeWSRecovery();
}

async function sendPayload(payload, sendContext) {
  const to = selectedPeer.value;
  const msgId = nextMessageId();
  const localMessage = {
    id: msgId,
    msgId,
    from: deviceId.value,
    kind: payload.kind,
    text: payload.text || "",
    file: payload.file,
    privateTo: to || "",
    mine: true,
    status: "pending",
  };
  addMessage(localMessage);
  draft.value = "";
  clearSelectedFile();

  try {
    if (to) {
      await sendPrivateMessage(to, payload, msgId, sendContext);
    } else {
      await sendGroupMessage(payload, msgId, sendContext);
    }
  } catch (err) {
    markMessageFailed(msgId, err.message || String(err));
    throw err;
  }
}

async function makeMessagePayload(text, file, mode) {
  if (!file) return { kind: "text", text, sent_at: Date.now() };
  const limit = mode === "sse" ? fallbackMaxFileBytes : maxFileBytes;
  if (file.size > limit) {
    throw new Error(`File cannot exceed ${formatBytes(limit)}.`);
  }
  return {
    kind: "file",
    text,
    sent_at: Date.now(),
    file: await readFilePayload(file, mode),
  };
}

function readFilePayload(file, mode) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      resolve({
        name: cleanFileName(file.name),
        type: file.type || "application/octet-stream",
        size: file.size,
        data: mode === "ws" ? bytes : b64(bytes),
      });
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

async function sendGroupMessage(payload, msgId, sendContext) {
  const event = await encryptGroupEvent(payload, msgId, sendContext);
  await sendEncryptedEvent(event, { msgId, privateTo: "", hasFile: Boolean(payload.file), ...sendContext });
  epochMessageCount += 1;
  if (epochMessageCount >= 100) maybeStartKeyRotation().catch(showError);
}

async function sendPrivateMessage(to, payload, msgId, sendContext) {
  const event = await encryptPrivateEvent(to, payload, msgId, sendContext.mode);
  await sendEncryptedEvent(event, { msgId, privateTo: to, hasFile: Boolean(payload.file), ...sendContext });
}

async function encryptGroupEvent(payload, msgId, sendContext) {
  const { mode, epoch, epochKey } = sendContext;
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = encodePlainPayload(payload, mode);
  const event = {
    type: "group_msg",
    room: roomId.value,
    from: deviceId.value,
    protocol: 3,
    msg_id: msgId,
    epoch,
    sender_key_id: senderKeyId.value,
    nonce,
  };
  event.ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, canonicalMessageAAD(event), null, nonce, epochKey);
  event.signature = sodium.crypto_sign_detached(canonicalEventBytes(event), signingKeyPair.value.privateKey);
  return event;
}

async function encryptPrivateEvent(to, payload, msgId, mode) {
  const peer = peers.value.get(to);
  if (!peer) {
    throw new Error("Missing peer public key.");
  }
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  if (mode === "ws") {
    try {
      const { ciphertext } = await cryptoCall("privateEncrypt", {
        payload,
        nonce,
        peerPublicKey: peer.publicKey,
        privateKey: keyPair.value.privateKey,
      });
      const event = {
        type: "private_msg",
        room: roomId.value,
        from: deviceId.value,
        to,
        protocol: 3,
        msg_id: msgId,
        nonce,
        ciphertext,
        epoch: currentEpoch, sender_key_id: senderKeyId.value, recipient_key_id: peer.keyId,
        public_key: keyPair.value.publicKey,
      };
      event.signature = sodium.crypto_sign_detached(canonicalEventBytes(event), signingKeyPair.value.privateKey);
      return event;
    } catch {
      // Fall through to main-thread encrypt.
    }
  }
  const plaintext = encodePlainPayload(payload, mode);
  const ciphertext = sodium.crypto_box_easy(plaintext, nonce, peer.publicKey, keyPair.value.privateKey);
  const event = {
    type: "private_msg",
    room: roomId.value,
    from: deviceId.value,
    to,
    protocol: 3,
    msg_id: msgId,
    nonce,
    ciphertext,
    epoch: currentEpoch, sender_key_id: senderKeyId.value, recipient_key_id: peer.keyId,
    public_key: keyPair.value.publicKey,
  };
  event.signature = sodium.crypto_sign_detached(canonicalEventBytes(event), signingKeyPair.value.privateKey);
  return event;
}

function encodePlainPayload(payload, mode) {
  return mode === "ws" ? encode(payload) : sodium.from_string(JSON.stringify(payload));
}

function decodePlainPayload(plaintext, protocol = 3) {
  if (protocol === 3) {
    try { return decode(plaintext); } catch { return JSON.parse(sodium.to_string(plaintext)); }
  }
  throw new Error("Unsupported protocol");
}

async function decryptGroupPayload(event) {
  const nonce = decodeWireBytes(event.nonce);
  const ciphertext = decodeWireBytes(event.ciphertext);
  let key = epochKeys.get(Number(event.epoch));
  if (!key && pendingEpochKeys.has(Number(event.epoch))) {
    key = pendingEpochKeys.get(Number(event.epoch)).key;
    activateEpoch(Number(event.epoch), key);
  }
  if (!key) throw new Error("Unknown key epoch");
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, canonicalMessageAAD(event), nonce, key);
  return decodePlainPayload(plaintext, event.protocol);
}

async function decryptPrivatePayload(event, peer) {
  const nonce = decodeWireBytes(event.nonce);
  const ciphertext = decodeWireBytes(event.ciphertext);
  const recipientKeys = event.recipient_key_id === senderKeyId.value ? keyPair.value : boxKeyHistory.get(event.recipient_key_id);
  if (!recipientKeys) throw new Error("Unknown recipient key");
  const senderPublicKey = event.public_key ? asBytes(event.public_key) : peer.publicKey;
  if (event.protocol === 3) {
    try {
      return await cryptoCall("privateDecrypt", {
        nonce,
        ciphertext,
        peerPublicKey: senderPublicKey,
        privateKey: recipientKeys.privateKey,
      });
    } catch {
      // Fall through to main-thread decrypt.
    }
  }
  const plaintext = sodium.crypto_box_open_easy(ciphertext, nonce, senderPublicKey, recipientKeys.privateKey);
  return decodePlainPayload(plaintext, event.protocol);
}

async function sendEncryptedEvent(event, { msgId, privateTo, hasFile, transport: activeTransport, mode }) {
  registerPendingMessage(msgId, { privateTo, hasFile });
  if (mode === "sse") {
    await sendEvent(event, activeTransport);
    handleMessageServerAck(msgId);
    return;
  }
  if (mode === "ws" && hasFile) {
    await sendChunkedEvent(event, { msgId, privateTo, transport: activeTransport });
  } else {
    const ack = waitForServerAck(msgId, textAckTimeoutMs);
    await sendEvent(event, activeTransport);
    await ack;
    handleMessageServerAck(msgId);
  }
}

async function sendChunkedEvent(event, { msgId, transport: activeTransport }) {
  const ciphertext = asBytes(event.ciphertext);
  const total = Math.max(1, Math.ceil(ciphertext.length / chunkSize));
  for (let seq = 0; seq < total; seq += 1) {
    await waitForSocketDrain(activeTransport);
    const chunkMsgId = `${msgId}:${seq}`;
    const chunk = ciphertext.slice(seq * chunkSize, Math.min(ciphertext.length, (seq + 1) * chunkSize));
    const ack = waitForServerAck(chunkMsgId, chunkAckTimeoutMs, msgId);
    await sendSignedEvent({
      type: "chunk",
      room: event.room,
      from: event.from,
      to: event.to || "",
      protocol: 3,
      msg_id: chunkMsgId,
      transfer_id: msgId,
      message_type: event.type,
      seq,
      total,
      nonce: event.nonce,
      ciphertext: chunk,
      epoch: event.epoch,
      sender_key_id: event.sender_key_id,
      recipient_key_id: event.recipient_key_id || "",
    }, activeTransport);
    await ack;
  }
  handleMessageServerAck(msgId);
}

async function waitForSocketDrain(activeTransport) {
  while (activeTransport?.mode === "ws" && activeTransport.bufferedAmount?.() > chunkSize * 2) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sendEvent(event, activeTransport = transport.value) {
  if (!activeTransport) throw new Error("Not connected");
  await activeTransport.send(event);
}

async function receiveGroupMessage(event) {
  const msgId = event.msg_id || event.msgId;
  if (event.from === deviceId.value) {
    if (msgId) handleMessageServerAck(msgId);
    return;
  }
  const payload = await decryptGroupPayload(event);
  addMessage({ msgId, from: event.from, kind: payload.kind, text: payload.text || "", file: normalizeReceivedFile(payload.file), mine: false, status: "delivered" });
  notifyIncomingMessage();
  wakeWSRecovery();
}

async function receivePrivateMessage(event) {
  const msgId = event.msg_id || event.msgId;
  if (event.from === deviceId.value) return;
  if (event.to !== deviceId.value) return;
  const peer = peers.value.get(event.from);
  if (!peer) {
    addSystemMessage(`Received a private message from ${shortId(event.from)}, but the peer public key is missing.`);
    return;
  }
  const payload = await decryptPrivatePayload(event, peer);
  addMessage({ msgId, from: event.from, kind: payload.kind, text: payload.text || "", file: normalizeReceivedFile(payload.file), privateTo: deviceId.value, mine: false, status: "delivered" });
  sendRecipientAck(msgId, event.from).catch(showError);
  notifyIncomingMessage();
  wakeWSRecovery();
}

async function postEvent(payload) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId.value)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Connection-Token": connectionToken,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Send failed: HTTP ${response.status}`);
}

async function purgeOwnMessages() {
  if (!transport.value || roomActionBusy.value) return;
  roomActionBusy.value = true;
  try {
    await sendSignedEvent({
      type: "purge_self",
      room: roomId.value,
      from: deviceId.value,
      protocol: 3,
    });
  } catch (err) {
    showError(err);
  } finally {
    roomActionBusy.value = false;
  }
}

async function leaveRoom() {
  if (!transport.value || roomActionBusy.value) return;
  roomActionBusy.value = true;
  try {
    await sendSignedEvent({
      type: "leave_room",
      room: roomId.value,
      from: deviceId.value,
      protocol: 3,
    });
    purgeMessagesFrom(deviceId.value);
    await new Promise((resolve) => setTimeout(resolve, transportMode.value === "ws" ? 150 : 0));
    sessionEpoch += 1;
    cancelWSRecovery();
    transport.value?.close();
    location.href = "/";
  } catch (err) {
    roomActionBusy.value = false;
    showError(err);
  }
}

function purgeMessagesFrom(senderId) {
  if (!senderId) return;
  const removed = messages.value.filter((message) => !message.system && message.from === senderId);
  for (const message of removed) revokeMessageFileUrl(message);
  messages.value = messages.value.filter((message) => message.system || message.from !== senderId);
  for (const [transferId, transfer] of incomingTransfers.entries()) {
    if (transfer?.event?.from === senderId) incomingTransfers.delete(transferId);
  }
}

function revokeMessageFileUrl(message) {
  if (!message?.file) return;
  const url = fileUrlCache.get(message.file);
  if (!url) return;
  if (imagePreviewUrl.value === url) closeImagePreview();
  URL.revokeObjectURL(url);
  createdFileUrls.delete(url);
  fileUrlCache.delete(message.file);
}

function registerPendingMessage(msgId, { privateTo, hasFile }) {
  clearPendingMessage(msgId);
  pendingMessages.set(msgId, {
    privateTo,
    hasFile,
    serverAcked: false,
    recipientAcked: false,
    timer: setTimeout(() => {
      markMessageFailed(msgId, privateTo ? "Peer did not acknowledge" : "Server did not acknowledge");
    }, textAckTimeoutMs),
  });
}

function waitForServerAck(ackId, timeoutMs, parentMsgId = ackId) {
  clearPendingServerAck(ackId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingServerAcks.delete(ackId);
      markMessageFailed(parentMsgId, parentMsgId === ackId ? "Server did not acknowledge" : "File chunk timed out");
      reject(new Error(parentMsgId === ackId ? "Server did not acknowledge" : "File chunk timed out"));
    }, timeoutMs);
    pendingServerAcks.set(ackId, { resolve, reject, timer });
  });
}

function handleServerAck(ackId) {
  if (!ackId) return;
  const pendingAck = pendingServerAcks.get(ackId);
  if (pendingAck) {
    clearTimeout(pendingAck.timer);
    pendingServerAcks.delete(ackId);
    pendingAck.resolve();
  }
  if (!ackId.includes(":")) handleMessageServerAck(ackId);
}

function handleMessageServerAck(msgId) {
  const pending = pendingMessages.get(msgId);
  if (!pending || pending.serverAcked) return;
  pending.serverAcked = true;
  clearTimeout(pending.timer);
  if (pending.privateTo) {
    updateMessageStatus(msgId, "server_acked");
    pending.timer = setTimeout(() => {
      markMessageFailed(msgId, "Peer did not acknowledge");
    }, textAckTimeoutMs);
  } else {
    clearPendingMessage(msgId);
    updateMessageStatus(msgId, "sent");
  }
}

function handleRecipientAck(event) {
  const ackId = event.ack_id || event.ackId;
  const pending = pendingMessages.get(ackId);
  if (!pending) return;
  pending.recipientAcked = true;
  clearPendingMessage(ackId);
  updateMessageStatus(ackId, "delivered");
}

async function sendRecipientAck(msgId, to) {
  if (!msgId) return;
  await sendSignedEvent({
    type: "recipient_ack",
    room: roomId.value,
    from: deviceId.value,
    to,
    protocol: 3,
    ack_id: msgId,
  });
}

function clearPendingMessage(msgId) {
  const pending = pendingMessages.get(msgId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingMessages.delete(msgId);
}

function clearPendingServerAck(ackId) {
  const pending = pendingServerAcks.get(ackId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingServerAcks.delete(ackId);
}

function clearPendingTimers() {
  for (const msgId of pendingMessages.keys()) clearPendingMessage(msgId);
  for (const ackId of pendingServerAcks.keys()) clearPendingServerAck(ackId);
}

function markMessageFailed(msgId, reason) {
  clearPendingMessage(msgId);
  updateMessageStatus(msgId, "failed", reason);
}

function updateMessageStatus(msgId, status, failureReason = "") {
  const index = messages.value.findIndex((message) => message.msgId === msgId || message.id === msgId);
  if (index < 0) return;
  messages.value[index] = { ...messages.value[index], status, failureReason };
}

async function receiveChunk(event) {
  if (event.from === deviceId.value) return;
  if (event.to && event.to !== deviceId.value) return;
  const transferId = event.transfer_id;
  if (!transferId) return;
  const total = Number(event.total || 0);
  const seq = Number(event.seq || 0);
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= total) return;

  let transfer = incomingTransfers.get(transferId);
  if (!transfer) {
    transfer = {
      event,
      chunks: new Array(total),
      received: 0,
      expires: setTimeout(() => incomingTransfers.delete(transferId), chunkAckTimeoutMs * 2),
    };
    incomingTransfers.set(transferId, transfer);
  }
  if (!transfer.chunks[seq]) {
    transfer.chunks[seq] = asBytes(event.ciphertext);
    transfer.received += 1;
  }
  if (transfer.received !== transfer.chunks.length) return;

  clearTimeout(transfer.expires);
  incomingTransfers.delete(transferId);
  const ciphertext = concatBytes(transfer.chunks);
  const complete = {
    ...transfer.event,
    type: transfer.event.message_type,
    msg_id: transferId,
    ciphertext,
  };
  if (complete.type === "group_msg") await receiveGroupMessage(complete);
  if (complete.type === "private_msg") await receivePrivateMessage(complete);
}

function decodeWireBytes(value) {
  return typeof value === "string" ? sodium.from_base64(value, sodium.base64_variants.ORIGINAL) : asBytes(value);
}

function rotationRoster() {
  return [deviceId.value, ...peers.value.keys()].filter(Boolean).sort();
}

async function offerCurrentEpochToPeer(id) {
  if (currentEpoch === 0 || rotationRoster()[0] !== deviceId.value) return;
  const peer = peers.value.get(id);
  const key = epochKeys.get(currentEpoch);
  if (!peer?.publicKey || !key) return;
  const rotationId = `join_${base64Url(sodium.randombytes_buf(12))}`;
  await sendSignedEvent({ type: "join_key_offer", room: roomId.value, from: deviceId.value, to: id, rotation_id: rotationId, epoch: currentEpoch - 1, next_epoch: currentEpoch, roster_hash: rosterDigest(), recipient_key_id: peer.keyId, sealed_key: sodium.crypto_box_seal(key, peer.publicKey) });
}

function rosterDigest(roster = rotationRoster()) {
  return sodium.crypto_generichash(32, sodium.from_string(roster.join("\n")));
}

async function maybeStartKeyRotation() {
  if (!transport.value || activeRotation || pendingEpochKeys.size || currentEpoch > 0 && epochKeys.size > 1) return;
  if (Date.now() - epochStartedAt < 15 * 60 * 1000 && epochMessageCount < 100) return;
  const roster = rotationRoster();
  if (roster[0] !== deviceId.value) return;
  const rotationId = `rot_${base64Url(sodium.randombytes_buf(12))}`;
  const nextEpoch = currentEpoch + 1;
  const key = sodium.randombytes_buf(32);
  const hash = rosterDigest(roster);
  activeRotation = { id: rotationId, nextEpoch, key, hash, roster, ready: new Set([deviceId.value]), timeout: null };
  await sendSignedEvent({ type: "key_prepare", room: roomId.value, from: deviceId.value, rotation_id: rotationId, epoch: currentEpoch, next_epoch: nextEpoch, roster_hash: hash });
  for (const id of roster.slice(1)) {
    const peer = peers.value.get(id);
    if (!peer?.publicKey) continue;
    await sendSignedEvent({ type: "key_offer", room: roomId.value, from: deviceId.value, to: id, rotation_id: rotationId, epoch: currentEpoch, next_epoch: nextEpoch, roster_hash: hash, recipient_key_id: peer.keyId, sealed_key: sodium.crypto_box_seal(key, peer.publicKey) });
  }
  activeRotation.timeout = setTimeout(() => abortRotation(rotationId), 30000);
  if (roster.length === 1) await commitRotation();
}

async function handleKeyEvent(event) {
  if (event.type === "key_prepare") {
    if (Number(event.epoch) !== currentEpoch || !sodium.memcmp(asBytes(event.roster_hash), rosterDigest())) return;
    activeRotation = { id: event.rotation_id, nextEpoch: Number(event.next_epoch), hash: asBytes(event.roster_hash), roster: rotationRoster(), ready: new Set(), coordinator: event.from };
    return;
  }
  if (event.type === "key_offer" || event.type === "join_key_offer") {
    if (event.to !== deviceId.value || event.recipient_key_id !== senderKeyId.value) return;
    const key = sodium.crypto_box_seal_open(asBytes(event.sealed_key), keyPair.value.publicKey, keyPair.value.privateKey);
    pendingEpochKeys.set(Number(event.next_epoch), { key, rotationId: event.rotation_id, receivedAt: Date.now() });
    await sendSignedEvent({ type: event.type === "key_offer" ? "key_ready" : "join_key_ready", room: roomId.value, from: deviceId.value, to: event.from, rotation_id: event.rotation_id, epoch: currentEpoch, next_epoch: Number(event.next_epoch), roster_hash: asBytes(event.roster_hash) });
    return;
  }
  if (event.type === "key_ready" && activeRotation?.id === event.rotation_id && event.to === deviceId.value) {
    activeRotation.ready.add(event.from);
    if (activeRotation.roster.every((id) => activeRotation.ready.has(id))) await commitRotation();
    return;
  }
  if (event.type === "key_commit") {
    const pending = pendingEpochKeys.get(Number(event.next_epoch));
    if (pending?.rotationId === event.rotation_id) activateEpoch(Number(event.next_epoch), pending.key);
    activeRotation = null;
    return;
  }
  if (event.type === "key_abort") {
    for (const [epoch, pending] of pendingEpochKeys) if (pending.rotationId === event.rotation_id) pendingEpochKeys.delete(epoch);
    if (activeRotation?.id === event.rotation_id) activeRotation = null;
  }
  if (event.type === "device_key_update") rememberPeer(event.from, event.public_key, event.display_name, event.sign_public_key, event.sender_key_id);
}

async function commitRotation() {
  const rotation = activeRotation;
  if (!rotation) return;
  clearTimeout(rotation.timeout);
  await sendSignedEvent({ type: "key_commit", room: roomId.value, from: deviceId.value, rotation_id: rotation.id, epoch: currentEpoch, next_epoch: rotation.nextEpoch, roster_hash: rotation.hash });
  activateEpoch(rotation.nextEpoch, rotation.key);
  activeRotation = null;
}

async function abortRotation(rotationId) {
  if (activeRotation?.id !== rotationId) return;
  await sendSignedEvent({ type: "key_abort", room: roomId.value, from: deviceId.value, rotation_id: rotationId, epoch: currentEpoch, next_epoch: activeRotation.nextEpoch, roster_hash: activeRotation.hash }).catch(() => {});
  activeRotation = null;
}

function activateEpoch(epoch, key) {
  if (epoch <= currentEpoch) return;
  epochKeys.set(epoch, key);
  pendingEpochKeys.delete(epoch);
  currentEpoch = epoch;
  roomKey.value = key;
  epochStartedAt = Date.now();
  epochMessageCount = 0;
  const previousKeyId = senderKeyId.value;
  boxKeyHistory.set(previousKeyId, keyPair.value);
  keyPair.value = sodium.crypto_box_keypair();
  senderKeyId.value = base64Url(sodium.crypto_generichash(12, keyPair.value.publicKey));
  sendSignedEvent({ type: "device_key_update", room: roomId.value, from: deviceId.value, public_key: keyPair.value.publicKey, sign_public_key: signingKeyPair.value.publicKey, sender_key_id: senderKeyId.value }).catch(showError);
  setTimeout(() => {
    for (const oldEpoch of [...epochKeys.keys()].sort((a, b) => a - b)) {
      if (oldEpoch < currentEpoch && epochKeys.size > 1 && activeSendOperations === 0 && incomingTransfers.size === 0) epochKeys.delete(oldEpoch);
    }
    if (activeSendOperations === 0 && incomingTransfers.size === 0) boxKeyHistory.delete(previousKeyId);
  }, 120000);
}

function normalizeWireEvent(event) {
  const normalized = { ...event, protocol: Number(event.protocol || 0) };
  for (const field of binaryEventFields) {
    if (normalized[field] != null && normalized[field] !== "") normalized[field] = decodeWireBytes(normalized[field]);
  }
  return normalized;
}

function toWireEvent(event, mode) {
  const wire = { ...event, protocol: 3 };
  for (const field of binaryEventFields) {
    if (wire[field] == null) continue;
    const bytes = asBytes(wire[field]);
    wire[field] = mode === "sse" ? b64(bytes) : bytes;
  }
  return wire;
}

function canonicalEventBytes(event) {
  const bytes = (name) => event[name] ? asBytes(event[name]) : new Uint8Array();
  return encode([
    3, event.type || "", event.room || "", event.from || "", event.to || "",
    event.msg_id || "", event.ack_id || "", event.transfer_id || "",
    Number(event.seq || 0), Number(event.total || 0), Number(event.epoch || 0), Number(event.next_epoch || 0),
    event.sender_key_id || "", event.recipient_key_id || "", event.rotation_id || "",
    bytes("nonce"), bytes("ciphertext"), bytes("roster_hash"), bytes("sealed_key"),
    bytes("public_key"), bytes("sign_public_key"), event.display_name || "",
    bytes("hello_mac"),
  ]);
}

function canonicalMessageAAD(event) {
  return encode([3, event.type || "", event.room || "", event.from || "", event.to || "", event.msg_id || "", Number(event.epoch || 0), event.sender_key_id || "", event.recipient_key_id || "", event.nonce ? asBytes(event.nonce) : new Uint8Array()]);
}

function requiresPeerSignature(type) {
  return ["group_msg", "private_msg", "recipient_ack", "chunk", "purge_self", "leave_room", "key_prepare", "key_offer", "key_ready", "key_commit", "key_abort", "join_key_offer", "join_key_ready", "device_key_update"].includes(type);
}

function verifyHelloEvent(event) {
  if (event.protocol !== 3 || event.from === deviceId.value) return true;
  try {
    const unsigned = { ...event, signature: undefined, hello_mac: undefined };
    if (!sodium.crypto_auth_verify(asBytes(event.hello_mac), canonicalEventBytes(unsigned), authKey.value)) return false;
    const signed = { ...event, signature: undefined };
    return sodium.crypto_sign_verify_detached(asBytes(event.signature), canonicalEventBytes(signed), asBytes(event.sign_public_key));
  } catch { return false; }
}

function verifyPeerEvent(event) {
  if (event.from === deviceId.value) return true;
  const peer = peers.value.get(event.from);
  if (!peer?.signPublicKey || !event.signature) return false;
  const replayId = `${event.from}:${event.type}:${event.msg_id || event.rotation_id || event.ack_id || ""}:${event.seq || 0}`;
  if (seenAuthenticatedEvents.has(replayId)) return false;
  const ok = sodium.crypto_sign_verify_detached(asBytes(event.signature), canonicalEventBytes({ ...event, signature: undefined }), peer.signPublicKey);
  if (ok) {
    seenAuthenticatedEvents.add(replayId);
    if (seenAuthenticatedEvents.size > 5000) seenAuthenticatedEvents.delete(seenAuthenticatedEvents.values().next().value);
  }
  return ok;
}

async function sendSignedEvent(event, activeTransport = transport.value) {
  const complete = { ...event, protocol: 3, epoch: event.epoch ?? currentEpoch, sender_key_id: event.sender_key_id || senderKeyId.value };
  if (complete.type === "peer_hello") {
    complete.hello_mac = sodium.crypto_auth(canonicalEventBytes(complete), authKey.value);
  }
  complete.signature = sodium.crypto_sign_detached(canonicalEventBytes(complete), signingKeyPair.value.privateKey);
  await sendEvent(complete, activeTransport);
  return complete;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return new Uint8Array(value || []);
}

function concatBytes(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function normalizeReceivedFile(file) {
  if (!file) return null;
  return { ...file, data: typeof file.data === "string" ? file.data : asBytes(file.data) };
}

function cryptoCall(op, data) {
  const worker = getCryptoWorker();
  const id = `crypto_${cryptoJobSeq += 1}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cryptoJobs.delete(id);
      reject(new Error("Crypto worker timed out"));
    }, 30000);
    cryptoJobs.set(id, { resolve, reject, timer });
    worker.postMessage({ id, op, data });
  });
}

function getCryptoWorker() {
  if (cryptoWorker) return cryptoWorker;
  cryptoWorker = new Worker(new URL("./crypto-worker.js", import.meta.url), { type: "module" });
  cryptoWorker.addEventListener("message", (event) => {
    const { id, ok, result, error } = event.data || {};
    const job = cryptoJobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    cryptoJobs.delete(id);
    if (ok) {
      job.resolve(result);
    } else {
      job.reject(new Error(error || "Crypto worker failed"));
    }
  });
  cryptoWorker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Crypto worker failed");
    for (const [id, job] of cryptoJobs.entries()) {
      clearTimeout(job.timer);
      job.reject(error);
      cryptoJobs.delete(id);
    }
    cryptoWorker?.terminate();
    cryptoWorker = null;
  });
  return cryptoWorker;
}

function selectPeer(id) {
  if (!id) {
    offlinePrivatePeers.value = new Map();
  }
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
  sendSignedEvent({
    type: "hello",
    room: roomId.value,
    from: deviceId.value,
    protocol: 3,
    public_key: transportMode.value === "ws" ? keyPair.value.publicKey : b64(keyPair.value.publicKey),
    display_name: displayName.value,
  }).catch(showError);
}

function displayNameFor(id) {
  if (id === deviceId.value) return displayName.value || shortId(id);
  return peers.value.get(id)?.name || offlinePrivatePeers.value.get(id)?.name || shortId(id);
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
  codeMode.value = false;
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

function isMessageBusy(message) {
  return message.mine && (message.status === "pending" || message.status === "server_acked");
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

async function copyCodeBlock(text) {
  await navigator.clipboard.writeText(text || "");
  addSystemMessage("已复制代码块");
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
  try {
    notificationSeq += 1;
    new Notification("您收到一条信息", {
      tag: `e2ee-chat-${roomId.value}-${Date.now()}-${notificationSeq}`,
      body: "",
    });
  } catch {
    notificationsEnabled.value = false;
    localStorage.removeItem("e2ee-chat-notifications");
  }
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

function fromB64(text) {
  return sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
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

function fileObjectUrl(file) {
  if (!file || typeof file !== "object") return "";
  const cached = fileUrlCache.get(file);
  if (cached) return cached;
  const blob = new Blob([fileBytes(file)], { type: file.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  fileUrlCache.set(file, url);
  createdFileUrls.add(url);
  return url;
}

function openImagePreview(file) {
  if (!isImageFile(file)) return;
  resetImagePreviewTransform();
  imagePreviewUrl.value = fileObjectUrl(file);
  imagePreviewName.value = file.name || "图片";
  imagePreviewVisible.value = true;
}

function closeImagePreview() {
  imagePreviewVisible.value = false;
}

function finalizeImagePreviewClose() {
  resetImagePreviewTransform();
  imagePreviewUrl.value = "";
  imagePreviewName.value = "";
}

function resetImagePreviewTransform() {
  imagePreviewScale.value = 1;
  imagePreviewOffsetX.value = 0;
  imagePreviewOffsetY.value = 0;
  imagePreviewDragging.value = false;
  imagePreviewPan = null;
}

function zoomImagePreview(delta, originX = 0, originY = 0) {
  const oldScale = imagePreviewScale.value;
  const nextScale = Math.min(5, Math.max(0.5, Math.round((oldScale + delta) * 100) / 100));
  if (nextScale === oldScale) return;
  const ratio = nextScale / oldScale;
  imagePreviewOffsetX.value = originX - (originX - imagePreviewOffsetX.value) * ratio;
  imagePreviewOffsetY.value = originY - (originY - imagePreviewOffsetY.value) * ratio;
  imagePreviewScale.value = nextScale;
  if (nextScale <= 1) {
    imagePreviewOffsetX.value = 0;
    imagePreviewOffsetY.value = 0;
  }
}

function onImagePreviewWheel(event) {
  const stage = imagePreviewStageRef.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const originX = event.clientX - rect.left - rect.width / 2;
  const originY = event.clientY - rect.top - rect.height / 2;
  zoomImagePreview(event.deltaY < 0 ? 0.25 : -0.25, originX, originY);
}

function startImagePreviewPan(event) {
  if (imagePreviewScale.value <= 1 || event.button !== 0) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  imagePreviewDragging.value = true;
  imagePreviewPan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: imagePreviewOffsetX.value,
    offsetY: imagePreviewOffsetY.value,
  };
}

function moveImagePreviewPan(event) {
  if (!imagePreviewPan || imagePreviewPan.pointerId !== event.pointerId) return;
  imagePreviewOffsetX.value = imagePreviewPan.offsetX + event.clientX - imagePreviewPan.startX;
  imagePreviewOffsetY.value = imagePreviewPan.offsetY + event.clientY - imagePreviewPan.startY;
}

function endImagePreviewPan(event) {
  if (!imagePreviewPan || imagePreviewPan.pointerId !== event.pointerId) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  imagePreviewDragging.value = false;
  imagePreviewPan = null;
}

function fileBytes(file) {
  if (typeof file.data === "string") {
    return sodium.from_base64(file.data, sodium.base64_variants.ORIGINAL);
  }
  return asBytes(file.data);
}

function revokeFileObjectUrls() {
  for (const url of createdFileUrls) URL.revokeObjectURL(url);
  createdFileUrls.clear();
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
  height: 100dvh;
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

.room-limit-control {
  display: grid;
  grid-template-columns: auto 120px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
}

.room-limit-control small {
  color: var(--muted);
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
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}

.room-header {
  flex: 0 0 auto;
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
  flex: 0 0 auto;
  margin: 8px 18px 0;
}

.name-modal {
  max-width: min(420px, calc(100vw - 32px));
}

.meta {
  flex: 0 0 auto;
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
  overflow: hidden;
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
  overflow: hidden;
}

.messages {
  min-height: 0;
  overflow: hidden;
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

.message-bubble .text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code-block {
  display: grid;
  gap: 6px;
}

.code-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.code-block pre {
  max-width: min(560px, calc(100vw - 116px));
  max-height: 360px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-strong);
  color: var(--text);
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre;
}

.code-block code {
  font: inherit;
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
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--user-color, var(--muted));
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}

.message-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #d92d20;
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
}

.message-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, var(--user-color, var(--muted)) 24%, transparent);
  border-top-color: var(--user-color, var(--muted));
  border-radius: 50%;
  animation: message-spin 0.8s linear infinite;
}

@keyframes message-spin {
  to {
    transform: rotate(360deg);
  }
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
  cursor: zoom-in;
}

.attachment-image:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.image-preview-modal {
  width: min(1100px, calc(100vw - 32px));
}

.image-preview-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 20px 60px rgb(0 0 0 / 35%);
}

.image-preview-stage {
  display: grid;
  place-items: center;
  min-height: 240px;
  height: calc(100vh - 150px);
  max-height: 760px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--surface-strong);
  touch-action: none;
  user-select: none;
}

.image-preview-stage.pannable {
  cursor: grab;
}

.image-preview-stage.dragging {
  cursor: grabbing;
}

.image-preview-stage > img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center;
  transition: transform 120ms ease-out;
  pointer-events: none;
}

.image-preview-stage.dragging > img {
  transition: none;
}

.image-preview-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.image-preview-actions strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-preview-zoom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.image-preview-zoom span {
  width: 48px;
  color: var(--muted);
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
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
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.composer-input-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
  min-width: 0;
}

.composer-input-row > .n-input {
  min-width: 0;
  flex: 1;
}

.composer-send {
  flex: 0 0 auto;
  min-width: 126px;
}

.composer-tools {
  order: -1;
  display: flex;
  align-items: center;
  gap: 10px;
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
  /* iOS Safari zooms the viewport when a focused form control renders below 16px. */
  :deep(.n-input__input-el),
  :deep(.n-input__textarea-el),
  :deep(input:not([type="checkbox"]):not([type="radio"])),
  :deep(textarea),
  :deep(select) {
    font-size: 16px !important;
  }

  .content {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    margin: 0;
  }

  .chat {
    border: 0;
    border-radius: 0;
  }

  .chat-grid {
    grid-template-columns: 1fr;
    min-height: 0;
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

  .conversation {
    min-height: 0;
    overflow: hidden;
  }

  .composer {
    gap: 8px;
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom, 0px));
  }

  .composer-input-row {
    order: -1;
    gap: 8px;
  }

  .composer-send {
    min-width: 94px;
  }

  .composer-tools {
    order: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .composer-tools > .n-button,
  .composer-tools > .n-popover {
    width: 100%;
  }

  .image-preview-modal {
    width: calc(100vw - 16px);
  }

  .image-preview-card {
    padding: 8px;
  }

  .image-preview-stage {
    height: calc(100vh - 190px);
  }

  .image-preview-actions {
    flex-wrap: wrap;
    gap: 8px;
  }

  .image-preview-actions strong {
    flex-basis: 100%;
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

  .room-limit-control {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .room-limit-control small {
    grid-column: 1 / -1;
  }

  .home {
    min-height: 100vh;
    min-height: 100dvh;
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
