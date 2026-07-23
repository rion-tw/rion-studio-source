use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::Duration,
};

use chrono::Utc;
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, bounded};

use crate::{
    error::{CoreError, CoreResult},
    model::{
        CoreEffectMetricsRecord, CountedLatencySummaryRecord, LatencySummaryRecord,
        NapiLatencySummaryRecord, PerformanceTelemetryRecord, TelemetryMetric,
        TelemetrySampleRecord,
    },
};

const SAMPLE_CAPACITY: usize = 1_024;
const WRITE_INTERVAL: Duration = Duration::from_secs(60);

enum Request {
    Record(TelemetrySampleRecord),
    Napi(f64),
    CoreEffects(CoreEffectMetricsRecord),
    Snapshot(Sender<PerformanceTelemetryRecord>),
    Shutdown(Sender<()>),
}

pub struct TelemetryWorker {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl TelemetryWorker {
    pub fn start(output_path: Option<PathBuf>) -> CoreResult<Self> {
        if let Some(path) = &output_path
            && !path.is_absolute()
        {
            return Err(CoreError::InvalidInput(
                "performanceTelemetryPath must be absolute".to_owned(),
            ));
        }
        let (sender, receiver) = bounded(512);
        let join = thread::Builder::new()
            .name("rion-performance-telemetry".to_owned())
            .spawn(move || run_worker(receiver, output_path))
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn record(&self, sample: TelemetrySampleRecord) {
        let _ = self.sender.try_send(Request::Record(sample));
    }

    pub fn record_napi(&self, duration_ms: f64) {
        let _ = self.sender.try_send(Request::Napi(duration_ms));
    }

    pub fn record_core_effects(&self, metrics: CoreEffectMetricsRecord) {
        let _ = self.sender.try_send(Request::CoreEffects(metrics));
    }

    pub fn snapshot(&self) -> CoreResult<PerformanceTelemetryRecord> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Snapshot(sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)
    }

    pub fn shutdown(&mut self) {
        let (sender, receiver) = bounded(1);
        let _ = self.sender.send(Request::Shutdown(sender));
        let _ = receiver.recv_timeout(Duration::from_secs(3));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for TelemetryWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker(receiver: Receiver<Request>, output_path: Option<PathBuf>) {
    let mut metrics = Metrics::new();
    if let Some(path) = &output_path {
        let _ = write_snapshot(path, &metrics.snapshot());
    }
    loop {
        match receiver.recv_timeout(WRITE_INTERVAL) {
            Ok(Request::Record(sample)) => metrics.record(sample),
            Ok(Request::Napi(duration_ms)) => {
                metrics.napi_count = metrics.napi_count.saturating_add(1);
                metrics.napi.record(duration_ms);
            }
            Ok(Request::CoreEffects(core_effects)) => metrics.core_effects = core_effects,
            Ok(Request::Snapshot(response)) => {
                let _ = response.send(metrics.snapshot());
            }
            Ok(Request::Shutdown(response)) => {
                if let Some(path) = &output_path {
                    let _ = write_snapshot(path, &metrics.snapshot());
                }
                let _ = response.send(());
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(path) = &output_path {
                    let _ = write_snapshot(path, &metrics.snapshot());
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

struct Metrics {
    browser_result_count: u64,
    cdp: LatencySampler,
    cdp_count: u64,
    core_event_batch_count: u64,
    core_effects: CoreEffectMetricsRecord,
    ipc_command: LatencySampler,
    macro_schedule_to_dispatch: LatencySampler,
    napi: LatencySampler,
    napi_count: u64,
    process_launch_count: u64,
    scheduled_wait_count: u64,
    started_at: String,
    tab_activation: LatencySampler,
}

impl Metrics {
    fn new() -> Self {
        Self {
            browser_result_count: 0,
            cdp: LatencySampler::default(),
            cdp_count: 0,
            core_event_batch_count: 0,
            core_effects: CoreEffectMetricsRecord::default(),
            ipc_command: LatencySampler::default(),
            macro_schedule_to_dispatch: LatencySampler::default(),
            napi: LatencySampler::default(),
            napi_count: 0,
            process_launch_count: 0,
            scheduled_wait_count: 0,
            started_at: Utc::now().to_rfc3339(),
            tab_activation: LatencySampler::default(),
        }
    }

    fn record(&mut self, sample: TelemetrySampleRecord) {
        let count = u64::from(sample.count.max(1));
        match sample.metric {
            TelemetryMetric::IpcCommand => {
                if let Some(duration) = sample.duration_ms {
                    self.ipc_command.record(duration);
                }
            }
            TelemetryMetric::MacroScheduleToDispatch => {
                if let Some(duration) = sample.duration_ms {
                    self.macro_schedule_to_dispatch.record(duration);
                }
            }
            TelemetryMetric::TabActivation => {
                if let Some(duration) = sample.duration_ms {
                    self.tab_activation.record(duration);
                }
            }
            TelemetryMetric::Cdp => {
                self.cdp_count = self.cdp_count.saturating_add(count);
                if let Some(duration) = sample.duration_ms {
                    self.cdp.record(duration);
                }
            }
            TelemetryMetric::CoreEventBatch => {
                self.core_event_batch_count = self.core_event_batch_count.saturating_add(count);
            }
            TelemetryMetric::BrowserResult => {
                self.browser_result_count = self.browser_result_count.saturating_add(count);
            }
            TelemetryMetric::ProcessLaunch => {
                self.process_launch_count = self.process_launch_count.saturating_add(count);
            }
            TelemetryMetric::ScheduledWait => {
                self.scheduled_wait_count = self.scheduled_wait_count.saturating_add(count);
            }
        }
    }

    fn snapshot(&self) -> PerformanceTelemetryRecord {
        PerformanceTelemetryRecord {
            browser_result_count: self.browser_result_count,
            cdp: CountedLatencySummaryRecord {
                message_count: self.cdp_count,
                latency: self.cdp.summary(),
            },
            core_event_batch_count: self.core_event_batch_count,
            core_effects: self.core_effects.clone(),
            ipc_command: self.ipc_command.summary(),
            macro_schedule_to_dispatch: self.macro_schedule_to_dispatch.summary(),
            napi: NapiLatencySummaryRecord {
                call_count: self.napi_count,
                latency: self.napi.summary(),
            },
            process_launch_count: self.process_launch_count,
            scheduled_wait_count: self.scheduled_wait_count,
            started_at: self.started_at.clone(),
            tab_activation: self.tab_activation.summary(),
        }
    }
}

#[derive(Default)]
struct LatencySampler {
    samples: VecDeque<f64>,
}

impl LatencySampler {
    fn record(&mut self, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        if self.samples.len() >= SAMPLE_CAPACITY {
            self.samples.pop_front();
        }
        self.samples.push_back(value);
    }

    fn summary(&self) -> LatencySummaryRecord {
        if self.samples.is_empty() {
            return LatencySummaryRecord::default();
        }
        let mut samples = self.samples.iter().copied().collect::<Vec<_>>();
        samples.sort_by(f64::total_cmp);
        LatencySummaryRecord {
            max_ms: *samples.last().unwrap_or(&0.0),
            p50_ms: percentile(&samples, 0.5),
            p95_ms: percentile(&samples, 0.95),
            sample_count: samples.len() as u32,
        }
    }
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    let index = ((values.len() as f64 * percentile).ceil() as usize)
        .saturating_sub(1)
        .min(values.len().saturating_sub(1));
    values.get(index).copied().unwrap_or(0.0)
}

fn write_snapshot(path: &Path, snapshot: &PerformanceTelemetryRecord) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| CoreError::Platform(error.to_string()))?;
    }
    let temporary = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(snapshot)
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    fs::write(&temporary, bytes).map_err(|error| CoreError::Platform(error.to_string()))?;
    rion_platform::atomic_replace_file(&temporary, path)
        .map_err(|error| CoreError::Platform(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_bounded_latency_and_flushes_on_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("telemetry.json");
        let mut worker = TelemetryWorker::start(Some(output.clone())).unwrap();
        worker.record(TelemetrySampleRecord {
            metric: TelemetryMetric::IpcCommand,
            duration_ms: Some(5.0),
            count: 1,
        });
        worker.record_napi(2.0);
        worker.record_core_effects(CoreEffectMetricsRecord {
            peak_pending_effect_count: 3,
            launch_operation_count: 1,
            launch_effect_count: 7,
            ..Default::default()
        });
        let snapshot = worker.snapshot().unwrap();
        assert_eq!(snapshot.ipc_command.p95_ms, 5.0);
        assert_eq!(snapshot.napi.call_count, 1);
        assert_eq!(snapshot.core_effects.peak_pending_effect_count, 3);
        assert_eq!(snapshot.core_effects.launch_effect_count, 7);
        worker.shutdown();
        let persisted =
            serde_json::from_slice::<PerformanceTelemetryRecord>(&fs::read(output).unwrap())
                .unwrap();
        assert_eq!(persisted.ipc_command.sample_count, 1);
    }
}
