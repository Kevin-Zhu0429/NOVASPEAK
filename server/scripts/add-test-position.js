import db from "../db.js";

try {
  const user = db.prepare(`
    SELECT id
    FROM users
    WHERE username_key = ?
  `).get("chillily");

  if (!user) {
    throw new Error(
      "没有找到 CHILLILY"
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO user_positions (
      user_id,
      position
    )
    VALUES (?, ?)
  `).run(
    user.id,
    "sniper"
  );

  const positions = db.prepare(`
    SELECT position
    FROM user_positions
    WHERE user_id = ?
    ORDER BY position
  `).all(user.id);

  console.log(
    "✅ CHILLILY 当前职位：",
    positions.map(
      (item) => item.position
    )
  );
} catch (error) {
  console.error(
    "❌ 添加职位失败：",
    error.message
  );

  process.exitCode = 1;
} finally {
  db.close();
}