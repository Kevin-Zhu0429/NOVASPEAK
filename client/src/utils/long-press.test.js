import test from "node:test";
import assert from "node:assert/strict";
import {
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  createLongPressTracker,
  shouldIgnoreLongPressTarget,
} from "./long-press.js";

function createFakeScheduler() {
  const tasks = new Map();
  let nextId = 1;
  return {
    schedule: (fn, delay) => {
      const id = nextId++;
      tasks.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => tasks.delete(id),
    fire: () => {
      for (const [id, { fn }] of [...tasks]) {
        tasks.delete(id);
        fn();
      }
    },
    pending: () => tasks.size,
    lastDelay: () => [...tasks.values()].at(-1)?.delay,
  };
}

function createTracker(onLongPress, scheduler) {
  return createLongPressTracker({ onLongPress, schedule: scheduler.schedule, cancelSchedule: scheduler.cancel });
}

test("默认延迟 550ms，容差 10px", () => {
  assert.equal(LONG_PRESS_DELAY_MS, 550);
  assert.equal(LONG_PRESS_MOVE_TOLERANCE_PX, 10);
  const scheduler = createFakeScheduler();
  const tracker = createTracker(() => {}, scheduler);
  tracker.start({ x: 10, y: 20 });
  assert.equal(scheduler.lastDelay(), 550);
});

test("长按定时触发并带起始坐标", () => {
  const scheduler = createFakeScheduler();
  const fired = [];
  const tracker = createTracker((point) => fired.push(point), scheduler);
  tracker.start({ x: 100, y: 200 });
  assert.equal(tracker.isPending(), true);
  scheduler.fire();
  assert.deepEqual(fired, [{ x: 100, y: 200 }]);
  assert.equal(tracker.isPending(), false);
});

test("容差内移动不取消长按", () => {
  const scheduler = createFakeScheduler();
  const fired = [];
  const tracker = createTracker((point) => fired.push(point), scheduler);
  tracker.start({ x: 100, y: 200 });
  tracker.move({ x: 105, y: 195 });
  assert.equal(tracker.isPending(), true);
  scheduler.fire();
  assert.equal(fired.length, 1);
});

test("移动超过容差（滚动）时取消长按", () => {
  const scheduler = createFakeScheduler();
  const fired = [];
  const tracker = createTracker((point) => fired.push(point), scheduler);
  tracker.start({ x: 100, y: 200 });
  tracker.move({ x: 100, y: 230 });
  assert.equal(tracker.isPending(), false);
  scheduler.fire();
  assert.equal(fired.length, 0);
});

test("touchend / touchcancel 取消后不触发", () => {
  const scheduler = createFakeScheduler();
  const fired = [];
  const tracker = createTracker((point) => fired.push(point), scheduler);
  tracker.start({ x: 1, y: 2 });
  tracker.cancel();
  assert.equal(tracker.isPending(), false);
  scheduler.fire();
  assert.equal(fired.length, 0);
});

test("重复 start 只保留最后一个定时器", () => {
  const scheduler = createFakeScheduler();
  const fired = [];
  const tracker = createTracker((point) => fired.push(point), scheduler);
  tracker.start({ x: 1, y: 1 });
  tracker.start({ x: 9, y: 9 });
  assert.equal(scheduler.pending(), 1);
  scheduler.fire();
  assert.deepEqual(fired, [{ x: 9, y: 9 }]);
});

test("非法起点不启动长按", () => {
  const scheduler = createFakeScheduler();
  const tracker = createTracker(() => {}, scheduler);
  tracker.start(null);
  tracker.start({ x: "a", y: 1 });
  assert.equal(scheduler.pending(), 0);
});

test("按钮、输入框和菜单内的触摸不触发长按", () => {
  const insideButton = { closest: (selector) => (selector.includes("button") ? {} : null) };
  const plainCard = { closest: () => null };
  assert.equal(shouldIgnoreLongPressTarget(insideButton), true);
  assert.equal(shouldIgnoreLongPressTarget(plainCard), false);
  assert.equal(shouldIgnoreLongPressTarget(null), false);
  assert.equal(shouldIgnoreLongPressTarget({}), false);
});
