export const ACCESS_LEVEL_LABELS = {
  everyone: "所有正式成员及允许的访客",
  members: "仅正式战队成员",
  admins: "仅管理员",
};

export function getChannelFormInitialValues(channel = {}) {
  const maxMembers = Number.isInteger(channel.maxMembers) ? String(channel.maxMembers) : "";
  return {
    name: typeof channel.name === "string" ? channel.name : "",
    description: typeof channel.description === "string" ? channel.description : "",
    maxMembersMode: Number.isInteger(channel.maxMembers) ? "limited" : "unlimited",
    maxMembers,
    accessLevel: ACCESS_LEVEL_LABELS[channel.accessLevel] ? channel.accessLevel : "everyone",
    allowGuests: Boolean(channel.allowGuests) && channel.accessLevel === "everyone",
  };
}

export function parseMaxMembers(mode, value) {
  if (mode === "unlimited") return { maxMembers: null };
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(trimmed)) return { error: "人数上限必须是 1—99 的整数" };
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 1 || number > 99) {
    return { error: "人数上限必须是 1—99 的整数" };
  }
  return { maxMembers: number };
}

export function getAccessLevelLabel(value) {
  return ACCESS_LEVEL_LABELS[value] || "未知权限";
}

export function canToggleGuests(accessLevel) {
  return accessLevel === "everyone";
}

export function validateChannelForm(values) {
  const name = typeof values?.name === "string" ? values.name.normalize("NFKC").trim() : "";
  if (name.length < 1 || name.length > 40) return { error: "频道名称必须为 1—40 个字符" };
  const description = typeof values?.description === "string" ? values.description.normalize("NFKC").trim() : "";
  if (description.length > 200) return { error: "频道描述不能超过 200 个字符" };
  if (!ACCESS_LEVEL_LABELS[values?.accessLevel]) return { error: "频道进入权限无效" };
  const maxResult = parseMaxMembers(values?.maxMembersMode, values?.maxMembers);
  if (maxResult.error) return maxResult;
  return { name, description, maxMembers: maxResult.maxMembers, accessLevel: values.accessLevel, allowGuests: values.accessLevel === "everyone" ? Boolean(values.allowGuests) : false };
}

export function buildChannelPatchPayload(values) {
  const normalized = validateChannelForm(values);
  if (normalized.error) return normalized;
  return {
    payload: {
      name: normalized.name,
      description: normalized.description,
      maxMembers: normalized.maxMembers,
      accessLevel: normalized.accessLevel,
      allowGuests: normalized.allowGuests,
    },
  };
}

export function canMoveChannelUp(channels, index) {
  return Array.isArray(channels) && index > 0 && index < channels.length;
}

export function canMoveChannelDown(channels, index) {
  return Array.isArray(channels) && index >= 0 && index < channels.length - 1;
}

function getSortOrder(channel, fallback) {
  return Number.isInteger(channel?.sortOrder) ? channel.sortOrder : fallback;
}

export function calculateMoveUpSortPatches(channels, index) {
  if (!canMoveChannelUp(channels, index)) return { error: "该频道已经在最上方" };
  const current = channels[index];
  const target = channels[index - 1];
  return { patches: [
    { id: current.id, sortOrder: getSortOrder(target, index - 1) },
    { id: target.id, sortOrder: getSortOrder(current, index) },
  ] };
}

export function calculateMoveDownSortPatches(channels, index) {
  if (!canMoveChannelDown(channels, index)) return { error: "该频道已经在最下方" };
  const current = channels[index];
  const target = channels[index + 1];
  return { patches: [
    { id: current.id, sortOrder: getSortOrder(target, index + 1) },
    { id: target.id, sortOrder: getSortOrder(current, index) },
  ] };
}

export function canDeleteChannel(channel) {
  return Boolean(channel) && !channel.isSystem && channel.id !== "lobby";
}

export async function extractApiError(response, fallback = "请求失败") {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!contentType.includes("application/json")) return fallback;
  try {
    const data = await response.json();
    return data?.error || fallback;
  } catch {
    return fallback;
  }
}
