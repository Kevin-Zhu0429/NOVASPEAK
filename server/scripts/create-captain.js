import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import {
  stdin as input,
  stdout as output,
} from "node:process";

import db from "../db.js";
import { hashPassword } from "../auth-utils.js";

const rl = readline.createInterface({
  input,
  output,
});

function normalizeMemberId(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
}

function validateMemberId(memberId) {
  return /^[A-Za-z0-9_-]{3,32}$/.test(memberId);
}

try {
  console.log("");
  console.log("=== NovaSpeak 创建初始队长账号 ===");
  console.log("");

  const memberId = (
    await rl.question(
      "请输入队长成员 ID，例如 NOVA001："
    )
  )
    .normalize("NFKC")
    .trim();

  if (!validateMemberId(memberId)) {
    throw new Error(
      "成员 ID 必须为 3—32 位，只能包含字母、数字、下划线和短横线"
    );
  }

  const displayName = (
    await rl.question(
      "请输入队长显示名称，例如 Shawn："
    )
  )
    .normalize("NFKC")
    .trim();

  if (
    displayName.length < 1 ||
    displayName.length > 30
  ) {
    throw new Error(
      "显示名称必须为 1—30 个字符"
    );
  }

  const password = await rl.question(
    "请输入登录密码（至少 8 位）："
  );

  if (
    password.length < 8 ||
    password.length > 128
  ) {
    throw new Error(
      "密码长度必须为 8—128 位"
    );
  }

  const confirmPassword = await rl.question(
    "请再次输入密码："
  );

  if (password !== confirmPassword) {
    throw new Error("两次输入的密码不一致");
  }

  const usernameKey = normalizeMemberId(memberId);

  const existingUser = db
    .prepare(`
      SELECT id, username
      FROM users
      WHERE username_key = ?
    `)
    .get(usernameKey);

  if (existingUser) {
    throw new Error(
      `成员 ID ${memberId} 已经存在`
    );
  }

  const existingCaptain = db
    .prepare(`
      SELECT id, username
      FROM users
      WHERE role = 'admin'
      LIMIT 1
    `)
    .get();

  if (existingCaptain) {
    throw new Error(
      `已经存在队长账号：${existingCaptain.username}`
    );
  }

  console.log("");
  console.log("正在生成密码哈希……");

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO users (
      id,
      username,
      username_key,
      password_hash,
      role,
      created_at,
      display_name
    )
    VALUES (
      @id,
      @username,
      @usernameKey,
      @passwordHash,
      'admin',
      @createdAt,
      @displayName
    )
  `).run({
    id: userId,
    username: memberId,
    usernameKey,
    passwordHash,
    createdAt,
    displayName,
  });

  console.log("");
  console.log("✅ 队长账号创建成功");
  console.log(`成员 ID：${memberId}`);
  console.log(`显示名称：${displayName}`);
  console.log("身份：队长");
  console.log("");
  console.log(
    "请妥善保存密码，数据库中不会保存密码明文。"
  );
} catch (error) {
  console.error("");
  console.error(`❌ 创建失败：${error.message}`);
} finally {
  rl.close();
  db.close();
}