import { test } from "node:test";
import assert from "node:assert/strict";
import { observeMessageVisibility } from "../src/message-visibility.js";
import { partitionRetainedMessages, MESSAGE_RETENTION_MS } from "../src/message-retention.js";

function fixture(mouse = true) {
  const win = new EventTarget(), doc = new EventTarget();
  doc.documentElement = new EventTarget();
  doc.visibilityState = "visible";
  let focus = true;
  doc.hasFocus = () => focus;
  win.matchMedia = () => ({ matches: mouse });
  const states = [];
  const stop = observeMessageVisibility(win, doc, (value) => states.push(value));
  const emit = (target, type, pointerType = "mouse") => {
    const event = new Event(type);
    event.pointerType = pointerType;
    target.dispatchEvent(event);
  };
  return { win, doc, states, stop, emit, focus: (value) => { focus = value; }, visible: () => states.at(-1) };
}

test("mouse entry cannot override blur, and focus cannot override mouse leave", () => {
  const f = fixture();
  assert.equal(f.visible(), false);
  f.emit(f.doc, "pointermove");
  assert.equal(f.visible(), true);
  f.emit(f.doc.documentElement, "pointerleave");
  assert.equal(f.visible(), false);
  f.emit(f.win, "focus");
  assert.equal(f.visible(), false);
  f.focus(false); f.emit(f.win, "blur");
  f.emit(f.doc.documentElement, "pointerenter");
  assert.equal(f.visible(), false);
  f.focus(true); f.emit(f.win, "focus");
  assert.equal(f.visible(), true);
  f.stop();
  f.emit(f.doc.documentElement, "pointerleave");
  assert.equal(f.visible(), true);
});

test("touch release stays visible; background, blur and pagehide conceal", () => {
  const f = fixture(false);
  assert.equal(f.visible(), true);
  f.emit(f.doc.documentElement, "pointerleave", "touch");
  assert.equal(f.visible(), true);
  f.doc.visibilityState = "hidden"; f.emit(f.doc, "visibilitychange");
  assert.equal(f.visible(), false);
  f.emit(f.doc, "pointerdown", "touch");
  assert.equal(f.visible(), false);
  f.doc.visibilityState = "visible"; f.emit(f.doc, "visibilitychange");
  assert.equal(f.visible(), true);
  f.emit(f.win, "pagehide");
  f.emit(f.win, "focus");
  assert.equal(f.visible(), false);
  f.emit(f.win, "pageshow");
  assert.equal(f.visible(), true);
  f.focus(false); f.emit(f.win, "blur");
  assert.equal(f.visible(), false);
});

test("wall-clock expiry removes old messages even without timer ticks", () => {
  const now = Date.now();
  const old = { receivedAt: now - MESSAGE_RETENTION_MS - 1 };
  const fresh = { receivedAt: now - 1000 };
  assert.deepEqual(partitionRetainedMessages([old, fresh], now), { retained: [fresh], removed: [old] });
});
