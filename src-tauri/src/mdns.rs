use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::net::Ipv4Addr;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct Peer {
    pub name: String,
    pub ip: String,
    pub port: u16,
}

pub fn start(app: AppHandle, device_name: &str, ips: Vec<Ipv4Addr>, port: u16) {
    let safe_name: String = device_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect();

    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => { eprintln!("mDNS daemon failed: {e}"); return; }
    };

    let hostname = format!("{safe_name}.local.");
    let info = match ServiceInfo::new(
        "_doublechat._tcp.local.",
        &safe_name,
        &hostname,
        ips.as_slice(),
        port,
        None,
    ) {
        Ok(i) => i,
        Err(e) => { eprintln!("mDNS service info failed: {e}"); return; }
    };

    if let Err(e) = mdns.register(info) {
        eprintln!("mDNS register failed: {e}");
        return;
    }

    let receiver = match mdns.browse("_doublechat._tcp.local.") {
        Ok(r) => r,
        Err(e) => { eprintln!("mDNS browse failed: {e}"); return; }
    };

    let own_name = safe_name;
    tokio::spawn(async move {
        let _keep = mdns;
        loop {
            match receiver.recv_async().await {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    let name = info.get_fullname()
                        .split('.')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if name == own_name { continue; }
                    if let Some(ip) = info.get_addresses().iter().find(|a| a.is_ipv4()) {
                        let _ = app.emit("mdns-peer-found", Peer {
                            name,
                            ip: ip.to_string(),
                            port: info.get_port(),
                        });
                    }
                }
                Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                    let name = fullname.split('.').next().unwrap_or("").to_string();
                    if name != own_name {
                        let _ = app.emit("mdns-peer-lost", name);
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });
}
