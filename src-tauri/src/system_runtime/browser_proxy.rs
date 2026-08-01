#[derive(Clone)]
struct BrowserProxyLaunchSnapshot {
    endpoint: Option<rion_platform::BrowserProxyEndpoint>,
    #[cfg(windows)]
    fingerprint: String,
    generation: u64,
}

#[cfg(windows)]
struct WebView2ProxyEnvironment {
    fingerprint: String,
    lifecycle_trackers: Vec<Arc<SurfaceLifecycleTracker>>,
}

struct BrowserProxyController {
    diagnostics: Mutex<BrowserProxyDiagnosticsRecord>,
    generation: AtomicU64,
    role_snapshots: Mutex<HashMap<String, Arc<BrowserProxyLaunchSnapshot>>>,
    settings: Mutex<BrowserProxySettingsRecord>,
    #[cfg(windows)]
    webview2_environments: Mutex<HashMap<PathBuf, WebView2ProxyEnvironment>>,
}

impl BrowserProxyController {
    fn new(settings: BrowserProxySettingsRecord) -> Self {
        let mode = settings.mode.clone();
        let endpoint = diagnostic_endpoint(&settings);
        let protocol = endpoint.map(|value| value.protocol.clone());
        let port = endpoint.map(|value| value.port);
        Self {
            diagnostics: Mutex::new(BrowserProxyDiagnosticsRecord {
                mode,
                protocol,
                port,
                preflight_status: "pending".to_owned(),
                preflight_duration_ms: None,
                platform_apply_status: "notApplied".to_owned(),
                fingerprint_generation: 0,
                last_error_code: None,
            }),
            generation: AtomicU64::new(0),
            role_snapshots: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
            #[cfg(windows)]
            webview2_environments: Mutex::new(HashMap::new()),
        }
    }

    fn update_settings(
        &self,
        settings: BrowserProxySettingsRecord,
        active_role_ids: &HashSet<String>,
    ) -> RuntimeResult<()> {
        let mut current = self.settings.lock().map_err(|_| {
            RuntimeError::new(
                "BROWSER_PROXY_APPLY_FAILED",
                "The browser proxy settings snapshot is unavailable.",
            )
        })?;
        *current = settings.clone();
        drop(current);
        self.role_snapshots
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "BROWSER_PROXY_APPLY_FAILED",
                    "The role browser proxy snapshot registry is unavailable.",
                )
            })?
            .retain(|role_id, _| active_role_ids.contains(role_id));
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.mode = settings.mode.clone();
            let endpoint = diagnostic_endpoint(&settings);
            diagnostics.protocol = endpoint.map(|value| value.protocol.clone());
            diagnostics.port = endpoint.map(|value| value.port);
            diagnostics.preflight_status = "pending".to_owned();
            diagnostics.preflight_duration_ms = None;
            diagnostics.platform_apply_status = "notApplied".to_owned();
            diagnostics.last_error_code = None;
        }
        Ok(())
    }

    fn prepare_roles(&self, role_ids: &[String]) -> RuntimeResult<Arc<BrowserProxyLaunchSnapshot>> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "BROWSER_PROXY_APPLY_FAILED",
                    "The browser proxy settings snapshot is unavailable.",
                )
            })?
            .clone();
        let endpoint = proxy_endpoint_from_settings(&settings)?;
        let preflight_started = Instant::now();
        let preflight = if let Some(endpoint) = endpoint.as_ref() {
            rion_platform::preflight_browser_proxy(endpoint).map_err(|error| {
                self.record_failure(
                    &settings,
                    "failed",
                    Some(preflight_started.elapsed()),
                    "BROWSER_PROXY_UNAVAILABLE",
                );
                RuntimeError::new(
                    "BROWSER_PROXY_UNAVAILABLE",
                    format!("The configured local browser proxy is unavailable: {error}"),
                )
            })?
        } else {
            rion_platform::BrowserProxyPreflight { duration_ms: 0 }
        };
        let generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        #[cfg(windows)]
        let fingerprint = rion_platform::browser_proxy_fingerprint(endpoint.as_ref());
        let snapshot = Arc::new(BrowserProxyLaunchSnapshot {
            endpoint,
            #[cfg(windows)]
            fingerprint,
            generation,
        });
        let mut snapshots = self.role_snapshots.lock().map_err(|_| {
            RuntimeError::new(
                "BROWSER_PROXY_APPLY_FAILED",
                "The role browser proxy snapshot registry is unavailable.",
            )
        })?;
        for role_id in role_ids {
            snapshots.insert(role_id.clone(), Arc::clone(&snapshot));
        }
        drop(snapshots);
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.mode = settings.mode.clone();
            let endpoint = diagnostic_endpoint(&settings);
            diagnostics.protocol = endpoint.map(|value| value.protocol.clone());
            diagnostics.port = endpoint.map(|value| value.port);
            diagnostics.preflight_status = if snapshot.endpoint.is_some() {
                "succeeded"
            } else {
                "bypassed"
            }
            .to_owned();
            diagnostics.preflight_duration_ms = snapshot
                .endpoint
                .as_ref()
                .map(|_| preflight.duration_ms);
            diagnostics.platform_apply_status = "pending".to_owned();
            diagnostics.fingerprint_generation = generation;
            diagnostics.last_error_code = None;
        }
        Ok(snapshot)
    }

    fn snapshot_for_role(&self, role_id: &str) -> RuntimeResult<Arc<BrowserProxyLaunchSnapshot>> {
        if let Some(snapshot) = self
            .role_snapshots
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "BROWSER_PROXY_APPLY_FAILED",
                    "The role browser proxy snapshot registry is unavailable.",
                )
            })?
            .get(role_id)
            .cloned()
        {
            return Ok(snapshot);
        }
        self.prepare_roles(&[role_id.to_owned()])
    }

    fn diagnostics(&self) -> Option<BrowserProxyDiagnosticsRecord> {
        self.diagnostics.lock().ok().map(|value| value.clone())
    }

    fn role_uses_custom_proxy(&self, role_id: &str) -> bool {
        self.role_snapshots
            .lock()
            .ok()
            .and_then(|snapshots| snapshots.get(role_id).cloned())
            .is_some_and(|snapshot| snapshot.endpoint.is_some())
    }

    fn record_apply_success(&self, snapshot: &BrowserProxyLaunchSnapshot) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.platform_apply_status = "applied".to_owned();
            diagnostics.fingerprint_generation = snapshot.generation;
            diagnostics.last_error_code = None;
        }
    }

    fn record_apply_failure(&self, snapshot: &BrowserProxyLaunchSnapshot, code: &str) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.platform_apply_status = "failed".to_owned();
            diagnostics.fingerprint_generation = snapshot.generation;
            diagnostics.last_error_code = Some(code.to_owned());
        }
    }

    fn record_failure(
        &self,
        settings: &BrowserProxySettingsRecord,
        preflight_status: &str,
        duration: Option<Duration>,
        code: &str,
    ) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.mode = settings.mode.clone();
            let endpoint = diagnostic_endpoint(settings);
            diagnostics.protocol = endpoint.map(|value| value.protocol.clone());
            diagnostics.port = endpoint.map(|value| value.port);
            diagnostics.preflight_status = preflight_status.to_owned();
            diagnostics.preflight_duration_ms = duration.map(|value| {
                value.as_millis().min(u128::from(u64::MAX)) as u64
            });
            diagnostics.platform_apply_status = "failed".to_owned();
            diagnostics.last_error_code = Some(code.to_owned());
        }
    }

    #[cfg(windows)]
    fn ensure_webview2_environment(
        &self,
        data_directory: &Path,
        snapshot: &BrowserProxyLaunchSnapshot,
    ) -> RuntimeResult<()> {
        let trackers = {
            let mut environments = self.webview2_environments.lock().map_err(|_| {
                RuntimeError::new(
                    "BROWSER_PROXY_APPLY_FAILED",
                    "The WebView2 proxy environment registry is unavailable.",
                )
            })?;
            let Some(environment) = environments.get_mut(data_directory) else {
                environments.insert(
                    data_directory.to_path_buf(),
                    WebView2ProxyEnvironment {
                        fingerprint: snapshot.fingerprint.clone(),
                        lifecycle_trackers: Vec::new(),
                    },
                );
                return Ok(());
            };
            if environment.fingerprint == snapshot.fingerprint {
                return Ok(());
            }
            environment.lifecycle_trackers.clone()
        };
        let deadline = Instant::now() + SURFACE_RECLAMATION_TIMEOUT;
        for tracker in trackers {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || !tracker.wait_for_browser_process_exit(remaining) {
                if let Ok(mut diagnostics) = self.diagnostics.lock() {
                    diagnostics.platform_apply_status = "failed".to_owned();
                    diagnostics.last_error_code = Some("BROWSER_PROXY_RESTART_REQUIRED".to_owned());
                }
                return Err(RuntimeError::new(
                    "BROWSER_PROXY_RESTART_REQUIRED",
                    "WebView2 is still using the previous proxy environment. Restart Rion Studio before launching this role.",
                ));
            }
        }
        let mut environments = self.webview2_environments.lock().map_err(|_| {
            RuntimeError::new(
                "BROWSER_PROXY_APPLY_FAILED",
                "The WebView2 proxy environment registry is unavailable.",
            )
        })?;
        environments.insert(
            data_directory.to_path_buf(),
            WebView2ProxyEnvironment {
                fingerprint: snapshot.fingerprint.clone(),
                lifecycle_trackers: Vec::new(),
            },
        );
        Ok(())
    }

    #[cfg(windows)]
    fn register_webview2_lifecycle(
        &self,
        data_directory: &Path,
        snapshot: &BrowserProxyLaunchSnapshot,
        lifecycle: Arc<SurfaceLifecycleTracker>,
    ) {
        if let Ok(mut environments) = self.webview2_environments.lock()
            && let Some(environment) = environments.get_mut(data_directory)
            && environment.fingerprint == snapshot.fingerprint
        {
            environment.lifecycle_trackers.push(lifecycle);
        }
    }
}

fn diagnostic_endpoint(
    settings: &BrowserProxySettingsRecord,
) -> Option<&rion_core::BrowserProxyEndpointRecord> {
    (settings.mode == "custom")
        .then_some(settings.custom.as_ref())
        .flatten()
}

fn proxy_endpoint_from_settings(
    settings: &BrowserProxySettingsRecord,
) -> RuntimeResult<Option<rion_platform::BrowserProxyEndpoint>> {
    if settings.mode == "system" {
        return Ok(None);
    }
    let endpoint = settings.custom.as_ref().ok_or_else(|| {
        RuntimeError::new(
            "BROWSER_PROXY_INVALID_CONFIGURATION",
            "Custom browser proxy settings are missing their endpoint.",
        )
    })?;
    let protocol = match endpoint.protocol.as_str() {
        "http" => rion_platform::BrowserProxyProtocol::Http,
        "socks5" => rion_platform::BrowserProxyProtocol::Socks5,
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_PROXY_INVALID_CONFIGURATION",
                "Browser proxy protocol is invalid.",
            ));
        }
    };
    let host = endpoint.host.parse().map_err(|_| {
        RuntimeError::new(
            "BROWSER_PROXY_INVALID_CONFIGURATION",
            "Browser proxy host is invalid.",
        )
    })?;
    let port = u16::try_from(endpoint.port).map_err(|_| {
        RuntimeError::new(
            "BROWSER_PROXY_INVALID_CONFIGURATION",
            "Browser proxy port is invalid.",
        )
    })?;
    let endpoint = rion_platform::BrowserProxyEndpoint {
        protocol,
        host,
        port,
    };
    endpoint.validate().map_err(|error| {
        RuntimeError::new("BROWSER_PROXY_INVALID_CONFIGURATION", error.to_string())
    })?;
    Ok(Some(endpoint))
}

impl SystemRuntimeExecutor {
    pub fn update_browser_proxy_settings(
        &self,
        settings: BrowserProxySettingsRecord,
    ) -> Result<(), String> {
        let active_role_ids = self
            .state()
            .map(|state| state.role_tabs.keys().cloned().collect::<HashSet<_>>())
            .map_err(|error| error.message)?;
        self.browser_proxy
            .update_settings(settings, &active_role_ids)
            .map_err(|error| error.message)
    }

    pub fn browser_proxy_diagnostics(&self) -> Option<BrowserProxyDiagnosticsRecord> {
        self.browser_proxy.diagnostics()
    }
}

#[cfg(test)]
mod browser_proxy_tests {
    use super::*;

    #[test]
    fn one_system_launch_snapshot_is_shared_by_every_role_and_bypasses_preflight() {
        let controller = BrowserProxyController::new(BrowserProxySettingsRecord {
            mode: "system".to_owned(),
            custom: None,
        });
        let snapshot = controller
            .prepare_roles(&["role-a".to_owned(), "role-b".to_owned()])
            .unwrap();
        let role_a = controller.snapshot_for_role("role-a").unwrap();
        let role_b = controller.snapshot_for_role("role-b").unwrap();

        assert!(Arc::ptr_eq(&snapshot, &role_a));
        assert!(Arc::ptr_eq(&role_a, &role_b));
        assert!(snapshot.endpoint.is_none());
        let diagnostics = controller.diagnostics().unwrap();
        assert_eq!(diagnostics.preflight_status, "bypassed");
        assert!(diagnostics.preflight_duration_ms.is_none());
    }

    #[test]
    fn settings_changes_keep_only_running_role_snapshots() {
        let controller = BrowserProxyController::new(BrowserProxySettingsRecord {
            mode: "system".to_owned(),
            custom: None,
        });
        controller
            .prepare_roles(&["running".to_owned(), "stopped".to_owned()])
            .unwrap();
        controller
            .update_settings(
                BrowserProxySettingsRecord {
                    mode: "custom".to_owned(),
                    custom: Some(rion_core::BrowserProxyEndpointRecord {
                        protocol: "http".to_owned(),
                        host: "127.0.0.1".to_owned(),
                        port: 8080,
                    }),
                },
                &HashSet::from(["running".to_owned()]),
            )
            .unwrap();

        let snapshots = controller.role_snapshots.lock().unwrap();
        assert!(snapshots.contains_key("running"));
        assert!(!snapshots.contains_key("stopped"));
        assert!(snapshots["running"].endpoint.is_none());
    }

    #[test]
    fn diagnostics_include_route_state_without_the_proxy_host() {
        let controller = BrowserProxyController::new(BrowserProxySettingsRecord {
            mode: "custom".to_owned(),
            custom: Some(rion_core::BrowserProxyEndpointRecord {
                protocol: "socks5".to_owned(),
                host: "127.0.0.1".to_owned(),
                port: 10_090,
            }),
        });
        let diagnostics = serde_json::to_value(controller.diagnostics().unwrap()).unwrap();

        assert_eq!(diagnostics["mode"], "custom");
        assert_eq!(diagnostics["protocol"], "socks5");
        assert_eq!(diagnostics["port"], 10_090);
        assert!(diagnostics.get("host").is_none());
        assert!(!diagnostics.to_string().contains("127.0.0.1"));
    }
}
