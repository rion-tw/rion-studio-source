impl AppCore {
    pub async fn invoke_async(self: &Arc<Self>, command: CoreCommand) -> CoreResult<Value> {
        match command {
            CoreCommand::RoleCreate { input } => {
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let mut roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
                let candidate = crate::domain::create_role(&games, &mut roles, input.clone())?;
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.refresh_local_storage_source_before_binding(&candidate)
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.invoke(CoreCommand::RoleCreate { input }))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::RoleBrowserDataClear { role_id } => {
                self.clear_role_browser_data(role_id).await
            }
            CoreCommand::ChromeProfileRequestQuit { import_id } => {
                let pending = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .get(&import_id)?;
                let platform = self.platform;
                tokio::task::spawn_blocking(move || {
                    rion_platform::request_graceful_chrome_quit(platform)
                        .map_err(|error| CoreError::Platform(error.to_string()))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while rion_platform::chrome_user_data_in_use(&pending.source_user_data_dir)
                    && std::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                let preview = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .refresh(&import_id)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileApply {
                import_id,
                game_id,
                consent_accepted,
                resolutions,
            } => {
                self.apply_chrome_profile_import(import_id, game_id, consent_accepted, resolutions)
                    .await
            }
            CoreCommand::GameDelete { id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_state(StateMutation::GameDelete { id })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::GamesDelete { ids } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_state(StateMutation::GamesDelete { ids })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::RoleUpdate { id, input } => {
                self.update_role_runtime_aware(id, input).await
            }
            CoreCommand::RoleDelete { id } => self.delete_role_runtime_aware(id).await,
            CoreCommand::RolesDelete { ids } => self.delete_roles_runtime_aware(ids).await,
            CoreCommand::WorkspaceCreate { input } => {
                let role_ids = workspace_create_role_ids(&input);
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(role_ids, StateMutation::WorkspaceCreate(input))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::WorkspaceUpdate { id, input } => {
                let mut role_ids = self
                    .state_workspace(&id)?
                    .slots
                    .into_iter()
                    .filter_map(|slot| slot.role_id)
                    .collect::<Vec<_>>();
                role_ids.extend(workspace_update_role_ids(&input));
                role_ids.push(workspace_operation_key(&id));
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(
                        role_ids,
                        StateMutation::WorkspaceUpdate { id, input },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::WorkspaceDelete { id } => self.delete_workspace_runtime_aware(id).await,
            CoreCommand::WorkspacesDelete { ids } => {
                self.delete_workspaces_runtime_aware(ids).await
            }
            CoreCommand::MacroCreate { input } => {
                let role_ids = input.role_ids.clone();
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(role_ids, StateMutation::MacroCreate(input))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacroUpdate { id, input } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.update_macro_runtime_aware(id, input))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacroDelete { id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_macros_runtime_aware(
                        vec![id.clone()],
                        StateMutation::MacroDelete { id },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacrosDelete { ids } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_macros_runtime_aware(
                        ids.clone(),
                        StateMutation::MacrosDelete { ids },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::DiagnosticsExport { path, snapshot } => {
                serde_json::to_value(self.export_diagnostics(path, snapshot).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::OverlayRequest {
                role_id,
                request_json,
                language,
            } => serde_json::to_value(
                self.handle_overlay_request(&role_id, &request_json, language)
                    .await?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserRoleLaunch {
                role_id,
                target,
                zoom_factor,
            } => {
                let launch_started = std::time::Instant::now();
                eprintln!(
                    "Core launch phase: role-session-preflight completed elapsedMs={}",
                    launch_started.elapsed().as_millis()
                );
                let statuses = self
                    .accept_browser_role_launch(role_id, target, zoom_factor.unwrap_or(1.0))
                    .await?;
                serde_json::to_value(statuses)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id,
                target,
            } => {
                let statuses = self
                    .accept_browser_workspace_launch(workspace_id, target)
                    .await?;
                serde_json::to_value(statuses)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRoleStop { role_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_role(&role_id))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserWorkspaceStop { workspace_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_workspace(&workspace_id))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserWindowStop { window_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_window(&window_id, false))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserWindowDelete { window_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_window(&window_id, true))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "deleted": true }))
            }
            command => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.invoke(command))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
        }
    }

    async fn apply_chrome_profile_import(
        self: &Arc<Self>,
        import_id: String,
        game_id: String,
        consent_accepted: bool,
        resolutions: Vec<ChromeProfileImportResolutionRecord>,
    ) -> CoreResult<Value> {
        if !consent_accepted {
            return Err(CoreError::Domain {
                code: "CONSENT_REQUIRED",
                message: "Consent is required before importing Chrome profile data.".to_owned(),
            });
        }
        let pending = self
            .chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .get(&import_id)?;
        if rion_platform::chrome_user_data_in_use(&pending.source_user_data_dir) {
            return Err(CoreError::Domain {
                code: "CHROME_RUNNING",
                message: "Chrome is still using the selected profile.".to_owned(),
            });
        }
        if resolutions.is_empty() {
            return Err(CoreError::Domain {
                code: "PROFILE_SELECTION_EMPTY",
                message: "Select at least one Chrome profile to import.".to_owned(),
            });
        }
        let game = self.state_game(&game_id)?;
        let profiles = pending
            .profiles
            .iter()
            .map(|profile| (profile.id.as_str(), profile.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut seen_profiles = std::collections::HashSet::new();
        let mut seen_targets = std::collections::HashSet::new();
        for resolution in &resolutions {
            if !seen_profiles.insert(resolution.profile_id().to_owned())
                || !profiles.contains_key(resolution.profile_id())
            {
                return Err(CoreError::Domain {
                    code: "PROFILE_SELECTION_INVALID",
                    message: "Chrome profile selection is invalid.".to_owned(),
                });
            }
            if let ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } = resolution
                && !seen_targets.insert(target_role_id.clone())
            {
                return Err(CoreError::Domain {
                    code: "ROLE_TARGET_CONFLICT",
                    message: "Multiple Chrome profiles cannot replace the same role.".to_owned(),
                });
            }
        }
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let mut used_names = roles
            .iter()
            .filter(|role| role.game_id == game.id)
            .map(|role| role.name.to_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut final_names = std::collections::HashSet::new();
        for resolution in &resolutions {
            let profile = profiles
                .get(resolution.profile_id())
                .expect("validated Chrome profile");
            let base_name = crate::chrome_profile_import::normalized_profile_name(
                &profile.name,
                &profile.directory_name,
            );
            let final_name = match resolution {
                ChromeProfileImportResolutionRecord::Create { .. } => {
                    if used_names.contains(&base_name.to_lowercase()) {
                        return Err(CoreError::Domain {
                            code: "ROLE_CONFLICT_RESOLUTION_REQUIRED",
                            message: "Choose how to handle each matching role.".to_owned(),
                        });
                    }
                    base_name
                }
                ChromeProfileImportResolutionRecord::Copy { .. } => {
                    crate::chrome_profile_import::copy_role_name(&base_name, &used_names)
                }
                ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } => roles
                    .iter()
                    .find(|role| role.id == *target_role_id && role.game_id == game.id)
                    .map(|role| role.name.clone())
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_TARGET_INVALID",
                        message: "The role selected for replacement is invalid.".to_owned(),
                    })?,
            };
            let normalized = final_name.to_lowercase();
            if !final_names.insert(normalized.clone()) {
                return Err(CoreError::Domain {
                    code: "FINAL_ROLE_NAME_CONFLICT",
                    message: "Multiple Chrome profiles cannot produce the same role name."
                        .to_owned(),
                });
            }
            used_names.insert(normalized);
        }

        self.chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .begin(&import_id)?;

        let total = resolutions.len() as u32;
        let mut items = Vec::with_capacity(resolutions.len());
        for (index, resolution) in resolutions.into_iter().enumerate() {
            if self.chrome_import_cancel_requested(&import_id)? {
                break;
            }
            let profile = profiles
                .get(resolution.profile_id())
                .expect("validated Chrome profile")
                .clone();
            let source_fingerprint = pending
                .source_fingerprints
                .get(&profile.id)
                .expect("validated Chrome profile fingerprint")
                .clone();
            self.emit_chrome_import_progress(
                &import_id,
                Some(&profile.id),
                "copying",
                index as u32,
                total,
            );
            let outcome = self
                .apply_one_chrome_profile(
                    &import_id,
                    &pending.source_user_data_dir,
                    &game,
                    profile.clone(),
                    &source_fingerprint,
                    resolution,
                )
                .await;
            let cancelled = outcome
                .as_ref()
                .is_err_and(|error| error.code() == "IMPORT_CANCELLED");
            let item = match outcome {
                Ok(item) => item,
                Err(error) => ChromeProfileImportItemResultRecord {
                    profile_id: profile.id.clone(),
                    role_id: None,
                    role_name: crate::chrome_profile_import::normalized_profile_name(
                        &profile.name,
                        &profile.directory_name,
                    ),
                    status: if cancelled { "cancelled" } else { "failed" }.to_owned(),
                    auth_state: ChromeProfileImportAuthStateRecord::NotApplicable,
                    cookie_count: 0,
                    local_storage_count: 0,
                    unsupported: ChromeProfileImportUnsupportedCountsRecord::default(),
                    warnings: Vec::new(),
                    error_code: Some(error.code().to_owned()),
                },
            };
            items.push(item);
            self.emit_chrome_import_progress(
                &import_id,
                Some(&profile.id),
                "complete",
                (index + 1) as u32,
                total,
            );
            if cancelled || self.chrome_import_cancel_requested(&import_id)? {
                break;
            }
        }
        self.chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .finish(&import_id);
        serde_json::to_value(ChromeProfileImportResultRecord { import_id, items })
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub async fn recover_pending_chrome_profile_imports(self: &Arc<Self>) -> CoreResult<Value> {
        let journals = self.with_runtime(|runtime| runtime.state.operation_journals())?;
        let mut recovered = 0_u32;
        let mut pending = 0_u32;
        for journal in journals
            .into_iter()
            .filter(|journal| journal.kind == "chrome_profile_import_v2")
        {
            let Some(role_id) = journal.payload.get("roleId").and_then(Value::as_str) else {
                pending += 1;
                continue;
            };
            let Some(transaction_id) = journal.payload.get("transactionId").and_then(Value::as_str)
            else {
                pending += 1;
                continue;
            };
            let transfer_directory = match crate::chrome_profile_import::session_transfer_directory(
                &self.user_data_dir,
                transaction_id,
            ) {
                Ok(path) => path,
                Err(_) => {
                    pending += 1;
                    continue;
                }
            };
            let committed = transfer_directory.join("committed").is_file();
            if !committed && transfer_directory.join("backup.enc").is_file() {
                let Some(launch_url) = journal.payload.get("launchUrl").and_then(Value::as_str)
                else {
                    pending += 1;
                    continue;
                };
                let paths = self.resolve_role_paths(role_id)?;
                if self
                    .request_core_effect(
                        role_id,
                        CoreEffectAction::ChromeProfileImportRollback {
                            transaction_id: transaction_id.to_owned(),
                            role_id: role_id.to_owned(),
                            launch_url: launch_url.to_owned(),
                            webview2_user_data_dir: paths.webview2_user_data_dir,
                            webkit_data_store_identifier: paths.webkit_data_store_identifier,
                        },
                        CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
                    )
                    .await
                    .is_err()
                {
                    pending += 1;
                    continue;
                }
            }
            if !committed
                && journal
                    .payload
                    .get("createdRole")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && self
                    .read_typed_state_collection::<StateRoleRecord>("roles")?
                    .iter()
                    .any(|role| role.id == role_id)
                && self.delete_role_saga(role_id).is_err()
            {
                pending += 1;
                continue;
            }
            self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(journal.id.clone())
            })?;
            if transfer_directory.exists() {
                let _ = fs::remove_dir_all(&transfer_directory);
            }
            recovered += 1;
        }
        self.cleanup_orphaned_session_transfer_directories()?;
        Ok(json!({ "recovered": recovered, "pending": pending }))
    }

    fn cleanup_orphaned_session_transfer_directories(&self) -> CoreResult<()> {
        let active = self
            .with_runtime(|runtime| runtime.state.operation_journals())?
            .into_iter()
            .filter(|journal| journal.kind == "chrome_profile_import_v2")
            .filter_map(|journal| {
                journal
                    .payload
                    .get("transactionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<std::collections::HashSet<_>>();
        let root = self.user_data_dir.join(".session-transfers");
        let metadata = match fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(CoreError::Platform(error.to_string())),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CoreError::Platform(
                "Session-transfer root must be a real directory.".to_owned(),
            ));
        }
        for entry in fs::read_dir(&root).map_err(|error| CoreError::Platform(error.to_string()))? {
            let entry = entry.map_err(|error| CoreError::Platform(error.to_string()))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if uuid::Uuid::parse_str(&name).is_err() || active.contains(&name) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(entry.path())
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            }
        }
        Ok(())
    }

    fn chrome_import_cancel_requested(&self, import_id: &str) -> CoreResult<bool> {
        Ok(self
            .chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .is_cancel_requested(import_id))
    }

    fn ensure_role_session_recovery_complete(&self, role_id: &str) -> CoreResult<()> {
        let pending = self
            .with_runtime(|runtime| runtime.state.operation_journals())?
            .into_iter()
            .any(|journal| {
                journal.kind == "chrome_profile_import_v2"
                    && journal.payload.get("roleId").and_then(Value::as_str) == Some(role_id)
            });
        if pending {
            Err(CoreError::Domain {
                code: "ROLE_SESSION_RECOVERY_REQUIRED",
                message: "This role is waiting for browser session recovery before it can launch."
                    .to_owned(),
            })
        } else {
            Ok(())
        }
    }

    async fn accept_browser_workspace_launch(
        self: &Arc<Self>,
        workspace_id: String,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let completion_permit = self.launch_completion.try_reserve()?;
        for _ in 0..4 {
            let workspace = self.state_workspace(&workspace_id)?;
            let expected_role_ids = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.clone())
                .collect::<Vec<_>>();
            let core = Arc::clone(self);
            let workspace_id = workspace_id.clone();
            let target = target.clone();
            let result = tokio::task::spawn_blocking(move || {
                core.start_embedded_workspace_for_roles(&workspace_id, &expected_role_ids, target)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?;
            match result {
                Err(CoreError::Domain {
                    code: "WORKSPACE_DATA_CHANGED",
                    ..
                }) => continue,
                Ok(EmbeddedWorkspaceLaunchStart::Completed(results)) => {
                    return self.decorate_browser_statuses(
                        results.into_iter().map(embedded_status).collect(),
                    );
                }
                Ok(EmbeddedWorkspaceLaunchStart::Pending(pending)) => {
                    let accepted_at = Instant::now();
                    let accepted = pending
                        .role_ids
                        .iter()
                        .cloned()
                        .map(launching_browser_status)
                        .collect();
                    let core = Arc::clone(self);
                    completion_permit.send(Box::pin(async move {
                        let PendingEmbeddedWorkspaceLaunch {
                            handle,
                            lease_id,
                            role_ids,
                            roles,
                            tab_id,
                            target,
                            title,
                            window_id,
                            workspace_id,
                        } = *pending;
                        let completion_tab_id = tab_id.clone();
                        let completion_source_id = workspace_id.clone();
                        let launch = core.finish_system_launch_async(handle, &roles).await;
                        let completion_core = Arc::clone(&core);
                        let completion = tokio::task::spawn_blocking(move || {
                            let result = completion_core.commit_embedded_workspace_launch_outcome(
                                role_ids,
                                tab_id,
                                workspace_id,
                                launch,
                            );
                            let lease_completion =
                                completion_core.browser_operations.complete(&lease_id);
                            match (result, lease_completion) {
                                (Ok(value), Ok(())) => Ok(value),
                                (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                            }
                        })
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))
                        .and_then(|result| result);
                        if let Err(error) = &completion {
                            eprintln!(
                                "Background workspace launch failed after acceptance: {error}"
                            );
                        }
                        core.notify_browser_launch_completion(BrowserLaunchCompletionRecord {
                            accepted_at,
                            error: completion.as_ref().err().map(|error| error.payload()),
                            source_id: completion_source_id,
                            tab_id: completion_tab_id,
                            tab_type: "workspace".to_owned(),
                            target,
                            title,
                            window_id,
                            zoom_factor: None,
                        });
                        core.emit_browser_statuses();
                    }));
                    return Ok(accepted);
                }
                Err(error) => return Err(error),
            }
        }
        Err(CoreError::Domain {
            code: "WORKSPACE_DATA_CHANGED",
            message: "The launch workspace kept changing while launch was waiting.".to_owned(),
        })
    }

}
