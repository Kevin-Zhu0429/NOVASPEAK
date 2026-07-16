// 公平队列的纯调度逻辑：按用户分桶动态轮询。
// 纯函数：不访问数据库、不修改输入、结果确定。
//
// 模型：
// - 每个频道里，用户桶首次出现时获得递增 bucket_order（持久化在
//   music_queue_buckets）；
// - 频道游标 last_served_bucket_order（持久化在 music_queue_state）
//   记录上一次消费到的桶；
// - 选下一首时：在仍有 pending 的活跃桶中，取 bucket_order 大于游标的
//   最小者；不存在则回绕到最小 bucket_order；
// - 桶内部严格 FIFO（按队列项 id 递增）。
//
// 这保证 A 连续加 50 首、B 随后加 2 首时的顺序是
// A1 → B1 → A2 → B2 → A3 → A4 → ... → A50。

/**
 * 计算预计公平播放顺序。
 *
 * @param {object} input
 * @param {Array<{principalKey: string, bucketOrder: number}>} input.buckets
 * @param {Array<{id: number|string, principalKey: string}>} input.pendingItems
 * @param {number} input.lastServedBucketOrder
 * @returns {Array} pendingItems 中的原对象，按预计播放顺序排列（新数组）
 */
export function projectFairQueue({
  buckets = [],
  pendingItems = [],
  lastServedBucketOrder = 0,
} = {}) {
  const orderByPrincipal = new Map();
  for (const bucket of buckets) {
    if (
      bucket &&
      typeof bucket.principalKey === "string" &&
      Number.isFinite(Number(bucket.bucketOrder))
    ) {
      orderByPrincipal.set(bucket.principalKey, Number(bucket.bucketOrder));
    }
  }

  // 桶内 FIFO：按队列项 id（自增主键）升序；输入乱序也得到确定结果
  const sortedItems = [...pendingItems].sort(
    (a, b) => Number(a?.id) - Number(b?.id)
  );

  const queuesByOrder = new Map();
  for (const item of sortedItems) {
    const order = orderByPrincipal.get(item?.principalKey);
    if (order === undefined) continue;
    if (!queuesByOrder.has(order)) queuesByOrder.set(order, []);
    queuesByOrder.get(order).push(item);
  }

  const activeOrders = [...queuesByOrder.keys()].sort((a, b) => a - b);
  const nextIndexByOrder = new Map(activeOrders.map((order) => [order, 0]));

  const projected = [];
  let cursor = Number.isFinite(Number(lastServedBucketOrder))
    ? Number(lastServedBucketOrder)
    : 0;

  for (;;) {
    const candidates = activeOrders.filter(
      (order) => nextIndexByOrder.get(order) < queuesByOrder.get(order).length
    );
    if (candidates.length === 0) break;

    // 游标之后的最小桶；不存在则回绕到最小桶
    let next = candidates.find((order) => order > cursor);
    if (next === undefined) next = candidates[0];

    const index = nextIndexByOrder.get(next);
    projected.push(queuesByOrder.get(next)[index]);
    nextIndexByOrder.set(next, index + 1);
    cursor = next;
  }

  return projected;
}
