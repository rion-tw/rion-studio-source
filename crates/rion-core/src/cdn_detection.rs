use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use tokio::sync::oneshot;

use crate::{
    error::{CoreError, CoreResult},
    model::BrowserProxySettingsRecord,
};

const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);

struct CacheEntry {
    enabled: bool,
    expires_at: Instant,
}

pub(crate) enum DetectionStart {
    Immediate(bool),
    Leader { cache_key: String },
    Follower(oneshot::Receiver<bool>),
}

pub(crate) struct CdnDetectionRuntime {
    cache: HashMap<String, CacheEntry>,
    in_flight: HashMap<String, Vec<oneshot::Sender<bool>>>,
    cache_ttl: Duration,
    probe_timeout: Duration,
}

impl Default for CdnDetectionRuntime {
    fn default() -> Self {
        Self {
            cache: HashMap::new(),
            in_flight: HashMap::new(),
            cache_ttl: DEFAULT_CACHE_TTL,
            probe_timeout: DEFAULT_PROBE_TIMEOUT,
        }
    }
}

impl CdnDetectionRuntime {
    pub fn begin(
        &mut self,
        mode: &str,
        proxy: &BrowserProxySettingsRecord,
    ) -> CoreResult<DetectionStart> {
        self.begin_at(mode, proxy, Instant::now())
    }

    fn begin_at(
        &mut self,
        mode: &str,
        proxy: &BrowserProxySettingsRecord,
        now: Instant,
    ) -> CoreResult<DetectionStart> {
        match mode {
            "off" => return Ok(DetectionStart::Immediate(false)),
            "on" => return Ok(DetectionStart::Immediate(true)),
            "auto" => {}
            _ => {
                return Err(CoreError::InvalidInput(
                    "CDN compatibility mode is invalid".to_owned(),
                ));
            }
        }
        self.cache.retain(|_, entry| entry.expires_at > now);
        let cache_key = format!("{}:{}", proxy.mode, proxy.server.trim());
        if let Some(cached) = self.cache.get(&cache_key) {
            return Ok(DetectionStart::Immediate(cached.enabled));
        }
        if let Some(waiters) = self.in_flight.get_mut(&cache_key) {
            let (sender, receiver) = oneshot::channel();
            waiters.push(sender);
            return Ok(DetectionStart::Follower(receiver));
        }
        self.in_flight.insert(cache_key.clone(), Vec::new());
        Ok(DetectionStart::Leader { cache_key })
    }

    pub fn complete(&mut self, cache_key: String, enabled: bool) {
        self.complete_at(cache_key, enabled, Instant::now());
    }

    fn complete_at(&mut self, cache_key: String, enabled: bool, now: Instant) {
        self.cache.insert(
            cache_key.clone(),
            CacheEntry {
                enabled,
                expires_at: now + self.cache_ttl,
            },
        );
        if let Some(waiters) = self.in_flight.remove(&cache_key) {
            for waiter in waiters {
                let _ = waiter.send(enabled);
            }
        }
    }

    pub fn probe_timeout(&self) -> Duration {
        self.probe_timeout
    }

    #[cfg(test)]
    fn with_durations(cache_ttl: Duration, probe_timeout: Duration) -> Self {
        Self {
            cache: HashMap::new(),
            in_flight: HashMap::new(),
            cache_ttl,
            probe_timeout,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(server: &str) -> BrowserProxySettingsRecord {
        BrowserProxySettingsRecord {
            mode: "custom".to_owned(),
            server: server.to_owned(),
        }
    }

    #[tokio::test]
    async fn deduplicates_in_flight_probes_and_caches_by_proxy() {
        let mut runtime =
            CdnDetectionRuntime::with_durations(Duration::from_secs(60), Duration::from_millis(9));
        let DetectionStart::Leader { cache_key } =
            runtime.begin("auto", &proxy("127.0.0.1:1")).unwrap()
        else {
            panic!("first caller must lead the probe");
        };
        let DetectionStart::Follower(follower) =
            runtime.begin("auto", &proxy("127.0.0.1:1")).unwrap()
        else {
            panic!("second caller must share the probe");
        };
        assert_eq!(runtime.probe_timeout(), Duration::from_millis(9));

        runtime.complete(cache_key, true);

        crate::v1_case!("external-chrome-cdn-f871ece09751", {
            assert!(follower.await.unwrap());
        });
        assert!(matches!(
            runtime.begin("auto", &proxy("127.0.0.1:1")).unwrap(),
            DetectionStart::Immediate(true)
        ));
        assert!(matches!(
            runtime.begin("auto", &proxy("127.0.0.1:2")).unwrap(),
            DetectionStart::Leader { .. }
        ));
    }

    #[test]
    fn expires_cached_results_and_forces_explicit_modes_without_probes() {
        let mut runtime =
            CdnDetectionRuntime::with_durations(Duration::ZERO, Duration::from_secs(1));
        crate::v1_case!("external-chrome-cdn-e0ad7eae66df", {
            assert!(matches!(
                runtime.begin("off", &proxy("")).unwrap(),
                DetectionStart::Immediate(false)
            ));
            assert!(matches!(
                runtime.begin("on", &proxy("")).unwrap(),
                DetectionStart::Immediate(true)
            ));
        });
        let DetectionStart::Leader { cache_key } = runtime.begin("auto", &proxy("")).unwrap()
        else {
            panic!("auto should probe");
        };
        runtime.complete(cache_key, false);
        assert!(matches!(
            runtime.begin("auto", &proxy("")).unwrap(),
            DetectionStart::Leader { .. }
        ));
    }

    #[test]
    fn caches_probe_failures_by_proxy_for_exactly_ten_minutes() {
        let start = Instant::now();
        let mut runtime = CdnDetectionRuntime::default();
        let DetectionStart::Leader { cache_key } = runtime
            .begin_at("auto", &proxy("127.0.0.1:1"), start)
            .unwrap()
        else {
            panic!("first caller must lead the probe");
        };
        runtime.complete_at(cache_key, true, start);

        crate::v1_case!("external-chrome-cdn-6461b23a938b", {
            assert_eq!(runtime.cache_ttl, Duration::from_secs(10 * 60));
            assert!(matches!(
                runtime
                    .begin_at(
                        "auto",
                        &proxy("127.0.0.1:1"),
                        start + Duration::from_secs(10 * 60) - Duration::from_nanos(1),
                    )
                    .unwrap(),
                DetectionStart::Immediate(true)
            ));
            assert!(matches!(
                runtime
                    .begin_at(
                        "auto",
                        &proxy("127.0.0.1:1"),
                        start + Duration::from_secs(10 * 60),
                    )
                    .unwrap(),
                DetectionStart::Leader { .. }
            ));
        });
    }
}
