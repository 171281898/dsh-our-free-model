use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent, WebviewUrl, WebviewWindowBuilder,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct ServiceState {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

fn find_service_resources(app: &tauri::AppHandle) -> (String, String) {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let cli = resource_dir.join("standalone").join("cli.mjs");
        if cli.exists() {
            let node = find_node_binary();
            return (node, cli.to_string_lossy().to_string());
        }
    }
    let dev_cli = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../standalone/cli.mjs");
    if dev_cli.exists() {
        return (find_node_binary(), dev_cli.to_string_lossy().to_string());
    }
    (find_node_binary(), "packages/standalone/cli.mjs".to_string())
}

fn find_node_binary() -> String {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let candidates = vec![
        "C:\\Program Files\\nodejs\\node.exe".to_string(),
        "C:\\Program Files (x86)\\nodejs\\node.exe".to_string(),
        format!("{}\\nodejs\\node.exe", home),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    "node".to_string()
}

fn wait_for_port(port: u16, timeout: Duration) -> Option<u16> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return Some(port);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

fn build_titlebar_injection() -> String {
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let css = std::fs::read_to_string(base.join("../ui/titlebar.css")).unwrap_or_default();
    let js = std::fs::read_to_string(base.join("../ui/titlebar.js")).unwrap_or_default();
    if css.is_empty() && js.is_empty() {
        return String::new();
    }
    format!(
        "(function(){{var s=document.createElement('style');s.textContent={};document.head.appendChild(s);var sc=document.createElement('script');sc.textContent={};document.head.appendChild(sc);}})();",
        serde_json::to_string(&css).unwrap_or_default(),
        serde_json::to_string(&js).unwrap_or_default()
    )
}

fn read_splash_html() -> String {
    include_str!("../../splash/splash.html").to_string()
}

fn show_splash(app: &tauri::AppHandle) -> Result<(), String> {
    let splash_html = read_splash_html();
    if splash_html.is_empty() {
        return Ok(());
    }
    let _splash = WebviewWindowBuilder::new(
        app,
        "splash",
        WebviewUrl::App("splash.html".into()),
    )
    .title("Our Free Model")
    .inner_size(400.0, 300.0)
    .center()
    .resizable(false)
    .decorations(false)
    .transparent(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn close_splash(app: &tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}


fn start_service(app: &tauri::AppHandle) -> Result<u16, String> {
    let state = app.state::<ServiceState>();
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        // 已在运行，返回已知端口
        let port_guard = state.port.lock().map_err(|e| e.to_string())?;
        return Ok(port_guard.unwrap_or(18900));
    }

    let (node_bin, cli_script) = find_service_resources(app);

    #[cfg(windows)]
    let child = Command::new(&node_bin)
        .arg(&cli_script)
        .arg("--port").arg("18900")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("failed to start service: {}", e))?;

    #[cfg(not(windows))]
    let child = Command::new(&node_bin)
        .arg(&cli_script)
        .arg("--port").arg("18900")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start service: {}", e))?;

    *guard = Some(child);

    // 等服务端口就绪（TCP 轮询，不读锁文件）
    let port = wait_for_port(18900, Duration::from_secs(15));
    if port.is_none() {
        // 服务启动失败，清理子进程
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        return Err("service failed to bind port 18900 within 15s".to_string());
    }

    let actual_port = port.unwrap();
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    *port_guard = Some(actual_port);
    Ok(actual_port)
}

fn stop_service(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServiceState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut port_guard) = state.port.lock() {
            *port_guard = None;
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(ServiceState {
                child: Mutex::new(None),
                port: Mutex::new(None),
            });

            // 显示启动动画
            show_splash(app.handle())?;

            // 启动后端服务（同步等待端口就绪）
            let service_port = match start_service(app.handle()) {
                Ok(port) => {
                    log::info!("service ready on port {}", port);
                    Some(port)
                }
                Err(e) => {
                    log::error!("failed to start service: {}", e);
                    None
                }
            };

            // 关闭启动动画
            close_splash(app.handle());

            // 显示主窗口
            if let Some(window) = app.get_webview_window("main") {
                // 注入标题栏
                let injection = build_titlebar_injection();
                if !injection.is_empty() {
                    let _ = window.eval(&injection);
                }

                // 如果服务就绪，导航到实际服务地址
                if let Some(port) = service_port {
                    let url = format!("http://127.0.0.1:{}", port);
                    let _ = window.navigate(url.parse().unwrap());
                }

                let _ = window.show();
                let _ = window.set_focus();
            }

            // 系统托盘
            let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Our Free Model")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        stop_service(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_service(app);
            }
        });
}