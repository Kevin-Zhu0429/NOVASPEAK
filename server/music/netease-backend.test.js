import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productionDbPath = path.resolve(__dirname, "..", "data", "novaspeak.db");

// 临时数据库，绝不触碰真实数据
const tempRoot = await fsPromises.mkdtemp(
  path.join(os.tmpdir(), "novaspeak-music-")
);
const testDbPath = path.join(tempRoot, "novaspeak-test.db");
assert.notEqual(path.resolve(testDbPath), productionDbPath);

process.env.NOVASPEAK_DB_PATH = testDbPath;
process.env.NOVASPEAK_UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "0";
process.env.GUEST_SESSION_SECRET ||=
  "music-test-guest-secret-0123456789abcdef";
process.env.LIVEKIT_URL ||= "wss://music-test.invalid";
process.env.LIVEKIT_API_KEY ||= "music-test-key";
process.env.LIVEKIT_API_SECRET ||= "music-test-secret";
process.env.MUSIC_CREDENTIAL_KEY = crypto.randomBytes(32).toString("base64");

const { server } = await import("../index.js");
const importedDb = (await import("../db.js")).default;
const { hashSessionToken } = await import("../auth-utils.js");
const { createGuestSession } = await import("../guest-auth.js");
const { migrateNeteaseAccounts } = await import("./migrate.js");
const { encryptMusicCredential } = await import("./credential-store.js");
const {
  cleanupExpiredNeteaseAccounts,
  getMusicPrincipal,
  getNeteaseAccountRow,
  saveNeteaseBinding,
} = await import("./account-service.js");
const { createNeteaseClient, NETEASE_ERROR, NeteaseError } = await import(
  "./netease-client.js"
);
const { createNeteaseMusicRouter } = await import("./routes.js");

if (!server.listening) {
  await once(server, "listening");
}
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ---------- 测试账号与会话 ----------

const now = Date.now();
const insertUser = importedDb.prepare(`
  INSERT INTO users (id, username, username_key, display_name, password_hash, role, position, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
insertUser.run("music-member-a", "MUSICA", "musica", "MUSICA", "test-hash", "member", "member", now);
insertUser.run("music-member-b", "MUSICB", "musicb", "MUSICB", "test-hash", "member", "member", now);
insertUser.run("music-admin", "MUSICADMIN", "musicadmin", "MUSICADMIN", "test-hash", "admin", "captain", now);
const insertSession = importedDb.prepare(
  "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
);
insertSession.run(hashSessionToken("music-a-token"), "music-member-a", now + 3_600_000, now);
insertSession.run(hashSessionToken("music-b-token"), "music-member-b", now + 3_600_000, now);
insertSession.run(hashSessionToken("music-admin-token"), "music-admin", now + 3_600_000, now);

const memberACookie = "novaspeak_session=music-a-token";
const memberBCookie = "novaspeak_session=music-b-token";
const adminCookie = "novaspeak_session=music-admin-token";

function makeGuestCookie(nickname) {
  let cookie = "";
  const guestUser = createGuestSession(nickname, { secure: false }, {
    cookie: (name, value) => {
      cookie = `${name}=${value}`;
    },
  });
  return { cookie, guestUser };
}

const guestA = makeGuestCookie("音乐访客A");
const guestB = makeGuestCookie("音乐访客B");

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  importedDb.close();
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function api(method, apiPath, { cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function seedBinding(principalKey, { musicU, nickname, expiresAt = null }) {
  const encrypted = encryptMusicCredential(
    `MUSIC_U=${musicU}; os=pc`,
    process.env
  );
  saveNeteaseBinding(importedDb, {
    principalKey,
    encrypted,
    profile: {
      neteaseUserId: `netease-${principalKey}`,
      nickname,
      avatarUrl: "https://p1.music.126.net/example.jpg",
    },
    credentialExpiresAt: expiresAt,
  });
}

// ---------- 认证与配置 ----------

test("未登录访问所有网易云接口返回 401", async () => {
  for (const [method, apiPath] of [
    ["GET", "/api/music/netease/account"],
    ["POST", "/api/music/netease/session"],
    ["DELETE", "/api/music/netease/session"],
  ]) {
    const result = await api(method, apiPath);
    assert.equal(result.status, 401, `${method} ${apiPath}`);
  }
});

test("未配置 MUSIC_CREDENTIAL_KEY 时返回 503 MUSIC_NOT_CONFIGURED", async () => {
  const savedKey = process.env.MUSIC_CREDENTIAL_KEY;
  delete process.env.MUSIC_CREDENTIAL_KEY;
  try {
    for (const [method, apiPath] of [
      ["GET", "/api/music/netease/account"],
      ["POST", "/api/music/netease/session"],
      ["DELETE", "/api/music/netease/session"],
    ]) {
      const result = await api(method, apiPath, { cookie: memberACookie });
      assert.equal(result.status, 503, `${method} ${apiPath}`);
      assert.equal(result.json.code, "MUSIC_NOT_CONFIGURED");
    }
  } finally {
    process.env.MUSIC_CREDENTIAL_KEY = savedKey;
  }
});

test("密钥长度错误时同样视为未配置", async () => {
  const savedKey = process.env.MUSIC_CREDENTIAL_KEY;
  process.env.MUSIC_CREDENTIAL_KEY = crypto
    .randomBytes(16)
    .toString("base64");
  try {
    const result = await api("GET", "/api/music/netease/account", {
      cookie: memberACookie,
    });
    assert.equal(result.status, 503);
    assert.equal(result.json.code, "MUSIC_NOT_CONFIGURED");
  } finally {
    process.env.MUSIC_CREDENTIAL_KEY = savedKey;
  }
});

// ---------- 查询与输入校验 ----------

test("未绑定用户查询返回 bound: false", async () => {
  const result = await api("GET", "/api/music/netease/account", {
    cookie: memberACookie,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { bound: false });
});

test("POST 缺少 cookies 字段返回 400", async () => {
  const result = await api("POST", "/api/music/netease/session", {
    cookie: memberACookie,
    body: {},
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "NETEASE_COOKIE_INVALID");
});

test("POST 缺少 MUSIC_U 返回 400 且不访问网易云", async () => {
  const result = await api("POST", "/api/music/netease/session", {
    cookie: memberACookie,
    body: { cookies: [{ name: "os", value: "pc" }] },
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "NETEASE_MUSIC_U_MISSING");
});

// ---------- 绑定信息与隔离 ----------

test("绑定后查询只返回安全账号信息，响应不含凭据材料", async () => {
  seedBinding("music-member-a", {
    musicU: "member-a-secret-music-u",
    nickname: "成员A的网易云",
  });

  const result = await api("GET", "/api/music/netease/account", {
    cookie: memberACookie,
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.bound, true);
  assert.deepEqual(result.json.account, {
    neteaseUserId: "netease-music-member-a",
    nickname: "成员A的网易云",
    avatarUrl: "https://p1.music.126.net/example.jpg",
  });

  const raw = result.text;
  assert.ok(!raw.includes("member-a-secret-music-u"));
  assert.ok(!raw.includes("MUSIC_U"));
  for (const forbiddenKey of [
    "ciphertext",
    "cookie_iv",
    "cookie_auth_tag",
    "encrypted_cookie",
    "authTag",
    "iv",
  ]) {
    assert.ok(
      !(forbiddenKey in (result.json.account || {})),
      `account 不应包含 ${forbiddenKey}`
    );
  }
});

test("数据库中没有明文 MUSIC_U", () => {
  const rows = importedDb
    .prepare("SELECT * FROM netease_accounts")
    .all();
  assert.ok(rows.length > 0);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("member-a-secret-music-u"));
  assert.ok(!dump.includes("MUSIC_U="));
});

test("A 用户看不到 B 用户的绑定，删除也只影响自己", async () => {
  seedBinding("music-member-b", {
    musicU: "member-b-secret-music-u",
    nickname: "成员B的网易云",
  });

  // B 只能看到自己的账号
  const bView = await api("GET", "/api/music/netease/account", {
    cookie: memberBCookie,
  });
  assert.equal(bView.json.account.nickname, "成员B的网易云");

  // A 删除自己的绑定
  const aDelete = await api("DELETE", "/api/music/netease/session", {
    cookie: memberACookie,
  });
  assert.equal(aDelete.status, 200);
  assert.deepEqual(aDelete.json, { success: true, bound: false, removed: true });

  // A 已解绑，B 不受影响
  const aView = await api("GET", "/api/music/netease/account", {
    cookie: memberACookie,
  });
  assert.deepEqual(aView.json, { bound: false });

  const bViewAfter = await api("GET", "/api/music/netease/account", {
    cookie: memberBCookie,
  });
  assert.equal(bViewAfter.json.bound, true);

  // 重复删除幂等
  const aDeleteAgain = await api("DELETE", "/api/music/netease/session", {
    cookie: memberACookie,
  });
  assert.equal(aDeleteAgain.json.removed, false);
});

test("不同 guest 用户的绑定相互隔离", async () => {
  seedBinding(guestA.guestUser.id, {
    musicU: "guest-a-secret",
    nickname: "访客A的网易云",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  seedBinding(guestB.guestUser.id, {
    musicU: "guest-b-secret",
    nickname: "访客B的网易云",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const aView = await api("GET", "/api/music/netease/account", {
    cookie: guestA.cookie,
  });
  assert.equal(aView.json.account.nickname, "访客A的网易云");

  const aDelete = await api("DELETE", "/api/music/netease/session", {
    cookie: guestA.cookie,
  });
  assert.equal(aDelete.json.removed, true);

  const bView = await api("GET", "/api/music/netease/account", {
    cookie: guestB.cookie,
  });
  assert.equal(bView.json.bound, true);
  assert.equal(bView.json.account.nickname, "访客B的网易云");
});

test("过期的访客凭据会被自动清理", () => {
  const expiredKey = "guest:expired-cleanup-test";
  seedBinding(expiredKey, {
    musicU: "expired-secret",
    nickname: "过期访客",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  assert.equal(getNeteaseAccountRow(importedDb, expiredKey), null);
  const remaining = importedDb
    .prepare("SELECT COUNT(*) AS count FROM netease_accounts WHERE principal_key = ?")
    .get(expiredKey);
  assert.equal(remaining.count, 0);

  // 清理函数可重复安全调用
  assert.equal(typeof cleanupExpiredNeteaseAccounts(importedDb), "number");
});

test("删除正式成员时其网易云凭据在同一事务中一并删除", async () => {
  const nowTs = Date.now();
  insertUser.run("doomed-member", "DOOMED", "doomed", "DOOMED", "test-hash", "member", "member", nowTs);
  insertSession.run(hashSessionToken("doomed-token"), "doomed-member", nowTs + 3_600_000, nowTs);
  importedDb
    .prepare("INSERT INTO user_positions (user_id, position) VALUES (?, ?)")
    .run("doomed-member", "member");
  insertUser.run("keep-member", "KEEP", "keep", "KEEP", "test-hash", "member", "member", nowTs);

  seedBinding("doomed-member", {
    musicU: "doomed-secret",
    nickname: "将被删除的绑定",
  });
  seedBinding("keep-member", {
    musicU: "keep-secret",
    nickname: "保留的绑定",
  });
  const guestKeepKey = "guest:cascade-keep";
  seedBinding(guestKeepKey, {
    musicU: "guest-keep-secret",
    nickname: "访客保留绑定",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const result = await api("DELETE", "/api/admin/members/doomed-member", {
    cookie: adminCookie,
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);

  const countIn = (table, column, value) =>
    importedDb
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
      .get(value).count;

  // 用户、session、职位、网易云凭据全部删除
  assert.equal(countIn("users", "id", "doomed-member"), 0);
  assert.equal(countIn("sessions", "user_id", "doomed-member"), 0);
  assert.equal(countIn("user_positions", "user_id", "doomed-member"), 0);
  assert.equal(
    countIn("netease_accounts", "principal_key", "doomed-member"),
    0
  );

  // 其他正式成员和访客的绑定不受影响
  assert.equal(countIn("netease_accounts", "principal_key", "keep-member"), 1);
  assert.equal(
    countIn("netease_accounts", "principal_key", guestKeepKey),
    1
  );

  // 没有绑定的成员删除同样幂等成功
  insertUser.run("unbound-member", "UNBOUND", "unbound", "UNBOUND", "test-hash", "member", "member", nowTs);
  const unboundResult = await api(
    "DELETE",
    "/api/admin/members/unbound-member",
    { cookie: adminCookie }
  );
  assert.equal(unboundResult.status, 200);
});

test("数据库迁移可重复执行且不破坏数据", () => {
  const before = importedDb
    .prepare("SELECT COUNT(*) AS count FROM netease_accounts")
    .get().count;
  migrateNeteaseAccounts(importedDb);
  migrateNeteaseAccounts(importedDb);
  const after = importedDb
    .prepare("SELECT COUNT(*) AS count FROM netease_accounts")
    .get().count;
  assert.equal(after, before);
});

test("getMusicPrincipal 只信任服务端身份", () => {
  assert.equal(getMusicPrincipal(null), null);
  assert.equal(getMusicPrincipal({}), null);
  assert.equal(getMusicPrincipal({ id: "  " }), null);

  const member = getMusicPrincipal({ id: "user-1", isGuest: false });
  assert.deepEqual(member, { key: "user-1", isGuest: false });

  const guest = getMusicPrincipal({ id: "guest:abc", isGuest: true });
  assert.deepEqual(guest, { key: "guest:abc", isGuest: true });
});

// ---------- POST /session 成功与失败路径（mock 网易云客户端）----------

function createMockedApp({ verifySession, authUser }) {
  const app = express();
  app.use(express.json());
  const router = createNeteaseMusicRouter({
    db: importedDb,
    neteaseClient: { verifySession },
    requireAuthenticated: (req, res, next) => {
      req.authUser = authUser;
      next();
    },
  });
  app.use("/api/music/netease", router);
  return app;
}

async function withMockedServer(app, run) {
  const mockServer = app.listen(0);
  await once(mockServer, "listening");
  try {
    return await run(`http://127.0.0.1:${mockServer.address().port}`);
  } finally {
    mockServer.closeAllConnections?.();
    await new Promise((resolve) => mockServer.close(resolve));
  }
}

test("POST /session 成功绑定：验证、加密入库并返回安全信息", async () => {
  let receivedCookieHeader = "";
  const app = createMockedApp({
    authUser: { id: "music-member-a", isGuest: false },
    verifySession: async (cookieHeader) => {
      receivedCookieHeader = cookieHeader;
      return {
        neteaseUserId: "10086",
        nickname: "Mock网易云用户",
        avatarUrl: "https://p1.music.126.net/mock.jpg",
      };
    },
  });

  await withMockedServer(app, async (mockBase) => {
    const response = await fetch(`${mockBase}/api/music/netease/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cookies: [
          { name: "MUSIC_U", value: "bind-flow-secret" },
          { name: "os", value: "pc" },
        ],
      }),
    });
    const text = await response.text();
    const json = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.deepEqual(json, {
      success: true,
      bound: true,
      account: {
        neteaseUserId: "10086",
        nickname: "Mock网易云用户",
        avatarUrl: "https://p1.music.126.net/mock.jpg",
      },
    });

    // 客户端收到规范化后的 Cookie 请求头
    assert.equal(receivedCookieHeader, "MUSIC_U=bind-flow-secret; os=pc");

    // 响应中不含任何凭据材料
    assert.ok(!text.includes("bind-flow-secret"));
    assert.ok(!text.includes("MUSIC_U"));

    // 数据库中只有密文
    const row = importedDb
      .prepare("SELECT * FROM netease_accounts WHERE principal_key = ?")
      .get("music-member-a");
    assert.ok(row);
    assert.equal(row.netease_user_id, "10086");
    assert.ok(!JSON.stringify(row).includes("bind-flow-secret"));
    assert.equal(row.credential_expires_at, null);
  });
});

test("访客绑定会写入凭据过期时间", async () => {
  const guestId = "guest:mock-bind-guest";
  const app = createMockedApp({
    authUser: { id: guestId, isGuest: true },
    verifySession: async () => ({
      neteaseUserId: "20000",
      nickname: "访客Mock",
      avatarUrl: null,
    }),
  });

  await withMockedServer(app, async (mockBase) => {
    const response = await fetch(`${mockBase}/api/music/netease/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: "MUSIC_U=guest-bind-secret" }),
    });
    assert.equal(response.status, 200);

    const row = importedDb
      .prepare("SELECT credential_expires_at FROM netease_accounts WHERE principal_key = ?")
      .get(guestId);
    assert.ok(row.credential_expires_at);
    assert.ok(new Date(row.credential_expires_at).getTime() > Date.now());
  });
});

test("网易云登录失效返回 401 NETEASE_SESSION_INVALID", async () => {
  const app = createMockedApp({
    authUser: { id: "music-member-a", isGuest: false },
    verifySession: async () => {
      throw new NeteaseError(
        NETEASE_ERROR.SESSION_INVALID,
        "网易云登录已失效，请重新扫码登录"
      );
    },
  });

  await withMockedServer(app, async (mockBase) => {
    const response = await fetch(`${mockBase}/api/music/netease/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: "MUSIC_U=stale-token" }),
    });
    const json = await response.json();
    assert.equal(response.status, 401);
    assert.equal(json.code, "NETEASE_SESSION_INVALID");
  });
});

test("网易云限流与请求失败分别返回 429 / 502", async () => {
  for (const [code, expectedStatus] of [
    [NETEASE_ERROR.RATE_LIMITED, 429],
    [NETEASE_ERROR.REQUEST_FAILED, 502],
  ]) {
    const app = createMockedApp({
      authUser: { id: "music-member-a", isGuest: false },
      verifySession: async () => {
        throw new NeteaseError(code, "测试错误");
      },
    });

    await withMockedServer(app, async (mockBase) => {
      const response = await fetch(`${mockBase}/api/music/netease/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookies: "MUSIC_U=any-token" }),
      });
      const json = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(json.code, code);
    });
  }
});

// ---------- netease-client 封装（mock NeteaseCloudMusicApi）----------

test("netease-client：login_status 返回有效资料时解析成功", async () => {
  const client = createNeteaseClient({
    api: {
      login_status: async ({ cookie }) => {
        assert.equal(cookie, "MUSIC_U=ok-token");
        return {
          status: 200,
          body: {
            data: {
              code: 200,
              account: { id: 555 },
              profile: {
                userId: 555,
                nickname: "  真实昵称  ",
                avatarUrl: "https://p2.music.126.net/a.jpg",
              },
            },
          },
        };
      },
    },
  });

  const profile = await client.verifySession("MUSIC_U=ok-token");
  assert.deepEqual(profile, {
    neteaseUserId: "555",
    nickname: "真实昵称",
    avatarUrl: "https://p2.music.126.net/a.jpg",
  });
});

test("netease-client：profile 为空视为登录失效", async () => {
  const client = createNeteaseClient({
    api: {
      login_status: async () => ({
        status: 200,
        body: { data: { code: 200, account: null, profile: null } },
      }),
    },
  });

  await assert.rejects(
    () => client.verifySession("MUSIC_U=logged-out"),
    (error) => error.code === NETEASE_ERROR.SESSION_INVALID
  );
});

test("netease-client：第三方异常映射为稳定错误码", async () => {
  const cases = [
    [{ status: 301 }, NETEASE_ERROR.SESSION_INVALID],
    [{ status: 429 }, NETEASE_ERROR.RATE_LIMITED],
    [{ status: 500 }, NETEASE_ERROR.REQUEST_FAILED],
    [new Error("socket hang up"), NETEASE_ERROR.REQUEST_FAILED],
  ];

  for (const [thrown, expectedCode] of cases) {
    const client = createNeteaseClient({
      api: {
        login_status: async () => {
          throw thrown;
        },
      },
    });
    await assert.rejects(
      () => client.verifySession("MUSIC_U=x"),
      (error) =>
        error.code === expectedCode &&
        !String(error.message).includes("MUSIC_U"),
      `期望错误码 ${expectedCode}`
    );
  }
});

test("netease-client：请求超时返回 NETEASE_REQUEST_FAILED", async () => {
  const client = createNeteaseClient({
    timeoutMs: 30,
    api: {
      login_status: () => new Promise(() => {}),
    },
  });

  await assert.rejects(
    () => client.verifySession("MUSIC_U=slow"),
    (error) => error.code === NETEASE_ERROR.REQUEST_FAILED
  );
});

test("netease-client：空 Cookie 直接拒绝", async () => {
  const client = createNeteaseClient({
    api: {
      login_status: async () => {
        throw new Error("不应被调用");
      },
    },
  });
  for (const input of ["", "   ", null, undefined]) {
    await assert.rejects(
      () => client.verifySession(input),
      (error) => error.code === NETEASE_ERROR.SESSION_INVALID
    );
  }
});
