use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

/// Reuses one system snapshot and refreshes only CPU usage and RAM. Process,
/// disk, network, user, and component inventories are deliberately disabled.
pub struct SystemPressureSampler {
    system: System,
    has_cpu_baseline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SystemPressureSample {
    pub cpu_ratio: Option<f64>,
    pub memory_available_ratio: Option<f64>,
}

impl SystemPressureSampler {
    pub fn new() -> Self {
        let refreshes = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram());
        Self {
            system: System::new_with_specifics(refreshes),
            has_cpu_baseline: false,
        }
    }

    pub fn sample(&mut self) -> SystemPressureSample {
        self.system.refresh_cpu_usage();
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let cpu_ratio = self
            .has_cpu_baseline
            .then(|| f64::from(self.system.global_cpu_usage()).clamp(0.0, 100.0) / 100.0);
        self.has_cpu_baseline = true;
        let total_memory = self.system.total_memory();
        let memory_available_ratio = (total_memory > 0)
            .then(|| (self.system.available_memory() as f64 / total_memory as f64).clamp(0.0, 1.0));
        SystemPressureSample {
            cpu_ratio,
            memory_available_ratio,
        }
    }
}

impl Default for SystemPressureSampler {
    fn default() -> Self {
        Self::new()
    }
}
