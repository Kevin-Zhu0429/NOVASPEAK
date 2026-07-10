# NovaSpeak 桌面客户端(Tauri 壳,对照 Electron 5A)

这是与 `Electron` 分支 `desktop/` 等价的 **Tauri 2.x 桌面壳**,用于和 Electron 做公平的语音功能 + 资源占用对照,帮助决定桌面框架。

- Tauri 版本:**tauri 2.11.5(Rust crate)/ @tauri-apps/cli 2.11.4**(编写时的最新稳定版)
- 与 Electron 壳一样,**不接管任何业务逻辑**:
  - LiveKit 连接、VoiceRoom 生命周期、Presence WebSocket、服务器静音 / 移动 / 头像等逻辑全部沿用现有 `client/` 前端代码。
  - LiveKit token 仍由后端签发,LiveKit URL(`wss://livekit.novagaming.top`)仍来自后端返回。
  - 壳内不存放任何 secret(`LIVEKIT_API_SECRET`、session secret 等),不打包前端、不打包后端。

## 环境要求(仅首次)

Tauri 需要 Rust 工具链 + WebView2 运行时(Win10/11 一般自带):

```powershell
winget install --id Rustlang.Rustup -e
rustup default stable
```

另需 Visual Studio 的 **Desktop development with C++** 生成工具(MSVC 链接器)。如果没有,先安装 Visual Studio Build Tools 并勾选该工作负载。

## 启动顺序(与 Electron 壳一致)

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\server
npm run dev
```

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client
npm run dev
```

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\desktop-tauri
npm install
npm run dev
```

第三步首次运行会编译 Rust 依赖(约几分钟),之后启动很快。窗口加载 `http://localhost:5173`,`/api`、`/ws`、`/uploads` 继续由 Vite 代理到本地后端。

Vite 未启动时:`tauri dev` 会先在终端等待 5173 就绪;若窗口已打开而 Vite 未就绪(如直接运行编译产物),窗口内显示中文等待页,检测到 Vite 启动后自动进入。

## 与 Electron 5A 的对齐关系

| 能力 | Electron 5A | 本 Tauri 壳 |
| --- | --- | --- |
| 加载目标 | `http://localhost:5173` | 相同 |
| 桥接 API | preload 暴露 `window.novaDesktop = { platform, isDesktop: true }` | 初始化脚本注入同形只读对象(`Object.freeze` + 不可改写) |
| 权限白名单 | `setPermissionRequestHandler` 放行 media 等 | Windows 上注册 WebView2 `PermissionRequested`:只放行 **来自 5173 页面的麦克风** 请求,其余一律拒绝、不弹询问框 |
| 输出设备选择 | `speaker-selection` 权限 | WebView2 无独立 speaker-selection 权限类型;设备枚举 / `setSinkId` 随麦克风授权解锁(需本机验证) |
| 新窗口 | 一律拒绝,http(s) 交系统浏览器 | WebView2 `NewWindowRequested` 一律拒绝 + `on_navigation` 拦截,http(s) 交系统浏览器 |
| Vite 未启动 | `did-fail-load` → 中文错误页 | 启动探测 + 中文等待页 + 每秒自动重试进入 |
| 自动播放 | Electron 默认允许 | wry 默认注入 `--autoplay-policy=no-user-gesture-required`,一致 |
| 后台节流 | 默认 Chromium 行为(未关闭) | 同样保持默认,保证对照公平 |
| Node/IPC 能力 | `contextIsolation: true`、`nodeIntegration: false` | 未授予任何 capability;`withGlobalTauri: false`;远程 URL 默认无 IPC 权限 |

## 安全配置说明

- 渲染层(React)拿不到任何 Tauri command:没有 capabilities 文件,且 `http://localhost:5173` 属于远程 URL,Tauri 2 默认禁止其访问 IPC。
- `window.novaDesktop` 只包含 `platform` 和 `isDesktop`,与 Electron preload 完全同形,不新增任何能力。
- 窗口内只允许加载 Vite 前端和等待页;其余地址(包括页面内跳转、新窗口、中键 / Ctrl+点击、`window.open`)一律拦截,http(s) 交给系统默认浏览器。
- 麦克风权限只授予 `http://localhost:5173` 来源;摄像头、定位、通知、剪贴板读取等全部拒绝。

## 资源占用对照(测量步骤)

Electron 与 Tauri 都是多进程(Tauri 的页面跑在若干 `msedgewebview2.exe` 子进程里),**必须统计整棵进程树**才公平。PowerShell:

```powershell
function Get-AppMemoryMB($pattern) {
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern }
  $sum = 0
  foreach ($p in $procs) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $sum += $proc.WorkingSet64 }
  }
  "{0} 个进程,共 {1} MB" -f $procs.Count, [math]::Round($sum / 1MB, 1)
}

# Electron 壳(desktop 目录启动的 electron.exe 进程树)
Get-AppMemoryMB 'electron.*desktop'

# Tauri 壳(主进程 + WebView2 进程树,识别 exe 名或 WebView2 用户数据目录)
Get-AppMemoryMB 'novaspeak-desktop-tauri|top\.novagaming\.novaspeak'
```

每个场景稳定后运行一次,填表:

| 场景 | Electron | Tauri |
| --- | --- | --- |
| 启动空闲 1 分钟 | | |
| 登录未进频道 | | |
| 进频道、麦克风关闭 | | |
| 通话 5 分钟 | | |
| CPU/GPU(任务管理器观察通话期间) | | |

CPU/GPU:任务管理器 → 详细信息,按上述进程名筛选,通话 5 分钟期间目测记录平均 CPU%;GPU 看"性能"页或 Process Explorer。也可以在两次测量间保持同样的频道人数和说话状态,减少偏差。

## 已知限制与风险

- **WebView2 麦克风权限**:已通过原生 `PermissionRequested` 处理器自动放行(仅 5173 来源)。若 WebView2 运行时过旧导致注册失败,会退回 WebView2 默认弹框询问,终端有中文错误日志。
- **输出设备选择(setSinkId)**:WebView2 对 `setSinkId` 的支持晚于 Chrome,且没有独立 speaker-selection 权限。需要在本机验证"输出设备选择"面板是否生效;若不生效,这是 Tauri/WebView2 的硬伤,需记入对照结论。
- **后台 / 最小化通话**:保持 Chromium 默认节流策略(与 Electron 对照公平)。WebRTC 活跃音频通常豁免节流,但仍需实测最小化后语音是否持续。
- **speechSynthesis 播报**:WebView2 走 Edge 的语音合成栈,中文语音包取决于系统 Edge/Windows 语音;需实测欢迎播报和事件播报音色、是否发声。
- **刷新后 Vite 已挂**:等待页只覆盖启动时;页面加载后若 Vite 崩溃再刷新,会看到 WebView2 原生错误页(英文),重启 Vite 后手动刷新即可。
- **生产打包未做**(与 Electron 5A 相同的预留):`bundle.active: false`,`frontendDist` 暂指向开发地址;打包版的 `API_BASE` / 静态资源 / ws 地址策略留到下一阶段。
- **全局 PTT(按键说话)**:Tauri 有 `global-shortcut` 插件可做全局快捷键,但需要新增 capability 并通过受控桥接暴露,不在本阶段范围。
- **首次编译**:Rust 全量编译较慢(数分钟),并占用数 GB 磁盘(`src-tauri/target/`,已 gitignore)。

## 本阶段刻意不包含

与 Electron 5A 相同:系统托盘、后台常驻、开机启动、自动更新、打包安装包、按键说话、降噪、音乐机器人。
