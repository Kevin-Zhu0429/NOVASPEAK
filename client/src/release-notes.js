export const WEB_APP_VERSION = "3.0.2";

// 网页小更新由服务器直接下发，不要求重新安装；只有 Electron/安装器等
// 桌面端大版本才标记 requiresDesktopUpdate: true 并通过 OTA 发布。
export const RELEASE_NOTES = Object.freeze([
  Object.freeze({
    version: "3.0.2",
    title: "音乐音量优化",
    releasedAt: "2026-07-21",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "降低音乐机器人源音轨的基础输出增益，默认 10% 音量更加舒适",
      "保留每位用户对音乐机器人音量和静音状态的本地调节",
    ]),
  }),
  Object.freeze({
    version: "3.0.1",
    title: "体验修复",
    releasedAt: "2026-07-20",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "修复音乐机器人默认音量过大，并在重新进入频道后同步保存的音量",
      "修复服务器静音、移动频道和踢出服务器后的操作提示不会自动消失",
      "新增版本号展示和更新日志入口",
    ]),
  }),
  Object.freeze({
    version: "3.0.0",
    title: "正式版",
    releasedAt: "2026-07-20",
    requiresDesktopUpdate: true,
    changes: Object.freeze([
      "正式切换至 voice.novagaming.top 服务器",
      "支持聊天记录、图片与文件发送",
      "完善网易云音乐机器人、频道队列和成员管理功能",
      "启用桌面客户端 OTA 更新能力",
    ]),
  }),
]);
