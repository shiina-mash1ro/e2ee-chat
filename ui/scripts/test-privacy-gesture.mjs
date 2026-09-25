import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGesture, validGesture, quadrant, DEFAULT_GESTURE } from '../src/privacy-gesture.js';
const point = (q, extra = {}) => ({pointerId:1, pointerType:'mouse', button:0, buttons:1, clientX:q % 2 ? 750 : 250, clientY:q > 1 ? 750 : 250, ...extra});
test('gesture validation and viewport midpoint rules', () => {
  assert.ok(validGesture(DEFAULT_GESTURE));
  for (const p of [[],[0],[0,0],[0,4],Array(9).fill(0),null]) assert.equal(validGesture(p),false);
  assert.ok(validGesture([0,1,0]));
  assert.equal(quadrant(500,250,1000,1000),null);
  assert.equal(quadrant(0,250,1000,1000),null);
});
test('ordered path ignores repeats and midpoint, requires release in final quadrant', () => {
  const g=createGesture(DEFAULT_GESTURE);
  g.down(point(0),1000,1000);
  g.move(point(0),1000,1000);
  g.move(point(0,{clientX:500}),1000,1000);
  for(const q of [1,3,2]) g.move(point(q),1000,1000);
  assert.ok(g.up(point(2,{buttons:0}),1000,1000));
  assert.equal(g.up(point(2),1000,1000),false);
});
test('wrong order, extra step, early release, timeout, resize, boundary and cancellation reject', () => {
  const attempts = [
    g=>g.move(point(2),1000,1000),
    g=>{for(const q of [1,3,2,0])g.move(point(q),1000,1000);},
    g=>g.cancel(),
    g=>g.move(point(1),999,1000),
    g=>g.move(point(1,{clientX:-1}),1000,1000),
    g=>g.move(point(1,{buttons:0}),1000,1000),
  ];
  for(const attempt of attempts){const g=createGesture(DEFAULT_GESTURE);g.down(point(0),1000,1000);attempt(g);assert.equal(g.up(point(2),1000,1000),false);}
  const g=createGesture(DEFAULT_GESTURE);g.down(point(0),1000,1000);assert.equal(g.up(point(0),1000,1000),false);
  let now=0;const timed=createGesture([0,1],()=>now);timed.down(point(0),1000,1000);now=5000;assert.equal(timed.up(point(1),1000,1000),false);
});
test('touch, right button, outside press and another pointer cannot unlock', () => {
  for(const extra of [{pointerType:'touch'},{button:2,buttons:2},{clientX:-1}]){const g=createGesture([0,1]);g.down(point(0,extra),1000,1000);assert.equal(g.up(point(1),1000,1000),false);}
  const g=createGesture([0,1]);g.down(point(0),1000,1000);assert.equal(g.up(point(1,{pointerId:2}),1000,1000),false);
});
