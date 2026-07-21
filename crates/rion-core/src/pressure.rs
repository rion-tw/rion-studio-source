use std::{
    sync::Arc,
    thread::{self, JoinHandle},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, bounded};
use rion_platform::{SystemPressureSample, SystemPressureSampler};

use crate::{
    error::{CoreError, CoreResult},
    model::{PressureLevel, SystemPressureSnapshot},
};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const ENTER_CPU_RATIO: f64 = 0.8;
const EXIT_CPU_RATIO: f64 = 0.65;
const ENTER_MEMORY_RATIO: f64 = 0.1;
const EXIT_MEMORY_RATIO: f64 = 0.15;
const ENTER_SAMPLE_COUNT: u8 = 3;
const EXIT_SAMPLE_COUNT: u8 = 5;

enum Request {
    UpdateSignals {
        speed_limit: Option<f64>,
        thermal_state: Option<String>,
    },
    Shutdown(Sender<()>),
}

pub struct PressureMonitor {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl PressureMonitor {
    pub fn start(on_change: Arc<dyn Fn(SystemPressureSnapshot) + Send + Sync>) -> CoreResult<Self> {
        let (sender, receiver) = bounded(16);
        let join = thread::Builder::new()
            .name("rion-system-pressure".to_owned())
            .spawn(move || run_monitor(receiver, on_change))
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn update_signals(
        &self,
        speed_limit: Option<f64>,
        thermal_state: Option<String>,
    ) -> CoreResult<()> {
        if speed_limit.is_some_and(|limit| !limit.is_finite()) {
            return Err(CoreError::InvalidInput(
                "speedLimit must be finite".to_owned(),
            ));
        }
        self.sender
            .try_send(Request::UpdateSignals {
                speed_limit,
                thermal_state,
            })
            .map_err(|error| CoreError::Platform(format!("pressure signal queue: {error}")))
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

impl Drop for PressureMonitor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_monitor(
    receiver: Receiver<Request>,
    on_change: Arc<dyn Fn(SystemPressureSnapshot) + Send + Sync>,
) {
    let mut sampler = SystemPressureSampler::new();
    let mut evaluator = PressureEvaluator::default();
    let first = sampler.sample();
    evaluator.last_memory_ratio = first.memory_available_ratio;
    loop {
        match receiver.recv_timeout(SAMPLE_INTERVAL) {
            Ok(Request::UpdateSignals {
                speed_limit,
                thermal_state,
            }) => {
                if let Some(speed_limit) = speed_limit {
                    evaluator.speed_limit = speed_limit;
                }
                if let Some(thermal_state) = thermal_state {
                    evaluator.thermal_state = thermal_state;
                }
                if let Some(snapshot) = evaluator.evaluate(SystemPressureSample {
                    cpu_ratio: None,
                    memory_available_ratio: evaluator.last_memory_ratio,
                }) {
                    on_change(snapshot);
                }
            }
            Ok(Request::Shutdown(response)) => {
                let _ = response.send(());
                break;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if let Some(snapshot) = evaluator.evaluate(sampler.sample()) {
                    on_change(snapshot);
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }
}

struct PressureEvaluator {
    constrained_samples: u8,
    healthy_samples: u8,
    last_memory_ratio: Option<f64>,
    snapshot: SystemPressureSnapshot,
    speed_limit: f64,
    thermal_state: String,
}

impl Default for PressureEvaluator {
    fn default() -> Self {
        Self {
            constrained_samples: 0,
            healthy_samples: 0,
            last_memory_ratio: None,
            snapshot: SystemPressureSnapshot {
                level: PressureLevel::Normal,
                reason: "baseline".to_owned(),
            },
            speed_limit: 100.0,
            thermal_state: "unknown".to_owned(),
        }
    }
}

impl PressureEvaluator {
    fn evaluate(&mut self, sample: SystemPressureSample) -> Option<SystemPressureSnapshot> {
        self.last_memory_ratio = sample.memory_available_ratio.or(self.last_memory_ratio);
        let thermal_pressure = matches!(self.thermal_state.as_str(), "serious" | "critical")
            || self.speed_limit < 80.0;
        let cpu_pressure = sample
            .cpu_ratio
            .is_some_and(|ratio| ratio >= ENTER_CPU_RATIO);
        let memory_pressure = self
            .last_memory_ratio
            .is_some_and(|ratio| ratio <= ENTER_MEMORY_RATIO);
        let healthy = !thermal_pressure
            && sample.cpu_ratio.is_none_or(|ratio| ratio <= EXIT_CPU_RATIO)
            && self
                .last_memory_ratio
                .is_none_or(|ratio| ratio >= EXIT_MEMORY_RATIO)
            && self.speed_limit >= 95.0;

        if thermal_pressure {
            self.constrained_samples = ENTER_SAMPLE_COUNT;
        } else if cpu_pressure || memory_pressure {
            self.constrained_samples = self.constrained_samples.saturating_add(1);
        } else {
            self.constrained_samples = 0;
        }
        self.healthy_samples = if healthy {
            self.healthy_samples.saturating_add(1)
        } else {
            0
        };

        let next = if self.snapshot.level == PressureLevel::Normal
            && self.constrained_samples >= ENTER_SAMPLE_COUNT
        {
            Some(SystemPressureSnapshot {
                level: PressureLevel::Constrained,
                reason: if thermal_pressure {
                    "thermal"
                } else if memory_pressure {
                    "memory"
                } else {
                    "cpu"
                }
                .to_owned(),
            })
        } else if self.snapshot.level == PressureLevel::Constrained
            && self.healthy_samples >= EXIT_SAMPLE_COUNT
        {
            self.constrained_samples = 0;
            Some(SystemPressureSnapshot {
                level: PressureLevel::Normal,
                reason: "baseline".to_owned(),
            })
        } else {
            None
        };
        if let Some(ref next) = next {
            self.snapshot = next.clone();
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enters_after_three_cpu_samples_and_exits_after_five_healthy_samples() {
        let mut evaluator = PressureEvaluator::default();
        let constrained = SystemPressureSample {
            cpu_ratio: Some(0.9),
            memory_available_ratio: Some(0.5),
        };
        assert_eq!(evaluator.evaluate(constrained), None);
        assert_eq!(evaluator.evaluate(constrained), None);
        assert_eq!(
            evaluator.evaluate(constrained).unwrap().level,
            PressureLevel::Constrained
        );
        let healthy = SystemPressureSample {
            cpu_ratio: Some(0.2),
            memory_available_ratio: Some(0.5),
        };
        for _ in 0..4 {
            assert_eq!(evaluator.evaluate(healthy), None);
        }
        assert_eq!(
            evaluator.evaluate(healthy).unwrap().level,
            PressureLevel::Normal
        );
    }

    #[test]
    fn thermal_signal_enters_immediately() {
        let mut evaluator = PressureEvaluator {
            thermal_state: "serious".to_owned(),
            ..PressureEvaluator::default()
        };
        assert_eq!(
            evaluator
                .evaluate(SystemPressureSample {
                    cpu_ratio: None,
                    memory_available_ratio: Some(0.5),
                })
                .unwrap()
                .reason,
            "thermal"
        );
    }
}
