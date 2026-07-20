import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createChatAttachmentStore,
  decodeChatAttachmentName,
  inspectChatAttachment,
} from "./attachments.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("聊天附件：规范化文件名、拒绝危险类型和伪造图片", () => {
  assert.equal(decodeChatAttachmentName(encodeURIComponent("../截图.png")), "截图.png");
  assert.equal(inspectChatAttachment({ encodedName: "shot.png", data: png }).mimeType, "image/png");
  assert.throws(
    () => inspectChatAttachment({ encodedName: "page.html", data: Buffer.from("<html>") }),
    (error) => error.code === "CHAT_ATTACHMENT_TYPE_UNSUPPORTED"
  );
  assert.throws(
    () => inspectChatAttachment({ encodedName: "fake.png", data: Buffer.from("not png") }),
    (error) => error.code === "CHAT_ATTACHMENT_IMAGE_INVALID"
  );
});

test("聊天附件：随机存储名不含原文件名，路径校验和删除均安全", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-chat-files-"));
  try {
    const store = createChatAttachmentStore({
      attachmentsDirectory: root,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });
    const saved = store.save({ encodedName: encodeURIComponent("我的截图.png"), data: png });
    assert.equal(saved.storageName, "12345678123412341234123456789abc.png");
    assert.equal(saved.originalName, "我的截图.png");
    assert.equal(fs.readFileSync(store.getFilePath(saved.storageName)).equals(png), true);
    assert.equal(store.getFilePath("../secret.png"), null);
    assert.equal(store.remove(saved.storageName), true);
    assert.equal(store.getFilePath(saved.storageName), null);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
