import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateChatMessages } from "./migrate.js";
import {
  getChatHistoryLimit,
  listRecentChannelMessages,
  normalizeChatText,
  saveChannelMessage,
} from "./messages.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.prepare("INSERT INTO channels VALUES (?, ?)").run("lobby", "大厅");
  migrateChatMessages(db);
  return db;
}

test("聊天迁移可重复执行且频道删除级联清理", () => {
  const db = createDb();
  migrateChatMessages(db);
  saveChannelMessage(db, {
    channelId: "lobby",
    senderPrincipalKey: "user:1",
    senderDisplayName: "成员",
    text: "消息",
  });
  db.prepare("DELETE FROM channels WHERE id = ?").run("lobby");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM channel_messages").get().count, 0);
  db.close();
});

test("每频道只保留配置数量并按时间顺序返回", () => {
  const db = createDb();
  for (let index = 1; index <= 105; index += 1) {
    saveChannelMessage(db, {
      channelId: "lobby",
      senderPrincipalKey: "user:1",
      senderDisplayName: "成员",
      text: `消息${index}`,
      historyLimit: 100,
      now: index,
    });
  }
  const rows = listRecentChannelMessages(db, { channelId: "lobby", limit: 500 });
  assert.equal(rows.length, 100);
  assert.equal(rows[0].text, "消息6");
  assert.equal(rows.at(-1).text, "消息105");
  assert.deepEqual(rows.map((row) => row.createdAt), Array.from({ length: 100 }, (_, index) => index + 6));
  db.close();
});

test("公开消息不包含内部 principal key", () => {
  const db = createDb();
  const message = saveChannelMessage(db, {
    channelId: "lobby",
    senderPrincipalKey: "guest:secret-uuid",
    senderDisplayName: "访客",
    text: "你好",
    now: 123,
  });
  assert.deepEqual(message, {
    id: "1",
    channelId: "lobby",
    sender: "访客",
    text: "你好",
    createdAt: 123,
  });
  assert.equal(JSON.stringify(message).includes("secret-uuid"), false);
  db.close();
});

test("历史数量配置限制在 100～500，非法值使用 300", () => {
  assert.equal(getChatHistoryLimit({ CHAT_HISTORY_LIMIT: "100" }), 100);
  assert.equal(getChatHistoryLimit({ CHAT_HISTORY_LIMIT: "1" }), 100);
  assert.equal(getChatHistoryLimit({ CHAT_HISTORY_LIMIT: "999" }), 500);
  assert.equal(getChatHistoryLimit({ CHAT_HISTORY_LIMIT: "bad" }), 300);
  assert.equal(getChatHistoryLimit({}), 300);
});

test("消息规范化拒绝空白、非字符串和超长内容", () => {
  assert.equal(normalizeChatText("  hello  "), "hello");
  assert.equal(normalizeChatText("   "), null);
  assert.equal(normalizeChatText(null), null);
  assert.equal(normalizeChatText("x".repeat(2001)), null);
});
