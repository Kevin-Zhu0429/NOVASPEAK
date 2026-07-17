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
- `latest.yml` 与 `*.blockmap`：安装版自动更新所需的元数据。

推送到 `main` 时，GitHub Actions 也会在 Windows runner 上执行相同打包，并上传 `NovaSpeak-Windows` artifact。

## 安装版自动更新

自动更新只支持 NSIS 安装版；`Portable.exe` 仍需手动替换。客户端启动约 15 秒后检查一次，此后每 4 小时检查一次。发现新版本时会先询问是否下载，下载完成后可以立即重启更新，也可以等退出应用时安装。

更新文件通过以下公开地址提供：

```text
https://app.novagaming.top/desktop-updates/
```

第一次启用自动更新时，现有用户必须手动安装一次 `0.2.0` 安装版；从这个版本开始才具备 OTA 能力。

以后发布更新：

1. 将 `desktop/package.json` 的 `version` 提升，例如从 `0.2.0` 改为 `0.2.1`。
2. 在 Windows 构建并发布到当前服务器：

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\desktop
npm ci
npm test
npm run dist:win
npm run publish:update-local
```

`publish:update-local` 默认把 `latest.yml`、安装版 EXE 和 blockmap 复制到 `server/data/desktop-updates/`。如果更新目录在其他位置，可在 `server/.env` 与运行发布命令的 PowerShell 中设置同一个绝对 `DESKTOP_UPDATE_DIR`。

3. 重启或保持 server 运行均可，静态更新文件无需重启即可生效。
4. 先检查 `https://app.novagaming.top/desktop-updates/latest.yml` 可以访问，再通知用户重启 NovaSpeak 检查更新。

必须先完整复制安装包和 blockmap，最后再覆盖 `latest.yml`，避免客户端在文件尚未就绪时读到新版本清单。当前脚本在本机复制速度很快；如果以后改成远程上传，应在部署流程中明确保持这一顺序。

## 安全配置

- `contextIsolation: true`,`nodeIntegration: false`:渲染进程(React)无法直接访问 Node.js 能力。
- `preload.js` 只暴露最小只读信息:`window.novaDesktop = { platform, isDesktop: true }`;不暴露 `fs`、`child_process`、`shell`、环境变量或任何 secret。
- 渲染进程权限走白名单:允许 `media`(麦克风)、`speaker-selection` 等语音必需权限,其余请求一律拒绝。
- 新窗口一律拒绝,外部 `http(s)` 链接交给系统默认浏览器打开。

## 当前不包含

本阶段刻意不包含以下能力(后续阶段再做):

- 系统托盘、后台常驻、开机启动
- 按键说话(Push-to-Talk)
- Windows 代码签名

## 后续阶段计划

1. 桌面体验：托盘、窗口状态记忆、更新下载进度 UI。
2. 正式发布前配置 Windows 代码签名，消除 SmartScreen 的“未知发布者”提示。
3. 按键说话与全局快捷键（不改 VoiceRoom 生命周期，通过 preload 暴露受控 API）。
