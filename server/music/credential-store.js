// 网易云凭据加密存储：AES-256-GCM + 随机 IV，密钥来自环境变量
// MUSIC_CREDENTIAL_KEY（base64 编码的 32 字节随机密钥）。
// 未配置密钥时音乐功能整体不可用，但不得影响 NOVASPEAK 其他功能启动。
// 本模块不得记录明文凭据、密钥或密文内容。

import crypto from "node:crypto";

export const MUSIC_NOT_CONFIGURED = "MUSIC_NOT_CONFIGURED";

const KEY_ENV_NAME = "MUSIC_CREDENTIAL_KEY";
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;

export class MusicConfigError extends Error {
  constructor(message = "音乐功能尚未配置") {
    super(message);
    this.name = "MusicConfigError";
    this.code = MUSIC_NOT_CONFIGURED;
  }
}

/**
 * 严格读取加密密钥：必须是 base64 且解码后正好 32 字节，否则视为未配置。
 * 绝不提供硬编码默认密钥。
 */
export function readMusicCredentialKey(env = process.env) {
  const raw = env?.[KEY_ENV_NAME];
  if (typeof raw !== "string" || !raw.trim()) return null;

  let key;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch {
    return null;
  }

  if (key.length !== KEY_BYTE_LENGTH) return null;
  return key;
}

export function isMusicCredentialConfigured(env = process.env) {
  return readMusicCredentialKey(env) !== null;
}

/**
 * AES-256-GCM 加密。每次调用生成新的随机 IV。
 *
 * @returns {{ ciphertext: string, iv: string, authTag: string }} base64 三元组
 */
export function encryptMusicCredential(plaintext, env = process.env) {
  if (typeof plaintext !== "string" || !plaintext) {
    throw new TypeError("待加密凭据必须是非空字符串");
  }

  const key = readMusicCredentialKey(env);
  if (!key) throw new MusicConfigError();

  const iv = crypto.randomBytes(IV_BYTE_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * AES-256-GCM 解密。密文、IV 或 auth tag 被篡改时抛出异常。
 */
export function decryptMusicCredential(record, env = process.env) {
  if (
    !record ||
    typeof record.ciphertext !== "string" ||
    typeof record.iv !== "string" ||
    typeof record.authTag !== "string"
  ) {
    throw new TypeError("加密记录格式无效");
  }

  const key = readMusicCredentialKey(env);
  if (!key) throw new MusicConfigError();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(record.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
