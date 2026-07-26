use std::thread;

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHostDiagnostics {
    pub cpu_model: Option<String>,
    pub cpu_cores: usize,
    pub total_memory_bytes: u64,
    pub free_memory_bytes: u64,
}

pub fn collect_system_host_diagnostics() -> SystemHostDiagnostics {
    let refreshes = RefreshKind::nothing()
        .with_cpu(CpuRefreshKind::nothing().with_frequency())
        .with_memory(MemoryRefreshKind::nothing().with_ram());
    let mut system = System::new_with_specifics(refreshes);
    system.refresh_cpu_specifics(CpuRefreshKind::nothing().with_frequency());
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    SystemHostDiagnostics {
        cpu_model: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim().to_owned())
            .filter(|model| !model.is_empty()),
        cpu_cores: system.cpus().len().max(
            thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
        ),
        total_memory_bytes: system.total_memory(),
        free_memory_bytes: system.available_memory(),
    }
}
