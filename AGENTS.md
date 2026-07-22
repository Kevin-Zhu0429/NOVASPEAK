# NovaSpeak — Agent 开发与发布规范

本文件是 NovaSpeak 仓库中所有自动化 Agent、Codex 和协作者的最高级项目说明。开始任何任务前必须完整阅读本文件，并以当前真实代码、数据库迁移和测试为准。历史对话、旧报告和旧分支只能作为线索，不能替代代码检查。

服务器内容更新步骤

ssh root@47.116.129.181

cd /opt/novaspeak-app

git status --short
正常应该没有输出。

git fetch origin
git switch main
git pull --ff-only origin main

cd client 
npm run build

---

## 1. 项目定位与当前基线

NovaSpeak 是 NOVA GAMING 战队使用的私有语音、聊天和频道音乐应用。

当前主要能力：

- 正式成员与访客登录
- Admin / Member / Guest 权限模型
- 语音频道、系统大厅、频道管理和成员 Presence
- LiveKit 实时语音、服务器静音、移动与移出成员
- 本地音量、本地静音、Voice Gate、噪声处理和网络质量显示
- 频道聊天历史、未读消息、图片与文件附件
- 网易云账号绑定、歌单、歌曲、搜索和公平点歌队列
- 服务端音乐机器人、FFmpeg 解码、LiveKit 音频推流和播放控制
- Windows Electron 客户端与自动更新
- Ubuntu ECS 生产部署

### 当前生产基线快照

截至 2026-07-21：

```text
主分支：main
main 基线：2b2d2e6f0fc595670a584c81f471705c56a5d981
网页版本：v3.0.6
桌面安装器版本：3.0.0
网页/API：https://voice.novagaming.top
LiveKit：https://livekit.novagaming.top
```

该 SHA 只是本文件更新时的快照。开始任务时必须先 fetch 并检查远程 `main`；如果远程已有正常快进提交，以远程最新代码为准，不得强行退回本 SHA。

### 当前最高优先级已知问题

音乐机器人仍存在尚未解决的真实环境问题：

1. 快速切换频道时可能先出现约半秒的超大音量，然后才恢复保存值。
2. 切换后偶尔出现电音、失真或疑似双路径叠音。
3. 拖动一次机器人音量条后通常立即恢复，说明 UI 偏好值与实际音频链状态可能不同步。
4. 网络面板曾在问题版本中显示 40%～50% 上行丢包；尚未证明是实际网络丢包、客户端线程阻塞还是统计基线问题。

`v3.0.5` 曾尝试让机器人断开 Web Audio、改走原生 `<audio>`：

```text
预先创建并静音 audio 元素
track.attach(element)
track.setAudioContext(undefined)
再用 element.volume 播放
```

真实结果是黑屏、卡顿、切换变慢、高丢包显示，而且原音频问题仍然存在。该实现已在 `v3.0.6` 回滚。

明确禁止：

- 不得恢复 `v3.0.5` 的 `disableRemoteTrackWebAudio()` 方案。
- 不得把 `track.setAudioContext(undefined)` 作为机器人常规播放路径。
- 不得在运行时反复切换 Web Audio 与原生 audio。
- 不得用定时反复 `setVolume()` 掩盖问题。
- 不得在没有 Windows 真实验证时宣称音频问题已修复或直接合并生产。

前端发布还存在潜在风险：当前生产目录可能直接执行 Vite build，而 Nginx 同时读取 `client/dist`。旧 `index.html` 与新哈希资源不一致时可能黑屏。后续应独立实现临时目录构建、健康检查和原子切换，不要与音乐音频修复混为一个提交。

---

## 2. 技术架构

### 客户端

```text
React
Vite
LiveKit Client SDK
原生 WebSocket / Web APIs
Electron 壳加载线上生产网页
```

Electron 打包版不是内置完整服务器。正式环境加载：

```text
https://voice.novagaming.top
```

页面、API、WebSocket、上传文件和 Session Cookie 保持同源。

### 后端

```text
Node.js
Express
ws Presence WebSocket
SQLite
better-sqlite3
@livekit/server-sdk
@livekit/rtc-node
NeteaseCloudMusicApi
FFmpeg / ffmpeg-static
```

### 生产环境

```text
系统：Ubuntu 24.04 LTS x86_64
反向代理：Nginx
服务管理：systemd novaspeak.service
LiveKit：Docker 容器
Node：/opt/node24/bin/node
FFmpeg：/usr/bin/ffmpeg
代码入口：/opt/novaspeak-current
环境文件：/etc/novaspeak/server.env
数据库：/var/lib/novaspeak/data/novaspeak.db
上传文件：/var/lib/novaspeak/uploads
OTA 文件：/var/lib/novaspeak/desktop-updates
备份：/var/backups/novaspeak
```

生产运行时数据必须位于代码仓库外部。不得把 ECS 生产数据库、上传目录、OTA 安装包或环境文件提交进 Git。

---

## 3. 开始任务前的强制检查

每次任务开始必须：

1. 完整读取根目录 `AGENTS.md`。
2. 检查当前目录、分支、HEAD、remote 和工作树。
3. fetch 远程目标分支，并确认本地基线没有偏离。
4. 读取相关生产代码、测试、迁移和调用点。
5. 搜索同名旧实现，避免创建第二套状态或服务。
6. 说明当前实现和修改边界，再开始编辑。

常用检查：

```bash
pwd
git status --short
git branch --show-current
git remote -v
git rev-parse HEAD
git log -10 --oneline
```

如果工作树有用户改动：

- 不得 reset、checkout 覆盖、stash 或删除。
- 先识别是否与任务重叠。
- 不相关改动必须保留并排除在提交外。
- 无法安全绕开时停止并说明冲突。

如果远程不可用，不得虚报 fetch、push 或同步成功。

---

## 4. 工作方法

### 默认原则

```text
先诊断，再修改
先读真实代码，再相信历史报告
一次处理一个明确问题
优先最小兼容修改
高风险路径必须补测试
失败时恢复稳定版本，不继续叠加猜测性补丁
没有真实验证就明确写“尚未验证”
```

### 禁止行为

- 不得为了 UI 调整重写 `VoiceRoom` 生命周期。
- 不得为了 Presence 功能新增第二套 WebSocket。
- 不得为了音乐功能绕过网易云会员、版权、地区或试听限制。
- 不得把播放 URL、Cookie、MUSIC_U、密钥或内部 principal 返回前端。
- 不得静默删除现有功能。
- 不得在构建或必要测试失败时声称完成。
- 不得把 mock 测试描述成真实 LiveKit/网易云/Windows 端到端验证。
- 不得未经明确授权 force push、rebase 公共历史或直接覆盖 `main`。

### 修复生产回归

出现黑屏、崩溃、高 CPU、高丢包、无法登录或服务器退出等回归时：

1. 先确认受影响版本和提交。
2. 将恢复服务稳定性置于继续开发之前。
3. 能精确撤销时优先小范围 revert。
4. 回滚也要测试、写版本说明和使用正常 PR。
5. 原问题和回归问题分开跟踪。

---

## 5. 身份、角色与权限

权限只由 `role` 决定，职位不能提升角色权限。

### Admin

- 管理成员和频道。
- 服务器静音与解除静音。
- 移动和移出在线成员。
- 控制音乐暂停、继续、下一首、清空、随机和优先播放。
- 使用正式账号、头像、语音、聊天和音乐功能。

### Member

- 使用正式账号、头像、语音、聊天和音乐功能。
- 根据当前产品规则可移动或移出其他在线成员。
- 可使用允许给战队成员的音乐播放控制。
- 不得获得 Admin 专属频道管理和服务器静音权限。

### Guest

- 使用签名 Guest Session 临时登录。
- 只能进入允许访客的频道。
- 使用允许范围内的基础语音、聊天和队列查看。
- 不得上传头像、管理频道、管理成员或控制频道音乐。
- 不得插入 `users`、`sessions`、`user_positions`。

示例：

```js
{ role: "member", positions: ["captain"] }
```

仍然是 Member，不是 Admin。

常用认证职责：

```text
requireAuthenticated：Admin / Member / Guest
requireRegistered：Admin / Member
requireAdmin：Admin
```

任何新路由必须同时测试未登录、Guest、Member 和 Admin。

---

## 6. 已完成功能与保护边界

### 6.1 认证和成员

已完成：

- 正式成员 Session 登录。
- Guest 签名 Cookie 登录。
- 昵称规范化、密码哈希、多职位。
- 账号资料、昵称和头像。
- 管理成员与公开成员结构。

要求：

- 正式密码只保存哈希。
- Guest Cookie 使用 HMAC 并校验过期。
- 正式登录清理 Guest 身份；Guest 登录清理正式 Session。
- 公开响应不得包含密码哈希、数据库字段、Cookie 或内部路径。
- 多职位权威存储为 `user_positions`，不要把 legacy `users.position` 当作唯一真源。

### 6.2 频道

已完成：

- 系统大厅与普通频道。
- 创建、编辑、删除、排序。
- 名称、描述、人数上限。
- `everyone / members / admins` 访问等级。
- `allowGuests`。
- 用户登录后默认位于 Presence 大厅。

规则：

- `channel.id` 同时用于 LiveKit room，不得随意更改。
- 只有真实系统频道是 lobby；普通频道不能因名字叫“大厅”获得系统权限。
- 系统频道受保护。
- 有人频道禁止删除。
- LiveKit room not found 可视为 0 人，不应导致删除 503。
- `GET /api/channels` 不应依赖 LiveKit `listParticipants` 才能工作。

### 6.3 语音与 Presence

已完成：

- LiveKit 加入、离开、重连和管理员移动。
- Presence snapshot、在线位置和 reconnecting 宽限。
- 服务器静音、移动频道和移出服务器。
- 后端 announcement 与前端 speechSynthesis 播报。
- 本地麦克风、Deafen、设备切换。
- 本地成员音量和本地静音。
- Voice Gate、回声消除、噪声抑制和自动增益选项。
- RTT、上行/下行丢包和连接质量显示。

高风险文件：

```text
client/src/components/voice/VoiceRoom.jsx
client/src/utils/voice-room-lifecycle.js
client/src/hooks/useVoiceNetworkStats.js
client/src/hooks/usePresence.js
server/presence.js
server/voice-management.js
server/online-member-management.js
```

不得混淆：

```text
麦克风关闭：用户不发送自己的麦克风。
服务器静音：后端/LiveKit 对目标用户实施，全频道有效。
本地静音：当前客户端不听某个成员，只影响自己。
```

管理员移动必须走现有 pending move / force move 保护，避免重复播报离开、进入和移动。

### 6.4 聊天

已完成：

- 每频道聊天持久化。
- 历史加载和消息去重。
- 未读数量和时间分隔线。
- 新消息自动滚动；用户阅读历史时不强制拉到底部。
- 发送后恢复输入框焦点。
- 图片和受控文件附件。
- 输入框粘贴图片发送。

关键文件：

```text
server/chat/messages.js
server/chat/attachments.js
server/chat/routes.js
client/src/components/chat/ChatComposer.jsx
client/src/components/chat/ChatMessageAttachment.jsx
client/src/utils/chat-*.js
```

要求：

- 附件使用受控文件名和路径，不信任用户原始路径。
- 校验类型、大小和频道归属。
- 不返回服务器绝对路径。
- `CHAT_HISTORY_LIMIT` 控制历史上限，默认配置为 300。
- 上传内容保存在运行时 uploads 目录，不提交 Git。

### 6.5 头像

已完成 JPG / PNG / WebP、magic bytes、2MB 限制、Guest 禁止上传、替换清理、公开 `avatarUrl` 和前端 fallback。

要求：

- 禁止 SVG、GIF 和路径穿越。
- 不使用用户原始文件名。
- 不打印 base64。
- 不返回 `avatar_path` 或绝对路径。

### 6.6 网易云与频道音乐

已完成：

- Electron 网易云登录窗口。
- Cookie 加密保存和账号隔离。
- 账号绑定、解绑和登录失效处理。
- 歌单、歌曲、封面、分页和标准化。
- 网易云歌曲搜索。
- 单曲点歌、整歌单添加。
- 按点歌用户分桶的公平队列。
- 删除自己的待播歌曲、清空频道队列、随机队列和优先播放。
- 暂停、继续、下一首和当前播放进度。
- 无人频道超时处理。
- FFmpeg 解码、可恢复媒体流和 LiveKit 机器人推流。

关键文件：

```text
server/music/netease-client.js
server/music/credential-store.js
server/music/library-service.js
server/music/music-queue-scheduler.js
server/music/music-queue.js
server/music/playback-source.js
server/music/ffmpeg-runtime.js
server/music/ffmpeg-decoder.js
server/music/livekit-bot.js
server/music/music-bot-manager.js
server/music/routes.js
client/src/components/music/*
client/src/utils/music-api.js
client/src/utils/local-audio-preferences.js
```

安全要求：

- principal 只来自后端认证身份。
- 播放时只解密该队列项点歌者自己的 Cookie。
- Cookie 明文只在请求函数作用域短暂存在。
- 播放 URL 不入库、不回传、不写日志。
- 媒体 URL 必须经过协议、主机、重定向和大小限制。
- VIP、试听、无版权和地区限制不得绕过。
- FFmpeg 使用 `spawn` 且 `shell: false`，URL/Cookie 不进入 argv 或 env。
- 基础设施故障应 requeue 并恢复公平游标；明确不可播放应 skipped；内容失败才 failed。
- 音乐模块故障不得调用 `process.exit()` 或关闭 Express、Presence、LiveKit 全局资源。

公平队列规则：

- 每频道按 requester bucket 轮转。
- 桶内 FIFO。
- 临时基础设施失败重入队时恢复 claim 前游标。
- 同频道最多一个 playing。
- 任何队列响应不得泄露 `principal_key`、Cookie、URL、失败内部信息或 bucket cursor。

### 6.7 Electron 与 OTA

已完成：

- Windows NSIS 安装器。
- 正式版加载 `https://voice.novagaming.top`。
- Electron 网易云登录 IPC。
- generic provider 自动更新。
- GitHub Actions Windows 构建。

关键文件：

```text
desktop/main.js
desktop/main-window-policy.js
desktop/netease-login.js
desktop/auto-update.js
desktop/package.json
.github/workflows/package-windows.yml
server/desktop-updates.js
```

版本规则：

- 仅网页/服务端小更新：更新 `client/src/release-notes.js`，不要求用户重新安装。
- Electron、preload、安装器或自动更新逻辑变化：提升 desktop semver，构建新安装器并发布 OTA。
- 不得用网页版本冒充安装器版本。
- 当前安装器品牌作者为 `KAICHEN ZHU`；修改包元数据时必须保持一致，除非用户明确要求更改。
- OTA 正式目录只发布 Setup、blockmap 和 `latest.yml`；Portable 不参与自动更新。

---

## 7. VoiceRoom 和音乐音频专项规则

### VoiceRoom 生命周期不可随意重构

必须保留并理解：

```text
generation
connectAttemptRef
disposed
roomRef
cleanupVoiceRoomAttempt
RoomEvent.Moved
RoomEvent.Disconnected
TrackSubscribed / TrackUnsubscribed
effect cleanup
```

修改连接 effect 依赖前必须运行生命周期测试。回调引用、频道数组引用、普通 state 更新不得导致当前 Room 重连。

### 当前音乐音频诊断要求

修复切换频道的音量/电音问题前必须证明以下哪一种成立：

- 原生 audio 在 GainNode 建立前抢先播放。
- 同一 publication attach 了多个元素。
- 旧 Room 或旧 GainNode 未清理。
- 快速切换时短暂存在两个可听 Room。
- 新 RemoteAudioTrack 没继承 `elementVolume`。
- GainNode 重建时增益恢复到 1。
- 服务端存在重复机器人 session/publication。
- PCM、声道或削波导致失真，而不是客户端叠音。

诊断日志只能记录：

```text
attemptId / generation / channelId
trackSid
机器人布尔标记
attach/detach 数量
audio element 数量
AudioContext state
muted / volume / gain 数值
连接和清理时间
```

禁止记录 token、Cookie、URL、用户密钥或完整敏感 metadata。

修复分支在 Windows 至少快速切换频道 20 次、连续播放 30 分钟并观察 CPU/内存后，才允许合并 `main`。

### 网络统计要求

`useVoiceNetworkStats` 的旧异步 poll 不得覆盖新 Room；Room、track、SSRC 或 remote-inbound id 改变时第一帧只建立 baseline。

音乐是下行音轨，本地调整音乐音量理论上不应直接增加上行流量。出现高上行丢包时必须分别测试：

1. 未进入频道。
2. 进入频道、麦克风关闭、无音乐。
3. 麦克风开启、无音乐。
4. 播放音乐。

不要把统计显示异常直接描述成真实线路丢包。

---

## 8. API 与前端请求规则

所有 `/api/*` 路由必须在静态资源和 SPA fallback 前注册。未匹配 API 必须返回 JSON，不能返回 `index.html`。

前端请求必须：

- 使用现有 API 基址。
- Session 请求带 `credentials: "include"`。
- 解析 JSON 前检查 `content-type`。
- 检查 `response.ok`。
- AbortController 中止不能当普通错误弹出。
- 使用稳定中文错误信息。
- 不产生 unhandled rejection。

响应禁止包含：

```text
raw stack
SQL
绝对路径
password hash
session token
Cookie / MUSIC_U
LiveKit secret
网易云播放 URL
principal_key
队列内部游标
```

常用状态码：

```text
400 输入无效
401 未登录、Session 或网易云凭据失效
403 权限不足或不在频道
404 资源不存在
409 状态冲突、队列限制或歌曲不可播放
429 上游限流
500 非预期内部错误
502 / 503 上游或基础设施不可用
```

---

## 9. 数据库、迁移和运行时文件

SQLite 迁移必须：

1. 检查当前 schema。
2. 在修改生产库前创建可验证备份。
3. 支持重复启动。
4. 多步写入使用 transaction。
5. 在临时数据库或副本上测试。
6. 运行 `PRAGMA integrity_check`。

不得用真实生产数据库跑破坏性测试。

严禁提交：

```text
server/.env
*.db / *.db-shm / *.db-wal
backups/
server/uploads/
desktop-updates/
node_modules/
client/dist/
desktop/dist/
FFmpeg 二进制
真实头像、聊天附件和安装包
server-crash.log
```

仓库历史中可能存在旧追踪运行时文件。任务不得借机删除或重写用户数据；应单独提出清理方案并先备份。

环境变量名称可记录，值不得记录。当前重要变量：

```text
NODE_ENV
PORT
LIVEKIT_URL
LIVEKIT_ADMIN_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
SESSION_SECRET（旧环境可能存在）
GUEST_SESSION_SECRET
MUSIC_CREDENTIAL_KEY
FFMPEG_PATH
CHAT_HISTORY_LIMIT
NOVASPEAK_DB_PATH
NOVASPEAK_UPLOADS_DIR
DESKTOP_UPDATE_DIR
```

---

## 10. 关键文件索引

### 后端入口与基础服务

```text
server/index.js                    Express、路由、静态资源、生命周期装配
server/db.js                       SQLite 初始化和迁移装配
server/auth-session.js             正式 Session 和公开用户
server/guest-auth.js               Guest Session
server/presence.js                 Presence WebSocket
server/channels.js                 频道规则与排序
server/voice-management.js         LiveKit 服务器语音管理
server/online-member-management.js 在线成员移动与移出
server/avatar.js                   头像校验和存储
server/desktop-updates.js          OTA 文件服务
```

### 前端核心

```text
client/src/App.jsx
client/src/App.css
client/src/components/ChannelList.jsx
client/src/components/voice/VoiceRoom.jsx
client/src/components/voice/VoiceParticipantCard.jsx
client/src/components/voice/VoiceMemberContextMenu.jsx
client/src/components/presence/OnlineMembersPanel.jsx
client/src/components/presence/OnlineMemberContextMenu.jsx
client/src/components/chat/ChatComposer.jsx
client/src/components/music/MusicPanel.jsx
client/src/components/music/MusicQueue.jsx
client/src/hooks/usePresence.js
client/src/hooks/useVoiceNetworkStats.js
client/src/hooks/useLocalAudioPreferences.js
client/src/release-notes.js
```

### 桌面端

```text
desktop/main.js
desktop/preload.js
desktop/main-window-policy.js
desktop/netease-login.js
desktop/auto-update.js
desktop/package.json
```

---

## 11. UI 与交互规范

保持现有深色、cyan/teal、轻量电竞风格。不要为了单个问题重做整套 UI。

要求：

- 中文提示清楚、简短。
- 错误、加载、空状态、disabled 和 focus-visible 完整。
- 列表长名称使用省略号，不撑破布局。
- 音乐面板保持单一内部滚动区域，禁止重新引入双滚动条和账号卡重叠。
- 在线成员头像为较大的正方形样式。
- 聊天发送完成后输入框应自动恢复焦点。
- 操作提示应自动消失，不长期覆盖页面。
- 发布网页小版本时同步 `WEB_APP_VERSION` 和第一条 release note。

`App.jsx` 拥有中心 `currentUser`。用户资料变化应通过现有回调或重新请求 `/api/auth/me` 同步，不得创建第二套认证状态。

---

## 12. 开发、测试与验证

### 服务端

在仓库根目录或 `server` 中按实际脚本运行：

```bash
cd server
node --test --test-concurrency=1
```

修改 JS 后运行相关 `node --check`。

服务端测试必须使用 mock、内存库或临时数据库，不访问真实网易云、LiveKit 或生产数据。

### 前端

```bash
cd client
node --test src/utils/*.test.js
npm run build
npm run lint
```

当前仓库可能存在已知 lint 存量问题。必须区分存量问题与本次新增问题；不得用“存量问题”掩盖新错误。

### Electron

```bash
cd desktop
npm test
```

涉及打包时使用：

```bash
npm run dist:win
```

若本地下载 Electron 很慢，可使用现有 GitHub Actions `package-windows.yml`。不得虚报本地构建成功。

### 通用检查

```bash
git diff --check
git status --short
git diff --cached
```

测试强度按风险提高：

- UI 文案：相关单测 + build。
- API/权限：服务端路由测试 + 全量相关回归。
- 数据库：迁移测试 + 备份 + integrity check。
- VoiceRoom/Presence：专项生命周期测试 + 前端全量测试 + Windows 人工验证。
- 音乐解码/推流：服务端全量测试 + FFmpeg/LiveKit mock + Windows 真实长时间播放。
- Electron/OTA：桌面测试 + GitHub Actions 构建 + 安装/升级验证。

---

## 13. Windows 本地开发命令

用户本地通常使用 PowerShell。给用户的 Windows 命令必须是 PowerShell 语法，不要混入 Bash。

```powershell
Set-Location "C:\Users\zkcsk\Desktop\NovaSpeak-V3\server"
npm run dev
```

```powershell
Set-Location "C:\Users\zkcsk\Desktop\NovaSpeak-V3\client"
npm run dev
```

```powershell
Set-Location "C:\Users\zkcsk\Desktop\NovaSpeak-V3\desktop"
npm run dev
```

优先使用：

```text
Get-Content
Get-ChildItem
Select-String
Copy-Item
Move-Item
Remove-Item
Get-FileHash
Test-Path
```

不要把终端提示符、命令输出或表格横线复制进下一条 PowerShell 命令。

---

## 14. Ubuntu 生产部署规则

生产更新前：

1. 确认 Git remote 和目标提交。
2. 备份数据库和上传文件。
3. 在非生产目录安装依赖、测试和构建。
4. 检查环境变量名称，不打印值。
5. 健康检查后再切换。

systemd：

```bash
sudo systemctl status novaspeak.service --no-pager -l
sudo journalctl -u novaspeak.service --no-pager -n 100
```

Nginx 修改后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

网页小更新通常只需更新代码并重新构建前端，不需要重启后端。服务端代码或环境变化才重启：

```bash
sudo systemctl restart novaspeak.service
```

任何生产切换都应验证：

```text
GET /
GET /api/auth/me
WebSocket /ws
上传文件访问
LiveKit 连接
desktop-updates/latest.yml（发布 OTA 时）
```

### 前端原子发布目标

当前直接构建生产 `dist` 存在黑屏风险。后续部署脚本应：

1. 构建到临时 release 目录。
2. 验证 `index.html` 和所有引用的 hash assets 存在。
3. 原子切换 Nginx 指向或 `current` 符号链接。
4. `index.html` 使用 no-cache/revalidate。
5. 哈希 assets 使用长期 immutable cache。
6. 保留上一版目录以便秒级回滚。

在原子部署完成前，不得把构建期间短暂黑屏误判为 React 业务逻辑错误。

---

## 15. Git 与 GitHub 规则

- 默认从最新远程 `main` 创建功能或修复分支。
- 分支名应描述任务，例如 `fix/...`、`feature/...`、`docs/...`、`agent/...`。
- 只 stage 本任务文件，工作树混杂时禁止 `git add .`。
- commit 简洁描述实际变更。
- 默认普通快进 push，禁止 force 和 force-with-lease，除非用户明确授权且充分说明风险。
- 不 amend 已推送的公共提交。
- 合并前确认 PR base/head 和最新 SHA。
- 合并后重新 fetch 或查询远程 `main` 验证。

涉及高风险音频、VoiceRoom 生命周期、数据库迁移和生产部署时，默认先推测试分支，不得跳过用户真实验收直接合并。

提交前必须扫描：

```text
node_modules
.env
数据库和 WAL/SHM
backups
uploads
Cookie / MUSIC_U
LiveKit 密钥
播放 URL
构建产物
安装包
```

---

## 16. 已知历史故障，禁止重新引入

```text
VoiceRoom effect 依赖不稳定导致 Client initiated disconnect。
旧 Room cleanup 断开新 Room。
退出频道把 SyntheticEvent 放入 state 导致 React 黑屏。
管理员移动触发离开、进入、移动三次播报。
Presence 初始 snapshot 被误当成新事件播报。
频道编辑草稿被轮询覆盖。
普通“大厅”名称被误判为系统频道。
LiveKit room not found 导致删除频道 503。
音乐媒体被下游背压拖慢后 CDN 中断并从头重播。
FFmpeg 路径无效导致 Node 进程退出。
机器人被踢后 manager 保留失效 session，必须重启服务。
机器人音量 UI 值正确但新音轨实际增益恢复。
v3.0.5 断开 Web Audio 的方案造成严重客户端回归。
直接在 Nginx 正在读取的 dist 中构建导致旧 HTML/新 assets 不一致。
Electron 旧域名 app.novagaming.top 导致生产客户端加载错误。
```

遇到相似问题先搜索历史提交和测试，不要重复已经失败的方案。

---

## 17. 完成报告要求

最终报告必须包含：

1. 开始基线、当前分支和最终 HEAD。
2. 是否完整读取本文件。
3. 修改/新增文件清单。
4. 根因和主要实现决策。
5. API、数据库和权限变化；没有也要明确写无。
6. 安全与敏感数据检查。
7. 实际运行的测试、构建和 lint 结果。
8. 存量 warning/failure 与本次新增问题的区分。
9. Windows 或生产环境人工验证步骤。
10. commit、push、PR 和 merge 状态。
11. 未完成、未验证和仍存在的风险。

不得只回答“完成”“测试通过”或“已经修复”。

如果只做了 mock 测试，应写：

```text
自动测试通过；尚未完成 Windows + 真实 LiveKit + 真实网易云端到端验证。
```

如果没有权限或环境不能完成 push、部署或真实验证，必须明确说明阻塞，不得伪造结果。
