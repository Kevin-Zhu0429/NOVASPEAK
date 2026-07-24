import assert from "node:assert/strict";
import { once } from "node:events";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fsPromises.mkdtemp(
  path.join(os.tmpdir(), "novaspeak-auth-roles-")
);
process.env.NOVASPEAK_DB_PATH = path.join(tempRoot, "novaspeak.db");
process.env.NOVASPEAK_UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.DESKTOP_UPDATE_DIR = path.join(tempRoot, "desktop-updates");
process.env.PORT = "0";
process.env.REGISTRATION_ENABLED = "true";
process.env.GUEST_SESSION_SECRET = "auth-roles-test-guest-secret-0123456789";
process.env.LIVEKIT_URL = "wss://auth-roles-test.invalid";
process.env.LIVEKIT_ADMIN_URL = "https://auth-roles-test.invalid";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";

const { server } = await import("./index.js");
const db = (await import("./db.js")).default;
const {
  hashPassword,
  hashSessionToken,
} = await import("./auth-utils.js");

if (!server.listening) await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function api(method, pathname, { cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const setCookie = response.headers.get("set-cookie") || "";
  return {
    status: response.status,
    json,
    text,
    cookie: setCookie.split(";")[0],
  };
}

function insertSession(token, userId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(hashSessionToken(token), userId, now + 3_600_000, now);
}

test("registration creates an ordinary user without login or positions", async () => {
  const registration = await api("POST", "/api/auth/register", {
    body: {
      username: "  普通玩家01  ",
      password: "password-123",
      role: "admin",
      positions: ["captain"],
    },
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.json.user.role, "user");
  assert.equal(registration.json.user.roleLabel, "普通语音用户");
  assert.deepEqual(registration.json.user.positions, []);
  assert.equal(registration.json.user.position, null);
  assert.equal(registration.cookie, "");
  const row = db.prepare(`
    SELECT id, role FROM users WHERE username_key = '普通玩家01'
  `).get();
  assert.equal(row.role, "user");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM user_positions WHERE user_id = ?")
      .get(row.id).count,
    0
  );
  assert.equal((await api("GET", "/api/auth/me")).json.user, null);
});

test("registration duplicate, validation and kill switch are enforced", async () => {
  assert.equal((await api("POST", "/api/auth/register", {
    body: { username: "普通玩家01", password: "password-123" },
  })).status, 409);
  assert.equal((await api("POST", "/api/auth/register", {
    body: { username: "x", password: "short" },
  })).status, 400);
  process.env.REGISTRATION_ENABLED = "false";
  const disabled = await api("POST", "/api/auth/register", {
    body: { username: "关闭期间", password: "password-123" },
  });
  process.env.REGISTRATION_ENABLED = "true";
  assert.equal(disabled.status, 403);
  assert.equal(disabled.json.code, "REGISTRATION_DISABLED");
});

test("ordinary users can manage their profile but cannot create channels", async () => {
  const login = await api("POST", "/api/auth/member-login", {
    body: { nickname: "普通玩家01", password: "password-123" },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, "user");
  const denied = await api("POST", "/api/channels", {
    cookie: login.cookie,
    body: { name: "普通用户创建" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /不能管理频道/);
  assert.equal((await api("GET", "/api/account/me", {
    cookie: login.cookie,
  })).status, 200);
});

test("changing a password preserves the current session and revokes other sessions", async () => {
  const first = await api("POST", "/api/auth/member-login", {
    body: { nickname: "普通玩家01", password: "password-123" },
  });
  const second = await api("POST", "/api/auth/member-login", {
    body: { nickname: "普通玩家01", password: "password-123" },
  });
  const changed = await api("PATCH", "/api/account/me/password", {
    cookie: first.cookie,
    body: {
      currentPassword: "password-123",
      newPassword: "password-456",
      confirmPassword: "password-456",
    },
  });
  assert.equal(changed.status, 200);
  assert.equal((await api("GET", "/api/auth/me", { cookie: first.cookie })).json.user.role, "user");
  assert.equal((await api("GET", "/api/auth/me", { cookie: second.cookie })).json.user, null);
});

test("admin role changes are audited, revoke sessions and never accept guest", async () => {
  const passwordHash = await hashPassword("admin-password");
  db.prepare(`
    INSERT INTO users (
      id, username, username_key, display_name, password_hash,
      role, position, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "admin-id",
    "ADMIN",
    "admin",
    "ADMIN",
    passwordHash,
    "admin",
    "captain",
    Date.now()
  );
  db.prepare(`
    INSERT INTO user_positions (user_id, position) VALUES ('admin-id', 'captain')
  `).run();
  insertSession("admin-token", "admin-id");

  const target = db.prepare(`
    SELECT id FROM users WHERE username_key = '普通玩家01'
  `).get();
  insertSession("target-token", target.id);

  const invalid = await api("PATCH", `/api/admin/members/${target.id}/role`, {
    cookie: "novaspeak_session=admin-token",
    body: { role: "guest" },
  });
  assert.equal(invalid.status, 400);

  const changed = await api("PATCH", `/api/admin/members/${target.id}/role`, {
    cookie: "novaspeak_session=admin-token",
    body: { role: "member" },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.member.role, "member");
  assert.deepEqual(changed.json.member.positions, ["member"]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
      .get(target.id).count,
    0
  );
  const audit = db.prepare(`
    SELECT previous_role, next_role
    FROM role_change_audit
    WHERE target_user_id = ?
  `).get(target.id);
  assert.deepEqual(audit, { previous_role: "user", next_role: "member" });
});
