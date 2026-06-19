mod signaling;

use tauri::Emitter;

const SIGNAL_PORT: u16 = 3717;

#[tauri::command]
fn get_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Unknown Device".to_string())
}

#[tauri::command]
fn get_local_ips() -> Vec<String> {
    match local_ip_address::list_afinet_netifas() {
        Ok(ifaces) => ifaces
            .into_iter()
            .filter_map(|(_, ip)| {
                if let std::net::IpAddr::V4(v4) = ip {
                    if !v4.is_loopback() {
                        return Some(format!("{}:{}", v4, SIGNAL_PORT));
                    }
                }
                None
            })
            .collect(),
        Err(_) => vec![],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            tauri::async_runtime::spawn(signaling::start(SIGNAL_PORT));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(check_for_updates(handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_local_ips, get_device_name])
        .run(tauri::generate_context!())
        .expect("error while running doublechat");
}

async fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater_builder().build() {
        Ok(u) => u,
        Err(_) => return, // Not configured yet (no pubkey)
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        _ => return,
    };

    // Download silently in background, then notify frontend to prompt restart
    let version = update.version.clone();
    if update
        .download_and_install(|_dl, _total| {}, || {})
        .await
        .is_ok()
    {
        let _ = app.emit("update-ready", version);
    }
}
