import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  backupBeforeUserRoleMigration,
  migrateUserRoles,
  userRoleSupportsOrdinaryUser,
} from "./role-migrate.js";

test("role migration creates a readable backup before rebuilding an existing database", async () => {
  const tempDirectory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "novaspeak-role-backup-")
  );
  const databasePath = path.join(tempDirectory, "novaspeak.db");
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
        created_at INTEGER NOT NULL,
        display_name TEXT,
        position TEXT NOT NULL DEFAULT 'member',
        avatar_path TEXT
      );
      INSERT INTO users VALUES (
        'u1', 'Admin', 'admin', 'hash', 'admin', 1, 'Admin', 'captain', NULL
      );
    `);

    const result = await backupBeforeUserRoleMigration(db, {
      databasePath,
      preExistingDatabase: true,
    });
    assert.equal(result.backedUp, true);
    assert.equal(path.dirname(result.backupPath), path.join(tempDirectory, "backups"));

    const backup = new Database(result.backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.deepEqual(
        backup.prepare("SELECT id, role FROM users").get(),
        { id: "u1", role: "admin" }
      );
      assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      backup.close();
    }
  } finally {
    db.close();
    await fsPromises.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("role migration preserves users and allows only formal roles", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      created_at INTEGER NOT NULL,
      display_name TEXT,
      position TEXT NOT NULL DEFAULT 'member',
      avatar_path TEXT
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users VALUES (
      'u1', 'Admin', 'admin', 'hash', 'admin', 1, 'Admin', 'captain', NULL
    );
    INSERT INTO sessions VALUES ('token', 'u1', 2, 1);
  `);
  assert.equal(userRoleSupportsOrdinaryUser(db), false);
  migrateUserRoles(db);
  assert.equal(userRoleSupportsOrdinaryUser(db), true);
  assert.equal(db.prepare("SELECT role FROM users WHERE id = 'u1'").get().role, "admin");
  assert.equal(db.prepare("SELECT user_id FROM sessions").get().user_id, "u1");
  db.prepare(`
    INSERT INTO users VALUES (
      'u2', 'User', 'user', 'hash', 'user', 1, 'User', 'member', NULL
    )
  `).run();
  assert.throws(() => db.prepare(`
    INSERT INTO users VALUES (
      'g1', 'Guest', 'guest', 'hash', 'guest', 1, 'Guest', 'member', NULL
    )
  `).run(), /constraint/i);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(db.pragma("foreign_key_check").length, 0);
  assert.doesNotThrow(() => migrateUserRoles(db));
  db.close();
});
