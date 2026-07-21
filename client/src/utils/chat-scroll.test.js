import test from "node:test";
import assert from "node:assert/strict";
import { isNearChatBottom, shouldRestoreChatComposerFocus } from "./chat-scroll.js";

test("聊天区在底部或距离底部 72px 内时自动跟随新消息", () => {
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }), true);
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 430, clientHeight: 500 }), true);
});

test("用户向上阅读历史消息时不强制拉回底部", () => {
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 }), false);
  assert.equal(isNearChatBottom({ scrollHeight: NaN, scrollTop: 0, clientHeight: 0 }), true);
});

test("聊天发送结束后恢复输入焦点，发送中或频道不可用时不恢复", () => {
  assert.equal(shouldRestoreChatComposerFocus({ previousSending: true, sending: false, disabled: false }), true);
  assert.equal(shouldRestoreChatComposerFocus({ previousSending: false, sending: false, disabled: false }), false);
  assert.equal(shouldRestoreChatComposerFocus({ previousSending: true, sending: true, disabled: false }), false);
  assert.equal(shouldRestoreChatComposerFocus({ previousSending: true, sending: false, disabled: true }), false);
});
