impl SystemRuntimeExecutor {
    fn webview_builder(
        &self,
        label: String,
        paths: &SessionPaths,
        owner_id: Option<&str>,
        surface_policy: WebviewSurfaceFeaturePolicy,
    ) -> RuntimeResult<WebviewBuilder<tauri::Wry>> {
        let blank = "about:blank"
            .parse()
            .map_err(|_| RuntimeError::new("TAURI_URL_INVALID", "Invalid blank URL."))?;
        let popup_app = self.app.clone();
        let popup_role_id = owner_id.map(str::to_owned);
        #[cfg(target_os = "macos")]
        let popup_surface_generation = owner_id
            .and_then(|role_id| self.surface_generation_for_role(role_id));
        let popup_surface_policy = surface_policy;
        let popup_install_role_features = popup_surface_policy.installs_role_features();
        let popup_install_contained_fullscreen =
            popup_surface_policy.installs_contained_fullscreen();
        let popup_webview2_data_directory = paths.webview2.clone();
        let popup_webkit_data_store_identifier = paths.webkit_identifier;
        #[cfg(windows)]
        let popup_additional_browser_arguments =
            self.configuration.additional_browser_arguments.clone();
        let popup_base_document_start_script = self.configuration.document_start_script.clone();
        let install_role_features = surface_policy.installs_role_features();
        let contained_fullscreen_document_start_script = surface_policy
            .installs_contained_fullscreen()
            .then(workspace_contained_fullscreen_script);
        let overlay_document_start_script = owner_id
            .filter(|_| install_role_features)
            .map(|_| self.overlay_document_start_script_for_label(&label))
            .transpose()?;
        let download_app = self.app.clone();
        let download_role_id = owner_id.map(str::to_owned);
        #[cfg(not(target_os = "macos"))]
        let navigation_role_id = owner_id.filter(|_| install_role_features).map(str::to_owned);
        #[cfg(not(target_os = "macos"))]
        let navigation_app = self.app.clone();
        #[cfg(not(target_os = "macos"))]
        let navigation_label = label.clone();
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
            .data_directory(paths.webview2.clone())
            .data_store_identifier(paths.webkit_identifier)
            .initialization_script_for_all_frames(&self.configuration.document_start_script)
            .enable_clipboard_access()
            .zoom_hotkeys_enabled(false)
            .on_navigation(move |url| {
                #[cfg(target_os = "macos")]
                {
                    matches!(url.scheme(), "about" | "http" | "https")
                }
                #[cfg(not(target_os = "macos"))]
                {
                let Some(role_id) = navigation_role_id.as_deref() else {
                    return matches!(url.scheme(), "about" | "http" | "https");
                };
                navigation_app
                    .try_state::<crate::CoreState>()
                    .is_some_and(|state| {
                        state.runtime.allow_main_frame_navigation_after_input_fence(
                            &navigation_label,
                            role_id,
                            url,
                        )
                    })
                }
            })
            .on_new_window(move |url, features| {
                let decision = popup_contract_decision(popup_role_id.is_some(), url.scheme());
                if decision != PopupContractDecision::Create {
                    if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                        let stage = match decision {
                            PopupContractDecision::DenyMissingOwner => {
                                "popupDeniedMissingOwner"
                            }
                            PopupContractDecision::DenyUnsupportedScheme => {
                                "popupDeniedUnsupportedScheme"
                            }
                            PopupContractDecision::Create => unreachable!(),
                        };
                        state.runtime.record_popup_contract_outcome(
                            popup_role_id.as_deref(),
                            stage,
                            NativeOperationStatus::Applied,
                            None,
                        );
                    }
                    return NewWindowResponse::Deny;
                }
                let role_id = popup_role_id
                    .as_ref()
                    .expect("popup contract requires a role owner");
                let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let label = runtime_label("game-role-popup", &format!("{role_id}:{sequence}"));
                let popup_document_start_script = if popup_install_role_features {
                    let overlay_document_start_script =
                        match popup_app.try_state::<crate::CoreState>().map(|state| {
                            state
                                .runtime
                                .overlay_document_start_script_for_label(&label)
                        }) {
                            Some(Ok(source)) => source,
                            Some(Err(error)) => {
                                let _ = popup_app.emit(
                                    "rion://shell-error",
                                    json!({
                                        "code": error.code,
                                        "message": error.message,
                                        "roleId": role_id,
                                        "url": url
                                    }),
                                );
                                return NewWindowResponse::Deny;
                            }
                            None => return NewWindowResponse::Deny,
                        };
                    [
                        popup_base_document_start_script.clone(),
                        overlay_document_start_script,
                    ]
                    .join("\n")
                } else if popup_install_contained_fullscreen {
                    [
                        popup_base_document_start_script.clone(),
                        "Object.defineProperty(globalThis, '__rionWorkspaceWebContainedPopup', { configurable: false, enumerable: false, writable: false, value: true });".to_owned(),
                        workspace_contained_fullscreen_script(),
                    ]
                    .join("\n")
                } else {
                    popup_base_document_start_script.clone()
                };
                let blank = match "about:blank".parse() {
                    Ok(blank) => blank,
                    Err(_) => return NewWindowResponse::Deny,
                };
                let popup_download_app = popup_app.clone();
                let popup_download_role_id = role_id.clone();
                #[cfg(not(target_os = "macos"))]
                let popup_navigation_app = popup_app.clone();
                #[cfg(not(target_os = "macos"))]
                let popup_navigation_role_id = role_id.clone();
                #[cfg(not(target_os = "macos"))]
                let popup_navigation_label = label.clone();
                #[cfg(target_os = "macos")]
                let popup_navigation_ready = Arc::new(AtomicBool::new(
                    !popup_install_contained_fullscreen,
                ));
                #[cfg(target_os = "macos")]
                let popup_navigation_ready_for_handler =
                    Arc::clone(&popup_navigation_ready);
                let popup_page_load_app = popup_app.clone();
                let popup_builder = WebviewWindowBuilder::new(
                    &popup_app,
                    label.clone(),
                    WebviewUrl::External(blank),
                )
                .title(url.as_str())
                .window_features(features)
                .data_directory(popup_webview2_data_directory.clone())
                .data_store_identifier(popup_webkit_data_store_identifier)
                .initialization_script_for_all_frames(&popup_document_start_script)
                .enable_clipboard_access()
                .zoom_hotkeys_enabled(false)
                .on_navigation(move |target| {
                    #[cfg(target_os = "macos")]
                    {
                        matches!(target.scheme(), "about" | "http" | "https")
                            && (target.scheme() == "about"
                                || popup_navigation_ready_for_handler
                                    .load(Ordering::Acquire))
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                    if !popup_install_role_features {
                        return matches!(target.scheme(), "about" | "http" | "https");
                    }
                    popup_navigation_app
                        .try_state::<crate::CoreState>()
                        .is_some_and(|state| {
                            state.runtime.allow_main_frame_navigation_after_input_fence(
                                &popup_navigation_label,
                                &popup_navigation_role_id,
                                target,
                            )
                        })
                    }
                })
                .on_page_load(move |webview, payload| {
                    if payload.event() == PageLoadEvent::Finished
                        && let Some(state) =
                            popup_page_load_app.try_state::<crate::CoreState>()
                    {
                        state
                            .runtime
                            .finish_main_frame_navigation_page(
                                webview.as_ref(),
                                payload.url(),
                            );
                    }
                })
                .on_download(move |_webview, event| {
                    handle_browser_download(
                        &popup_download_app,
                        Some(&popup_download_role_id),
                        event,
                    )
                });
                #[cfg(target_os = "macos")]
                let popup_builder = if popup_install_contained_fullscreen {
                    match platform_contained_fullscreen_popup_configuration(
                        popup_webkit_data_store_identifier,
                    ) {
                        Ok(configuration) =>
                            popup_builder.with_webview_configuration(configuration),
                        Err(error) => {
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.record_popup_contract_outcome(
                                    Some(role_id),
                                    "popupContainedFullscreenPolicyFailed",
                                    NativeOperationStatus::Failed,
                                    Some(error.code),
                                );
                            }
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                    }
                } else {
                    popup_builder
                };
                #[cfg(target_os = "macos")]
                let popup_builder =
                    popup_builder.background_throttling(BackgroundThrottlingPolicy::Throttle);
                #[cfg(target_os = "macos")]
                let popup_builder = if popup_install_contained_fullscreen {
                    popup_builder.visible(false)
                } else {
                    popup_builder
                };
                #[cfg(windows)]
                let popup_builder =
                    popup_builder.additional_browser_args(&popup_additional_browser_arguments);
                let popup = popup_builder.build();
                match popup {
                    Ok(window) => {
                        #[cfg(target_os = "macos")]
                        if popup_install_contained_fullscreen {
                            let Some(generation) = popup_surface_generation else {
                                let _ = window.close();
                                return NewWindowResponse::Deny;
                            };
                            let setup_app = popup_app.clone();
                            let setup_label = label.clone();
                            let setup_role_id = role_id.clone();
                            let setup_url = url.clone();
                            let setup_window = window.clone();
                            let setup_navigation_ready = Arc::clone(&popup_navigation_ready);
                            let setup_result = submit_platform_role_surface_setup_inner(
                                window.as_ref(),
                                popup_app.clone(),
                                SurfaceFailureTarget::Popup {
                                    label: label.clone(),
                                    role_id: role_id.clone(),
                                    generation,
                                },
                                move |result| {
                                    let result = result.and_then(|lifecycle| {
                                        install_platform_contained_fullscreen_policy(
                                            setup_window.as_ref(),
                                        )?;
                                        preflight_platform_contained_fullscreen_policy(
                                            setup_window.as_ref(),
                                        )?;
                                        let state = setup_app
                                            .try_state::<crate::CoreState>()
                                            .ok_or_else(|| {
                                                RuntimeError::new(
                                                    "SYSTEM_RUNTIME_UNAVAILABLE",
                                                    "System Runtime stopped while preparing a contained-fullscreen popup.",
                                                )
                                            })?;
                                        state.runtime.register_popup(
                                            setup_window.as_ref(),
                                            &lifecycle,
                                            setup_label.clone(),
                                            setup_role_id.clone(),
                                            generation,
                                        )?;
                                        setup_navigation_ready.store(true, Ordering::Release);
                                        setup_window
                                            .navigate(setup_url.clone())
                                            .map_err(RuntimeError::tauri)?;
                                        setup_window.show().map_err(RuntimeError::tauri)
                                    });
                                    if let Err(error) = result {
                                        let _ = setup_window.close();
                                        if let Some(state) =
                                            setup_app.try_state::<crate::CoreState>()
                                        {
                                            state.runtime.revoke_overlay_capability(&setup_label);
                                            state.runtime.record_popup_contract_outcome(
                                                Some(&setup_role_id),
                                                "popupContainedFullscreenPolicyFailed",
                                                NativeOperationStatus::Failed,
                                                Some(error.code),
                                            );
                                        }
                                        let _ = setup_app.emit(
                                            "rion://shell-error",
                                            json!({
                                                "code": error.code,
                                                "message": error.message,
                                                "roleId": setup_role_id,
                                                "url": setup_url
                                            }),
                                        );
                                    }
                                },
                            );
                            if let Err(error) = setup_result {
                                let _ = window.close();
                                if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                    state.runtime.record_popup_contract_outcome(
                                        Some(role_id),
                                        "popupContainedFullscreenPolicyFailed",
                                        NativeOperationStatus::Failed,
                                        Some(error.code),
                                    );
                                }
                                return NewWindowResponse::Deny;
                            }
                            return NewWindowResponse::Create { window };
                        }
                        if popup_install_contained_fullscreen
                            && let Err(error) = install_platform_contained_fullscreen_policy(
                                window.as_ref(),
                            )
                            .and_then(|()| {
                                preflight_platform_contained_fullscreen_policy(window.as_ref())
                            })
                        {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                                state.runtime.record_popup_contract_outcome(
                                    Some(role_id),
                                    "popupContainedFullscreenPreflightFailed",
                                    NativeOperationStatus::Failed,
                                    Some(error.code),
                                );
                            }
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        if let Err(error) = install_platform_security_policy(window.as_ref()) {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                                state.runtime.record_popup_contract_outcome(
                                    Some(role_id),
                                    "popupSecurityFailed",
                                    NativeOperationStatus::Failed,
                                    Some(error.code),
                                );
                            }
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        let generation = popup_app
                            .try_state::<crate::CoreState>()
                            .and_then(|state| state.runtime.surface_generation_for_role(role_id));
                        let Some(generation) = generation else {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
                            return NewWindowResponse::Deny;
                        };
                        let lifecycle =
                            match popup_app.try_state::<crate::CoreState>().map(|state| {
                                state
                                    .runtime
                                    .install_popup_surface_lifecycle_tracker(
                                        window.as_ref(),
                                        &label,
                                        role_id,
                                        generation,
                                    )
                            }) {
                                Some(Ok(lifecycle)) => lifecycle,
                                Some(Err(error)) => {
                                    let _ = window.close();
                                    if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                        state.runtime.revoke_overlay_capability(&label);
                                    }
                                    let _ = popup_app.emit(
                                        "rion://shell-error",
                                        json!({
                                            "code": error.code,
                                            "message": error.message,
                                            "roleId": role_id
                                        }),
                                    );
                                    return NewWindowResponse::Deny;
                                }
                                None => {
                                    let _ = window.close();
                                    return NewWindowResponse::Deny;
                                }
                            };
                        if let Err(error) = install_process_failure_monitor(
                            window.as_ref(),
                            popup_app.clone(),
                            SurfaceFailureTarget::Popup {
                                label: label.clone(),
                                role_id: role_id.clone(),
                                generation,
                            },
                        ) {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        if popup_install_role_features
                            && let Err(error) = install_role_application_shortcut_handler(
                                window.as_ref(),
                                popup_app.clone(),
                            )
                        {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        match popup_app.try_state::<crate::CoreState>().map(|state| {
                            state.runtime.register_popup(
                                window.as_ref(),
                                &lifecycle,
                                label.clone(),
                                role_id.clone(),
                                generation,
                            )
                        }) {
                            Some(Ok(())) => {}
                            Some(Err(error)) => {
                                let _ = window.close();
                                if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                    state.runtime.revoke_overlay_capability(&label);
                                }
                                let _ = popup_app.emit(
                                    "rion://shell-error",
                                    json!({
                                        "code": error.code,
                                        "message": error.message,
                                        "roleId": role_id
                                    }),
                                );
                                return NewWindowResponse::Deny;
                            }
                            None => {
                                let _ = window.close();
                                return NewWindowResponse::Deny;
                            }
                        }
                        NewWindowResponse::Create { window }
                    }
                    Err(error) => {
                        if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                            state.runtime.revoke_overlay_capability(&label);
                            state.runtime.record_popup_contract_outcome(
                                Some(role_id),
                                "popupCreationFailed",
                                NativeOperationStatus::Failed,
                                Some("SYSTEM_POPUP_CREATE_FAILED"),
                            );
                        }
                        let _ = popup_app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_POPUP_CREATE_FAILED",
                                "message": error.to_string(),
                                "roleId": role_id,
                                "url": url
                            }),
                        );
                        NewWindowResponse::Deny
                    }
                }
            })
            .on_download(move |_webview, event| {
                handle_browser_download(&download_app, download_role_id.as_deref(), event)
            });
        if let Some(source) = contained_fullscreen_document_start_script {
            builder = builder.initialization_script_for_all_frames(&source);
        }
        if install_role_features {
            // This API is main-frame-only. Popup builders and child frames must
            // retain their own scrolling behavior.
            builder = builder.initialization_script(CANVAS_SCROLL_LOCK_INITIALIZATION_SCRIPT);
            if let Some(source) = overlay_document_start_script.as_deref() {
                builder = builder.initialization_script_for_all_frames(source);
            }
            #[cfg(target_os = "macos")]
            {
                // Match browser-like background tabs: keep hidden game pages throttled instead
                // of accepting WebKit's default full suspension. Role-less utility WebViews keep
                // the system default so imports are not delayed.
                builder = builder.background_throttling(BackgroundThrottlingPolicy::Throttle);
            }
        }
        #[cfg(windows)]
        {
            if install_role_features {
                // Keep the native WebView2 under-page surface transparent so the
                // selected workspace material remains visible until the game paints.
                builder = builder.background_color(tauri::utils::config::Color(0, 0, 0, 0));
            }
            builder = builder
                .additional_browser_args(&self.configuration.additional_browser_arguments);
        }
        Ok(builder)
    }

    fn role_webview_builder(
        &self,
        window: &Window,
        label: String,
        paths: &SessionPaths,
        role_id: &str,
    ) -> RuntimeResult<(
        WebviewBuilder<tauri::Wry>,
        HighRefreshRateDiagnosticStatus,
        RoleWebGlConfiguration,
    )> {
        let builder = self.webview_builder(
            label,
            paths,
            Some(role_id),
            WebviewSurfaceFeaturePolicy::Role,
        )?;
        #[cfg(all(windows, feature = "desktop-e2e"))]
        let builder = builder
            .initialization_script(&desktop_e2e_windows_role_viewport_probe_script(role_id));
        let high_refresh_rate_enabled = if cfg!(target_os = "macos") {
            macos_high_refresh_rate_enabled(
                self.configuration.macos_high_refresh_mode,
                platform_display_refresh_rate(window),
            )
        } else {
            false
        };
        Ok(prepare_platform_role_webview_builder(
            &self.app,
            builder,
            paths.webkit_identifier,
            high_refresh_rate_enabled,
            false,
        ))
    }

    fn workspace_webview_builder(
        &self,
        window: &Window,
        label: String,
        paths: &SessionPaths,
        surface_id: &str,
        capability_token: &str,
        generation: u64,
    ) -> RuntimeResult<(
        WebviewBuilder<tauri::Wry>,
        HighRefreshRateDiagnosticStatus,
        RoleWebGlConfiguration,
    )> {
        let identity = serde_json::to_string(&json!({
            "capabilityToken": capability_token,
            "generation": generation,
        }))
        .map_err(|error| RuntimeError::new("WORKSPACE_WEB_IDENTITY_INVALID", error.to_string()))?;
        let identity_script = format!(
            "Object.defineProperty(globalThis, '__rionWorkspaceWebIdentity', {{ configurable: false, enumerable: false, writable: false, value: Object.freeze({identity}) }});"
        );
        let builder = self
            .webview_builder(
                label,
                paths,
                Some(surface_id),
                WebviewSurfaceFeaturePolicy::WorkspaceWeb,
            )?
            .initialization_script(&identity_script);
        let high_refresh_rate_enabled = cfg!(target_os = "macos")
            && macos_high_refresh_rate_enabled(
                self.configuration.macos_high_refresh_mode,
                platform_display_refresh_rate(window),
            );
        Ok(prepare_platform_role_webview_builder(
            &self.app,
            builder,
            paths.webkit_identifier,
            high_refresh_rate_enabled,
            true,
        ))
    }

    fn clear_role_browser_data(
        &self,
        role_id: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<()> {
        if self.state()?.has_native_role_surface(role_id) {
            return Err(RuntimeError::new(
                "ROLE_BROWSER_DATA_IN_USE",
                "Stop the role before clearing its System WebView data.",
            ));
        }
        let webkit_identifier = uuid::Uuid::parse_str(webkit_data_store_identifier)
            .map_err(|_| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_INVALID",
                    "The WKWebsiteDataStore identifier is invalid.",
                )
            })?
            .into_bytes();
        let paths = SessionPaths {
            webkit_identifier,
            webview2: PathBuf::from(webview2_user_data_dir),
        };
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let window_app = self.app.clone();
        let window_label = runtime_label("browser-data-clear", role_id);
        let window = self.create_window_bounded(role_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .inner_size(1.0, 1.0)
                .visible(false)
                .build()
        })?;
        let webview = self
            .add_child_bounded(
                &window,
                self.webview_builder(
                    runtime_label("browser-data-clear-webview", role_id),
                    &paths,
                    None,
                    WebviewSurfaceFeaturePolicy::Utility,
                )?,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
                role_id,
            )
            .inspect_err(|_| {
                let _ = window.close();
            })?;
        let result = webview
            .clear_all_browsing_data()
            .map_err(RuntimeError::tauri);
        let surface_cleanup = webview.close().map_err(RuntimeError::tauri);
        let window_cleanup = window.close().map_err(RuntimeError::tauri);
        result.and(surface_cleanup).and(window_cleanup)?;
        self.remove_role_cookie_checkpoint(role_id)
    }

    fn apply_role_session_transfer(
        &self,
        request: RoleSessionTransferRequest<'_>,
    ) -> RuntimeResult<(u32, NativeSessionBackup)> {
        let RoleSessionTransferRequest {
            role_id,
            launch_url,
            webview2_user_data_dir,
            webkit_data_store_identifier,
            replace_existing,
            payload,
            backup_transaction_id,
        } = request;
        if self.state()?.has_native_role_surface(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before importing browser session data.",
            ));
        }
        let launch = checked_web_url(launch_url)?;
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;

        let (snapshot_window, snapshot_webview, snapshot_navigation, snapshot_lifecycle) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let snapshot_result = (|| {
            let existing_backup = match backup_transaction_id {
                Some(transaction_id) => self
                    .state()?
                    .session_import_backups
                    .get(transaction_id)
                    .cloned(),
                None => None,
            };
            if backup_transaction_id.is_some() && existing_backup.is_none() {
                return Err(RuntimeError::new(
                    "SESSION_IMPORT_BACKUP_UNAVAILABLE",
                    "Chrome profile import requires a verified native session snapshot.",
                ));
            }
            let (cookie_backup, storage_backup) = if let Some(backup) = existing_backup {
                (backup.cookies, backup.local_storage)
            } else {
                let cookies = cookies_for_launch(&snapshot_webview, &launch)?;
                let local_storage = if replace_existing {
                    snapshot_navigation.reset();
                    snapshot_webview
                        .navigate(launch.clone())
                        .map_err(RuntimeError::tauri)?;
                    snapshot_navigation.wait().map_err(|message| {
                        RuntimeError::new("SESSION_IMPORT_SNAPSHOT_LOAD_FAILED", message)
                    })?;
                    require_exact_webview_origin(&snapshot_webview, &origin)?;
                    read_local_storage_entries(&snapshot_webview)
                } else {
                    Ok(Vec::new())
                }?;
                (cookies, local_storage)
            };

            let existing_cookie_keys = cookie_backup
                .iter()
                .map(native_cookie_key)
                .collect::<HashSet<_>>();
            let import_cookies = payload
                .cookies
                .iter()
                .filter(|cookie| {
                    replace_existing
                        || !existing_cookie_keys.contains(&transfer_cookie_key(cookie, &launch))
                })
                .map(|cookie| transfer_cookie(cookie, &launch))
                .collect::<RuntimeResult<Vec<_>>>()?;
            if let Some(transaction_id) = backup_transaction_id {
                let backup = NativeSessionBackup {
                    cookies: cookie_backup.clone(),
                    local_storage: storage_backup.clone(),
                    storage_touched: replace_existing || !payload.local_storage.is_empty(),
                };
                self.persist_session_backup(transaction_id, &backup)?;
                self.state()?
                    .session_import_backups
                    .insert(transaction_id.to_owned(), backup);
            }

            let cookie_apply_result = (|| {
                if replace_existing {
                    for cookie in &cookie_backup {
                        snapshot_webview
                            .delete_cookie(cookie.clone())
                            .map_err(RuntimeError::tauri)?;
                    }
                }
                for cookie in &import_cookies {
                    snapshot_webview
                        .set_cookie(cookie.clone())
                        .map_err(RuntimeError::tauri)?;
                }
                let readback = cookies_for_launch(&snapshot_webview, &launch)?;
                verify_cookie_readback(&import_cookies, &readback)
            })();
            if let Err(error) = cookie_apply_result {
                let rollback = restore_url_cookies(&snapshot_webview, &launch, &cookie_backup);
                return Err(rollback.err().unwrap_or(error));
            }
            Ok((cookie_backup, storage_backup, import_cookies))
        })();
        let snapshot_checkpoint = if snapshot_result.is_ok() {
            self.persist_role_cookie_checkpoint(&snapshot_webview, role_id)
        } else {
            Ok(())
        };
        let snapshot_cleanup = self.close_hidden_surface(
            role_id,
            snapshot_window,
            snapshot_webview,
            &snapshot_lifecycle,
        );
        let (cookie_backup, storage_backup, import_cookies) =
            match (snapshot_result, snapshot_checkpoint, snapshot_cleanup) {
                (Ok(result), Ok(()), Ok(())) => result,
                (Err(error), _, _) | (Ok(_), Err(error), _) | (Ok(_), Ok(()), Err(error)) => {
                    return Err(error);
                }
            };

        let storage_required = replace_existing || !payload.local_storage.is_empty();
        if !storage_required {
            return Ok((
                import_cookies.len() as u32,
                NativeSessionBackup {
                    cookies: cookie_backup,
                    local_storage: Vec::new(),
                    storage_touched: false,
                },
            ));
        }
        let apply_script =
            local_storage_document_start_script(&origin, replace_existing, &payload.local_storage)?;
        let storage_result = (|| {
            let (window, webview, navigation, lifecycle) =
                self.create_session_transfer_surface(role_id, &paths, Some(&apply_script))?;
            let result = (|| {
                navigation.reset();
                webview
                    .navigate(launch.clone())
                    .map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("SESSION_IMPORT_STORAGE_LOAD_FAILED", message)
                })?;
                require_exact_webview_origin(&webview, &origin)?;
                verify_local_storage_import(&webview, &payload.local_storage, replace_existing)
            })();
            let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            result.and(cleanup)
        })();
        if let Err(error) = storage_result {
            let cookie_rollback =
                self.restore_role_session_cookies(role_id, &paths, &launch, &cookie_backup);
            let storage_rollback =
                self.restore_role_local_storage(role_id, &paths, &launch, &origin, &storage_backup);
            if let Err(rollback_error) = cookie_rollback.and(storage_rollback) {
                return Err(RuntimeError::new(
                    "SESSION_IMPORT_ROLLBACK_FAILED",
                    format!(
                        "{} Rollback failed: {}",
                        error.message, rollback_error.message
                    ),
                ));
            }
            return Err(error);
        }
        Ok((
            import_cookies.len() as u32,
            NativeSessionBackup {
                cookies: cookie_backup,
                local_storage: storage_backup,
                storage_touched: true,
            },
        ))
    }

    fn snapshot_role_session_transfer(
        &self,
        transaction_id: &str,
        role_id: &str,
        launch_url: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
        replace_existing: bool,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        if self.state()?.has_native_role_surface(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before importing browser session data.",
            ));
        }
        let launch = checked_web_url(launch_url)?;
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let (window, webview, navigation, lifecycle) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let result = (|| {
            let cookies = cookies_for_launch(&webview, &launch)?;
            let local_storage = if replace_existing {
                navigation.reset();
                webview
                    .navigate(launch.clone())
                    .map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("SESSION_IMPORT_SNAPSHOT_LOAD_FAILED", message)
                })?;
                require_exact_webview_origin(&webview, &origin)?;
                read_local_storage_entries(&webview)?
            } else {
                Vec::new()
            };
            let backup = NativeSessionBackup {
                cookies,
                local_storage,
                storage_touched: replace_existing,
            };
            self.persist_session_backup(transaction_id, &backup)?;
            self.state()?
                .session_import_backups
                .insert(transaction_id.to_owned(), backup);
            Ok(())
        })();
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
    }

}

fn macos_high_refresh_rate_enabled(
    mode: MacosHighRefreshMode,
    display_refresh_rate_hz: Option<f64>,
) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    macos_high_refresh_mode_requests(mode, display_refresh_rate_hz)
}

fn macos_high_refresh_mode_requests(
    mode: MacosHighRefreshMode,
    display_refresh_rate_hz: Option<f64>,
) -> bool {
    match mode {
        MacosHighRefreshMode::Auto => display_refresh_rate_hz.is_some_and(|rate| rate > 60.0),
        MacosHighRefreshMode::Enabled => true,
        MacosHighRefreshMode::Disabled => false,
    }
}
