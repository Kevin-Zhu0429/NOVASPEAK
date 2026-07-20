import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  addChatAttachmentFiles,
  chatImageFilesFromClipboard,
  formatChatAttachmentSize,
  normalizeChatAttachment,
  validateChatAttachment,
} from "./chat-attachments.js";

function file(name, size = 10, type = "application/octet-stream") {
  return { name, size, type, lastModified: 1 };
}

test("附件选择限制类型、大小和每次五个", () => {
  assert.equal(validateChatAttachment(file("photo.png")), "");
  assert.equal(validateChatAttachment(file("run.exe")), "不支持这种文件类型");
  assert.equal(validateChatAttachment(file("large.zip", MAX_CHAT_ATTACHMENT_BYTES + 1)), "单个文件不能超过 20MB");
  const result = addChatAttachmentFiles([], Array.from({ length: 6 }, (_, index) => file(`${index}.txt`)));
  assert.equal(result.files.length, 5);
  assert.match(result.error, /最多发送 5 个/);
});

test("剪贴板图片会转换为带安全扩展名的待发送文件", () => {
  const source = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  const files = chatImageFilesFromClipboard([{
    kind: "file",
    type: "image/png",
    getAsFile: () => source,
  }], 12345);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "粘贴图片-12345-1.png");
  assert.equal(files[0].type, "image/png");
});

test("附件公开结构只接受受控频道 URL，并安全格式化大小", () => {
  assert.deepEqual(normalizeChatAttachment({
    url: "/api/channels/cs2/messages/attachments/abc.pdf",
    name: "说明.pdf",
    mimeType: "application/pdf",
    size: 2048,
  }), {
    url: "/api/channels/cs2/messages/attachments/abc.pdf",
    name: "说明.pdf",
    mimeType: "application/pdf",
    size: 2048,
    kind: "file",
  });
  assert.equal(normalizeChatAttachment({ url: "https://evil.example/x", name: "x.pdf", mimeType: "application/pdf", size: 1 }), null);
  assert.equal(formatChatAttachmentSize(2048), "2.0 KB");
});
