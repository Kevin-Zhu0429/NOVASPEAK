import test from "node:test";
import assert from "node:assert/strict";
import { getChannelMessages, saveChannelMessage } from "./chat-api.js";

function response(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => data,
  };
}

test("聊天历史使用频道路径、Session Cookie 和 AbortSignal", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  await getChannelMessages("", "cs2/main", {
    signal,
    fetchImpl: async (...args) => { calls.push(args); return response({ messages: [] }); },
  });
  assert.equal(calls[0][0], "/api/channels/cs2%2Fmain/messages");
  assert.equal(calls[0][1].credentials, "include");
  assert.equal(calls[0][1].signal, signal);
});
test("保存消息只提交修剪后的 text", async () => {
  const calls = [];
  await saveChannelMessage("", "cs2", "  hello  ", {
    fetchImpl: async (...args) => { calls.push(args); return response({ message: { id: "1" } }, { status: 201 }); },
  });
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: "hello" });
});
