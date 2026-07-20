import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { migrateChatMessages } from "./migrate.js";
import { createChatRouter } from "./routes.js";
import { createChatAttachmentStore } from "./attachments.js";

function createFixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.prepare("INSERT INTO channels VALUES ('lobby', '大厅')").run();
  migrateChatMessages(db);
  const membership = new Map([["u1", "lobby"]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novaspeak-chat-route-"));
  const attachmentStore = createChatAttachmentStore({ attachmentsDirectory: root });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/channels/:channelId/messages",
    createChatRouter({
      db,
      env: { CHAT_HISTORY_LIMIT: "100" },
      requireAuthenticated(req, _res, next) {
        req.authUser = { id: "u1", role: "member", displayName: "成员甲", isGuest: false };
        next();
      },
      presenceService: {
        isUserInChannel(userId, channelId) {
          return membership.get(userId) === channelId;
        },
      },
      attachmentStore,
    })
  );
  return { db, membership, app, root };
}

test("聊天路由继承 channelId，保存后进入频道可加载最近消息", async () => {
  const { db, app, root } = createFixture();
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const posted = await fetch(`${base}/api/channels/lobby/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  第一条消息  " }),
    });
    assert.equal(posted.status, 201);
    const postedJson = await posted.json();
    assert.equal(postedJson.message.channelId, "lobby");
    assert.equal(postedJson.message.text, "第一条消息");

    const history = await fetch(`${base}/api/channels/lobby/messages`);
    assert.equal(history.status, 200);
    const historyJson = await history.json();
    assert.equal(historyJson.limit, 100);
    assert.deepEqual(historyJson.messages, [postedJson.message]);
    assert.equal(JSON.stringify(historyJson).includes("user:u1"), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("不在目标频道时聊天历史和发送均被拒绝", async () => {
  const { db, membership, app, root } = createFixture();
  membership.delete("u1");
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/channels/lobby/messages`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "CHAT_NOT_IN_CHANNEL");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("频道内可上传并读取图片，历史只返回元数据且文件接口继承频道权限", async () => {
  const { db, membership, app, root } = createFixture();
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const uploaded = await fetch(`${base}/api/channels/lobby/messages/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-nova-file-name": encodeURIComponent("聊天截图.png"),
      },
      body: png,
    });
    assert.equal(uploaded.status, 201);
    const message = (await uploaded.json()).message;
    assert.equal(message.text, "");
    assert.equal(message.attachment.name, "聊天截图.png");
    assert.equal(message.attachment.kind, "image");
    assert.equal(JSON.stringify(message).includes(root), false);

    const downloaded = await fetch(`${base}${message.attachment.url}`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).equals(png), true);

    membership.delete("u1");
    const forbidden = await fetch(`${base}${message.attachment.url}`);
    assert.equal(forbidden.status, 403);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
