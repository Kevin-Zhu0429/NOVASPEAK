import db from "../db.js";

const ALLOWED_POSITIONS = new Set([
  "captain",
  "commander",
  "entry",
  "sniper",
  "support",
  "rifler",
  "freeman",
  "backup",
  "member",
]);

try {
  const users = db.prepare(`
    SELECT
      id,
      username,
      display_name,
      role,
      position
    FROM users
  `).all();

  const insertPosition = db.prepare(`
    INSERT OR IGNORE INTO user_positions (
      user_id,
      position
    )
    VALUES (?, ?)
  `);

  const migrate = db.transaction(() => {
    for (const user of users) {
      const oldPosition =
        typeof user.position === "string"
          ? user.position.trim()
          : "";

      // Admin 默认拥有“队长”职位
      if (user.role === "admin") {
        insertPosition.run(
          user.id,
          "captain"
        );
      }

      // 迁移原来的单职位
      if (
        oldPosition &&
        ALLOWED_POSITIONS.has(oldPosition)
      ) {
        insertPosition.run(
          user.id,
          oldPosition
        );
      }

      // 没有任何职位的普通成员，默认设为“队员”
      const positionCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM user_positions
        WHERE user_id = ?
      `).get(user.id);

      if (
        user.role === "member" &&
        positionCount.count === 0
      ) {
        insertPosition.run(
          user.id,
          "member"
        );
      }
    }
  });

  migrate();

  const result = db.prepare(`
    SELECT
      users.id,
      users.display_name,
      users.username,
      users.role,
      GROUP_CONCAT(
        user_positions.position,
        ', '
      ) AS positions
    FROM users
    LEFT JOIN user_positions
      ON user_positions.user_id = users.id
    GROUP BY users.id
    ORDER BY users.id
  `).all();

  console.log("✅ 多职位迁移完成");
  console.table(result);
} catch (error) {
  console.error(
    "❌ 多职位迁移失败：",
    error
  );

  process.exitCode = 1;
} finally {
  db.close();
}