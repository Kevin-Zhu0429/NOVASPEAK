import { canEnterChannel } from "./channels.js";

function cleanId(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createOnlineMemberManagementService({
  presenceService,
  channelLookup,
  registeredUserLookup,
  revokeRegisteredSessions = () => {},
} = {}) {
  function validateActor(actor) {
    if (!actor) return { status: 401, error: "请先登录" };
    if (!["admin", "member"].includes(actor.role)) {
      return { status: 403, error: "该功能仅限正式战队成员" };
    }
    return null;
  }

  function targetFor(actor, targetPresenceId) {
    const actorError = validateActor(actor);
    if (actorError) return actorError;
    const presenceId = cleanId(targetPresenceId);
    if (!presenceId) return { status: 400, error: "请选择有效的在线成员" };
    let target = presenceService?.getManagementTarget?.(presenceId);
    if (!target) return { status: 404, error: "目标成员已离线" };
    // Presence 连接可能跨越成员角色调整。正式成员的角色必须以数据库当前值
    // 为准，不能依赖连接建立时缓存的 role。
    if (!target.isGuest && typeof registeredUserLookup === "function") {
      const registeredUser = registeredUserLookup(target.userId);
      if (!registeredUser) return { status: 404, error: "目标成员账号不存在" };
      target = { ...target, role: registeredUser.role };
    }
    if (target.userId === actor.id) return { status: 400, error: "不能对自己执行该操作" };
    return { target, presenceId };
  }

  function move({ actor, targetPresenceId, targetChannelId } = {}) {
    const base = targetFor(actor, targetPresenceId);
    if (base.error) return base;
    const channelId = cleanId(targetChannelId);
    const channel = channelId ? channelLookup?.(channelId) : null;
    if (!channel) {
      return { status: channelId ? 404 : 400, error: channelId ? "目标频道不存在" : "请选择目标频道" };
    }
    if (base.target.state === "in_channel" && base.target.channelId === channel.id) {
      return { status: 400, error: "目标成员已在该频道" };
    }
    if (!canEnterChannel(channel, { role: base.target.role })) {
      return { status: 403, error: "目标成员没有进入该频道的权限" };
    }

    presenceService.beginPresenceMemberMove?.(base.presenceId, channel.id, channel.name);
    const delivered = presenceService.sendVoiceControlToPresenceMember?.(base.presenceId, {
      type: "voice_control",
      action: "force_move_channel",
      targetChannelId: channel.id,
      targetChannelName: channel.name,
      sourceChannelId: base.target.channelId || null,
      reason: "online_member_move",
    }) === true;
    if (!delivered) {
      presenceService.cancelPresenceMemberMove?.(base.presenceId);
      return { status: 409, error: "目标成员当前没有可用连接" };
    }
    return {
      success: true,
      targetName: base.target.nickname || "目标成员",
      targetChannelName: channel.name,
    };
  }

  function kick({ actor, targetPresenceId } = {}) {
    const base = targetFor(actor, targetPresenceId);
    if (base.error) return base;
    if (base.target.role === "admin" && actor.role !== "admin") {
      return { status: 403, error: "战队成员不能将管理员移出服务器" };
    }

    const delivered = presenceService.disconnectPresenceMember?.(base.presenceId, {
      type: "voice_control",
      action: "force_logout",
      reason: "removed_from_server",
    }) === true;
    if (!delivered) return { status: 409, error: "目标成员当前没有可用连接" };
    if (!base.target.isGuest) revokeRegisteredSessions(base.target.userId);
    return { success: true, targetName: base.target.nickname || "目标成员" };
  }

  return { move, kick };
}
