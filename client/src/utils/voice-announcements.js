export const ANNOUNCEMENTS_ENABLED_STORAGE_KEY = "novaVoiceAnnouncementsEnabled:v1";

export const ANNOUNCEMENT_EVENT_TYPES = Object.freeze([
  "server_joined",
  "channel_joined",
  "channel_left",
  "channel_moved",
  "server_muted",
]);

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

// 默认开启；只有显式保存过 "false" 才关闭，localStorage 异常时安全回退开启。
export function isAnnouncementsEnabled(storage = defaultStorage()) {
  try {
    return storage?.getItem?.(ANNOUNCEMENTS_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAnnouncementsEnabled(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem?.(ANNOUNCEMENTS_ENABLED_STORAGE_KEY, enabled === true ? "true" : "false");
    return true;
  } catch {
    return false;
  }
}

// 解析 Presence WS 上的 announcement 消息；presence:snapshot 等其他消息返回 null。
export function parseAnnouncementMessage(raw) {
  try {
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (message?.type !== "announcement") return null;
    if (!ANNOUNCEMENT_EVENT_TYPES.includes(message.eventType)) return null;
    if (typeof message.eventId !== "string" || !message.eventId) return null;
    const actor = message.actor && typeof message.actor === "object" && !Array.isArray(message.actor) ? message.actor : {};
    return {
      eventId: message.eventId,
      eventType: message.eventType,
      actor: {
        displayName: typeof actor.displayName === "string" && actor.displayName.trim() ? actor.displayName.trim() : "",
        roleLabel: typeof actor.roleLabel === "string" ? actor.roleLabel : "",
        isGuest: actor.isGuest === true,
        positionNames: Array.isArray(actor.positionNames) ? actor.positionNames.filter((name) => typeof name === "string" && name) : [],
      },
      channelName: typeof message.channelName === "string" ? message.channelName : "",
    };
  } catch {
    return null;
  }
}

export function formatPositionsForSpeech(positionNames) {
  return (Array.isArray(positionNames) ? positionNames.filter((name) => typeof name === "string" && name.trim()) : [])
    .map((name) => name.trim())
    .join("、");
}

// 播报称呼：访客 → 访客；有职位 → 职位（顿号连接，职位中文由后端沿用现有映射下发）；
// 否则回退角色标签（管理员）或“成员”。
export function formatMemberVoiceLabel(actor = {}) {
  if (actor.isGuest === true) return "访客";
  const positions = formatPositionsForSpeech(actor.positionNames);
  if (positions) return positions;
  return actor.roleLabel === "管理员" ? "管理员" : "成员";
}

export function buildAnnouncementText(event) {
  if (!event || typeof event !== "object") return "";
  const name = event.actor?.displayName?.trim?.() || "未知成员";
  const label = formatMemberVoiceLabel(event.actor || {});
  const channelName = typeof event.channelName === "string" && event.channelName.trim() ? event.channelName.trim() : "语音频道";
  switch (event.eventType) {
    case "server_joined":
      return `欢迎 NOVA GAMING ${label} ${name} 进入服务器`;
    case "channel_joined":
      return `${label} ${name} 进入频道`;
    case "channel_left":
      return `${label} ${name} 离开频道`;
    case "channel_moved":
      return `${name} 被移动到 ${channelName}`;
    case "server_muted":
      return `${name} 被闭嘴`;
    default:
      return "";
  }
}

// 顺序播放队列：eventId 去重；未解锁（浏览器自动播放限制）前收到的事件直接丢弃；
// speechSynthesis 不存在时静默降级。synthesis / createUtterance 可注入，便于 Node 测试。
export function createAnnouncementSpeaker({
  synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined,
  createUtterance = (text) => (typeof window !== "undefined" && typeof window.SpeechSynthesisUtterance === "function" ? new window.SpeechSynthesisUtterance(text) : null),
  isEnabled = () => true,
  maxSeenEvents = 200,
} = {}) {
  const seenEventIds = new Set();
  const queue = [];
  let speaking = false;
  let unlocked = false;
  let disposed = false;
  const supported = Boolean(synthesis && typeof synthesis.speak === "function");

  function rememberEvent(eventId) {
    seenEventIds.add(eventId);
    if (seenEventIds.size > maxSeenEvents) {
      const oldest = seenEventIds.values().next().value;
      seenEventIds.delete(oldest);
    }
  }

  function playNext() {
    if (disposed || speaking) return;
    const text = queue.shift();
    if (!text) return;
    let utterance;
    try {
      utterance = createUtterance(text);
    } catch {
      utterance = null;
    }
    if (!utterance) {
      playNext();
      return;
    }
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    const finish = () => {
      if (disposed) return;
      speaking = false;
      playNext();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speaking = true;
    try {
      synthesis.speak(utterance);
    } catch {
      speaking = false;
    }
  }

  return {
    supported,
    setUnlocked(value) {
      unlocked = value === true;
    },
    enqueue(event) {
      if (disposed || !supported) return false;
      if (!event || typeof event.eventId !== "string" || !event.eventId) return false;
      if (seenEventIds.has(event.eventId)) return false;
      rememberEvent(event.eventId);
      if (!unlocked) return false;
      if (isEnabled() !== true) return false;
      const text = buildAnnouncementText(event);
      if (!text) return false;
      queue.push(text);
      playNext();
      return true;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      seenEventIds.clear();
      try {
        synthesis?.cancel?.();
      } catch {
        // 卸载清理绝不抛错
      }
    },
  };
}
