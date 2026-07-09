# NovaSpeak 桌面客户端(第一阶段 5A)

这是 NovaSpeak 桌面客户端的第一阶段:一个 Electron 桌面壳,把现有 NovaSpeak Web 前端承载到 Windows 桌面窗口中。

Electron 只负责桌面窗口和未来的桌面能力,**不接管任何业务逻辑**:

- LiveKit 连接、VoiceRoom 生命周期、Presence WebSocket、服务器静音 / 移动 / 头像等逻辑全部沿用现有 `client/` 前端代码。
- LiveKit token 仍由后端签发,LiveKit URL(`wss://livekit.novagaming.top`)仍来自后端返回。
- Electron 中不存放任何 secret(`LIVEKIT_API_SECRET`、session secret 等)。

## 当前开发模式依赖

当前阶段以**开发模式**为主:Electron 窗口加载本地 Vite 开发服务器 `http://localhost:5173`,`/api`、`/ws`、`/uploads` 继续由 Vite 代理到本地后端 `http://localhost:3001`。

因此运行桌面 App 前,必须先把本地 server 和 client 同时跑起来。

## 启动顺序

```powershell
cd server
npm run dev
```

```powershell
cd client
npm run dev
```

```powershell
cd desktop
npm install
npm run dev
```

第三步会打开 NovaSpeak 桌面窗口,显示现有 Web 前端页面,可正常登录、进入频道、申请麦克风权限并使用语音。

## 开发 / 生产模式判定

`desktop/main.js` 按以下规则选择加载目标:

| 条件 | 加载目标 |
| --- | --- |
| `NOVASPEAK_DESKTOP_DEV=true` | `http://localhost:5173` |
| 未打包运行(`electron .`)且未设置 `NOVASPEAK_DESKTOP_DEV=false` | `http://localhost:5173` |
| 其余情况(打包运行,或显式 `NOVASPEAK_DESKTOP_DEV=false`) | `../client/dist/index.html` |

## 生产模式说明(暂不完整)

当前 5A 阶段主要支持开发模式。生产模式只做了基础结构预留(加载 `client/dist/index.html`),但在 `file://` 协议下,前端对 `/api`、`/ws`、`/uploads` 的相对路径请求无法到达后端,所以生产模式目前**不可用**,属于预期限制。

生产打包前需要先确定以下策略(后续阶段处理,不在本阶段修改业务逻辑):

- `API_BASE` 策略:前端在桌面生产模式下应指向哪个后端地址(例如 `https://voice.novagaming.top`)。
- 静态资源服务策略:是加载本地 `client/dist`,还是让 Electron 直接加载线上部署页面。
- WebSocket(`/ws`)与上传(`/uploads`)在非同源场景下的地址策略。

## 安全配置

- `contextIsolation: true`,`nodeIntegration: false`:渲染进程(React)无法直接访问 Node.js 能力。
- `preload.js` 只暴露最小只读信息:`window.novaDesktop = { platform, isDesktop: true }`;不暴露 `fs`、`child_process`、`shell`、环境变量或任何 secret。
- 渲染进程权限走白名单:允许 `media`(麦克风)、`speaker-selection` 等语音必需权限,其余请求一律拒绝。
- 新窗口一律拒绝,外部 `http(s)` 链接交给系统默认浏览器打开。

## 当前不包含

本阶段刻意不包含以下能力(后续阶段再做):

- 系统托盘、后台常驻、开机启动
- 自动更新
- 打包 exe 安装包
- 按键说话(Push-to-Talk)
- 降噪
- 音乐机器人

## 后续阶段计划

1. **5B(建议)**:确定桌面生产模式的 `API_BASE` / 静态服务 / 后端地址策略,让打包版可直连线上后端。
2. 打包:electron-builder 产出 Windows 安装包 / 便携版。
3. 桌面体验:托盘、窗口状态记忆、自动更新。
4. 桌面语音增强:按键说话、全局快捷键(不改 VoiceRoom 生命周期,通过 preload 暴露受控 API)。
