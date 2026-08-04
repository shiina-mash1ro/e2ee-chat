const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;
let lastWidgetTabId = null;
const PANIC_WINDOW_MS = 3000;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS", "BLOBS"],
      justification: "运行共享的临时聊天连接、加密 Worker 与文件对象。",
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function showWidget(expand = false) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("找不到当前页面");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
    lastWidgetTabId = tab.id;
    if (expand) await chrome.tabs.sendMessage(tab.id, { type: "widget-expand" }).catch(() => {});
    return { embedded: true };
  } catch {
    await chrome.windows.create({
      url: chrome.runtime.getURL("standalone.html"),
      type: "popup",
      width: 430,
      height: 720,
      focused: true,
    });
    return { embedded: false };
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "panic-action") return;
  const result = await triggerPanicAction();
  if (result.armed) {
    await chrome.notifications.create("e2ee-chat-panic-armed", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("chat.svg"),
      title: "绿色出口待确认",
      message: `请在 3 秒内再次按下快捷键以${result.action === "uninstall" ? "卸载扩展" : "清除临时数据"}`,
      priority: 2,
    });
  }
});

chrome.action.onClicked.addListener(async () => {
  await ensureOffscreen();
  await showWidget(false);
});

async function triggerPanicAction() {
  const now = Date.now();
  const { panicAction = "wipe" } = await chrome.storage.local.get("panicAction");
  const action = panicAction === "uninstall" ? "uninstall" : "wipe";
  const { panicConfirmation } = await chrome.storage.session.get("panicConfirmation");
  if (!panicConfirmation || panicConfirmation.action !== action || panicConfirmation.expiresAt < now) {
    await chrome.storage.session.set({ panicConfirmation: { action, expiresAt: now + PANIC_WINDOW_MS } });
    return { armed: true, action };
  }
  await chrome.storage.session.remove("panicConfirmation");
  await executePanicAction(action);
  return { armed: false, executed: true, action };
}

async function executePanicAction(action) {
  await chrome.notifications.clear("e2ee-chat-panic-armed").catch(() => {});
  await Promise.race([
    chrome.runtime.sendMessage({ type: "emergency-leave-core" }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 900)),
  ]);
  await removeWidgetSurfaces();
  await chrome.offscreen.closeDocument().catch(() => {});
  await Promise.allSettled([
    chrome.storage.local.clear(),
    chrome.storage.sync.clear(),
    chrome.storage.session.clear(),
    clearExtensionCaches(),
  ]);
  const { origins = [] } = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
  if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
  if (action === "uninstall") await chrome.management.uninstallSelf({ showConfirmDialog: false });
}

async function clearExtensionCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

async function removeWidgetSurfaces() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => tab.id == null ? null : chrome.tabs.sendMessage(tab.id, { type: "widget-remove" }).catch(() => null)));
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).catch(() => []);
  const standaloneTabs = contexts
    .filter((context) => context.tabId != null && context.documentUrl && /\/(standalone|widget)\.html$/.test(new URL(context.documentUrl).pathname))
    .map((context) => context.tabId);
  if (standaloneTabs.length) await chrome.tabs.remove([...new Set(standaloneTabs)]).catch(() => {});
  lastWidgetTabId = null;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { chatOrigin } = await chrome.storage.sync.get("chatOrigin");
  if (!chatOrigin) chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "ensure-core":
        await ensureOffscreen();
        return { ok: true };
      case "show-widget":
        await ensureOffscreen();
        return { ok: true, ...(await showWidget(Boolean(message.expand))) };
      case "open-launcher":
        await chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), type: "popup", width: 420, height: 650, focused: true });
        return { ok: true };
      case "widget-active":
        if (sender.tab?.id) lastWidgetTabId = sender.tab.id;
        return { ok: true };
      case "open-options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "trigger-panic":
        return { ok: true, ...(await triggerPanicAction()) };
      case "storage-get": {
        const area = ["local", "sync", "session"].includes(message.area) ? message.area : "local";
        return { ok: true, value: await chrome.storage[area].get(message.keys) };
      }
      case "storage-set": {
        const area = ["local", "sync", "session"].includes(message.area) ? message.area : "local";
        await chrome.storage[area].set(message.value || {});
        return { ok: true };
      }
      case "storage-remove": {
        const area = ["local", "sync", "session"].includes(message.area) ? message.area : "local";
        await chrome.storage[area].remove(message.keys);
        return { ok: true };
      }
      case "close-offscreen":
        await chrome.offscreen.closeDocument().catch(() => {});
        return { ok: true };
      case "notify": {
        const id = `e2ee-chat-${Date.now()}-${crypto.randomUUID()}`;
        await chrome.notifications.create(id, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("chat.svg"),
          title: "您收到一条信息",
          message: message.message || "新消息",
          priority: 2,
        });
        return { ok: true, id };
      }
      default:
        return { ok: false };
    }
  };
  run().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.notifications.onClicked.addListener(async () => {
  if (lastWidgetTabId != null) {
    const tab = await chrome.tabs.get(lastWidgetTabId).catch(() => null);
    if (tab?.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.sendMessage(tab.id, { type: "widget-expand" }).catch(() => {});
      return;
    }
  }
  await chrome.windows.create({ url: chrome.runtime.getURL("standalone.html"), type: "popup", width: 430, height: 720 });
});
