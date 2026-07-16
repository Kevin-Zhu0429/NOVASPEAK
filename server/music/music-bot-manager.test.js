import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createMusicBotManager } from "./music-bot-manager.js";
import { migrateMusicQueue } from "./queue-migrate.js";

function makeDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL);");
  db.exec("CREATE TABLE netease_accounts (principal_key TEXT PRIMARY KEY, encrypted_cookie TEXT, cookie_iv TEXT, cookie_auth_tag TEXT, netease_user_id TEXT, nickname TEXT, avatar_url TEXT, credential_expires_at TEXT);");
  migrateMusicQueue(db);
  db.prepare("INSERT INTO channels (id, name) VALUES ('c1','C1'),('c2','C2')").run();
  return db;
}

function enqueue(db, channel, principal, song) {
  db.prepare("INSERT OR IGNORE INTO music_queue_buckets (channel_id, principal_key, bucket_order, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(bucket_order),0)+1 FROM music_queue_buckets WHERE channel_id=?), 1)").run(channel, principal, channel);
  db.prepare("INSERT INTO music_queue_items (channel_id, principal_key, requester_display_name, song_id, song_name, artists_json, duration_ms, status, added_at) VALUES (?, ?, ?, ?, ?, '[]', 1, 'pending', 1)").run(channel, principal, principal, song, song);
}

test("manager does not claim without real in-channel users", () => {
  const db = makeDb(); enqueue(db, "c1", "A", "A1");
  const manager = createMusicBotManager({ db, neteaseClient: {}, presenceService: { hasUsersInChannel: () => false }, scanIntervalMs: 999999 });
  manager.kick("c1");
  assert.equal(db.prepare("SELECT status FROM music_queue_items").get().status, "pending");
});

test("manager keeps one worker per channel", () => {
  const db = makeDb(); enqueue(db, "c1", "A", "A1");
  const manager = createMusicBotManager({ db, neteaseClient: {}, presenceService: { hasUsersInChannel: () => true }, createSession: () => ({ connect: async () => {}, close: async () => {} }), scanIntervalMs: 999999 });
  assert.equal(manager.kick("c1"), true);
  assert.equal(manager.kick("c1"), false);
  assert.equal(manager._workers.size, 1);
});
