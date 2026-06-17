import db from "../db.js";

const users = db.prepare(`
  SELECT
    id,
    username,
    username_key,
    display_name,
    role,
    position
  FROM users
`).all();

console.table(users);

db.close();