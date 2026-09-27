// Mouse presence is independent of focus: entering an inactive window must
// never reveal messages. Touch has no persistent hover position.
export function observeMessageVisibility(win, doc, onChange) {
  let inside = !win.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;
  let focused = doc.hasFocus();
  let suspended = false;
  let composing = false;
  let previous;
  const listeners = [];
  const update = (reason = "initial") => {
    const visible = inside && focused && doc.hasFocus() && !suspended && doc.visibilityState === "visible";
    if (visible !== previous || (!visible && reason !== "initial")) { previous = visible; onChange(visible, reason); }
  };
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const enter = (event) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "touch") return;
    inside = true;
    update("pointerenter");
  };
  listen(doc.documentElement, "pointerenter", enter);
  listen(doc, "pointermove", enter);
  listen(doc, "pointerdown", enter);
  listen(doc, "compositionstart", () => { composing = true; });
  listen(doc, "compositionend", () => { composing = false; });
  listen(doc.documentElement, "pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    // Native IME candidate windows can cover the pointer without moving it
    // outside the viewport. Never exempt an actual blur or boundary crossing.
    const active = doc.activeElement;
    const editable = active?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active?.tagName || "");
    if (composing && editable && focused && doc.hasFocus() && !suspended && doc.visibilityState === "visible"
      && event.clientX > 0 && event.clientY > 0 && event.clientX < win.innerWidth - 1 && event.clientY < win.innerHeight - 1) return;
    inside = false;
    update("pointerleave");
  });
  listen(win, "blur", () => { composing = false; focused = false; update("blur"); });
  listen(win, "focus", () => { focused = doc.hasFocus(); update("focus"); });
  listen(doc, "visibilitychange", () => { focused = doc.hasFocus(); update("visibilitychange"); });
  listen(win, "pagehide", () => { suspended = true; update("pagehide"); });
  listen(win, "pageshow", () => { suspended = false; focused = doc.hasFocus(); update(); });
  update();
  return () => listeners.forEach((remove) => remove());
}
