import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChatTime,
  mergeChatMessages,
  normalizeChatMessage,
  shouldShowChatTimeDivider,
} from "./chat-messages.js";

test("历史与实时消息按 id 去重并按时间排序", () => {
  const result = mergeChatMessages(
    [{ id: "2", sender: "B", text: "two", createdAt: 200 }],
    [{ id: "1", sender: "A", text: "one", createdAt: 100 }, { id: "2", sender: "B", text: "two", createdAt: 200 }]
  );
  assert.deepEqual(result.map((item) => item.id), ["1", "2"]);
});
test("时间分隔线在首条、跨日期或相隔五分钟时出现", () => {
  const first = { createdAt: 1_000 };
  assert.equal(shouldShowChatTimeDivider(null, first), true);
  assert.equal(shouldShowChatTimeDivider(first, { createdAt: 1_000 + 299_000 }), false);
  assert.equal(shouldShowChatTimeDivider(first, { createdAt: 1_000 + 300_000 }), true);
});

test("消息标准化拒绝空文本，时间格式对非法输入安全", () => {
  assert.equal(normalizeChatMessage({ text: "   " }), null);
  assert.equal(formatChatTime("bad"), "");
});
