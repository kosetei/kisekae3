import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'public/outfit-swipe.js'), 'utf8');
const context = { Set, globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const OutfitSwipe = context.OutfitSwipe;

const dresses = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
  { id: 'e' },
];
const generated = new Set(['a', 'c', 'e']);
const hasGenerated = (dress) => generated.has(dress.id);
const list = OutfitSwipe.swipeableGeneratedDresses(dresses, hasGenerated);
const ids = (items) => Array.from(items, (dress) => dress.id);

assert.deepEqual(ids(list), ['a', 'c', 'e']);
assert.equal(OutfitSwipe.swipeableGeneratedDresses(undefined, hasGenerated).length, 0);

// 生成済みどうしは折り返す
assert.equal(OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'c', 1), 2);
assert.equal(OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'e', 1), 0);
assert.equal(OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'a', -1), 2);
assert.equal(OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'c', -1), 0);

// 未生成の隣からは次／前の生成済みへ
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'b', 1)].id, 'c');
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'b', -1)].id, 'a');
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'd', 1)].id, 'e');
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, 'd', -1)].id, 'c');

// 未選択は次で先頭、前で末尾
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, null, 1)].id, 'a');
assert.equal(list[OutfitSwipe.adjacentGeneratedIndex(list, dresses, null, -1)].id, 'e');

// 1 件だけのときは、今それを見ていれば動かない
const onlyC = OutfitSwipe.swipeableGeneratedDresses(dresses, (dress) => dress.id === 'c');
assert.equal(OutfitSwipe.adjacentGeneratedIndex(onlyC, dresses, 'c', 1), -1);
assert.equal(OutfitSwipe.adjacentGeneratedIndex(onlyC, dresses, 'a', 1), 0);
assert.equal(OutfitSwipe.adjacentGeneratedIndex([], dresses, 'a', 1), -1);

assert.equal(OutfitSwipe.positionLabel(list, 'c'), '2 / 3');
assert.equal(OutfitSwipe.positionLabel(list, 'b'), '— / 3');
assert.equal(OutfitSwipe.positionLabel([], 'a'), '');

assert.equal(OutfitSwipe.shouldAcceptSwipe(-50, 10), true);
assert.equal(OutfitSwipe.shouldAcceptSwipe(-49, 10), false);
assert.equal(OutfitSwipe.shouldAcceptSwipe(-80, -80), false);
assert.equal(OutfitSwipe.shouldAcceptSwipe(-80, -81), false);
assert.equal(OutfitSwipe.shouldAcceptSwipe(80, 20), true);
assert.equal(OutfitSwipe.swipeDelta(-60, 10), 1);
assert.equal(OutfitSwipe.swipeDelta(60, 10), -1);
assert.equal(OutfitSwipe.swipeDelta(-40, 10), 0);

assert.equal(OutfitSwipe.isTypingTarget({ tagName: 'INPUT' }), true);
assert.equal(OutfitSwipe.isTypingTarget({ tagName: 'TEXTAREA' }), true);
assert.equal(OutfitSwipe.isTypingTarget({ tagName: 'SELECT' }), true);
assert.equal(OutfitSwipe.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
assert.equal(OutfitSwipe.isTypingTarget({ tagName: 'DIV' }), false);
assert.equal(OutfitSwipe.isTypingTarget(null), false);

const swipes = [];
const tracker = OutfitSwipe.createSwipeTracker({ onSwipe: (delta) => swipes.push(delta) });
tracker.pointerdown({ pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100, button: 0 });
assert.equal(tracker.pointermove({ pointerId: 1, clientX: 140, clientY: 108 }).prevent, true);
assert.equal(tracker.pointerup({ pointerId: 1, clientX: 140, clientY: 108 }), 1);
assert.deepEqual(swipes, [1]);

// 縦の方が大きいときは無視
assert.equal(
  (tracker.pointerdown({ pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100, button: 0 }),
   tracker.pointerup({ pointerId: 2, clientX: 200 - 40, clientY: 100 + 80 })),
  0,
);

// 複数指はキャンセル
const pinch = OutfitSwipe.createSwipeTracker({ onSwipe: (delta) => swipes.push(delta) });
pinch.pointerdown({ pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100, button: 0 });
pinch.pointerdown({ pointerId: 2, pointerType: 'touch', clientX: 220, clientY: 120, button: 0 });
assert.equal(pinch.pointerup({ pointerId: 1, clientX: 120, clientY: 100 }), 0);
assert.deepEqual(swipes, [1]);

// 右クリックでは開始しない
const mouse = OutfitSwipe.createSwipeTracker();
mouse.pointerdown({ pointerId: 1, pointerType: 'mouse', button: 2, clientX: 200, clientY: 100 });
assert.equal(mouse.pointerup({ pointerId: 1, clientX: 100, clientY: 100 }), 0);

console.log('outfit-swipe tests passed');
