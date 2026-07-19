import test from "node:test";
import assert from "node:assert/strict";
import { kickOnlineMember, moveOnlineMember } from "./presence-management-api.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => body,
  };
}

test("移动在线成员只提交随机 presenceId 和目标频道", async () => {
  let request;
  const result = await moveOnlineMember("https://app.test", "presence-random", "cs2", async (url, options) => {
    request = { url, options };
    return jsonResponse({ success: true });
  });
  assert.equal(result.success, true);
  assert.equal(request.url, "https://app.test/api/presence/members/move");
  assert.equal(request.options.credentials, "include");
  assert.deepEqual(JSON.parse(request.options.body), { targetPresenceId: "presence-random", targetChannelId: "cs2" });
});

test("踢出接口保留服务端中文错误且拒绝非 JSON 响应", async () => {
  await assert.rejects(
    () => kickOnlineMember("", "p", async () => jsonResponse({ error: "战队成员不能将管理员移出服务器" }, { ok: false, status: 403 })),
    /战队成员不能将管理员移出服务器/
  );
  await assert.rejects(
    () => kickOnlineMember("", "p", async () => ({ ok: false, headers: { get: () => "text/html" } })),
    /无效响应/
  );
});
