# NovaSpeak 桌面客户端

这是 NovaSpeak 桌面客户端的第一阶段:一个 Electron 桌面壳,把现有 NovaSpeak Web 前端承载到 Windows 桌面窗口中。

Electron 只负责桌面窗口和未来的桌面能力,**不接管任何业务逻辑**:

- LiveKit 连接、VoiceRoom 生命周期、Presence WebSocket、服务器静音 / 移动 / 头像等逻辑全部沿用现有 `client/` 前端代码。
- LiveKit token 仍由后端签发,LiveKit URL(`wss://livekit.novagaming.top`)仍来自后端返回。
- Electron 中不存放任何 secret(`LIVEKIT_API_SECRET`、session secret 等)。

## 当前开发模式依赖

开发模式下 Electron 窗口加载本地 Vite 开发服务器 `http://localhost:5173`,`/api`、`/ws`、`/uploads` 继续由 Vite 代理到本地后端 `http://localhost:3001`。

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
| 其余情况(打包运行,或显式 `NOVASPEAK_DESKTOP_DEV=false`) | `https://app.novagaming.top` |

## 生产模式

打包版直接加载 `https://app.novagaming.top`，因此页面、`/api`、`/ws`、`/uploads` 和 Session Cookie 都保持同源。朋友电脑只运行 NovaSpeak 客户端，不需要安装 Node.js、FFmpeg、server 或 client；你的服务器与 Cloudflare Tunnel 必须保持在线。

主窗口禁止导航到其他来源，外部 HTTP(S) 链接交给系统浏览器。网易云登录仍使用隔离的内存 Session，Cookie 只经 IPC 传到后端加密保存。

## Windows 打包

在 Windows 中运行：

```powershell
cd desktop
npm ci
npm test
npm run dist:win
```

输出位于 `desktop/dist/`：

- `NovaSpeak-<版本>-x64-Setup.exe`：NSIS 安装包。
- `NovaSpeak-<版本>-x64-Portable.exe`：免安装便携版。

推送到 `main` 时，GitHub Actions 也会在 Windows runner 上执行相同打包，并上传 `NovaSpeak-Windows` artifact。

## 安全配置

- `contextIsolation: true`,`nodeIntegration: false`:渲染进程(React)无法直接访问 Node.js 能力。
- `preload.js` 只暴露最小只读信息:`window.novaDesktop = { platform, isDesktop: true }`;不暴露 `fs`、`child_process`、`shell`、环境变量或任何 secret。
- 渲染进程权限走白名单:允许 `media`(麦克风)、`speaker-selection` 等语音必需权限,其余请求一律拒绝。
- 新窗口一律拒绝,外部 `http(s)` 链接交给系统默认浏览器打开。

## 当前不包含

本阶段刻意不包含以下能力(后续阶段再做):

- 系统托盘、后台常驻、开机启动
- 自动更新
- 按键说话(Push-to-Talk)
- Windows 代码签名

## 后续阶段计划

1. 桌面体验：托盘、窗口状态记忆、自动更新。
2. 正式发布前配置 Windows 代码签名，消除 SmartScreen 的“未知发布者”提示。
3. 按键说话与全局快捷键（不改 VoiceRoom 生命周期，通过 preload 暴露受控 API）。
