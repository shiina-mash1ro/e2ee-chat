// Mouse presence is independent of focus: entering an inactive window must
// never reveal messages. Touch has no persistent hover position.
export function observeMessageVisibility(win, doc, onChange) {
  let inside = !win.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;
  let focused = doc.hasFocus();
  let suspended = false;
  let previous;
  const listeners = [];
  const update = () => {
    const visible = inside && focused && doc.hasFocus() && !suspended && doc.visibilityState === "visible";
    if (visible !== previous) { previous = visible; onChange(visible); }
  };
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const enter = (event) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "touch") return;
    inside = true;
    update();
  };
  listen(doc.documentElement, "pointerenter", enter);
  listen(doc, "pointermove", enter);
  listen(doc, "pointerdown", enter);
  listen(doc.documentElement, "pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    inside = false;
    update();
  });
  listen(win, "blur", () => { focused = false; update(); });
  listen(win, "focus", () => { focused = doc.hasFocus(); update(); });
  listen(doc, "visibilitychange", () => { focused = doc.hasFocus(); update(); });
  listen(win, "pagehide", () => { suspended = true; update(); });
  listen(win, "pageshow", () => { suspended = false; focused = doc.hasFocus(); update(); });
  update();
  return () => listeners.forEach((remove) => remove());
}
