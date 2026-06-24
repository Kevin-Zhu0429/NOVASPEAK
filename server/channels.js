export const CHANNEL_ACCESS_LEVELS = new Set(["everyone", "members", "admins"]);
export const MAX_CHANNEL_MEMBERS_LIMIT = 99;

export const DEFAULT_CHANNELS = [
  { id: "lobby", name: "大厅", sortOrder: 0, isSystem: true },
  { id: "cs2", name: "CS2", sortOrder: 10, isSystem: false },
  { id: "delta-force", name: "三角洲行动", sortOrder: 20, isSystem: false },
  { id: "apex", name: "Apex", sortOrder: 30, isSystem: false },
  { id: "private-room", name: "私人房间", sortOrder: 40, isSystem: false },
];

export function normalizeChannelName(value) {
  if (typeof value !== "string") return { error: "频道名称不能为空" };
  const name = value.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 40) return { error: "频道名称必须为 1—40 个字符" };
  if (/[\u0000-\u001F\u007F]/.test(name)) return { error: "频道名称包含无效字符" };
  return { name, nameKey: name.toLocaleLowerCase() };
}

export function normalizeChannelDescription(value) {
  if (typeof value !== "string") return { error: "频道描述必须是字符串" };
  const description = value.normalize("NFKC").trim();
  if (description.length > 200) return { error: "频道描述不能超过 200 个字符" };
  return { description };
}

export function normalizeSortOrder(value) {
  if (!Number.isInteger(value)) return { error: "频道排序必须是整数" };
  return { sortOrder: value };
}

export function normalizeMaxMembers(value) {
  if (value === null) return { maxMembers: null };
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHANNEL_MEMBERS_LIMIT) {
    return { error: `频道人数上限必须是 1—${MAX_CHANNEL_MEMBERS_LIMIT} 的整数，或设为 null` };
  }
  return { maxMembers: value };
}

export function normalizeAccessLevel(value) {
  if (typeof value !== "string" || !CHANNEL_ACCESS_LEVELS.has(value)) {
    return { error: "频道进入权限无效" };
  }
  return { accessLevel: value };
}

export function normalizeAllowGuests(value) {
  if (typeof value !== "boolean") return { error: "是否允许访客进入必须是布尔值" };
  return { allowGuests: value };
}

export function toPublicChannel(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    sortOrder: row.sort_order,
    maxMembers: row.max_members,
    accessLevel: row.access_level,
    allowGuests: Boolean(row.allow_guests),
    isSystem: Boolean(row.is_system),
    ownerId: row.owner_id,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
  };
}

export function migrateChannels(db) {
  const columns = db.prepare("PRAGMA table_info(channels)").all();
  const names = new Set(columns.map((column) => column.name));
  const migrations = [
    ["description", "ALTER TABLE channels ADD COLUMN description TEXT NOT NULL DEFAULT ''"],
    ["sort_order", "ALTER TABLE channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"],
    ["max_members", "ALTER TABLE channels ADD COLUMN max_members INTEGER DEFAULT NULL"],
    ["access_level", "ALTER TABLE channels ADD COLUMN access_level TEXT NOT NULL DEFAULT 'everyone'"],
    ["allow_guests", "ALTER TABLE channels ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 1"],
    ["is_system", "ALTER TABLE channels ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, sql] of migrations) if (!names.has(name)) db.exec(sql);

  const existingCount = db.prepare("SELECT COUNT(*) AS count FROM channels").get().count;
  if (existingCount === 0) {
    const insert = db.prepare(`INSERT INTO channels (id, name, name_key, owner_id, is_default, description, sort_order, max_members, access_level, allow_guests, is_system, created_at) VALUES (@id, @name, @nameKey, NULL, 1, '', @sortOrder, NULL, 'everyone', 1, @isSystem, @createdAt)`);
    const seed = db.transaction(() => {
      const createdAt = Date.now();
      for (const channel of DEFAULT_CHANNELS) insert.run({ ...channel, nameKey: channel.name.normalize("NFKC").trim().toLocaleLowerCase(), isSystem: channel.isSystem ? 1 : 0, createdAt });
    });
    seed();
  } else {
    const repairSystemFlag = db.prepare("UPDATE channels SET is_system = ? WHERE id = ?");
    for (const channel of DEFAULT_CHANNELS) {
      repairSystemFlag.run(channel.isSystem ? 1 : 0, channel.id);
    }
  }
}

export function listChannelRows(db) {
  return db.prepare(`SELECT id, name, description, sort_order, max_members, access_level, allow_guests, is_system, owner_id, is_default, created_at FROM channels ORDER BY sort_order ASC, name ASC, id ASC`).all();
}

export function getChannelById(db, id) {
  return db.prepare(`SELECT id, name, description, sort_order, max_members, access_level, allow_guests, is_system, owner_id, is_default, created_at FROM channels WHERE id = ?`).get(id);
}

export function canEnterChannel(channel, user) {
  if (!channel || !user) return false;
  if (channel.access_level === "admins") return user.role === "admin";
  if (channel.access_level === "members") return user.role === "admin" || user.role === "member";
  if (channel.access_level === "everyone") {
    if (user.role === "guest") return Boolean(channel.allow_guests);
    return user.role === "admin" || user.role === "member";
  }
  return false;
}

export async function getLiveKitParticipantCount(roomService, roomName) {
  const participants = await roomService.listParticipants(roomName);
  return Array.isArray(participants) ? participants.length : 0;
}

export async function assertChannelCapacity({ roomService, channel }) {
  if (channel.max_members === null) {
    return { allowed: true, count: null };
  }
  const count = await getLiveKitParticipantCount(roomService, channel.id);
  if (count >= channel.max_members) {
    return { allowed: false, status: 409, error: "频道人数已满", count };
  }
  return { allowed: true, count };
}

export function buildChannelPatch(body) {
  const allowed = new Set(["name", "description", "sortOrder", "maxMembers", "accessLevel", "allowGuests"]);
  const forbidden = new Set(["id", "roomName", "isSystem", "is_system"]);
  for (const key of Object.keys(body || {})) {
    if (forbidden.has(key) || !allowed.has(key)) return { error: `不支持修改字段：${key}` };
  }
  const patch = {};
  if (Object.hasOwn(body, "name")) Object.assign(patch, normalizeChannelName(body.name));
  if (Object.hasOwn(body, "description")) Object.assign(patch, normalizeChannelDescription(body.description));
  if (Object.hasOwn(body, "sortOrder")) Object.assign(patch, normalizeSortOrder(body.sortOrder));
  if (Object.hasOwn(body, "maxMembers")) Object.assign(patch, normalizeMaxMembers(body.maxMembers));
  if (Object.hasOwn(body, "accessLevel")) Object.assign(patch, normalizeAccessLevel(body.accessLevel));
  if (Object.hasOwn(body, "allowGuests")) Object.assign(patch, normalizeAllowGuests(body.allowGuests));
  return patch.error ? { error: patch.error } : patch;
}
