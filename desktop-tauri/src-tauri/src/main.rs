// NovaSpeak 桌面壳(Tauri,对照 Electron 5A)。
// 只负责桌面窗口与安全策略,不承载任何业务逻辑:
// LiveKit 连接、VoiceRoom 生命周期、Presence WebSocket、token 签发全部沿用现有 client/ 与 server/。
// 本壳不存放任何 secret,也不向 renderer 暴露超出 window.novaDesktop 的能力。

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use tauri::webview::WebviewWindowBuilder;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

/// 开发模式加载的 Vite 前端地址,与 Electron 壳 DEV_SERVER_URL 一致。
/// /api、/ws、/uploads 由 Vite 代理到本地后端。
const DEV_SERVER_URL: &str = "http://localhost:5173";
const MAIN_WINDOW_LABEL: &str = "main";

/// Vite 未启动时显示的中文等待页,通过自定义协议提供
/// (Windows 上 WebView2 会把它映射为 http://novaspeak.localhost/waiting)。
const WAITING_PAGE_SCHEME: &str = "novaspeak";
const WAITING_PAGE_URL: &str = "novaspeak://localhost/waiting";
const WAITING_PAGE_WORKAROUND_HOST: &str = "novaspeak.localhost";

const WAITING_PAGE_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>NovaSpeak</title></head>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#050816;color:#e2f5f5;font-family:system-ui,sans-serif;">
    <div style="max-width:32rem;text-align:center;line-height:1.8;">
      <h1 style="color:#22d3ee;font-size:1.25rem;">无法连接 NovaSpeak 前端开发服务器</h1>
      <p>请先在 client 目录运行 <code style="color:#22d3ee;">npm run dev</code>,<br />确认 http://localhost:5173 可访问。</p>
      <p style="color:#7dd3fc;font-size:0.875rem;">检测到开发服务器启动后会自动进入。</p>
    </div>
  </body>
</html>"#;

/// 与 Electron preload 暴露的 process.platform 取值保持同形,
/// 前端无需为 Tauri 分叉逻辑。
fn desktop_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    return "win32";
    #[cfg(target_os = "macos")]
    return "darwin";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "linux";
}

/// 页面脚本运行前注入,等价于 Electron preload 的 contextBridge:
/// 只读最小对象,不暴露 fs、shell、环境变量或任何 secret。
fn bridge_init_script() -> String {
    format!(
        r#"(() => {{
  if (window.novaDesktop) return;
  Object.defineProperty(window, "novaDesktop", {{
    value: Object.freeze({{ platform: "{platform}", isDesktop: true }}),
    writable: false,
    configurable: false,
    enumerable: true,
  }});
}})();"#,
        platform = desktop_platform()
    )
}

/// Vite 默认只监听 localhost,Windows 上可能解析到 IPv4 或 IPv6,两个都探测。
fn dev_server_reachable() -> bool {
    ["127.0.0.1:5173", "[::1]:5173"].iter().any(|addr| {
        addr.parse::<SocketAddr>()
            .ok()
            .and_then(|sock| TcpStream::connect_timeout(&sock, Duration::from_millis(400)).ok())
            .is_some()
    })
}

fn is_dev_server_url(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
        && url.port_or_known_default() == Some(5173)
}

fn is_waiting_page_url(url: &Url) -> bool {
    url.scheme() == WAITING_PAGE_SCHEME || url.host_str() == Some(WAITING_PAGE_WORKAROUND_HOST)
}

#[cfg(windows)]
fn is_dev_server_origin(uri: &str) -> bool {
    Url::parse(uri).map(|url| is_dev_server_url(&url)).unwrap_or(false)
}

/// Windows WebView2 专项处理(Tauri 侧没有跨平台权限 API):
/// - PermissionRequested:只放行来自 Vite 前端页面的麦克风请求,其余一律拒绝,
///   不弹 WebView2 自带的询问框(对齐 Electron setPermissionRequestHandler 白名单)。
///   WebView2 没有独立的 speaker-selection 权限类型,输出设备枚举/切换随麦克风授权解锁。
/// - NewWindowRequested:新窗口一律拒绝,http(s) 外链交给系统默认浏览器
///   (对齐 Electron setWindowOpenHandler,并覆盖中键 / Ctrl+点击 / window.open)。
#[cfg(windows)]
fn attach_windows_webview2_policies(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{NewWindowRequestedEventHandler, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    let app_handle = window.app_handle().clone();
    let result = window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                eprintln!("[NovaSpeak] 获取 WebView2 内核失败:{err}");
                return;
            }
        };

        let mut permission_token = 0_i64;
        let permission_handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            let Some(args) = args else { return Ok(()) };

            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);

            let allowed =
                kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && is_dev_server_origin(&uri);
            args.SetState(if allowed {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            })?;
            Ok(())
        }));
        if let Err(err) = core.add_PermissionRequested(&permission_handler, &mut permission_token) {
            eprintln!("[NovaSpeak] 注册麦克风权限白名单失败:{err}");
        }

        let mut new_window_token = 0_i64;
        let new_window_handler = NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };

            args.SetHandled(true)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            if uri.starts_with("https://") || uri.starts_with("http://") {
                if let Err(err) = app_handle.opener().open_url(&uri, None::<&str>) {
                    eprintln!("[NovaSpeak] 打开外部链接失败:{err}");
                }
            }
            Ok(())
        }));
        if let Err(err) = core.add_NewWindowRequested(&new_window_handler, &mut new_window_token) {
            eprintln!("[NovaSpeak] 注册新窗口拦截失败:{err}");
        }
    });
    if let Err(err) = result {
        eprintln!("[NovaSpeak] 注册 WebView2 安全策略失败:{err}");
    }
}

/// 停留在等待页时每秒探测一次 Vite,启动后自动进入前端。
/// 只在等待页触发跳转,绝不打断已加载页面(避免影响进行中的语音通话)。
fn spawn_dev_server_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            continue;
        };
        let on_waiting_page = window
            .url()
            .map(|url| is_waiting_page_url(&url))
            .unwrap_or(false);
        if on_waiting_page && dev_server_reachable() {
            let script = format!("window.location.replace({DEV_SERVER_URL:?});");
            if let Err(err) = window.eval(script) {
                eprintln!("[NovaSpeak] 跳转开发服务器失败:{err}");
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol(WAITING_PAGE_SCHEME, |_ctx, _request| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(WAITING_PAGE_HTML.as_bytes().to_vec())
                .unwrap()
        })
        .setup(|app| {
            let initial_url = if dev_server_reachable() {
                WebviewUrl::External(Url::parse(DEV_SERVER_URL)?)
            } else {
                WebviewUrl::CustomProtocol(Url::parse(WAITING_PAGE_URL)?)
            };

            let nav_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, initial_url)
                .title("NovaSpeak")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1000.0, 640.0)
                .background_color(Color(5, 8, 22, 255))
                .initialization_script(bridge_init_script())
                .on_navigation(move |url| {
                    // 只允许 Vite 前端和等待页;其余 http(s) 链接交系统浏览器,一律不在窗口内加载。
                    if is_dev_server_url(url) || is_waiting_page_url(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        if let Err(err) = nav_handle.opener().open_url(url.as_str(), None::<&str>) {
                            eprintln!("[NovaSpeak] 打开外部链接失败:{err}");
                        }
                    }
                    false
                })
                .build()?;

            #[cfg(windows)]
            attach_windows_webview2_policies(&window);
            #[cfg(not(windows))]
            let _ = &window;

            spawn_dev_server_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NovaSpeak 桌面壳启动失败");
}
