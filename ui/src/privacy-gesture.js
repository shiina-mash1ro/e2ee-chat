export const DEFAULT_GESTURE = [0, 1, 3, 2];
export const validGesture = (path) => Array.isArray(path) && path.length >= 2 && path.length <= 8 && path.every((q, i) => Number.isInteger(q) && q >= 0 && q < 4 && (!i || q !== path[i - 1]));
export function quadrant(x, y, width, height) {
  if (x <= 0 || y <= 0 || x >= width || y >= height || x === width / 2 || y === height / 2) return null;
  return (y > height / 2 ? 2 : 0) + (x > width / 2 ? 1 : 0);
}
export function createGesture(path, now = () => performance.now()) {
  let index = -1, started = 0, pointer, width, height;
  const cancel = () => { index = -1; };
  const step = (e, w, h) => {
    if (index < 0 || e.pointerId !== pointer) return false;
    if (now() - started >= 5000 || w !== width || h !== height || e.clientX <= 0 || e.clientY <= 0 || e.clientX >= w || e.clientY >= h) { cancel(); return false; }
    const q = quadrant(e.clientX, e.clientY, w, h);
    if (q === null || q === path[index]) return true;
    if (q !== path[index + 1]) { cancel(); return false; }
    index++;
    return true;
  };
  return {
    cancel,
    down(e, w, h) {
      cancel();
      if (!validGesture(path) || e.pointerType !== 'mouse' || e.button !== 0 || e.buttons !== 1 || quadrant(e.clientX, e.clientY, w, h) !== path[0]) return;
      index = 0; started = now(); pointer = e.pointerId; width = w; height = h;
    },
    move(e, w, h) { if (e.buttons !== 1) cancel(); else step(e, w, h); },
    up(e, w, h) {
      const ok = e.pointerType === 'mouse' && e.button === 0 && step(e, w, h) && index === path.length - 1 && quadrant(e.clientX, e.clientY, w, h) === path.at(-1);
      cancel(); return Boolean(ok);
    },
  };
}
