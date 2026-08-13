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
        if self.state()?.has_native_role_surface(role_id) {
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
            .webview_builder(runtime_label("session-transfer-webview", &suffix), paths, None)?
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
        if let Err(error) = install_platform_security_policy(&webview) {
            let _ = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            return Err(error);
        }
        if let Err(error) = install_platform_navigation_completion_tracker(
            &webview,
            Arc::clone(&navigation),
        ) {
            let _ = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            return Err(error);
        }
        if let Err(error) = self.restore_role_cookie_checkpoint(&webview, role_id) {
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
        let checkpoint = if result.is_ok() {
            self.persist_role_cookie_checkpoint(&webview, role_id)
        } else {
            Ok(())
        };
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(checkpoint).and(cleanup)
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

}
