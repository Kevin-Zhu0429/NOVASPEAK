import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scryptCallback);

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_FORMAT = "scrypt-v1";

/**
 * 生成密码哈希。
 * 数据库只保存哈希和随机盐，不保存原始密码。
 */
export async function hashPassword(password) {
  if (typeof password !== "string") {
    throw new TypeError("Password must be a string");
  }

  const salt = randomBytes(16).toString("hex");

  const derivedKey = await scryptAsync(
    password,
    salt,
    PASSWORD_KEY_LENGTH
  );

  return [
    PASSWORD_FORMAT,
    salt,
    Buffer.from(derivedKey).toString("hex"),
  ].join("$");
}

/**
 * 验证用户输入的密码。
 */
export async function verifyPassword(password, storedPasswordHash) {
  try {
    if (
      typeof password !== "string" ||
      typeof storedPasswordHash !== "string"
    ) {
      return false;
    }

    const [format, salt, storedHashHex] =
      storedPasswordHash.split("$");

    if (
      format !== PASSWORD_FORMAT ||
      !salt ||
      !storedHashHex
    ) {
      return false;
    }

    const storedHash = Buffer.from(storedHashHex, "hex");

    const derivedKey = Buffer.from(
      await scryptAsync(
        password,
        salt,
        storedHash.length
      )
    );

    if (storedHash.length !== derivedKey.length) {
      return false;
    }

    return timingSafeEqual(storedHash, derivedKey);
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}

/**
 * 创建浏览器登录会话所使用的随机令牌。
 */
export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * 数据库只保存会话令牌的 SHA-256 哈希。
 */
export function hashSessionToken(token) {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}