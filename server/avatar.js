import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 头像原始图片最大 2MB（解码后大小）
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// JSON base64 请求体上限：2MB 图片 base64 后约 2.7MB，留出 JSON 包装余量
export const AVATAR_UPLOAD_BODY_LIMIT = "4mb";

// base64 字符串长度上限（对应 2MB 原始数据），超过直接拒绝，避免无谓解码
const AVATAR_MAX_BASE64_LENGTH = Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4;

// 只允许三种位图格式；不允许 SVG / GIF
const AVATAR_MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const AVATAR_FILE_NAME_PATTERN = /^[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * 通过 magic bytes 检测真实图片类型。
 * 不信任客户端提交的 mimeType。
 */
export function detectAvatarImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return null;
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  return null;
}

/**
 * 校验并解码 { imageBase64, mimeType } 上传体。
 * 返回 { buffer, extension } 或 { status, error }。
 */
export function decodeAvatarUpload(body) {
  const imageBase64 = body?.imageBase64;
  const mimeType = body?.mimeType;

  if (typeof imageBase64 !== "string" || !imageBase64.trim()) {
    return { status: 400, error: "请提供头像图片数据" };
  }

  if (
    typeof mimeType !== "string" ||
    !Object.hasOwn(AVATAR_MIME_EXTENSIONS, mimeType)
  ) {
    return { status: 400, error: "头像仅支持 JPG、PNG、WebP 格式" };
  }

  let base64Text = imageBase64.trim();

  // 兼容 data URL 前缀（data:image/png;base64,....）
  const dataUrlMatch = /^data:[A-Za-z0-9./+-]+;base64,/.exec(base64Text);
  if (dataUrlMatch) {
    base64Text = base64Text.slice(dataUrlMatch[0].length);
  }

  base64Text = base64Text.replace(/\s+/g, "");

  if (base64Text.length > AVATAR_MAX_BASE64_LENGTH) {
    return { status: 413, error: "头像文件不能超过 2MB" };
  }

  if (
    !base64Text ||
    base64Text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)
  ) {
    return { status: 400, error: "头像图片数据无效" };
  }

  const buffer = Buffer.from(base64Text, "base64");

  if (buffer.length === 0) {
    return { status: 400, error: "头像图片不能为空" };
  }

  if (buffer.length > AVATAR_MAX_BYTES) {
    return { status: 413, error: "头像文件不能超过 2MB" };
  }

  const detectedType = detectAvatarImageType(buffer);

  if (!detectedType) {
    return { status: 400, error: "头像必须是有效的 JPG、PNG 或 WebP 图片" };
  }

  if (detectedType !== mimeType) {
    return { status: 400, error: "头像图片内容与声明的格式不一致" };
  }

  return {
    buffer,
    extension: AVATAR_MIME_EXTENSIONS[detectedType],
  };
}

/**
 * 数据库保存的相对路径（avatars/<file>）转换为公开 URL。
 * 非法或缺失时返回 null，绝不返回磁盘路径。
 */
export function avatarUrlFromPath(avatarPath) {
  if (typeof avatarPath !== "string" || !avatarPath) {
    return null;
  }

  const fileName = avatarPath.startsWith("avatars/")
    ? avatarPath.slice("avatars/".length)
    : avatarPath;

  if (!AVATAR_FILE_NAME_PATTERN.test(fileName)) {
    return null;
  }

  return `/uploads/avatars/${fileName}`;
}

/**
 * 兼容旧数据库：为 users 表增加 avatar_path 字段。可重复执行。
 */
export function migrateAvatarColumn(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all();

  const hasAvatarPath = columns.some(
    (column) => column.name === "avatar_path"
  );

  if (!hasAvatarPath) {
    db.exec(`
      ALTER TABLE users
      ADD COLUMN avatar_path TEXT
    `);

    console.log("Database migration: added users.avatar_path");
  }
}

/**
 * 头像存储服务：文件名随机生成，客户端不能控制最终路径。
 */
export function createAvatarService({ db, avatarsDirectory }) {
  fs.mkdirSync(avatarsDirectory, { recursive: true });

  function resolveStoredAvatarFile(avatarPath) {
    if (typeof avatarPath !== "string" || !avatarPath) {
      return null;
    }

    const fileName = avatarPath.startsWith("avatars/")
      ? avatarPath.slice("avatars/".length)
      : avatarPath;

    if (!AVATAR_FILE_NAME_PATTERN.test(fileName)) {
      return null;
    }

    return path.join(avatarsDirectory, fileName);
  }

  // 删除头像文件；文件不存在不算错误，其余失败只记录日志
  function removeAvatarFile(avatarPath, context) {
    const filePath = resolveStoredAvatarFile(avatarPath);

    if (!filePath) {
      return;
    }

    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error(
          `删除头像文件失败（${context}）：`,
          error?.code || error?.message
        );
      }
    }
  }

  function saveAvatarForUser(userId, body) {
    const decoded = decodeAvatarUpload(body);

    if (decoded.error) {
      return decoded;
    }

    const row = db.prepare(`
      SELECT avatar_path
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!row) {
      return { status: 401, error: "正式成员账号不存在或已失效" };
    }

    const fileName = `${crypto.randomBytes(16).toString("hex")}.${decoded.extension}`;
    const filePath = path.join(avatarsDirectory, fileName);
    const storedPath = `avatars/${fileName}`;

    try {
      fs.writeFileSync(filePath, decoded.buffer, { flag: "wx" });
    } catch (error) {
      console.error("保存头像文件失败：", error?.code || error?.message);
      return { status: 500, error: "保存头像失败，请稍后重试" };
    }

    try {
      const result = db.prepare(`
        UPDATE users
        SET avatar_path = ?
        WHERE id = ?
      `).run(storedPath, userId);

      if (result.changes !== 1) {
        throw new Error("avatar owner missing");
      }
    } catch (error) {
      // 数据库更新失败：删除刚写入的新文件，避免孤儿文件
      removeAvatarFile(storedPath, "回滚新头像");
      console.error("更新头像数据库字段失败：", error?.message);
      return { status: 500, error: "保存头像失败，请稍后重试" };
    }

    // 新头像已生效后再清理旧文件；清理失败不影响上传结果
    if (row.avatar_path && row.avatar_path !== storedPath) {
      removeAvatarFile(row.avatar_path, "清理旧头像");
    }

    return {
      avatarPath: storedPath,
      avatarUrl: avatarUrlFromPath(storedPath),
    };
  }

  function deleteAvatarForUser(userId) {
    const row = db.prepare(`
      SELECT avatar_path
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!row) {
      return { status: 401, error: "正式成员账号不存在或已失效" };
    }

    try {
      db.prepare(`
        UPDATE users
        SET avatar_path = NULL
        WHERE id = ?
      `).run(userId);
    } catch (error) {
      console.error("清除头像数据库字段失败：", error?.message);
      return { status: 500, error: "删除头像失败，请稍后重试" };
    }

    if (row.avatar_path) {
      removeAvatarFile(row.avatar_path, "删除头像");
    }

    return { success: true };
  }

  return {
    avatarsDirectory,
    saveAvatarForUser,
    deleteAvatarForUser,
  };
}
