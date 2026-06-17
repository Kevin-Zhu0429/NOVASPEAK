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

  const preparedUsers = users.map((user) => {
    const nickname = String(
      user.display_name || user.username
    )
      .normalize("NFKC")
      .trim();

    if (!nickname) {
      throw new Error(
        `用户 ${user.id} 没有有效游戏昵称`
      );
    }

    return {
      id: user.id,
      oldUsername: user.username,
      nickname,
      nicknameKey: normalizeNickname(nickname),
    };
  });

  const uniqueKeys = new Set(
    preparedUsers.map((user) => user.nicknameKey)
  );

  if (uniqueKeys.size !== preparedUsers.length) {
    throw new Error(
      "存在重复游戏昵称，无法迁移"
    );
  }

  const setTemporaryKey = db.prepare(`
    UPDATE users
    SET username_key = ?
    WHERE id = ?
  `);

  const updateUser = db.prepare(`
    UPDATE users
    SET
      username = @nickname,
      username_key = @nicknameKey,
      display_name = @nickname
    WHERE id = @id
  `);

  const migrate = db.transaction(() => {
    // 先改成临时值，避免 UNIQUE 冲突
    for (const user of preparedUsers) {
      setTemporaryKey.run(
        `temporary-${user.id}`,
        user.id
      );
    }

    for (const user of preparedUsers) {
      updateUser.run({
        id: user.id,
        nickname: user.nickname,
        nicknameKey: user.nicknameKey,
      });
    }
  });

  migrate();

  console.log("✅ 游戏昵称登录迁移成功");

  for (const user of preparedUsers) {
    console.log(
      `${user.oldUsername} → ${user.nickname}`
    );
  }
} catch (error) {
  console.error(
    `❌ 迁移失败：${error.message}`
  );
  process.exitCode = 1;
} finally {
  db.close();
}