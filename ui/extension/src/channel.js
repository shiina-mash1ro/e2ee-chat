export const CHANNEL_NAME = "e2ee-chat-global-v1";

export function createClientChannel(kind, onMessage) {
  const instanceId = crypto.randomUUID();
  const channel = new BroadcastChannel(CHANNEL_NAME);
  let seq = 0;
  const pending = new Map();
  channel.onmessage = (event) => {
    const message = event.data;
    if (!message || message.source !== "core") return;
    if (message.target && message.target !== instanceId) return;
    if (message.requestId && pending.has(message.requestId)) {
      const job = pending.get(message.requestId);
      pending.delete(message.requestId);
      message.ok ? job.resolve(message.result) : job.reject(new Error(message.error || "操作失败"));
    }
    onMessage?.(message);
  };
  const send = (type, payload = {}) => channel.postMessage({ source: "ui", instanceId, kind, type, ...payload });
  const heartbeat = setInterval(() => send("heartbeat"), 10000);
  send("hello");
  return {
    instanceId,
    send,
    request(action, payload = {}) {
      const requestId = `${instanceId}:${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("聊天核心响应超时"));
        }, 60000);
        pending.set(requestId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        send("action", { requestId, action, payload });
      });
    },
    close() {
      clearInterval(heartbeat);
      send("bye");
      channel.close();
      for (const job of pending.values()) job.reject(new Error("窗口已关闭"));
      pending.clear();
    },
  };
}

export async function ensureCore() {
  const response = await chrome.runtime.sendMessage({ type: "ensure-core" });
  if (!response?.ok) throw new Error(response?.error || "无法启动聊天核心");
}
