(() => {
  if (globalThis.__e2eeChatWidgetController) {
    globalThis.__e2eeChatWidgetController.toggleVisible();
    return;
  }

  const host = document.createElement("div");
  host.id = `e2ee-chat-widget-${crypto.randomUUID()}`;
  const shadow = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("widget.html");
  frame.title = "E2EE Chat";
  frame.allow = "clipboard-read; clipboard-write";
  frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";

  const root = document.createElement("div");
  root.style.cssText = [
    "all:initial", "position:fixed", "z-index:2147483647", "right:18px", "bottom:18px",
    "width:56px", "height:56px", "max-width:calc(100vw - 24px)", "max-height:calc(100vh - 24px)",
    "filter:drop-shadow(0 12px 28px rgba(0,0,0,.28))",
  ].join(";");
  root.append(frame);
  shadow.append(root);
  (document.documentElement || document.body).append(host);

  let visible = true;
  let expanded = false;
  let size = { width: 390, height: 640 };
  chrome.storage.local.get("widgetSize").then(({ widgetSize }) => {
    if (widgetSize?.width && widgetSize?.height) size = widgetSize;
  });
  const apply = () => {
    host.style.display = visible ? "block" : "none";
    root.style.width = expanded ? `${Math.min(size.width, innerWidth - 24)}px` : "56px";
    root.style.height = expanded ? `${Math.min(size.height, innerHeight - 24)}px` : "56px";
  };
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.data?.source !== "e2ee-chat-widget") return;
    if (event.data.type === "expanded") {
      expanded = Boolean(event.data.value);
      apply();
    }
    if (event.data.type === "resize") {
      size = {
        width: Math.max(320, Math.min(Number(event.data.width) || 390, innerWidth - 24)),
        height: Math.max(420, Math.min(Number(event.data.height) || 640, innerHeight - 24)),
      };
      expanded = true;
      chrome.storage.local.set({ widgetSize: size });
      apply();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "widget-expand") {
      visible = true;
      expanded = true;
      apply();
      frame.contentWindow?.postMessage({ source: "e2ee-chat-host", type: "set-expanded", value: true }, "*");
    }
    if (message?.type === "widget-remove") {
      host.remove();
      delete globalThis.__e2eeChatWidgetController;
    }
  });
  globalThis.__e2eeChatWidgetController = { toggleVisible() { visible = !visible; apply(); } };
  apply();
})();
