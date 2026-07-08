# NovaSpeak — Codex Project Instructions

## 1. 项目定位与当前状态

NovaSpeak 是 NOVA GAMING 战队使用的轻量级私有语音与聊天工具。维护本项目时必须先检查当前真实代码，不要假设历史任务中的代码仍然完全一致。

### 技术栈

```text
前端：React + Vite
后端：Node.js / Express
数据库：SQLite + better-sqlite3
语音：LiveKit
Presence：自研 Presence WebSocket，基于 ws
认证：正式成员 Session + Guest Session
头像：JSON base64 上传，server/uploads/avatars 持久化
部署入口：Express 提供 API 并托管 client/dist
公开域名：https://voice.novagaming.top
用户本地路径：C:\Users\zkcsk\Desktop\NovaSpeak
```

### 已完成阶段

#### 第一阶段：频道成员语音管理

已完成：

```text
管理员服务器静音 / 解除服务器静音
管理员移动成员到其他频道
管理员移出成员
成员可移动 / 移出其他成员
Guest 无管理权限
服务器静音状态跨频道保持同步
解除服务器静音后，如果目标用户禁音前麦克风是开启的，会自动恢复麦克风
```

保护要求：

```text
不要随意重构 server/voice-management.js
不要随意重构 client/src/components/voice/VoiceRoom.jsx 生命周期
不要破坏服务器静音、移动、移出逻辑
```

#### 第二阶段：频道设置与权限

已完成：

```text
频道名称修改
频道描述修改
频道排序
人数上限
进入权限：everyone / members / admins
allowGuests
系统频道保护
有人频道禁止删除
频道删除
频道列表统一排序
PATCH /api/channels/reorder 批量排序
```

保护要求：

```text
GET /api/channels 不应依赖 LiveKit listParticipants
删除频道时可检查 LiveKit 占用
lobby 是系统频道
普通频道不能因为名字叫“大厅”就变成系统频道
不要破坏频道 id，因为 LiveKit room 使用 channel.id
```

#### 第三阶段 3A：成员右键菜单、本地音量、本地静音

已完成：

```text
成员右键菜单
手机端通过 ⋯ 打开完整成员菜单
查看成员资料
单成员本地音量
本地静音 / 取消本地静音
本地设置 localStorage 持久化
Admin / Member / Guest 菜单权限区分
服务器静音标签和本地静音标签区分
```

保护要求：

```text
本地静音只影响当前浏览器
本地音量只影响当前浏览器
本地音量 / 静音不调用后端
本地静音不写入 LiveKit metadata
不要和服务器静音混淆
```

#### 第三阶段 3B：指定事件语音播报

已完成：

```text
浏览器 speechSynthesis 语音播报
语音播报开关，默认开启，本地保存
server_joined
channel_joined
channel_left
channel_moved
server_muted
eventId 去重
队列顺序播放
自动播放解锁
```

最终播报规则：

```text
server_joined：全服播报欢迎
别人进入我所在频道：我听到“xxx 进入频道”
别人离开我所在频道：我听到“xxx 离开频道”
我自己手动进入 / 离开频道：我自己不听自己的进出播报
我被管理员移动：我自己可以听到“xxx 被移动到 xxx”
我被服务器静音：我自己可以听到“xxx 被闭嘴”
解除服务器静音不播报
无关频道不应听到频道事件
刷新 / reconnecting / 短暂断线不应误播
管理员 move 不应连播“离开 + 进入 + 被移动”
```

关键实现：

```text
announcement 由后端产生
通过 Presence WebSocket 发送
前端不推断事件，只播放后端 announcement
broadcastAnnouncement 支持 scope
channel_joined 只发目标频道其他用户
channel_left 只发原频道其他用户
channel_moved 发源频道 + 目标频道 + 被移动者 + 操作者
server_muted 发目标所在频道 + 目标本人 + 操作者
server_joined 仍全服
```

保护要求：

```text
不要新增第二套 WebSocket
不要把语音播报塞进 LiveKit 音频轨道
不要做机器人音频
不要破坏 Presence snapshot
不要让初始快照触发播报
```

#### 第四阶段 4A：头像后端

已完成：

```text
POST /api/me/avatar
DELETE /api/me/avatar
Admin / Member 可上传自己的头像
Guest 禁止上传
未登录禁止上传
支持 JPG / PNG / WebP
拒绝 SVG / GIF / 非图片
magic bytes 校验
2MB 限制
server/uploads/avatars/ 持久化存储
users.avatar_path 数据库字段
avatarUrl 公开字段
/uploads/avatars 静态访问
旧头像清理
数据库失败时回滚新文件
```

保护要求：

```text
不要提交真实头像文件
server/uploads/ 应被 gitignore
不要返回 avatar_path 或磁盘绝对路径
不要使用用户原始文件名
不要允许路径穿越
不要让 Guest 上传或删除头像
```

#### 第四阶段 4B：头像前端展示与上传入口

已完成：

```text
UserAvatar 通用头像组件
默认首字母头像
图片加载失败 fallback
我的账号中上传 / 删除头像
Guest 不显示上传 / 删除入口
左下角账号卡显示头像
频道成员卡片显示头像
在线成员列表显示头像
成员资料弹窗显示头像
战队成员列表显示头像
战队管理列表显示头像
上传成功后同步 currentUser / Presence / 成员展示
删除后回到默认首字母
```

保护要求：

```text
头像前端不要改后端 API
头像展示不要改 VoiceRoom 生命周期
normalizeAvatarUrl 应拒绝危险 URL，例如 javascript:、data:、协议相对 URL、反斜杠、空白
头像上传不应写 localStorage
头像 base64 不应打印到 console
```

---

## 2. 工作方法

每个任务都必须遵循：

1. 读取本 `AGENTS.md`。
2. 运行 `git status`，识别当前分支；需要时运行 `git branch --show-current`、`git remote -v`。
3. 检查相关文件和调用点。
4. 搜索相关标识符、路由、组件和测试。
5. 修改前先说明当前实现。
6. 做最小兼容修改，不重写整文件，除非任务明确要求。
7. 运行相关测试、构建或静态检查。
8. 报告实际结果，不报告“预计通过”。

开发原则：

```text
一次只做一个小阶段
先检查真实代码，再改
不要凭空假设文件结构
优先新增独立工具函数和组件
高风险核心逻辑只做最小改动
每次修改后必须跑相关测试
不要为了 UI 改 VoiceRoom 生命周期
不要为了播报改 LiveKit 音频轨道
不要为了头像改 token
不要为了音乐机器人提前改语音核心
```

不要静默删除现有功能。不要在构建或必要测试失败时声称任务完成。

---

## 3. 用户环境与命令格式

用户在 Windows PowerShell 中运行项目。给用户的命令必须使用 PowerShell 兼容写法。

优先使用：

```powershell
Select-String
Copy-Item
Remove-Item
Add-Content
Get-Content
Set-Content
```

不要让用户运行 Linux 专用命令，例如 `grep`、`printf`、`cp`、`rm`、`export`。

Codex Linux 沙箱内部可以使用环境原生命令，但最终说明应翻译为 PowerShell。

常用本地命令：

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client
npm run build
```

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\server
npm run dev
```

如果 `npm run dev` 不存在，先检查 `server/package.json`，不要凭空推荐命令。

---

## 4. 关键目录和文件

### 后端

```text
server/index.js
```

Express 主入口。注册认证、成员、频道、LiveKit token、头像、静态文件和 SPA fallback。所有 `/api/*` 路由必须在 `express.static(clientDistPath)` 和 SPA fallback 之前注册；未匹配 API 必须返回 JSON。

```text
server/db.js
```

SQLite 初始化和迁移入口。数据库使用 `better-sqlite3`。涉及 schema 时必须先检查当前结构、备份数据、让迁移可重复执行。

```text
server/presence.js
```

自研 Presence WebSocket 服务。负责在线成员、位置聚合、快照、重连宽限、移动窗口、播报 scope、eventId 去重等。高风险，不要随意重构。

```text
server/voice-management.js
```

服务器静音、解除静音、移动成员、移出成员等 LiveKit 管理逻辑。高风险，不要随意重构。

```text
server/channels.js
```

频道模型、字段规范化、权限判断、排序和批量 reorder 相关工具。

```text
server/avatar.js
```

头像上传、magic bytes 校验、文件保存、旧文件清理、公开 URL 转换、`avatar_path` migration 相关逻辑。

```text
server/auth-session.js
```

正式成员 session、认证中间件、公开用户结构、角色权限判断。

```text
server/guest-auth.js
```

Guest session、签名 cookie、过期校验、Guest 公开结构。

```text
server/data/novaspeak.db
```

SQLite 数据库。不得用生产数据库做破坏性自动化测试。

```text
server/uploads/avatars/
```

用户头像运行时上传目录。不得提交真实头像文件或用户上传内容。

### 前端

```text
client/src/App.jsx
```

前端主状态入口，拥有 `currentUser`。账号、成员和头像更新必须同步到这里或通过 `GET /api/auth/me` 重新获取，不要创建第二套认证用户状态。

```text
client/src/components/voice/VoiceRoom.jsx
```

LiveKit 房间生命周期、连接、断开、成员轨道、语音管理和播报集成。最高风险文件之一，不要轻易重构生命周期。

```text
client/src/components/voice/VoiceParticipantCard.jsx
```

频道成员卡片，展示头像、昵称、服务器静音、本地静音等状态。

```text
client/src/components/voice/VoiceParticipantList.jsx
```

频道成员列表和相关排序、展示逻辑。

```text
client/src/components/voice/VoiceMemberContextMenu.jsx
```

成员右键菜单 / 手机端完整菜单。区分 Admin、Member、Guest 权限，并包含查看资料、本地音量、本地静音、移动、移出、服务器静音等入口。

```text
client/src/components/voice/MemberProfileDialog.jsx
```

成员资料弹窗，展示头像、昵称、角色、职位等公开资料。

```text
client/src/components/common/UserAvatar.jsx
```

通用头像组件。支持图片头像、加载失败 fallback、默认首字母头像。

```text
client/src/components/account/AccountSettings.jsx
```

我的账号设置，包括正式成员昵称 / 密码相关功能和头像上传 / 删除入口。Guest 不显示头像上传 / 删除入口。

```text
client/src/utils/avatar.js
```

头像 URL 规范化、安全过滤、首字母等前端工具。必须拒绝危险 URL。

```text
client/src/utils/avatar-api.js
```

头像上传 / 删除 API 工具。应使用现有 API 基址、携带凭证、处理 JSON 和错误。

```text
client/src/utils/local-audio-preferences.js
```

本地音量、本地静音、语音播报开关等 localStorage 偏好。只影响当前浏览器。

```text
client/src/utils/voice-announcements.js
```

语音播报文本、队列、去重、speechSynthesis 相关纯工具。

```text
client/src/utils/voice-participant.js
```

语音成员展示、身份、状态衍生工具。

```text
client/src/hooks/usePresence.js
```

前端 Presence WebSocket hook。处理 snapshot、在线成员、位置和 announcement，不应创建第二套 WebSocket。

```text
client/src/hooks/useVoiceAnnouncements.js
```

前端语音播报 hook。只播放后端 Presence announcement，不自行推断事件。

```text
client/src/App.css
```

主要样式。保持 NovaSpeak 深色、青色 / 蓝绿色、轻量电竞 UI 风格。

---

## 5. 应用架构和 API 规则

Express 同时负责 API 和生产前端静态资源。

必须保持：

```js
app.use(express.static(clientDistPath));
```

和 SPA fallback 之前注册所有 `/api/*` 路由。

未匹配 API 路由必须返回 JSON，例如：

```js
app.use("/api", (req, res) => {
  res.status(404).json({
    error: `API 不存在：${req.method} ${req.originalUrl}`,
  });
});
```

这可以避免前端出现：

```text
Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

前端请求必须：

```text
使用现有 API_BASE
认证请求使用 credentials: "include"
解析 JSON 前检查 content-type
处理 response.ok
显示清晰中文错误
避免 unhandled promise
```

成功响应建议：

```json
{
  "success": true,
  "user": {}
}
```

错误响应建议：

```json
{
  "error": "清晰的中文错误信息"
}
```

常用状态码：

```text
400 invalid input
401 unauthenticated or incorrect current password
403 authenticated but insufficient permission
404 resource not found
409 nickname or resource conflict
500 unexpected server error
```

不要向浏览器返回 raw stack、SQL、secret、内部绝对路径、cookie、token、密码哈希。

---

## 6. 认证、角色与权限模型

权限只由 `role` 决定，不得用职位（例如 `captain`）提升权限。

支持角色：

```text
admin
member
guest
```

如果真实代码与下列描述略有差异，以真实代码为准，但不要随意扩大 Guest 权限。

### Admin

```text
可管理成员
可修改频道
可服务器静音 / 解除服务器静音
可移动 / 移出成员
可上传 / 删除自己头像
可查看和修改自己的正式账号
可使用语音和聊天
```

### Member

```text
可移动 / 移出成员
不可服务器静音
不可管理频道
可上传 / 删除自己头像
可查看和修改自己的正式账号
可使用语音和聊天
```

### Guest

```text
可临时登录
可加入允许访客的频道
可查看公开战队信息
可使用允许范围内的基础语音和聊天
不可管理频道
不可移动 / 移出
不可服务器静音
不可上传头像
不可访问正式账号设置和管理员管理页
```

一个用户即使是：

```js
{ role: "member", positions: ["captain"] }
```

仍然不是管理员。

### 中间件职责

```text
requireAuthenticated：允许 admin / member / guest，用于频道读取、加入语音、LiveKit token、基础聊天、公开成员信息。
requireRegistered：允许 admin / member，用于正式账号设置、头像上传 / 删除，以及当前真实代码允许的注册用户操作。
requireAdmin：允许 admin，用于成员管理、频道管理、服务器静音等管理员操作。
```

替换或删除旧中间件前必须搜索所有调用点。

---

## 7. 正式成员、职位与 Guest 认证

### 正式成员

正式用户存储在 SQLite。登录使用：

```text
规范化游戏昵称
密码哈希
数据库 session
HttpOnly session cookie
```

昵称字段必须同步：

```text
username
username_key
display_name
```

昵称规范化必须先检查类型，再 NFKC normalize、trim、生成大小写不敏感 key。不得对 `undefined` 直接调用 `.trim()` 或 `.normalize()`。

不得存储明文密码。使用 `auth-utils.js` 中现有哈希和验证函数，不要创建第二套密码实现。

### 多职位

正式成员可有多个职位。权威存储是：

```text
user_positions
```

不要把 legacy `users.position` 当成唯一真源，也不要在没有专门 migration 任务时删除 legacy 字段。

职位更新必须：

```text
验证输入是数组
拒绝未知值
去重
使用数据库 transaction
更新 user_positions
绝不修改 users.role
按当前 API 规则保留至少一个职位
```

### Guest 认证

Guest 是临时身份，不得插入：

```text
users
sessions
user_positions
```

Guest 使用：

```text
随机 UUID
签名 HttpOnly cookie
HMAC-SHA256
GUEST_SESSION_SECRET
过期校验
签名校验
```

期望公开结构：

```json
{
  "id": "guest:UUID",
  "nickname": "临时昵称",
  "displayName": "临时昵称",
  "role": "guest",
  "isAdmin": false,
  "isCaptain": false,
  "isGuest": true,
  "positions": [],
  "positionNames": [],
  "position": "guest",
  "positionName": "访客",
  "avatarUrl": null
}
```

Guest cookie 畸形、过期或被篡改时，应视为未登录，不得导致 500。

正式登录成功应清除旧 Guest cookie。Guest 登录成功应清除旧正式 session 和正式 cookie。Logout 必须安全清理两类身份。

---

## 8. LiveKit、VoiceRoom 与 Presence 高风险保护

### 不要轻易改 VoiceRoom 生命周期

以下内容不要随意重构：

```text
room.connect()
room.disconnect()
RoomEvent.Moved
RoomEvent.Disconnected
RoomEvent.TrackSubscribed
RoomEvent.TrackUnsubscribed
连接 effect 依赖数组
connectAttemptRef / disposed / roomRef 保护逻辑
LiveKit token 获取
```

原因：

```text
之前多次出现过黑屏、Client initiated disconnect、退出频道崩溃、移动频道状态错乱。
```

LiveKit token 必须由后端在验证当前身份后签发。不要信任前端传来的 role、positions、userId。正式成员 identity 使用现有稳定策略；Guest identity 必须使用 `guest:UUID`，不要用 Guest 昵称作为唯一 LiveKit identity。

Guest LiveKit metadata 应包含：

```json
{
  "role": "guest",
  "isGuest": true,
  "positions": []
}
```

### 不要轻易改 Presence WebSocket

以下内容不要随意重构：

```text
Presence snapshot
online members
location aggregation
reconnecting
multi_channel
announcement scope
pending move window
downgrade / offline grace timer
eventId 去重相关后端字段
```

原因：

```text
Presence 同时影响在线状态、频道成员、语音播报、移动频道去重。
```

不得新增第二套 WebSocket。不得破坏 Presence snapshot。不得让初始 snapshot 触发语音播报。

### 不要混淆三种静音

```text
麦克风开关：用户自己的本地麦克风状态。
服务器静音：管理员操作，后端 / LiveKit 权限控制，对所有人有效。
本地静音：当前用户只是不听某个成员，纯前端 localStorage，只影响自己。
```

要求：

```text
本地静音不得调用后端
本地静音不得写 metadata
本地音量不得调用后端
服务器静音不得被本地静音覆盖
解除服务器静音后，只在目标用户本人浏览器恢复麦克风
服务器静音标签和本地静音标签必须区分
```

### 不要混淆频道切换和管理员移动

```text
用户手动进出频道：channel_joined / channel_left
管理员移动成员：channel_moved
管理员移动不应连播 channel_left / channel_joined
pending move window 用于抑制 move 过程中的普通进出播报
```

---

## 9. 频道规则

频道相关规则：

```text
频道 id 是 LiveKit room 名称基础，不能随意改变
lobby 是系统频道
普通频道不能因为名字叫“大厅”就变成系统频道
系统频道受保护
有人频道禁止删除
删除频道时可以检查 LiveKit 占用
LiveKit 404 room not found 应视为 0 人，而不是删除失败
GET /api/channels 不应依赖 LiveKit listParticipants
频道列表必须统一排序
PATCH /api/channels/reorder 用于批量排序
```

权限字段：

```text
accessLevel: everyone / members / admins
allowGuests: true / false
maxMembers: 人数上限，可按当前代码规则为空或数字
```

---

## 10. 头像规则

后端规则：

```text
仅 Admin / Member 可上传或删除自己的头像
Guest 和未登录用户禁止上传 / 删除
上传使用 JSON base64
限制 2MB
仅允许 JPG / PNG / WebP
使用 magic bytes 校验真实类型
拒绝 SVG / GIF / 非图片
保存到 server/uploads/avatars/
数据库只保存受控相对路径 avatar_path
公开返回 avatarUrl
数据库失败时回滚新文件
替换头像时清理旧头像
```

安全要求：

```text
不要提交真实头像文件
server/uploads/ 应被 gitignore
不要返回 avatar_path
不要返回磁盘绝对路径
不要使用用户原始文件名
不要允许路径穿越
不要打印 base64 到 console
```

前端规则：

```text
使用 UserAvatar 展示头像
图片加载失败 fallback 到默认首字母头像
Guest 不显示上传 / 删除入口
上传成功后同步 currentUser / Presence / 各成员展示
删除后回到默认首字母
normalizeAvatarUrl 必须拒绝 javascript:、data:、协议相对 URL、反斜杠、空白等危险 URL
头像上传不写 localStorage
头像展示不要修改 VoiceRoom 生命周期
```

---

## 11. 前端状态与 UI 风格

`client/src/App.jsx` 拥有中心 `currentUser` 状态。账号和成员相关组件应通过回调（例如 `onUserUpdated(updatedUser)`）或重新请求 `GET /api/auth/me` 同步用户信息。

账号信息更新后必须同步：

```text
左下角账号显示
昵称
职位标签
头像
权限可见性
```

普通账号编辑不得重新播放登录欢迎动画，除非任务明确要求。

UI 风格：

```text
深色背景
cyan / teal 蓝绿色强调色
轻量电竞界面
中文标签和中文错误提示
清晰可读文字
克制动画
```

不要为了小功能重做整个 UI。不要对重要文字使用过度 blur 或大幅缩放动画。

### LoginScreen 特别规则

文件：

```text
client/src/components/auth/LoginScreen.jsx
```

不得创建嵌套 form。当前验证过的方式是：

```text
Guest 面板关闭：submit 调用 handleMemberLogin
Guest 面板打开：submit 调用 handleGuestLogin
```

按钮规则：

```text
打开 Guest 面板：type="button"
取消 Guest 模式：type="button"
正式登录：type="submit"
Guest 进入：type="submit"
```

所有 submit handler 必须调用 `event.preventDefault()`，不得重新引入浏览器跳转到 `/?` 的问题。

---

## 12. 数据库、Secrets 与运行时文件

数据库文件：

```text
server/data/novaspeak.db
```

数据库规则：

```text
使用参数化 SQL
相关多步写入必须使用 transaction
迁移前检查当前 schema
迁移前备份数据库
迁移尽量可重复
保留现有用户数据
不得用生产数据库做破坏性自动化测试
```

可使用：

```text
数据库副本
临时测试数据库
transaction rollback
可完全清理的一次性测试记录
```

不得提交或打印 secrets：

```text
server/.env
GUEST_SESSION_SECRET
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
session tokens
password hashes
cookies
```

`.env.example` 只能包含占位符，不能包含真实值。

---

## 13. Git 和文件管理规则

提交前必须检查：

```powershell
git status --short
git diff --cached
```

严禁：

```text
提交 node_modules
提交 .env
提交 server/data/*.db-shm
提交 server/data/*.db-wal
提交真实头像文件
提交上传目录里的用户内容
提交 package-lock 纯噪音改动
使用 git add .
强推
未获明确允许直接推 main
覆盖无关未提交用户改动
```

如果出现：

```text
server/node_modules/...
server/data/novaspeak.db-shm
server/data/novaspeak.db-wal
server/uploads/avatars/真实图片
```

必须说明它们是运行时文件或依赖文件，不应提交。

不要提交 `client/dist`，除非仓库已经明确追踪并要求提交生产构建输出。

如果发生 merge conflict：

```text
检查双方内容
手动保留所有必要功能
移除冲突标记
构建 / 测试后再提交
不要盲目选择全部 ours 或 theirs
```

PowerShell 检查冲突标记示例：

```powershell
Select-String `
  -Path .\client\src\components\auth\LoginScreen.jsx `
  -Pattern '<<<<<<<|=======|>>>>>>>'
```

---

## 14. 常用测试和检查命令

### 后端

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\server

node --check .\index.js
node --check .\db.js
node --check .\presence.js
node --check .\voice-management.js
node --check .\channels.js
node --check .\avatar.js

node --test --test-concurrency=1 .\presence.test.js .\presence-websocket.test.js .\voice-management.test.js .\channels.test.js .\avatar.test.js
```

### 前端

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client

node --test .\src\utils\avatar.test.js
node --test .\src\utils\avatar-api.test.js
node --test .\src\utils\voice-announcements.test.js
node --test .\src\utils\local-audio-preferences.test.js
node --test .\src\utils\channel-settings.test.js
node --test .\src\utils\voice-participant.test.js .\src\utils\voice-room-events.test.js .\src\utils\voice-member-menu.test.js .\src\utils\voice-room-lifecycle.test.js

npm run build
```

### 全局检查

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\
git diff --check
git status --short
```

任务相关最小检查应按修改范围选择。认证或权限任务至少覆盖：

```text
未登录访问
Guest 访问
Member 访问
Admin 访问
无效输入
成功输入
JSON content-type
session continuity
logout
响应不泄露 secret 字段
前端生产构建
```

没有正式密码时，不要索要或暴露用户真实密码；使用一次性测试账号、测试数据库或安全测试替身。

---

## 15. 已知历史问题和避免方式

不要重新引入以下问题：

```text
退出频道黑屏：SyntheticEvent 被写入 voiceNotice，React error #31。避免把事件对象直接放入渲染状态。
进频道失败：VoiceRoom lifecycle effect 依赖不稳定导致 Client initiated disconnect。避免随意改变连接 effect 依赖和 room 生命周期保护。
服务器静音状态跨频道不同步：已用稳定 identity / server mute records 修复。不要改坏 identity 和服务器静音记录。
移动频道语音播报连播：pending move window 修复。不要绕过移动窗口。
无关频道听到播报：announcement scope 修复。不要把频道事件广播成全服。
自己听到自己的进出频道：channel_joined / channel_left 排除事件本人修复。不要在前端自行推断进出播报。
频道编辑被三秒轮询重置：dirty draft 修复。编辑中不要被轮询覆盖草稿。
频道排序无效：批量 reorder 修复。排序要走 PATCH /api/channels/reorder 并保持全量顺序。
LiveKit 房间不存在导致删除频道 503：404 room not found 视为 0 人修复。删除频道时不要把该 404 当作致命错误。
```

---

## 16. 后续路线

### 下一阶段建议

现在前四阶段功能完成，后续建议优先进入稳定性、体验和运营工具完善阶段：

```text
5A：频道管理体验微调、空状态和错误提示整理
5B：语音状态与 Presence 稳定性回归测试
5C：成员资料、头像和在线列表展示细节优化
5D：生产部署检查清单和备份 / 恢复流程整理
5E：管理后台小型审计日志或操作记录（仅在明确需要时做）
```

### 音乐机器人未来路线

音乐机器人以后再做，建议拆为：

```text
6A：本地测试音频机器人加入 LiveKit 频道并推流
6B：播放队列
6C：网易云登录和歌单读取
6D：网易云歌单播放
6E：机器人控制 UI
```

明确提醒：

```text
不要现在直接接网易云和 QQ 音乐
先验证 LiveKit 后端机器人音频推流
不要绕过付费、会员、版权限制
不要缓存或重新分发音乐文件
```

---

## 17. 完成报告要求

完成任务后必须报告：

1. 当前分支。
2. 是否完整读取旧 `AGENTS.md`。
3. 检查过哪些相关文件。
4. 修改或新增了哪些文件。
5. 主要实现决策。
6. API 路由新增或变更；若无，明确说明无。
7. Admin / Member / Guest 权限行为；若未涉及，明确说明未改变。
8. 执行过的命令。
9. 构建和测试结果。
10. 现有无关 warning / failure。
11. 创建提交时给出 git commit hash。
12. Push 或 PR 状态。
13. 给用户的手动验证步骤。
14. 未完成或不确定事项。

回答不得只有“完成”或“已修复”。
