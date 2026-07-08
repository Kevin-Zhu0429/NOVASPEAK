import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productionDbPath = path.resolve(__dirname, "data", "novaspeak.db");
const productionUploadsDir = path.resolve(__dirname, "uploads");

// 临时数据库 + 临时 uploads 目录，绝不触碰真实数据
const tempRoot = await fsPromises.mkdtemp(
  path.join(os.tmpdir(), "novaspeak-avatar-")
);
const testDbPath = path.join(tempRoot, "novaspeak-test.db");
const testUploadsDir = path.join(tempRoot, "uploads");
const testAvatarsDir = path.join(testUploadsDir, "avatars");
assert.notEqual(path.resolve(testDbPath), productionDbPath);
assert.notEqual(path.resolve(testUploadsDir), productionUploadsDir);

process.env.NOVASPEAK_DB_PATH = testDbPath;
process.env.NOVASPEAK_UPLOADS_DIR = testUploadsDir;
process.env.PORT = "0";
process.env.GUEST_SESSION_SECRET ||=
  "avatar-test-guest-secret-0123456789abcdef";
process.env.LIVEKIT_URL ||= "wss://avatar-test.invalid";
process.env.LIVEKIT_API_KEY ||= "avatar-test-key";
process.env.LIVEKIT_API_SECRET ||= "avatar-test-secret";

const { server } = await import("./index.js");
const importedDb = (await import("./db.js")).default;
const { hashSessionToken } = await import("./auth-utils.js");
const { createGuestSession } = await import("./guest-auth.js");
const { toPublicUser } = await import("./auth-session.js");
const {
  AVATAR_MAX_BYTES,
  avatarUrlFromPath,
  decodeAvatarUpload,
  detectAvatarImageType,
  migrateAvatarColumn,
} = await import("./avatar.js");
const { createPresenceService } = await import("./presence.js");

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
insertUser.run("admin-id", "ADMIN01", "admin01", "ADMIN01", "test-hash", "admin", "captain", now);
insertUser.run("member-id", "PLAYER01", "player01", "PLAYER01", "test-hash", "member", "member", now);
insertUser.run("member2-id", "PLAYER02", "player02", "PLAYER02", "test-hash", "member", "member", now);
const insertPosition = importedDb.prepare(
  "INSERT INTO user_positions (user_id, position) VALUES (?, ?)"
);
insertPosition.run("admin-id", "captain");
insertPosition.run("member-id", "member");
insertPosition.run("member2-id", "member");
const insertSession = importedDb.prepare(
  "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
);
insertSession.run(hashSessionToken("admin-token"), "admin-id", now + 3_600_000, now);
insertSession.run(hashSessionToken("member-token"), "member-id", now + 3_600_000, now);
insertSession.run(hashSessionToken("member2-token"), "member2-id", now + 3_600_000, now);

const adminCookie = "novaspeak_session=admin-token";
const memberCookie = "novaspeak_session=member-token";
const member2Cookie = "novaspeak_session=member2-token";

function makeGuestCookie(nickname = "临时访客") {
  let cookie = "";
  createGuestSession(nickname, { secure: false }, {
    cookie: (name, value) => {
      cookie = `${name}=${value}`;
    },
  });
  return cookie;
}

const guestCookie = makeGuestCookie();

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  importedDb.close();
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

// ---------- 图片构造 ----------

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makeJpegBytes(extraBytes = 16) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(extraBytes, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeWebpBytes(payloadBytes = 20) {
  const payload = Buffer.alloc(payloadBytes, 0x22);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + payload.length);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    riffSize,
    Buffer.from("WEBP", "latin1"),
    payload,
  ]);
}

function uploadBody(buffer, mimeType) {
  return { imageBase64: buffer.toString("base64"), mimeType };
}

async function api(method, pathname, { cookie, body, rawBody } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body || rawBody ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

function dbAvatarPath(userId) {
  return importedDb
    .prepare("SELECT avatar_path FROM users WHERE id = ?")
    .get(userId).avatar_path;
}

function avatarFileOnDisk(avatarPath) {
  return path.join(testAvatarsDir, avatarPath.replace(/^avatars\//, ""));
}

// ---------- 校验单元测试 ----------

test("magic bytes 检测只认 JPEG/PNG/WEBP", () => {
  assert.equal(detectAvatarImageType(PNG_BYTES), "image/png");
  assert.equal(detectAvatarImageType(makeJpegBytes()), "image/jpeg");
  assert.equal(detectAvatarImageType(makeWebpBytes()), "image/webp");
  assert.equal(detectAvatarImageType(Buffer.from("GIF89a......")), null);
  assert.equal(detectAvatarImageType(Buffer.from("<svg></svg>")), null);
  assert.equal(detectAvatarImageType(Buffer.alloc(0)), null);
});

test("decodeAvatarUpload 拒绝无效输入并支持 data URL 前缀", () => {
  assert.equal(decodeAvatarUpload({}).status, 400);
  assert.equal(
    decodeAvatarUpload({ imageBase64: "", mimeType: "image/png" }).status,
    400
  );
  assert.equal(
    decodeAvatarUpload({ imageBase64: "@@@!!", mimeType: "image/png" }).status,
    400
  );
  const withPrefix = decodeAvatarUpload({
    imageBase64: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
    mimeType: "image/png",
  });
  assert.equal(withPrefix.error, undefined);
  assert.equal(withPrefix.extension, "png");
});

test("avatarUrlFromPath 拒绝路径穿越并绝不返回磁盘路径", () => {
  assert.equal(avatarUrlFromPath("avatars/abc123.png"), "/uploads/avatars/abc123.png");
  assert.equal(avatarUrlFromPath(null), null);
  assert.equal(avatarUrlFromPath(""), null);
  assert.equal(avatarUrlFromPath("avatars/../secrets.db"), null);
  assert.equal(avatarUrlFromPath("avatars/..\\secrets.db"), null);
  assert.equal(avatarUrlFromPath("/etc/passwd"), null);
  assert.equal(avatarUrlFromPath("avatars/a/b.png"), null);
  assert.equal(avatarUrlFromPath("avatars/evil.svg"), null);
});

// ---------- 上传权限 ----------

test("Guest 上传头像返回 403，未登录返回 401", async () => {
  const guestResult = await api("POST", "/api/me/avatar", {
    cookie: guestCookie,
    body: uploadBody(PNG_BYTES, "image/png"),
  });
  assert.equal(guestResult.status, 403);
  assert.match(guestResult.json.error, /正式/);

  const anonymousResult = await api("POST", "/api/me/avatar", {
    body: uploadBody(PNG_BYTES, "image/png"),
  });
  assert.equal(anonymousResult.status, 401);
});

test("Admin 可以上传头像，数据库更新且 /api/auth/me 返回 avatarUrl", async () => {
  const result = await api("POST", "/api/me/avatar", {
    cookie: adminCookie,
    body: uploadBody(PNG_BYTES, "image/png"),
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.match(result.json.user.avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);

  const storedPath = dbAvatarPath("admin-id");
  assert.match(storedPath, /^avatars\/[a-f0-9]{32}\.png$/);
  assert.equal(fs.existsSync(avatarFileOnDisk(storedPath)), true);

  const me = await api("GET", "/api/auth/me", { cookie: adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.avatarUrl, result.json.user.avatarUrl);

  // 返回值不包含磁盘路径 / 内部字段 / 秘密
  for (const payload of [result.text, me.text]) {
    assert.equal(payload.includes(tempRoot), false);
    assert.equal(payload.includes("avatar_path"), false);
    assert.doesNotMatch(payload, /password|token|cookie|session/i);
  }
});

test("Member 可以上传头像（WebP），Guest 身份信息 avatarUrl 为 null", async () => {
  const webpBytes = makeWebpBytes();
  const result = await api("POST", "/api/me/avatar", {
    cookie: memberCookie,
    body: uploadBody(webpBytes, "image/webp"),
  });
  assert.equal(result.status, 200);
  assert.match(result.json.user.avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.webp$/);

  const guestMe = await api("GET", "/api/auth/me", { cookie: guestCookie });
  assert.equal(guestMe.status, 200);
  assert.equal(guestMe.json.user.role, "guest");
  assert.equal(guestMe.json.user.avatarUrl, null);
});

// ---------- 上传校验 ----------

test("超过 2MB 的图片被拒绝（含超大请求体）", async () => {
  const oversized = Buffer.concat([
    PNG_BYTES,
    Buffer.alloc(AVATAR_MAX_BYTES + 1 - PNG_BYTES.length, 0x33),
  ]);
  const result = await api("POST", "/api/me/avatar", {
    cookie: memberCookie,
    body: uploadBody(oversized, "image/png"),
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error, "头像文件不能超过 2MB");

  // 超过 JSON 请求体上限时由 body 解析层拦截，同样返回中文 413
  const hugeBody = `{"mimeType":"image/png","imageBase64":"${"A".repeat(4 * 1024 * 1024 + 64)}"}`;
  const tooLarge = await api("POST", "/api/me/avatar", {
    cookie: memberCookie,
    rawBody: hugeBody,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error, "头像文件不能超过 2MB");
});

test("不支持的 mimeType、magic bytes 不匹配、无效 base64、SVG、空图片均被拒绝", async () => {
  const cases = [
    { body: uploadBody(Buffer.from("GIF89a-not-really"), "image/gif"), reason: "GIF mime" },
    { body: uploadBody(PNG_BYTES, "image/jpeg"), reason: "mime 与 magic bytes 不匹配" },
    { body: { imageBase64: "@@@@not-base64!!", mimeType: "image/png" }, reason: "无效 base64" },
    { body: uploadBody(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"), reason: "SVG mime" },
    { body: uploadBody(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png"), reason: "SVG 内容伪装 PNG" },
    { body: { imageBase64: "", mimeType: "image/png" }, reason: "空图片" },
    { body: { mimeType: "image/png" }, reason: "缺少图片数据" },
    { body: uploadBody(Buffer.from("plain text file"), "image/png"), reason: "非图片内容" },
  ];
  for (const { body, reason } of cases) {
    const result = await api("POST", "/api/me/avatar", {
      cookie: memberCookie,
      body,
    });
    assert.equal(result.status, 400, `${reason} 应返回 400`);
    assert.equal(typeof result.json.error, "string", `${reason} 应有中文错误`);
  }

  // 非法 JSON 请求体
  const badJson = await api("POST", "/api/me/avatar", {
    cookie: memberCookie,
    rawBody: "{not-json",
  });
  assert.equal(badJson.status, 400);

  // 以上失败不应改变已保存的头像
  assert.match(dbAvatarPath("member-id"), /\.webp$/);
});

// ---------- 公开字段 ----------

test("成员列表与管理员列表返回 avatarUrl，不泄露内部路径", async () => {
  const publicMembers = await api("GET", "/api/team/public-members", {
    cookie: memberCookie,
  });
  assert.equal(publicMembers.status, 200);
  const admin = publicMembers.json.members.find((item) => item.displayName === "ADMIN01");
  const member2 = publicMembers.json.members.find((item) => item.displayName === "PLAYER02");
  assert.match(admin.avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);
  assert.equal(member2.avatarUrl, null);
  assert.equal(publicMembers.text.includes("avatar_path"), false);
  assert.equal(publicMembers.text.includes(tempRoot), false);

  const managedMembers = await api("GET", "/api/team/members", {
    cookie: adminCookie,
  });
  assert.equal(managedMembers.status, 200);
  const managedAdmin = managedMembers.json.members.find((item) => item.displayName === "ADMIN01");
  assert.match(managedAdmin.avatarUrl, /^\/uploads\/avatars\//);
  assert.doesNotMatch(managedMembers.text, /password|token_hash|avatar_path/i);
});

test("Presence public members 返回 avatarUrl", () => {
  class FakeConnection extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    send(payload, callback) {
      callback?.();
    }
    ping() {}
    close() {
      this.emit("close");
    }
    terminate() {
      this.emit("close");
    }
  }

  const service = createPresenceService({
    heartbeatMs: 60_000,
    autoHeartbeat: false,
    channelLookup: () => null,
  });
  const adminRow = importedDb
    .prepare("SELECT id, username, display_name, role, avatar_path FROM users WHERE id = 'admin-id'")
    .get();
  service.addConnection(new FakeConnection(), {}, toPublicUser(adminRow));
  const guestConnectionUser = {
    id: "guest:presence-uuid",
    displayName: "TEMP01",
    role: "guest",
    isGuest: true,
    positions: [],
    positionNames: [],
    avatarUrl: null,
  };
  service.addConnection(new FakeConnection(), {}, guestConnectionUser);

  const members = service.publicMembers("user:admin-id");
  const adminMember = members.find((item) => item.nickname === "ADMIN01");
  const guestMember = members.find((item) => item.nickname === "TEMP01");
  assert.match(adminMember.avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);
  assert.equal(guestMember.avatarUrl, null);
  service.close();
});

// ---------- 静态访问 ----------

test("头像 URL 可以直接访问，且禁止路径穿越", async () => {
  const me = await api("GET", "/api/auth/me", { cookie: adminCookie });
  const avatarUrl = me.json.user.avatarUrl;
  const fileResult = await fetch(`${baseUrl}${avatarUrl}`);
  assert.equal(fileResult.status, 200);
  assert.match(fileResult.headers.get("content-type"), /image\/png/);
  const bytes = Buffer.from(await fileResult.arrayBuffer());
  assert.deepEqual(bytes, PNG_BYTES);

  const missing = await fetch(`${baseUrl}/uploads/avatars/does-not-exist.png`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type"), /application\/json/);

  const traversal = await fetch(
    `${baseUrl}/uploads/avatars/..%2f..%2fdata%2fnovaspeak-test.db`
  );
  assert.equal([403, 404].includes(traversal.status), true);
  assert.doesNotMatch(await traversal.text(), /SQLite/i);

  const outsideAvatars = await fetch(`${baseUrl}/uploads/secret.txt`);
  assert.equal(outsideAvatars.status, 404);
  assert.match(outsideAvatars.headers.get("content-type"), /application\/json/);
});

// ---------- 旧头像清理 ----------

test("上传新头像会清理旧头像文件", async () => {
  const oldPath = dbAvatarPath("admin-id");
  const oldFile = avatarFileOnDisk(oldPath);
  assert.equal(fs.existsSync(oldFile), true);

  const result = await api("POST", "/api/me/avatar", {
    cookie: adminCookie,
    body: uploadBody(makeJpegBytes(), "image/jpeg"),
  });
  assert.equal(result.status, 200);

  const newPath = dbAvatarPath("admin-id");
  assert.notEqual(newPath, oldPath);
  assert.match(newPath, /\.jpg$/);
  assert.equal(fs.existsSync(avatarFileOnDisk(newPath)), true);
  assert.equal(fs.existsSync(oldFile), false);
});

// ---------- 删除头像 ----------

test("Guest 删除头像返回 403，未登录返回 401", async () => {
  const guestResult = await api("DELETE", "/api/me/avatar", { cookie: guestCookie });
  assert.equal(guestResult.status, 403);
  const anonymousResult = await api("DELETE", "/api/me/avatar");
  assert.equal(anonymousResult.status, 401);
});

test("删除头像清空数据库字段并删除文件，不影响其他成员", async () => {
  // member2 也有头像，用于确认互不影响
  const member2Upload = await api("POST", "/api/me/avatar", {
    cookie: member2Cookie,
    body: uploadBody(PNG_BYTES, "image/png"),
  });
  assert.equal(member2Upload.status, 200);
  const member2Path = dbAvatarPath("member2-id");

  const memberPath = dbAvatarPath("member-id");
  const memberFile = avatarFileOnDisk(memberPath);
  assert.equal(fs.existsSync(memberFile), true);

  const result = await api("DELETE", "/api/me/avatar", { cookie: memberCookie });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.user.avatarUrl, null);
  assert.equal(dbAvatarPath("member-id"), null);
  assert.equal(fs.existsSync(memberFile), false);

  // 只能删除自己的头像：member 的删除不影响 member2
  assert.equal(dbAvatarPath("member2-id"), member2Path);
  assert.equal(fs.existsSync(avatarFileOnDisk(member2Path)), true);

  const me = await api("GET", "/api/auth/me", { cookie: memberCookie });
  assert.equal(me.json.user.avatarUrl, null);
});

test("头像文件已不存在时删除不报 500，重复删除也安全", async () => {
  const upload = await api("POST", "/api/me/avatar", {
    cookie: memberCookie,
    body: uploadBody(PNG_BYTES, "image/png"),
  });
  assert.equal(upload.status, 200);
  const storedPath = dbAvatarPath("member-id");
  await fsPromises.rm(avatarFileOnDisk(storedPath));

  const result = await api("DELETE", "/api/me/avatar", { cookie: memberCookie });
  assert.equal(result.status, 200);
  assert.equal(dbAvatarPath("member-id"), null);

  // 没有头像时再次删除仍然成功
  const again = await api("DELETE", "/api/me/avatar", { cookie: memberCookie });
  assert.equal(again.status, 200);
  assert.equal(again.json.user.avatarUrl, null);
});

// ---------- 数据库迁移 ----------

test("旧数据库 migration 自动补 avatar_path，旧用户 avatarUrl 为 null", () => {
  const legacyDb = new Database(path.join(tempRoot, "legacy.db"));
  legacyDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL
    );
  `);
  legacyDb
    .prepare("INSERT INTO users (id, username, username_key, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-id", "OLD01", "old01", "OLD01", "legacy-hash", "member", now);

  migrateAvatarColumn(legacyDb);
  migrateAvatarColumn(legacyDb);

  const columns = legacyDb.prepare("PRAGMA table_info(users)").all();
  assert.equal(columns.filter((column) => column.name === "avatar_path").length, 1);

  const legacyUser = legacyDb.prepare("SELECT * FROM users WHERE id = 'legacy-id'").get();
  assert.equal(legacyUser.avatar_path, null);
  assert.equal(legacyUser.username, "OLD01");
  assert.equal(legacyUser.role, "member");
  assert.equal(toPublicUser(legacyUser).avatarUrl, null);
  legacyDb.close();
});
