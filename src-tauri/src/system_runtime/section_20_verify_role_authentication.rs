impl SystemRuntimeExecutor {
    fn verify_role_authentication(
        &self,
        role_id: &str,
        verification_url: &str,
        authenticated_path: &str,
        login_path: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<Option<String>> {
        if self.state()?.role_tabs.contains_key(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before verifying imported browser session data.",
            ));
        }
        if !valid_auth_probe_path(authenticated_path)
            || !valid_auth_probe_path(login_path)
            || authenticated_path == login_path
        {
            return Err(RuntimeError::new(
                "SESSION_IMPORT_AUTH_PROBE_INVALID",
                "The session authentication probe paths are invalid.",
            ));
        }
        let verification = checked_web_url(verification_url)?;
        let expected_origin = verification.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let (window, webview, navigation, lifecycle) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let outcome = (|| {
            navigation.reset();
            webview
                .navigate(verification)
                .map_err(RuntimeError::tauri)?;
            navigation.wait().map_err(|message| {
                RuntimeError::new("SESSION_IMPORT_AUTH_PROBE_LOAD_FAILED", message)
            })?;
            webview.url().map_err(RuntimeError::tauri)
        })();
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        cleanup?;
        let (auth_state, final_path, reason_code) = match outcome {
            Ok(final_url) if final_url.origin().ascii_serialization() != expected_origin => (
                "indeterminate",
                final_url.path().to_owned(),
                Some("SESSION_IMPORT_AUTH_PROBE_ORIGIN_MISMATCH"),
            ),
            Ok(final_url) if auth_probe_path_matches(final_url.path(), authenticated_path) => {
                ("authenticated", final_url.path().to_owned(), None)
            }
            Ok(final_url) if auth_probe_path_matches(final_url.path(), login_path) => {
                ("notAuthenticated", final_url.path().to_owned(), None)
            }
            Ok(final_url) => (
                "indeterminate",
                final_url.path().to_owned(),
                Some("SESSION_IMPORT_AUTH_PROBE_UNEXPECTED_PATH"),
            ),
            Err(error) => ("indeterminate", String::new(), Some(error.code)),
        };
        Ok(Some(
            json!({
                "authState": auth_state,
                "finalPath": final_path,
                "reasonCode": reason_code,
            })
            .to_string(),
        ))
    }

    fn load_session_transfer(
        &self,
        transaction_id: &str,
    ) -> RuntimeResult<SessionTransferPayloadRecord> {
        validate_transaction_id(transaction_id)?;
        let path = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id)
            .join("session-transfer.enc");
        let protected = fs::read(&path).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_STAGING_UNAVAILABLE",
                format!("Encrypted session-transfer staging is unavailable: {error}"),
            )
        })?;
        let plaintext = rion_platform::unprotect_session_transfer(current_platform(), &protected)
            .map_err(|error| {
            RuntimeError::new("SESSION_IMPORT_STAGING_INVALID", error.to_string())
        })?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_STAGING_INVALID",
                format!("Encrypted session-transfer payload is invalid: {error}"),
            )
        })
    }

    fn persist_session_backup(
        &self,
        transaction_id: &str,
        backup: &NativeSessionBackup,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let payload = SessionTransferPayloadRecord {
            cookies: backup.cookies.iter().map(native_cookie_record).collect(),
            local_storage: backup
                .local_storage
                .iter()
                .map(|(key, value)| rion_core::LocalStorageEntryRecord {
                    key: key.clone(),
                    value: value.clone(),
                })
                .collect(),
        };
        let serialized = serde_json::to_vec(&PersistedSessionBackup {
            payload,
            storage_touched: backup.storage_touched,
        })
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))?;
        let platform = current_platform();
        let protected =
            rion_platform::protect_session_transfer(platform, &serialized).map_err(|error| {
                RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string())
            })?;
        let directory = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id);
        write_private_file(&directory, "backup.enc", &protected)
    }

    fn load_session_backup(
        &self,
        transaction_id: &str,
        launch: &Url,
    ) -> RuntimeResult<NativeSessionBackup> {
        validate_transaction_id(transaction_id)?;
        let protected = fs::read(
            self.user_data_dir
                .join(".session-transfers")
                .join(transaction_id)
                .join("backup.enc"),
        )
        .map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_ROLLBACK_UNAVAILABLE",
                format!("Encrypted session backup is unavailable: {error}"),
            )
        })?;
        let plaintext = rion_platform::unprotect_session_transfer(current_platform(), &protected)
            .map_err(|error| {
            RuntimeError::new("SESSION_IMPORT_ROLLBACK_INVALID", error.to_string())
        })?;
        let persisted: PersistedSessionBackup =
            serde_json::from_slice(&plaintext).map_err(|error| {
                RuntimeError::new("SESSION_IMPORT_ROLLBACK_INVALID", error.to_string())
            })?;
        Ok(NativeSessionBackup {
            cookies: persisted
                .payload
                .cookies
                .iter()
                .map(|cookie| transfer_cookie(cookie, launch))
                .collect::<RuntimeResult<Vec<_>>>()?,
            local_storage: persisted
                .payload
                .local_storage
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect(),
            storage_touched: persisted.storage_touched,
        })
    }

    fn commit_role_session_transfer(&self, transaction_id: &str) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let directory = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id);
        // Publish the durable commit marker before releasing either backup. If
        // marker creation fails, the caller can still restore the exact prior
        // session and the operation journal remains authoritative.
        write_private_file(&directory, "committed", b"1")?;
        if let Ok(mut state) = self.state.lock() {
            state.session_import_backups.remove(transaction_id);
        }
        Ok(())
    }

    fn rollback_role_session_transfer(
        &self,
        transaction_id: &str,
        role_id: &str,
        launch_url: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let launch = checked_web_url(launch_url)?;
        let backup = match self.state()?.session_import_backups.remove(transaction_id) {
            Some(backup) => backup,
            None => self.load_session_backup(transaction_id, &launch)?,
        };
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        self.restore_role_session_cookies(role_id, &paths, &launch, &backup.cookies)?;
        if backup.storage_touched {
            self.restore_role_local_storage(
                role_id,
                &paths,
                &launch,
                &origin,
                &backup.local_storage,
            )?;
        }
        Ok(())
    }

    fn create_session_transfer_surface(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        document_start_script: Option<&str>,
    ) -> RuntimeResult<(
        Window,
        Webview,
        Arc<NavigationTracker>,
        Arc<SurfaceLifecycleTracker>,
    )> {
        let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let suffix = format!("{role_id}:{sequence}");
        let window_app = self.app.clone();
        let window_label = runtime_label("session-transfer-window", &suffix);
        let window = self.create_window_bounded(role_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .inner_size(1.0, 1.0)
                .visible(false)
                .build()
        })?;
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let mut builder = self
            .role_store_webview_builder(
                runtime_label("session-transfer-webview", &suffix),
                paths,
                role_id,
            )?
            .on_page_load(move |_webview, payload| {
                callback_navigation.page_event(payload.event(), payload.url());
            });
        if let Some(script) = document_start_script {
            builder = builder.initialization_script_for_all_frames(script);
        }
        let webview = self
            .add_child_bounded(
                &window,
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
                role_id,
            )
            .inspect_err(|_| {
                let _ = window.close();
            })?;
        let lifecycle = match self.install_surface_lifecycle_tracker(&webview) {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                let _ = webview.close();
                let _ = window.close();
                return Err(error);
            }
        };
        #[cfg(windows)]
        {
            let snapshot = self.browser_proxy.snapshot_for_role(role_id)?;
            self.browser_proxy.register_webview2_lifecycle(
                &paths.webview2,
                &snapshot,
                Arc::clone(&lifecycle),
            );
        }
        if let Err(error) = install_platform_security_policy(&webview) {
            let _ = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            return Err(error);
        }
        Ok((window, webview, navigation, lifecycle))
    }

    fn close_hidden_surface(
        &self,
        role_id: &str,
        window: Window,
        webview: Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
    ) -> RuntimeResult<()> {
        let surface_cleanup = self
            .close_surface_and_wait(&webview, lifecycle, role_id)
            .map(|_| ());
        let window_cleanup = window.close().map_err(RuntimeError::tauri);
        surface_cleanup.and(window_cleanup)
    }

    fn restore_role_session_cookies(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        launch: &Url,
        backup: &[Cookie<'static>],
    ) -> RuntimeResult<()> {
        let (window, webview, _, lifecycle) =
            self.create_session_transfer_surface(role_id, paths, None)?;
        let result = restore_url_cookies(&webview, launch, backup);
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
    }

    fn restore_role_local_storage(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        launch: &Url,
        origin: &str,
        backup: &[(String, String)],
    ) -> RuntimeResult<()> {
        let script = local_storage_restore_script(origin, backup)?;
        let (window, webview, navigation, lifecycle) =
            self.create_session_transfer_surface(role_id, paths, Some(&script))?;
        let result = (|| {
            navigation.reset();
            webview
                .navigate(launch.clone())
                .map_err(RuntimeError::tauri)?;
            navigation.wait().map_err(|message| {
                RuntimeError::new("SESSION_IMPORT_ROLLBACK_LOAD_FAILED", message)
            })?;
            require_exact_webview_origin(&webview, origin)?;
            verify_local_storage_snapshot(&webview, backup)
        })();
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
    }

    fn evaluate_webview(&self, webview: &Webview, source: &str) -> RuntimeResult<String> {
        evaluate_system_webview(webview, source)
    }

    fn refresh_local_storage_sync_source(
        &self,
        source_role_id: &str,
        source_launch_url: &str,
        origin: &str,
        keys: &[String],
        selectors: &[String],
        codec: Option<&str>,
    ) -> RuntimeResult<()> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
        validate_local_storage_sync_contract(origin, keys, selectors, codec)?;
        let live = {
            let state = self.state()?;
            state
                .role_tabs
                .get(source_role_id)
                .and_then(|tab_id| state.tabs.get(tab_id))
                .and_then(|tab| tab.roles.get(source_role_id))
                .map(|surface| surface.webview.clone())
        };
        let snapshot = if let Some(webview) = live {
            require_exact_local_storage_sync_origin(&webview, origin)?;
            let (entries, selector_entries) =
                read_scoped_local_storage_snapshot(&webview, keys, selectors, codec)?;
            PersistedLocalStorageSyncSnapshot {
                codec: codec.map(str::to_owned),
                schema_version: 2,
                source_role_id: source_role_id.to_owned(),
                origin: origin.to_owned(),
                entries,
                selector_entries,
            }
        } else if let Ok(snapshot) =
            self.load_local_storage_sync_snapshot(source_role_id, origin, keys, selectors, codec)
        {
            // A stopped source may still have a native storage write in flight. The
            // encrypted observer snapshot is updated before dependents are allowed
            // to observe a value, so prefer it over rereading the just-closed store.
            snapshot
        } else {
            let launch = checked_web_url(source_launch_url)?;
            if launch.origin().ascii_serialization() != origin {
                return Err(RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
                    "The localStorage source launch origin changed.",
                ));
            }
            let paths = role_session_paths(&self.user_data_dir, source_role_id)?;
            fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
            let (window, webview, navigation, lifecycle) =
                self.create_session_transfer_surface(source_role_id, &paths, None)?;
            let result = (|| {
                navigation.reset();
                webview.navigate(launch).map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("LOCAL_STORAGE_SYNC_SNAPSHOT_LOAD_FAILED", message)
                })?;
                require_exact_local_storage_sync_origin(&webview, origin)?;
                read_scoped_local_storage_snapshot(&webview, keys, selectors, codec)
            })();
            let cleanup = self.close_hidden_surface(source_role_id, window, webview, &lifecycle);
            match (result, cleanup) {
                (Ok((entries, selector_entries)), Ok(())) => {
                    PersistedLocalStorageSyncSnapshot {
                        codec: codec.map(str::to_owned),
                        schema_version: 2,
                        source_role_id: source_role_id.to_owned(),
                        origin: origin.to_owned(),
                        entries,
                        selector_entries,
                    }
                }
                (Err(error), _) | (Ok(_), Err(error)) => return Err(error),
            }
        };
        self.persist_local_storage_sync_snapshot(snapshot)
    }

    fn persist_local_storage_sync_snapshot(
        &self,
        snapshot: PersistedLocalStorageSyncSnapshot,
    ) -> RuntimeResult<()> {
        let serialized = serde_json::to_vec(&snapshot).map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                "The localStorage synchronization snapshot could not be encoded.",
            )
        })?;
        if serialized.len() > LOCAL_STORAGE_SYNC_MAX_BYTES {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE",
                "The localStorage synchronization snapshot exceeds 10 MiB.",
            ));
        }
        role_session_paths(&self.user_data_dir, &snapshot.source_role_id)?;
        let protected = rion_platform::protect_local_storage_sync(current_platform(), &serialized)
            .map_err(|error| {
                RuntimeError::new("LOCAL_STORAGE_SYNC_CACHE_PROTECT_FAILED", error.to_string())
            })?;
        let directory = self
            .user_data_dir
            .join("roles")
            .join(&snapshot.source_role_id)
            .join("browser")
            .join("system");
        fs::create_dir_all(&directory).map_err(RuntimeError::io)?;
        rion_platform::restrict_directory_to_current_user(&directory).map_err(|error| {
            RuntimeError::new("LOCAL_STORAGE_SYNC_CACHE_WRITE_FAILED", error.to_string())
        })?;
        let temporary = directory.join(format!(".local-storage-sync-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, protected).map_err(RuntimeError::io)?;
        let destination = directory.join("local-storage-sync-v2.enc");
        if let Err(error) = rion_platform::atomic_replace_file(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_WRITE_FAILED",
                error.to_string(),
            ));
        }
        let legacy = directory.join("local-storage-sync-v1.enc");
        if legacy.is_file() {
            let _ = fs::remove_file(legacy);
        }
        Ok(())
    }

    fn load_local_storage_sync_snapshot(
        &self,
        source_role_id: &str,
        origin: &str,
        keys: &[String],
        selectors: &[String],
        codec: Option<&str>,
    ) -> RuntimeResult<PersistedLocalStorageSyncSnapshot> {
        validate_local_storage_sync_contract(origin, keys, selectors, codec)?;
        role_session_paths(&self.user_data_dir, source_role_id)?;
        let path = self
            .user_data_dir
            .join("roles")
            .join(source_role_id)
            .join("browser")
            .join("system")
            .join("local-storage-sync-v2.enc");
        let protected = fs::read(path).map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_UNAVAILABLE",
                "The encrypted localStorage synchronization snapshot is unavailable.",
            )
        })?;
        let plaintext = rion_platform::unprotect_local_storage_sync(current_platform(), &protected)
            .map_err(|_| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                    "The encrypted localStorage synchronization snapshot is invalid.",
                )
            })?;
        if plaintext.len() > LOCAL_STORAGE_SYNC_MAX_BYTES {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE",
                "The localStorage synchronization snapshot exceeds 10 MiB.",
            ));
        }
        let snapshot: PersistedLocalStorageSyncSnapshot = serde_json::from_slice(&plaintext)
            .map_err(|_| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                    "The encrypted localStorage synchronization snapshot is invalid.",
                )
            })?;
        let snapshot_keys = snapshot
            .entries
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>();
        let snapshot_selectors = snapshot
            .selector_entries
            .iter()
            .map(|(selector, _)| selector.as_str())
            .collect::<Vec<_>>();
        if snapshot.schema_version != 2
            || snapshot.source_role_id != source_role_id
            || snapshot.origin != origin
            || snapshot.codec.as_deref() != codec
            || snapshot_keys != keys.iter().map(String::as_str).collect::<Vec<_>>()
            || snapshot_selectors
                != selectors.iter().map(String::as_str).collect::<Vec<_>>()
        {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                "The encrypted localStorage synchronization snapshot does not match its binding.",
            ));
        }
        validate_local_storage_sync_selector_entries(
            codec,
            selectors,
            &snapshot.selector_entries,
        )?;
        Ok(snapshot)
    }

    pub fn local_storage_sync_changed(
        &self,
        webview_label: &str,
        request: LocalStorageSyncChangeRequest,
    ) -> Result<(), String> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            "The localStorage synchronization lifecycle lane is unavailable.".to_owned()
        })?;
        let role_id = self.role_id_for_webview(webview_label)?;
        let (config, webview) = {
            let state = self.state().map_err(|error| error.message)?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let surface = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&role_id))
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let config = surface.local_storage_sync.clone().ok_or_else(|| {
                "This role has no localStorage synchronization capability.".to_owned()
            })?;
            (config, surface.webview.clone())
        };
        if config.token != request.token || config.generation != request.generation {
            return Err("The localStorage synchronization capability is invalid.".to_owned());
        }
        require_exact_local_storage_sync_origin(&webview, &config.origin)
            .map_err(|error| error.message)?;
        if request.entries.len() != config.keys.len()
            || request
                .entries
                .iter()
                .zip(&config.keys)
                .any(|((key, _), expected)| key != expected)
        {
            return Err("The localStorage synchronization key set is invalid.".to_owned());
        }
        validate_local_storage_sync_selector_entries(
            config.codec.as_deref(),
            &config.selectors,
            &request.selector_entries,
        )
            .map_err(|error| error.message)?;
        if request.diagnostic_code.as_deref().is_some_and(|code| {
            !local_storage_sync_diagnostic_is_valid(config.codec.as_deref(), code)
        }) {
            return Err("The localStorage synchronization diagnostic is invalid.".to_owned());
        }
        {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .cloned()
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&role_id))
                .filter(|surface| surface.webview.label() == webview_label)
                .ok_or_else(|| {
                    "Runtime role generation changed during localStorage synchronization."
                        .to_owned()
                })?;
            if !surface
                .local_storage_sync
                .as_ref()
                .is_some_and(|config| {
                    config.token == request.token && config.generation == request.generation
                })
            {
                return Err("The localStorage synchronization capability is stale.".to_owned());
            }
            if !accept_local_storage_sync_sequence(
                &mut surface.local_storage_sync_sequence,
                request.sequence,
            ) {
                return Ok(());
            }
        }
        if let Some(code) = request.diagnostic_code.as_deref() {
            self.record_local_storage_sync_diagnostic(&role_id, &config, code);
            if matches!(
                code,
                "FLYFF_SETTINGS_INVALID" | "FLYFF_CHINA_SETTINGS_INVALID"
            ) {
                return Ok(());
            }
        }
        if let Some(source_role_id) = config.source_role_id.as_deref() {
            let snapshot = self
                .load_local_storage_sync_snapshot(
                    source_role_id,
                    &config.origin,
                    &config.keys,
                    &config.selectors,
                    config.codec.as_deref(),
                )
                .map_err(|error| error.message)?;
            webview
                .eval(local_storage_sync_apply_script(&snapshot).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        if config.dependent_role_ids.is_empty() {
            return Ok(());
        }
        let snapshot = PersistedLocalStorageSyncSnapshot {
            codec: config.codec.clone(),
            schema_version: 2,
            source_role_id: role_id.clone(),
            origin: config.origin.clone(),
            entries: request.entries,
            selector_entries: request.selector_entries,
        };
        self.persist_local_storage_sync_snapshot(snapshot.clone())
            .map_err(|error| error.message)?;
        self.apply_local_storage_sync_to_running_dependents(&role_id, &snapshot)
            .map_err(|error| error.message)
    }

    fn record_local_storage_sync_diagnostic(
        &self,
        role_id: &str,
        config: &LocalStorageRuntimeConfig,
        code: &str,
    ) {
        let (level, event, message) = match code {
            "FLYFF_IDENTITY_REPAIRED" => (
                LogLevel::Info,
                "local-storage-sync.flyff-identity-repaired",
                "Flyff settings identity was repaired from the role's own session.",
            ),
            "FLYFF_CHINA_IDENTITY_REPAIRED" => (
                LogLevel::Info,
                "local-storage-sync.flyff-china-identity-repaired",
                "Flyff China settings identity was repaired from the role's own session.",
            ),
            code if code.starts_with("FLYFF_CHINA_") => (
                LogLevel::Warn,
                "local-storage-sync.flyff-china-validation-failed",
                "Flyff China localStorage synchronization failed closed.",
            ),
            _ => (
                LogLevel::Warn,
                "local-storage-sync.flyff-validation-failed",
                "Flyff localStorage synchronization failed closed.",
            ),
        };
        let context = json!({
            "code": code,
            "generation": config.generation,
            "isSource": config.source_role_id.is_none(),
            "roleId": role_id,
            "selectorCount": config.selectors.len(),
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event: event.to_owned(),
                        message: message.to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

}
