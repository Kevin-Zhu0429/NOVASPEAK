import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const CHAT_ATTACHMENT_BODY_LIMIT = "20mb";
export const MAX_CHAT_ATTACHMENT_NAME_LENGTH = 180;

const FILE_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".zip", "application/zip"],
  [".7z", "application/x-7z-compressed"],
  [".rar", "application/vnd.rar"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const STORAGE_NAME_PATTERN = /^[a-f0-9]{32}\.[a-z0-9]{1,5}$/;

function attachmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isWebp(buffer) {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function isGif(buffer) {
  if (buffer.length < 6) return false;
  const signature = buffer.toString("ascii", 0, 6);
  return signature === "GIF87a" || signature === "GIF89a";
}

function detectedImageMime(buffer) {
  if (isJpeg(buffer)) return "image/jpeg";
  if (isPng(buffer)) return "image/png";
  if (isWebp(buffer)) return "image/webp";
  if (isGif(buffer)) return "image/gif";
  return null;
}

export function decodeChatAttachmentName(value) {
  if (typeof value !== "string" || !value || value.length > 720) {
    throw attachmentError("CHAT_ATTACHMENT_NAME_INVALID", "文件名无效");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw attachmentError("CHAT_ATTACHMENT_NAME_INVALID", "文件名无效");
  }
  const normalized = decoded.normalize("NFKC").replaceAll("\\", "/");
  const baseName = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!baseName || baseName === "." || baseName === ".." || baseName.length > MAX_CHAT_ATTACHMENT_NAME_LENGTH) {
    throw attachmentError("CHAT_ATTACHMENT_NAME_INVALID", "文件名无效");
  }
  return baseName;
}

export function inspectChatAttachment({ encodedName, data }) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw attachmentError("CHAT_ATTACHMENT_EMPTY", "文件不能为空");
  }
  if (data.length > MAX_CHAT_ATTACHMENT_BYTES) {
    throw attachmentError("CHAT_ATTACHMENT_TOO_LARGE", "单个文件不能超过 20MB");
  }
  const originalName = decodeChatAttachmentName(encodedName);
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = FILE_TYPES.get(extension);
  if (!mimeType) {
    throw attachmentError("CHAT_ATTACHMENT_TYPE_UNSUPPORTED", "不支持这种文件类型");
  }
  const image = IMAGE_EXTENSIONS.has(extension);
  if (image) {
    const detected = detectedImageMime(data);
    const expected = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : mimeType;
    if (detected !== expected) {
      throw attachmentError("CHAT_ATTACHMENT_IMAGE_INVALID", "图片内容与文件类型不一致");
    }
  }
  return {
    originalName,
    extension: extension === ".jpeg" ? ".jpg" : extension,
    mimeType: extension === ".jpeg" ? "image/jpeg" : mimeType,
    size: data.length,
    kind: image ? "image" : "file",
  };
}

export function createChatAttachmentStore({ attachmentsDirectory, randomUUID = crypto.randomUUID } = {}) {
  if (typeof attachmentsDirectory !== "string" || !path.isAbsolute(attachmentsDirectory)) {
    throw new TypeError("attachmentsDirectory must be an absolute path");
  }
  fs.mkdirSync(attachmentsDirectory, { recursive: true });

  function resolveStoragePath(storageName) {
    if (typeof storageName !== "string" || !STORAGE_NAME_PATTERN.test(storageName)) return null;
    const resolved = path.resolve(attachmentsDirectory, storageName);
    if (path.dirname(resolved) !== path.resolve(attachmentsDirectory)) return null;
    return resolved;
  }

  function save({ encodedName, data }) {
    const metadata = inspectChatAttachment({ encodedName, data });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const storageName = `${randomUUID().replaceAll("-", "").toLowerCase()}${metadata.extension}`;
      const filePath = resolveStoragePath(storageName);
      if (!filePath) continue;
      try {
        fs.writeFileSync(filePath, data, { flag: "wx", mode: 0o600 });
        return { ...metadata, storageName };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw attachmentError("CHAT_ATTACHMENT_STORE_FAILED", "保存文件失败");
  }

  function remove(storageName) {
    const filePath = resolveStoragePath(storageName);
    if (!filePath) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      console.error("Chat attachment cleanup failed:", error?.code || "unknown error");
      return false;
    }
  }

  function getFilePath(storageName) {
    const filePath = resolveStoragePath(storageName);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return filePath;
  }

  return { attachmentsDirectory, save, remove, getFilePath };
}

export function contentDispositionFileName(fileName) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
