import test from "node:test";
import assert from "node:assert/strict";
import { projectFairQueue } from "./music-queue-scheduler.js";

function makeItems(principalKey, count, startId) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    principalKey,
    label: `${principalKey}${index + 1}`,
  }));
}

function labels(items) {
  return items.map((item) => item.label);
}

test("A50 + B2：完整交替顺序逐项断言", () => {
  const buckets = [
    { principalKey: "A", bucketOrder: 1 },
    { principalKey: "B", bucketOrder: 2 },
  ];
  // A 先连续添加 50 首（id 1..50），B 随后添加 2 首（id 51..52）
  const pendingItems = [...makeItems("A", 50, 1), ...makeItems("B", 2, 51)];

  const projected = projectFairQueue({
    buckets,
    pendingItems,
    lastServedBucketOrder: 0,
  });

  assert.equal(projected.length, 52);
  const expected = [
    "A1", "B1", "A2", "B2",
    ...Array.from({ length: 48 }, (_, index) => `A${index + 3}`),
  ];
  // 逐项断言完整顺序
  assert.deepEqual(labels(projected), expected);
  assert.equal(projected[0].label, "A1");
  assert.equal(projected[1].label, "B1");
  assert.equal(projected[2].label, "A2");
  assert.equal(projected[3].label, "B2");
  assert.equal(projected[4].label, "A3");
  assert.equal(projected.at(-1).label, "A50");
});

test("只有一个用户时保持 FIFO", () => {
  const projected = projectFairQueue({
    buckets: [{ principalKey: "A", bucketOrder: 1 }],
    pendingItems: makeItems("A", 5, 10),
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "A2", "A3", "A4", "A5"]);
});

test("A/B 各多首：稳定交替", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: [...makeItems("A", 3, 1), ...makeItems("B", 3, 100)],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "B1", "A2", "B2", "A3", "B3"]);
});

test("A/B/C 三个用户轮询", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
      { principalKey: "C", bucketOrder: 3 },
    ],
    pendingItems: [
      ...makeItems("A", 2, 1),
      ...makeItems("B", 2, 10),
      ...makeItems("C", 2, 20),
    ],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "B1", "C1", "A2", "B2", "C2"]);
});

test("B 消费完后 A 继续连续播放", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: [...makeItems("A", 4, 1), ...makeItems("B", 1, 50)],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "B1", "A2", "A3", "A4"]);
});

test("新用户在 A 已被消费一首后加入（游标在 A 桶）", () => {
  // A 的第 1 首已 playing/finished，游标停在 A(1)
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "C", bucketOrder: 2 },
    ],
    pendingItems: [...makeItems("A", 3, 2), ...makeItems("C", 1, 100)],
    lastServedBucketOrder: 1,
  });
  // 游标 1 之后是 C(2)：新加入的 C 立即获得下一个位置
  assert.deepEqual(labels(projected), ["C1", "A1", "A2", "A3"]);
});

test("桶内部严格 FIFO", () => {
  const projected = projectFairQueue({
    buckets: [{ principalKey: "A", bucketOrder: 3 }],
    pendingItems: [
      { id: 30, principalKey: "A", label: "A3" },
      { id: 10, principalKey: "A", label: "A1" },
      { id: 20, principalKey: "A", label: "A2" },
    ],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "A2", "A3"]);
});

test("queueOrder 可改变桶内顺序，同时不改变跨用户轮询", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: [
      { id: 1, queueOrder: 30, principalKey: "A", label: "A1" },
      { id: 2, queueOrder: 10, principalKey: "A", label: "A2" },
      { id: 3, queueOrder: 20, principalKey: "A", label: "A3" },
      { id: 4, queueOrder: 20, principalKey: "B", label: "B1" },
      { id: 5, queueOrder: 10, principalKey: "B", label: "B2" },
    ],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A2", "B2", "A3", "B1", "A1"]);
});

test("中间用户桶为空时被跳过", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
      { principalKey: "C", bucketOrder: 3 },
    ],
    pendingItems: [...makeItems("A", 2, 1), ...makeItems("C", 2, 20)],
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "C1", "A2", "C2"]);
});

test("空桶重新加入后继续轮询", () => {
  // B 曾清空过队列，重新添加两首（id 更大），桶顺序不变
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: [...makeItems("A", 2, 1), ...makeItems("B", 2, 900)],
    lastServedBucketOrder: 2,
  });
  // 游标 2 之后无桶 → 回绕到 1
  assert.deepEqual(labels(projected), ["A1", "B1", "A2", "B2"]);
});

test("lastServedBucketOrder 需要回绕", () => {
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: [...makeItems("A", 1, 1), ...makeItems("B", 1, 2)],
    lastServedBucketOrder: 99,
  });
  assert.deepEqual(labels(projected), ["A1", "B1"]);
});

test("取消队列项后顺序立即正确", () => {
  const items = [...makeItems("A", 3, 1), ...makeItems("B", 2, 10)];
  // 取消 A2（id 2）
  const remaining = items.filter((item) => item.label !== "A2");
  const projected = projectFairQueue({
    buckets: [
      { principalKey: "A", bucketOrder: 1 },
      { principalKey: "B", bucketOrder: 2 },
    ],
    pendingItems: remaining,
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "B1", "A3", "B2"]);
});

test("输入乱序时仍得到确定结果", () => {
  const buckets = [
    { principalKey: "B", bucketOrder: 2 },
    { principalKey: "A", bucketOrder: 1 },
  ];
  const shuffled = [
    { id: 51, principalKey: "B", label: "B1" },
    { id: 3, principalKey: "A", label: "A3" },
    { id: 1, principalKey: "A", label: "A1" },
    { id: 52, principalKey: "B", label: "B2" },
    { id: 2, principalKey: "A", label: "A2" },
  ];
  const projected = projectFairQueue({
    buckets,
    pendingItems: shuffled,
    lastServedBucketOrder: 0,
  });
  assert.deepEqual(labels(projected), ["A1", "B1", "A2", "B2", "A3"]);
});

test("不修改输入对象与数组", () => {
  const buckets = [{ principalKey: "A", bucketOrder: 1 }];
  const pendingItems = [
    { id: 2, principalKey: "A", label: "A2" },
    { id: 1, principalKey: "A", label: "A1" },
  ];
  const bucketsSnapshot = JSON.stringify(buckets);
  const itemsSnapshot = JSON.stringify(pendingItems);

  projectFairQueue({ buckets, pendingItems, lastServedBucketOrder: 0 });

  assert.equal(JSON.stringify(buckets), bucketsSnapshot);
  assert.equal(JSON.stringify(pendingItems), itemsSnapshot);
});

test("空队列返回空数组", () => {
  assert.deepEqual(projectFairQueue({}), []);
  assert.deepEqual(
    projectFairQueue({ buckets: [], pendingItems: [], lastServedBucketOrder: 5 }),
    []
  );
});

test("单个项目", () => {
  const projected = projectFairQueue({
    buckets: [{ principalKey: "A", bucketOrder: 7 }],
    pendingItems: [{ id: 1, principalKey: "A", label: "A1" }],
    lastServedBucketOrder: 3,
  });
  assert.deepEqual(labels(projected), ["A1"]);
});
