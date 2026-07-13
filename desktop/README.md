# NovaSpeak 桌面客户端

NovaSpeak 桌面客户端是一个 Electron 壳,把现有 NovaSpeak Web 前端承载到 Windows 桌面窗口中,并打包成 NSIS 安装包(exe)发给战队安装使用。

Electron 只负责桌面窗口和最小桥接,**不接管任何业务逻辑**:

- LiveKit 连接、VoiceRoom 生命周期、Presence WebSocket、服务器静音 / 移动 / 头像、降噪三开关等逻辑全部沿用现有 `client/` 前端代码。
- LiveKit token 仍由后端签发,LiveKit URL(`wss://livekit.novagaming.top`)仍来自后端 `/api/token` 返回,前端直连。
- Electron 与安装包中不存放任何 secret(`LIVEKIT_API_SECRET`、session secret 等),不含 server 代码、不含 `.env`、不含 SQLite。

## 后端地址唯一切换点(重要)

打包版前端不再依赖 vite dev proxy,所有 `/api`、`/ws`、`/uploads` 请求都基于**构建期注入的后端地址**拼接。该地址只有一个切换点:

```text
desktop/app-config.json  →  backendOrigin
```

当前值(Cloudflare 命名隧道):

```json
{ "backendOrigin": "https://app.novagaming.top" }
```

备案后迁移 ECS 时,只需把它改成新地址(例如 `https://voice.novagaming.top`),重新打包即可,**无需改任何代码**:

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\desktop
npm run dist
```

打包脚本 `scripts/build-renderer.js` 会读取该文件,注入 `VITE_API_BASE` 运行 `vite build`,并自检产物(资源必须是相对路径、bundle 里必须包含该地址)。`main.js` 运行时读取同一份 `app-config.json`,保证主进程与渲染层指向同一个后端。

对应关系:

| 请求 | 打包版实际地址 |
| --- | --- |
| `/api/...` | `https://app.novagaming.top/api/...` |
| Presence WebSocket | `wss://app.novagaming.top/ws/presence` |
| 头像 `/uploads/avatars/...` | `https://app.novagaming.top/uploads/avatars/...` |
| LiveKit 媒体 | `wss://livekit.novagaming.top`(由后端返回,不受此配置影响) |

## 打包 Windows 安装包

前置:`client/` 与 `desktop/` 各自 `npm install` 过一次。

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client
npm install
```

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\desktop
npm install
npm run dist
```

产物:

```text
desktop\release\NovaSpeak-Setup-<版本号>.exe
```

版本号取 `desktop/package.json` 的 `version`。图标在 `desktop/build/icon.ico`。

分步命令:

| 命令 | 作用 |
| --- | --- |
| `npm run build:renderer` | 只构建渲染层:vite build(注入后端地址、`--base=./`)并复制 `client/dist` → `desktop/renderer/` |
| `npm run dist` | 渲染层构建 + electron-builder 产出 NSIS 安装包 |
| `npm run dist:dir` | 渲染层构建 + 免安装目录版(调试用) |

`desktop/renderer/` 与 `desktop/release/` 是构建产物,已被 gitignore,不要提交。

## 生产模式如何直连线上后端(file:// 跨站说明)

打包版通过 `loadFile` 加载本地静态页面(`file://`),对 `https://app.novagaming.top` 属于跨站请求。后端的 `cors()` 默认响应头与携带凭证请求互斥,会话 Cookie 又是 `SameSite=Lax`,纯浏览器规则下无法登录。桌面壳在主进程用 `webRequest.onHeadersReceived` 做了**只针对配置后端源**的会话桥(见 `main.js`):

1. 给该源的响应补 `Access-Control-Allow-Origin: null` + `Access-Control-Allow-Credentials: true`;
2. 把该源的 `Set-Cookie` 重写为 `SameSite=None; Secure`(因此 **backendOrigin 必须是 https**,http 仅限本机调试)。

这不修改服务器任何文件,只影响桌面壳自身会话存储,其他站点的请求一律不碰。Presence WebSocket 握手同样依赖该 Cookie,重写后可正常鉴权。

## 开发模式

开发模式不变:Electron 窗口加载本地 Vite 开发服务器 `http://localhost:5173`,`/api`、`/ws`、`/uploads` 由 Vite 代理到本地后端 `http://localhost:3001`。

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

## 开发 / 生产模式判定

`desktop/main.js` 按以下规则选择加载目标:

| 条件 | 加载目标 |
| --- | --- |
| `NOVASPEAK_DESKTOP_DEV=true` | `http://localhost:5173` |
| 未打包运行(`electron .`)且未设置 `NOVASPEAK_DESKTOP_DEV=false` | `http://localhost:5173` |
| 其余情况(打包运行,或显式 `NOVASPEAK_DESKTOP_DEV=false`) | `desktop/renderer/index.html`(缺失时回退 `../client/dist/index.html`) |

本机验证打包前生产模式(不出安装包):

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\desktop
npm run build:renderer
$env:NOVASPEAK_DESKTOP_DEV = "false"
npm run start
Remove-Item Env:NOVASPEAK_DESKTOP_DEV
```

## 安全配置

- `contextIsolation: true`,`nodeIntegration: false`:渲染进程(React)无法直接访问 Node.js 能力。
- `preload.js` 只暴露最小只读信息:`window.novaDesktop = { platform, isDesktop: true }`;不暴露 `fs`、`child_process`、`shell`、环境变量或任何 secret。
- 渲染进程权限走白名单:允许 `media`(麦克风)、`speaker-selection` 等语音必需权限,其余请求一律拒绝。
- 新窗口一律拒绝,外部 `http(s)` 链接交给系统默认浏览器打开。
- 主进程会话桥仅限 `app-config.json` 配置的后端源,不放宽任何其他站点,也不向渲染进程新增能力。

## 当前不包含

本阶段刻意不包含以下能力(后续阶段再做):

- 系统托盘、后台常驻、开机启动
- 自动更新(换后端地址或发新版本需重新分发安装包)
- 代码签名(安装时 SmartScreen 可能提示"未知发布者",点"仍要运行"即可)
- 按键说话(Push-to-Talk)
- 音乐机器人

## 后续阶段计划

1. 桌面体验:托盘、窗口状态记忆、自动更新(electron-updater + 静态更新源)。
2. 桌面语音增强:按键说话、全局快捷键(不改 VoiceRoom 生命周期,通过 preload 暴露受控 API)。
3. 代码签名证书(消除 SmartScreen 提示)。
