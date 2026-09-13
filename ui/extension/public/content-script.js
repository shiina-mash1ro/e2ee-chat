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
  frame.title = "显示客服";
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
  let pointerInside = !matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;
  let focused = document.hasFocus();
  let suspended = false;
  const pageHasFocus = () => visible && pointerInside && focused && !suspended && document.visibilityState === "visible" && document.hasFocus();
  const publishPageFocus = () => frame.contentWindow?.postMessage({
    source: "e2ee-chat-host",
    type: "page-focus",
    value: pageHasFocus(),
  }, "*");
  const privacyListeners = [];
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    privacyListeners.push(() => target.removeEventListener(type, fn));
  };
  const enter = (event) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "touch") return;
    if (pointerInside) return;
    pointerInside = true;
    publishPageFocus();
  };
  listen(document.documentElement, "pointerenter", enter);
  listen(document, "pointermove", enter);
  listen(document, "pointerdown", enter);
  listen(document.documentElement, "pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    pointerInside = false;
    publishPageFocus();
  });
  listen(window, "focus", () => { focused = document.hasFocus(); publishPageFocus(); });
  listen(window, "blur", () => {
    // Focusing our iframe is not leaving the host browser window.
    focused = document.hasFocus();
    publishPageFocus();
  });
  listen(document, "visibilitychange", () => { focused = document.hasFocus(); publishPageFocus(); });
  listen(window, "pagehide", () => { suspended = true; publishPageFocus(); });
  listen(window, "pageshow", () => { suspended = false; focused = document.hasFocus(); publishPageFocus(); });
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
    if (event.data.type === "request-page-focus") {
      focused = document.hasFocus();
      publishPageFocus();
    }
    if (event.data.type === "ready") {
      frame.contentWindow?.postMessage({ source: "e2ee-chat-host", type: "set-expanded", value: expanded }, "*");
      publishPageFocus();
    }
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
      privacyListeners.forEach((remove) => remove());
      host.remove();
      delete globalThis.__e2eeChatWidgetController;
    }
  });
  globalThis.__e2eeChatWidgetController = { toggleVisible() { visible = !visible; apply(); publishPageFocus(); } };
  apply();
})();
