export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_PER_SEND = 5;

const SUPPORTED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "gif",
  "pdf", "txt", "md", "log", "csv", "json",
  "zip", "7z", "rar", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm",
]);

export const CHAT_ATTACHMENT_ACCEPT = [...SUPPORTED_EXTENSIONS].map((extension) => `.${extension}`).join(",");

function fileExtension(name) {
  if (typeof name !== "string") return "";
  const match = name.trim().toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match?.[1] || "";
}

export function validateChatAttachment(file) {
  if (!file || typeof file.name !== "string" || !Number.isFinite(file.size)) return "文件无效";
  if (file.size <= 0) return "不能发送空文件";
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) return "单个文件不能超过 20MB";
  if (!SUPPORTED_EXTENSIONS.has(fileExtension(file.name))) return "不支持这种文件类型";
  return "";
}

export function addChatAttachmentFiles(current, incoming) {
  const existing = Array.isArray(current) ? current : [];
  const additions = Array.from(incoming || []);
  const accepted = [];
  for (const file of additions) {
    const error = validateChatAttachment(file);
    if (error) return { files: existing, error: `${file?.name || "文件"}：${error}` };
    accepted.push(file);
  }
  const available = Math.max(0, MAX_CHAT_ATTACHMENTS_PER_SEND - existing.length);
  if (accepted.length > available) {
    return {
      files: [...existing, ...accepted.slice(0, available)],
      error: `每次最多发送 ${MAX_CHAT_ATTACHMENTS_PER_SEND} 个文件`,
    };
  }
  return { files: [...existing, ...accepted], error: "" };
}

function extensionForImageMime(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export function chatImageFilesFromClipboard(items, now = Date.now()) {
  const files = [];
  let index = 0;
  for (const item of Array.from(items || [])) {
    if (item?.kind !== "file" || !String(item.type || "").startsWith("image/")) continue;
    const source = item.getAsFile?.();
    if (!source) continue;
    index += 1;
    const extension = extensionForImageMime(source.type);
    const name = `粘贴图片-${now}-${index}.${extension}`;
    files.push(typeof File === "function" ? new File([source], name, { type: source.type, lastModified: now }) : source);
  }
  return files;
}

export function formatChatAttachmentSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasUnsafeUrlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function normalizeChatAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType.trim().toLowerCase() : "";
  const size = Number(raw.size);
  if (
    !url.startsWith("/api/channels/") ||
    !url.includes("/messages/attachments/") ||
    hasUnsafeUrlCharacters(url) ||
    !name ||
    name.length > 180 ||
    !mimeType ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > MAX_CHAT_ATTACHMENT_BYTES
  ) return null;
  return {
    url,
    name,
    mimeType,
    size,
    kind: mimeType.startsWith("image/") ? "image" : "file",
  };
}
