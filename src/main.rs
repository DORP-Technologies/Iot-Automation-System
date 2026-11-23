#![allow(unused_imports)]

use active_win_pos_rs::get_active_window;
use battery::Manager as BatteryManager;
use serde::Serialize;
use std::net::{TcpListener, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Components, Disks, Networks, System};
use tungstenite::{accept, Message};

#[derive(Serialize, Clone, Default)]
pub struct TelemetryPayload {
    active_window: String,
    ram_usage_percent: f32,
    timestamp: u64,
    // Optional extra fields for your UI:
    cpu_usage_percent: f32,
    used_mem_mb: u64,
    total_mem_mb: u64,
    net_down_kbps: f64,
    net_up_kbps: f64,
}

/// Starts a background thread that broadcasts the telemetry agent's service
/// identifier and TCP/WebSocket port over UDP every 2 seconds.
pub fn start_discovery_beacon(telemetry_port: u16) {
    thread::spawn(move || {
        let socket = match UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Discovery] Failed to bind UDP socket: {}", e);
                return;
            }
        };

        if let Err(e) = socket.set_broadcast(true) {
            eprintln!("[Discovery] Failed to enable UDP broadcast: {}", e);
            return;
        }

        let payload = format!(
            r#"{{"service":"pc_telemetry_agent","port":{},"version":1}}"#,
            telemetry_port
        );

        println!(
            "[Discovery] Broadcasting telemetry beacon on UDP 45678 -> {}",
            payload
        );

        loop {
            let _ = socket.send_to(payload.as_bytes(), "255.255.255.255:45678");
            thread::sleep(Duration::from_secs(2));
        }
    });
}

/// Starts a WebSocket server on 0.0.0.0:<port> that pushes the latest
/// telemetry JSON payload every 2 seconds to connected clients.
pub fn start_telemetry_server(port: u16, latest_payload: Arc<Mutex<TelemetryPayload>>) {
    thread::spawn(move || {
        let bind_addr = format!("0.0.0.0:{}", port);
        let listener = match TcpListener::bind(&bind_addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[Server] Failed to bind WebSocket listener on {}: {}", bind_addr, e);
                return;
            }
        };

        println!("[Server] WebSocket telemetry server listening on {}", bind_addr);

        for stream in listener.incoming() {
            match stream {
                Ok(tcp_stream) => {
                    let shared_state = Arc::clone(&latest_payload);
                    thread::spawn(move || {
                        let peer = tcp_stream
                            .peer_addr()
                            .map(|a| a.to_string())
                            .unwrap_or_else(|_| "unknown".to_string());

                        let mut websocket = match accept(tcp_stream) {
                            Ok(ws) => ws,
                            Err(e) => {
                                eprintln!("[Server] WebSocket handshake failed for {}: {}", peer, e);
                                return;
                            }
                        };

                        println!("[Server] Client connected: {}", peer);

                        loop {
                            let json_msg = {
                                let guard = match shared_state.lock() {
                                    Ok(g) => g,
                                    Err(_) => break,
                                };
                                serde_json::to_string(&*guard)
                            };

                            match json_msg {
                                Ok(json) => {
                                    if let Err(e) = websocket.send(Message::Text(json.into())) {
                                        eprintln!("[Server] Client {} disconnected/send error: {}", peer, e);
                                        break;
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[Server] JSON serialization error: {}", e);
                                }
                            }

                            thread::sleep(Duration::from_secs(2));
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[Server] Incoming TCP connection error: {}", e);
                }
            }
        }
    });
}

fn main() {
    println!("==========================================================");
    println!("   PC TELEMETRY AGENT (CLI MODE) - INITIALIZING...        ");
    println!("==========================================================");

    let telemetry_port: u16 = 8080;
    let latest_payload = Arc::new(Mutex::new(TelemetryPayload::default()));

    // Start background UDP auto-discovery beacon
    start_discovery_beacon(telemetry_port);

    // Start WebSocket server listening on 0.0.0.0:8080
    start_telemetry_server(telemetry_port, Arc::clone(&latest_payload));

    let mut sys = System::new_all();
    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    let mut components = Components::new_with_refreshed_list();

    let battery_manager = BatteryManager::new().ok();

    sys.refresh_all();
    thread::sleep(Duration::from_millis(500));

    println!("Agent running. Press Ctrl+C to stop.\n");

    loop {
        sys.refresh_cpu_all();
        sys.refresh_memory();
        networks.refresh();
        disks.refresh();
        components.refresh();

        // --- A. ACTIVE WINDOW ---
        let active_window_title = match get_active_window() {
            Ok(win) => format!("{} ({})", win.title, win.app_name),
            Err(_) => String::from("Unavailable / Desktop Focused"),
        };

        // --- B. CPU USAGE ---
        let cpu_usage = sys.global_cpu_usage();
        let cpu_count = sys.cpus().len();

        // --- C. RAM USAGE ---
        let total_mem_mb = sys.total_memory() / 1024 / 1024;
        let used_mem_mb = sys.used_memory() / 1024 / 1024;
        let mem_pct = if sys.total_memory() > 0 {
            (sys.used_memory() as f32 / sys.total_memory() as f32) * 100.0
        } else {
            0.0
        };

        // --- D. BATTERY STATUS ---
        let battery_status = if let Some(ref manager) = battery_manager {
            match manager.batteries() {
                Ok(mut batteries) => {
                    if let Some(Ok(bat)) = batteries.next() {
                        let charge_pct = bat.state_of_charge().value * 100.0;
                        let state = format!("{:?}", bat.state());
                        format!("{:.1}% [{}]", charge_pct, state)
                    } else {
                        String::from("No battery detected (AC / Desktop)")
                    }
                }
                Err(_) => String::from("Battery read error"),
            }
        } else {
            String::from("Battery interface unavailable")
        };

        // --- E. NETWORK TRAFFIC (Interval delta & totals) ---
        let mut rx_delta_kb: f64 = 0.0;
        let mut tx_delta_kb: f64 = 0.0;
        let mut total_rx_mb: f64 = 0.0;
        let mut total_tx_mb: f64 = 0.0;

        for (_iface, data) in &networks {
            rx_delta_kb += data.received() as f64 / 1024.0;
            tx_delta_kb += data.transmitted() as f64 / 1024.0;
            total_rx_mb += data.total_received() as f64 / (1024.0 * 1024.0);
            total_tx_mb += data.total_transmitted() as f64 / (1024.0 * 1024.0);
        }

        let down_kbps = rx_delta_kb / 2.0;
        let up_kbps = tx_delta_kb / 2.0;

        // --- F. STORAGE / DISKS ---
        let mut disk_summary = Vec::new();
        for disk in &disks {
            let total_gb = disk.total_space() as f64 / 1_073_741_824.0;
            let avail_gb = disk.available_space() as f64 / 1_073_741_824.0;
            let used_gb = total_gb - avail_gb;
            disk_summary.push(format!(
                "{:?}: {:.1}/{:.1} GB",
                disk.mount_point(),
                used_gb,
                total_gb
            ));
        }

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Update shared telemetry snapshot for WebSocket clients
        if let Ok(mut guard) = latest_payload.lock() {
            *guard = TelemetryPayload {
                active_window: active_window_title.clone(),
                ram_usage_percent: mem_pct,
                timestamp: ts,
                cpu_usage_percent: cpu_usage,
                used_mem_mb,
                total_mem_mb,
                net_down_kbps: down_kbps,
                net_up_kbps: up_kbps,
            };
        }

        // --- PRINT SNAPSHOT ---
        println!("----------------------------------------------------------");
        println!(" TELEMETRY SNAPSHOT | Unix Timestamp: {}", ts);
        println!("----------------------------------------------------------");
        println!(" Active Window : {}", active_window_title);
        println!(" CPU Load      : {:.2}% ({} logical cores)", cpu_usage, cpu_count);
        println!(" RAM Usage     : {} MB / {} MB ({:.1}%)", used_mem_mb, total_mem_mb, mem_pct);
        println!(" Battery       : {}", battery_status);
        println!(
            " Network Rate  : Down {:.1} KB/s | Up {:.1} KB/s (Session: {:.2} MB Down / {:.2} MB Up)",
            down_kbps,
            up_kbps,
            total_rx_mb,
            total_tx_mb
        );
        println!(" Storage       : {}", disk_summary.join(" | "));

        for comp in &components {
            println!(" Sensor [{}] : {:.1}°C", comp.label(), comp.temperature());
        }

        thread::sleep(Duration::from_secs(2));
    }
}