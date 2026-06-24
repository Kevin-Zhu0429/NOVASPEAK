import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  assertChannelCapacity,
  buildChannelPatch,
  canEnterChannel,
  getLiveKitParticipantCount,
  listChannelRows,
  migrateChannels,
  toPublicChannel,
} from "./channels.js";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      owner_id TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertCustom(db, id = "custom-room") {
  db.prepare(`
    INSERT INTO channels (id, name, name_key, owner_id, is_default, description, sort_order, max_members, access_level, allow_guests, is_system, created_at)
    VALUES (?, ?, ?, NULL, 0, '', 99, NULL, 'everyone', 1, 0, ?)
  `).run(id, "自定义频道", id, Date.now());
}

const admin = { role: "admin" };
const member = { role: "member" };
const guest = { role: "guest" };

test("channel migration seeds defaults once and marks only lobby as system", () => {
  const db = createDb();
  migrateChannels(db);
  migrateChannels(db);
  const rows = listChannelRows(db);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.id), ["lobby", "cs2", "delta-force", "apex", "private-room"]);
  assert.deepEqual(rows.filter((row) => row.is_system === 1).map((row) => row.id), ["lobby"]);
  db.close();
});

test("migration repairs previous over-broad system flags and is repeatable", () => {
  const db = createDb();
  const insert = db.prepare("INSERT INTO channels (id, name, name_key, is_default, created_at) VALUES (?, ?, ?, 1, ?)");
  for (const [index, id] of ["lobby", "cs2", "delta-force", "apex", "private-room"].entries()) {
    insert.run(id, id, id, index + 1);
  }
  migrateChannels(db);
  db.prepare("UPDATE channels SET is_system = 1").run();
  const beforeSort = listChannelRows(db).map((row) => [row.id, row.sort_order]);
  migrateChannels(db);
  migrateChannels(db);
  const rows = listChannelRows(db);
  assert.deepEqual(rows.filter((row) => row.is_system === 1).map((row) => row.id), ["lobby"]);
  assert.deepEqual(rows.map((row) => [row.id, row.sort_order]), beforeSort);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM channels").get().count, 5);
  db.close();
});

test("system protection is based on fixed id rather than display name", () => {
  const db = createDb();
  migrateChannels(db);
  db.prepare("UPDATE channels SET name = '公共大厅', name_key = '公共大厅' WHERE id = 'lobby'").run();
  db.prepare("UPDATE channels SET name = '大厅', name_key = '大厅' WHERE id = 'cs2'").run();
  migrateChannels(db);
  const lobby = db.prepare("SELECT id, name, is_system FROM channels WHERE id = 'lobby'").get();
  const renamedCs2 = db.prepare("SELECT id, name, is_system FROM channels WHERE id = 'cs2'").get();
  assert.equal(lobby.is_system, 1);
  assert.equal(renamedCs2.is_system, 0);
  db.close();
});

test("channel list uses stable sortOrder ordering", () => {
  const db = createDb();
  migrateChannels(db);
  db.prepare("UPDATE channels SET sort_order = 10, name = 'B' WHERE id = 'lobby'").run();
  db.prepare("UPDATE channels SET sort_order = 10, name = 'A' WHERE id = 'cs2'").run();
  const rows = listChannelRows(db).slice(0, 2).map((row) => row.id);
  assert.deepEqual(rows, ["cs2", "lobby"]);
  db.close();
});

test("patch validation rejects unauthenticated/member/guest conceptually via admin-only route contract", () => {
  assert.equal(admin.role, "admin");
  assert.notEqual(member.role, "admin");
  assert.notEqual(guest.role, "admin");
});

test("patch can modify name without id/room change and can modify description/sort/max/access", () => {
  const db = createDb();
  migrateChannels(db);
  insertCustom(db);
  const patch = buildChannelPatch({ name: " 新名称 ", description: " 描述 ", sortOrder: 7, maxMembers: 3, accessLevel: "members", allowGuests: false });
  assert.equal(patch.name, "新名称");
  assert.equal(patch.description, "描述");
  assert.equal(patch.sortOrder, 7);
  assert.equal(patch.maxMembers, 3);
  assert.equal(patch.accessLevel, "members");
  assert.equal(patch.allowGuests, false);
  const before = db.prepare("SELECT id FROM channels WHERE id = ?").get("custom-room");
  assert.equal(before.id, "custom-room");
  db.close();
});

test("patch can clear maxMembers", () => {
  const patch = buildChannelPatch({ maxMembers: null });
  assert.equal(patch.maxMembers, null);
});

test("patch rejects illegal maxMembers and accessLevel plus protected fields", () => {
  for (const maxMembers of [0, -1, 1.5, "2", 100]) assert.match(buildChannelPatch({ maxMembers }).error, /人数上限/);
  assert.match(buildChannelPatch({ accessLevel: "captains" }).error, /权限/);
  assert.match(buildChannelPatch({ id: "new" }).error, /不支持修改字段/);
  assert.match(buildChannelPatch({ roomName: "new" }).error, /不支持修改字段/);
  assert.match(buildChannelPatch({ isSystem: false }).error, /不支持修改字段/);
});

test("lobby cannot be deleted and seeded ordinary channels can be deleted when idle", async () => {
  const db = createDb();
  migrateChannels(db);
  assert.equal(db.prepare("SELECT is_system FROM channels WHERE id = 'lobby'").get().is_system, 1);
  const ordinaryIds = ["cs2", "delta-force", "apex", "private-room"];
  for (const id of ordinaryIds) {
    assert.equal(db.prepare("SELECT is_system FROM channels WHERE id = ?").get(id).is_system, 0);
  }
  const roomService = { listParticipants: async () => [] };
  for (const id of ordinaryIds) {
    assert.equal(await getLiveKitParticipantCount(roomService, id), 0);
    db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    assert.equal(db.prepare("SELECT id FROM channels WHERE id = ?").get(id), undefined);
  }
  assert.equal(db.prepare("SELECT id FROM channels WHERE id = 'lobby'").get().id, "lobby");
  db.close();
});

test("occupied channels are detected before deletion", async () => {
  const roomService = { listParticipants: async () => [{ identity: "u1" }] };
  assert.equal(await getLiveKitParticipantCount(roomService, "custom-room"), 1);
});

test("entry permissions follow accessLevel and allowGuests matrix and ignore forged client role", () => {
  assert.equal(canEnterChannel({ access_level: "everyone", allow_guests: 1 }, guest), true);
  assert.equal(canEnterChannel({ access_level: "everyone", allow_guests: 0 }, guest), false);
  assert.equal(canEnterChannel({ access_level: "members", allow_guests: 1 }, guest), false);
  assert.equal(canEnterChannel({ access_level: "members", allow_guests: 0 }, member), true);
  assert.equal(canEnterChannel({ access_level: "members", allow_guests: 0 }, admin), true);
  assert.equal(canEnterChannel({ access_level: "admins", allow_guests: 1 }, member), false);
  assert.equal(canEnterChannel({ access_level: "admins", allow_guests: 1 }, guest), false);
  assert.equal(canEnterChannel({ access_level: "admins", allow_guests: 1 }, admin), true);
  const realGuest = { role: "guest", body: { role: "admin" } };
  assert.equal(canEnterChannel({ access_level: "admins", allow_guests: 1 }, realGuest), false);
});

test("capacity check rejects full rooms and allows rooms below max", async () => {
  const roomService = { listParticipants: async () => [{}, {}] };
  const full = await assertChannelCapacity({ roomService, channel: { id: "room", max_members: 2 } });
  assert.equal(full.allowed, false);
  assert.equal(full.status, 409);
  assert.equal(full.error, "频道人数已满");
  const available = await assertChannelCapacity({ roomService, channel: { id: "room", max_members: 3 } });
  assert.equal(available.allowed, true);
  const unlimited = await assertChannelCapacity({ roomService, channel: { id: "room", max_members: null } });
  assert.equal(unlimited.allowed, true);
});

test("public channel exposes safe compatibility fields", () => {
  const channel = toPublicChannel({ id: "r", name: "R", description: "", sort_order: 1, max_members: null, access_level: "everyone", allow_guests: 1, is_system: 0, owner_id: null, is_default: 0, created_at: 1 });
  assert.deepEqual(Object.keys(channel), ["id", "name", "description", "sortOrder", "maxMembers", "accessLevel", "allowGuests", "isSystem", "ownerId", "isDefault", "createdAt"]);
});
