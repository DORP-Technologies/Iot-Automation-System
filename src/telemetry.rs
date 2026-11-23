use serde::{Deserialize, Serialize};
use sysinfo::{Components, Disks, Networks, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    pub timestamp: String,
    pub hostname: String,
    pub cpu_usage_percent: f32,
    pub cpu_temp_celsius: Option<f32>,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub ram_usage_percent: f32,
    pub active_window: String,
    pub net_rx_kbps: f64,
    pub net_tx_kbps: f64,
    pub disk_free_gb: u64,
    pub disk_total_gb: u64,
}

/// Compact payload tailored for BLE GATT notifications (keeps packet size small)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BleCompactPayload {
    pub cpu: u8,
    pub tmp: Option<u8>,
    pub ram: u8,
    pub rx: u32,
    pub tx: u32,
    pub win: String,
}

impl From<&TelemetryPayload> for BleCompactPayload {
    fn from(full: &TelemetryPayload) -> Self {
        // Truncate active window title to 24 chars so BLE JSON stays compact
        let short_win: String = full.active_window.chars().take(24).collect();
        Self {
            cpu: full.cpu_usage_percent.round() as u8,
            tmp: full.cpu_temp_celsius.map(|t| t.round() as u8),
            ram: full.ram_usage_percent.round() as u8,
            rx: full.net_rx_kbps.round() as u32,
            tx: full.net_tx_kbps.round() as u32,
            win: short_win,
        }
    }
}

pub struct TelemetryCollector {
    sys: System,
    networks: Networks,
    disks: Disks,
    components: Components,
}

impl TelemetryCollector {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let networks = Networks::new_with_refreshed_list();
        let disks = Disks::new_with_refreshed_list();
        let components = Components::new_with_refreshed_list();

        Self {
            sys,
            networks,
            disks,
            components,
        }
    }

    pub fn collect(&mut self, active_window: String, interval_secs: f64) -> TelemetryPayload {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.networks.refresh();
        self.disks.refresh();
        self.components.refresh();

        let cpu_usage_percent = self.sys.global_cpu_info().cpu_usage();

        let cpu_temp_celsius = self
            .components
            .iter()
            .find(|c| {
                let label = c.label().to_lowercase();
                label.contains("cpu") || label.contains("core") || label.contains("package")
            })
            .map(|c| c.temperature());

        let ram_total_bytes = self.sys.total_memory();
        let ram_used_bytes = self.sys.used_memory();
        let ram_total_mb = ram_total_bytes / (1024 * 1024);
        let ram_used_mb = ram_used_bytes / (1024 * 1024);
        let ram_usage_percent = if ram_total_bytes > 0 {
            (ram_used_bytes as f32 / ram_total_bytes as f32) * 100.0
        } else {
            0.0
        };

        let mut total_rx_bytes: u64 = 0;
        let mut total_tx_bytes: u64 = 0;
        for (_interface_name, data) in &self.networks {
            total_rx_bytes += data.received();
            total_tx_bytes += data.transmitted();
        }

        let safe_interval = if interval_secs > 0.0 { interval_secs } else { 1.0 };
        let net_rx_kbps = (total_rx_bytes as f64 / 1024.0) / safe_interval;
        let net_tx_kbps = (total_tx_bytes as f64 / 1024.0) / safe_interval;

        let (disk_free_bytes, disk_total_bytes) = self
            .disks
            .iter()
            .next()
            .map(|d| (d.available_space(), d.total_space()))
            .unwrap_or((0, 0));

        let hostname = System::host_name().unwrap_or_else(|| "Windows-Host".to_string());
        let timestamp = chrono::Local::now().format("%H:%M:%S").to_string();

        TelemetryPayload {
            timestamp,
            hostname,
            cpu_usage_percent,
            cpu_temp_celsius,
            ram_used_mb,
            ram_total_mb,
            ram_usage_percent,
            active_window,
            net_rx_kbps,
            net_tx_kbps,
            disk_free_gb: disk_free_bytes / (1024 * 1024 * 1024),
            disk_total_gb: disk_total_bytes / (1024 * 1024 * 1024),
        }
    }
}
