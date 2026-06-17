import db from "../db.js";

function normalizeNickname(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
}

try {
  const users = db.prepare(`
    SELECT
      id,
      username,
      display_name
    FROM users
  `).all();

  const nicknameKeys = new Set();

  for (const user of users) {
    const nickname =
      user.display_name?.normalize("NFKC").trim();

    if (!nickname) {
      throw new Error(
        `账号 ${user.username} 没有游戏昵称`
      );
    }

    const nicknameKey =
      normalizeNickname(nickname);

    if (nicknameKeys.has(nicknameKey)) {
      throw new Error(
        `存在重复游戏昵称：${nickname}`
      );
    }

    nicknameKeys.add(nicknameKey);
  }

  const updateUser = db.prepare(`
    UPDATE users
    SET
      username = @nickname,
      username_key = @nicknameKey,
      display_name = @nickname
    WHERE id = @id
  `);

  const migrate = db.transaction(() => {
    for (const user of users) {
      const nickname =
        user.display_name.normalize("NFKC").trim();

      updateUser.run({
        id: user.id,
        nickname,
        nicknameKey:
          normalizeNickname(nickname),
      });
    }
  });

  migrate();

  console.log(
    "✅ 所有战队成员现在使用游戏昵称登录"
  );

  for (const user of users) {
    console.log(
      `${user.username} → ${user.display_name}`
    );
  }
} catch (error) {
  console.error(
    `❌ 昵称迁移失败：${error.message}`
  );
} finally {
  db.close();
}