export const WEB_APP_VERSION = "3.0.8";

// 网页小更新由服务器直接下发，不要求重新安装；只有 Electron/安装器等
// 桌面端大版本才标记 requiresDesktopUpdate: true 并通过 OTA 发布。
export const RELEASE_NOTES = Object.freeze([
  Object.freeze({
    version: "3.0.8",
    title: "普通用户注册与分级权限",
    releasedAt: "2026-07-24",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "登录页新增普通用户注册,
      "新增管理员、战队成员、普通用户、访客四级权限与统一服务端校验",
      "权限管理系统完善"，
    ]),
  }),
  Object.freeze({
    version: "3.0.7",
    title: "音乐机器人 DJ 混音",
    releasedAt: "2026-07-23",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "新增音乐机器人 DJ 混音功能：切歌前约 10 秒下一首平滑淡入重叠",
      "新增每频道 DJ 混音开关,
      "优化音乐机器人控制按钮布局",
    ]),
  }),
  Object.freeze({
    version: "3.0.5",
    title: "音乐机器人稳定正式版",
    releasedAt: "2026-07-22",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "修复快速切换频道时音乐机器人可能恢复到 100% 音量的问题",
      "修复用户实例化后音轨重建导致的声音异常问题",
      "修复陈铖是人类的问题",
    ]),
  }),
  Object.freeze({
    version: "3.0.4",
    title: "快速切换频道音量修复",
    releasedAt: "2026-07-21",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "修复快速切换频道时音乐机器人可能恢复到 100% 音量的问题",
      "修复音轨重建后声音异常、必须拖动音量条才能恢复的问题",
    ]),
  }),
  Object.freeze({
    version: "3.0.3",
    title: "频道切换与聊天修复",
    releasedAt: "2026-07-21",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "修复切换频道后音乐机器人恢复较大音量的问题，所有频道共用同一份本地机器人音量",
      "修复发送消息后需要再次点击输入框才能继续输入的问题",
    ]),
  }),
  Object.freeze({
    version: "3.0.2",
    title: "音乐音量优化",
    releasedAt: "2026-07-21",
    requiresDesktopUpdate: false,
    changes: Object.freeze([
      "降低音乐机器人源音轨的基础输出增益，默认 10% 音量",
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
