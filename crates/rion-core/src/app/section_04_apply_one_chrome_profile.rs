impl AppCore {
    async fn apply_one_chrome_profile(
        self: &Arc<Self>,
        import_id: &str,
        source_user_data_dir: &std::path::Path,
        game: &StateGameRecord,
        profile: crate::model::ChromeProfileEntryRecord,
        expected_source_fingerprint: &str,
        resolution: ChromeProfileImportResolutionRecord,
    ) -> CoreResult<ChromeProfileImportItemResultRecord> {
        if rion_platform::chrome_user_data_in_use(source_user_data_dir) {
            return Err(CoreError::Domain {
                code: "CHROME_RUNNING",
                message: "Chrome started using the selected profile before it could be imported."
                    .to_owned(),
            });
        }
        let current_fingerprint = rion_platform::chrome_profile_source_fingerprint(
            source_user_data_dir,
            &profile.directory_name,
        )
        .map_err(|error| CoreError::Platform(error.to_string()))?;
        if current_fingerprint != expected_source_fingerprint {
            return Err(CoreError::Domain {
                code: "SOURCE_CHANGED",
                message:
                    "Chrome profile data changed after preview. Preview it again before importing."
                        .to_owned(),
            });
        }
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let base_name = crate::chrome_profile_import::normalized_profile_name(
            &profile.name,
            &profile.directory_name,
        );
        let identity_match = roles
            .iter()
            .find(|role| role.game_id == game.id && role.name.eq_ignore_ascii_case(&base_name));
        let (role_name, existing_role, replace_existing) = match &resolution {
            ChromeProfileImportResolutionRecord::Create { .. } => {
                if identity_match.is_some() {
                    return Err(CoreError::Domain {
                        code: "ROLE_CONFLICT_RESOLUTION_REQUIRED",
                        message: "Choose how to handle the matching role.".to_owned(),
                    });
                }
                (base_name.clone(), None, false)
            }
            ChromeProfileImportResolutionRecord::Copy { .. } => {
                let used = roles
                    .iter()
                    .filter(|role| role.game_id == game.id)
                    .map(|role| role.name.to_lowercase())
                    .collect::<std::collections::HashSet<_>>();
                (
                    crate::chrome_profile_import::copy_role_name(&base_name, &used),
                    None,
                    false,
                )
            }
            ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } => {
                let role = roles
                    .iter()
                    .find(|role| role.id == *target_role_id && role.game_id == game.id)
                    .cloned()
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_TARGET_INVALID",
                        message: "The role selected for replacement is invalid.".to_owned(),
                    })?;
                if self
                    .browser_statuses()?
                    .iter()
                    .any(|status| status.role_id == role.id)
                {
                    return Err(CoreError::Domain {
                        code: "ROLE_BROWSER_DATA_IN_USE",
                        message: "Stop the role before replacing its session.".to_owned(),
                    });
                }
                (role.name.clone(), Some(role), true)
            }
        };
        let launch_url = existing_role
            .as_ref()
            .map(|role| role.launch_url.clone())
            .unwrap_or_else(|| game.default_launch_url.clone());
        let creates_role = existing_role.is_none();
        let role_id = existing_role
            .as_ref()
            .map(|role| role.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let operation_guard = BrowserOperationGuard::new(&self.browser_operations, lease.id);
        let paths = self.resolve_role_paths(&role_id)?;
        let auth_probe = chrome_import_auth_probe(game);
        if replace_existing && let Some(probe) = auth_probe {
            self.emit_chrome_import_progress(import_id, Some(&profile.id), "verifying", 0, 1);
            let auth_state = self
                .verify_chrome_import_auth(&role_id, &paths, probe)
                .await;
            if auth_state == ChromeProfileImportAuthStateRecord::Authenticated {
                operation_guard.complete()?;
                return Ok(ChromeProfileImportItemResultRecord {
                    profile_id: profile.id,
                    role_id: Some(role_id),
                    role_name,
                    status: "alreadyAuthenticated".to_owned(),
                    auth_state,
                    cookie_count: 0,
                    local_storage_count: 0,
                    unsupported: ChromeProfileImportUnsupportedCountsRecord::default(),
                    warnings: Vec::new(),
                    error_code: None,
                });
            }
        }
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let staging = crate::chrome_profile_import::session_transfer_directory(
            &self.user_data_dir,
            &transaction_id,
        )?;
        let source = source_user_data_dir.to_path_buf();
        let profile_directory = profile.directory_name.clone();
        let expected_source_fingerprint = expected_source_fingerprint.to_owned();
        let encrypted_staging = staging.clone();
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "copying", 0, 1);
        let platform = self.platform;
        let launch_for_parse = launch_url.clone();
        let include_all_cookie_paths = auth_probe.is_some();
        let parsed = tokio::task::spawn_blocking(move || {
            let parsed = crate::session_import::read_chrome_session_transfer(
                &source,
                &profile_directory,
                platform,
                &launch_for_parse,
                include_all_cookie_paths,
            )?;
            let current_fingerprint =
                rion_platform::chrome_profile_source_fingerprint(&source, &profile_directory)
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            if current_fingerprint != expected_source_fingerprint {
                return Err(CoreError::Domain {
                    code: "SOURCE_CHANGED",
                    message: "Chrome profile data changed while it was being read.".to_owned(),
                });
            }
            let serialized = serde_json::to_vec(&parsed.payload)
                .map_err(|error| CoreError::Internal(error.to_string()))?;
            let protected = rion_platform::protect_session_transfer(platform, &serialized)
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            crate::chrome_profile_import::persist_encrypted_staging(
                &encrypted_staging,
                &protected,
            )?;
            Ok::<_, CoreError>(parsed)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))??;
        if self.chrome_import_cancel_requested(import_id)? {
            let _ = fs::remove_dir_all(&staging);
            return Err(chrome_import_cancelled());
        }
        if parsed.payload.cookies.is_empty() && parsed.payload.local_storage.is_empty() {
            let _ = fs::remove_dir_all(&staging);
            return Err(CoreError::Domain {
                code: "PROFILE_SESSION_EMPTY",
                message: "No transferable session data was found for this game.".to_owned(),
            });
        }

        let operation_id = format!("chrome-profile-import-{transaction_id}");
        let mut journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "chrome_profile_import_v2".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({
                "importId": import_id,
                "profileId": profile.id,
                "roleId": role_id,
                "createdRole": creates_role,
                "transactionId": transaction_id,
                "launchUrl": launch_url,
                "sourceFingerprint": parsed.source_fingerprint,
            }),
        };
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        let rollback = ChromeImportRollbackContext {
            operation_id: operation_id.clone(),
            transaction_id: transaction_id.clone(),
            role_id: role_id.clone(),
            launch_url: launch_url.clone(),
            webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
            webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
            staging: staging.clone(),
        };
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "backingUp", 0, 1);
        if let Err(error) = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportSnapshot {
                    transaction_id: transaction_id.clone(),
                    role_id: role_id.clone(),
                    launch_url: launch_url.clone(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                    replace_existing,
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await
        {
            let _ = self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(operation_id.clone())
            });
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        journal.phase = "snapshotted".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(chrome_import_cancelled());
        }
        journal.phase = "applying".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "applying", 0, 1);
        let effect = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportApply {
                    transaction_id: transaction_id.clone(),
                    role_id: role_id.clone(),
                    launch_url: launch_url.clone(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                    replace_existing,
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await;
        if let Err(error) = effect {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(error);
        }
        let auth_state = if let Some(probe) = auth_probe {
            self.emit_chrome_import_progress(import_id, Some(&profile.id), "verifying", 0, 1);
            self.verify_chrome_import_auth_after_apply(&role_id, &paths, probe)
                .await
        } else {
            ChromeProfileImportAuthStateRecord::NotApplicable
        };
        journal.phase = "verified".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(chrome_import_cancelled());
        }

        let created_role_id = if creates_role {
            let created = self.mutate_state(StateMutation::RoleCreateWithId {
                id: role_id.clone(),
                input: crate::model::RoleCreateInputRecord {
                    game_id: game.id.clone(),
                    name: role_name.clone(),
                    launch_url: Some(launch_url.clone()),
                    notes: Some("Imported from a local Chrome profile.".to_owned()),
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            });
            match created {
                Ok(_) => Some(role_id.clone()),
                Err(error) => {
                    self.rollback_chrome_profile_import_item(&rollback, None)
                        .await?;
                    return Err(error);
                }
            }
        } else {
            None
        };
        journal.phase = "metadataCommitted".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, created_role_id.as_deref())
                .await?;
            return Err(chrome_import_cancelled());
        }
        journal.phase = "committing".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
        if let Err(error) = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportCommit {
                    transaction_id: transaction_id.clone(),
                },
                Duration::from_secs(10),
            )
            .await
        {
            self.rollback_chrome_profile_import_item(&rollback, created_role_id.as_deref())
                .await?;
            return Err(error);
        }
        let mut warnings = parsed.warnings;
        finalize_chrome_import_post_commit(
            &mut warnings,
            || self.with_runtime(|runtime| runtime.state.delete_operation_journal(operation_id)),
            || fs::remove_dir_all(&staging),
            || operation_guard.complete(),
        );
        let status = chrome_import_status(auth_state);
        Ok(ChromeProfileImportItemResultRecord {
            profile_id: profile.id,
            role_id: Some(role_id),
            role_name,
            status: status.to_owned(),
            auth_state,
            cookie_count: parsed.payload.cookies.len() as u32,
            local_storage_count: parsed.payload.local_storage.len() as u32,
            unsupported: parsed.unsupported,
            warnings,
            error_code: None,
        })
    }

    async fn verify_chrome_import_auth(
        &self,
        role_id: &str,
        paths: &RolePathsRecord,
        probe: ChromeImportAuthProbe,
    ) -> ChromeProfileImportAuthStateRecord {
        let effect = self
            .request_core_effect(
                role_id,
                CoreEffectAction::ChromeProfileImportVerify {
                    role_id: role_id.to_owned(),
                    verification_url: probe.verification_url.to_owned(),
                    authenticated_path: probe.authenticated_path.to_owned(),
                    login_path: probe.login_path.to_owned(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await;
        match effect.and_then(|result| effect_value::<ChromeImportAuthProbeResult>(&result)) {
            Ok(result) => result.auth_state,
            Err(_) => ChromeProfileImportAuthStateRecord::Indeterminate,
        }
    }

    async fn verify_chrome_import_auth_after_apply(
        &self,
        role_id: &str,
        paths: &RolePathsRecord,
        probe: ChromeImportAuthProbe,
    ) -> ChromeProfileImportAuthStateRecord {
        let mut auth_state = self.verify_chrome_import_auth(role_id, paths, probe).await;
        for delay in CHROME_PROFILE_IMPORT_AUTH_RETRY_DELAYS {
            if auth_state != ChromeProfileImportAuthStateRecord::NotAuthenticated {
                break;
            }
            tokio::time::sleep(delay).await;
            auth_state = self.verify_chrome_import_auth(role_id, paths, probe).await;
        }
        auth_state
    }

    async fn rollback_chrome_profile_import_item(
        self: &Arc<Self>,
        context: &ChromeImportRollbackContext,
        created_role_id: Option<&str>,
    ) -> CoreResult<()> {
        if self
            .request_core_effect(
                &context.role_id,
                CoreEffectAction::ChromeProfileImportRollback {
                    transaction_id: context.transaction_id.clone(),
                    role_id: context.role_id.clone(),
                    launch_url: context.launch_url.clone(),
                    webview2_user_data_dir: context.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: context.webkit_data_store_identifier.clone(),
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await
            .is_err()
        {
            return Err(CoreError::Domain {
                code: "SESSION_IMPORT_ROLLBACK_PENDING",
                message:
                    "The prior browser session is waiting for recovery before this role can launch."
                        .to_owned(),
            });
        }
        if let Some(created_role_id) = created_role_id {
            self.delete_role_saga(created_role_id)?;
        }
        self.with_runtime(|runtime| {
            runtime
                .state
                .delete_operation_journal(context.operation_id.clone())
        })?;
        let _ = fs::remove_dir_all(&context.staging);
        Ok(())
    }

    fn emit_chrome_import_progress(
        &self,
        import_id: &str,
        profile_id: Option<&str>,
        phase: &str,
        completed: u32,
        total: u32,
    ) {
        self.emit(vec![CoreEvent::ChromeProfileImportProgress {
            progress: ChromeProfileImportProgressRecord {
                import_id: import_id.to_owned(),
                profile_id: profile_id.map(str::to_owned),
                phase: phase.to_owned(),
                completed,
                total,
            },
        }]);
    }

    async fn update_role_runtime_aware(
        self: &Arc<Self>,
        id: String,
        input: crate::model::RoleUpdateInputRecord,
    ) -> CoreResult<Value> {
        let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
        let mut roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let current = roles
            .iter()
            .find(|role| role.id == id)
            .cloned()
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_NOT_FOUND",
                message: "Role not found.".to_owned(),
            })?;
        let candidate = crate::domain::update_role(&games, &mut roles, &id, input.clone())?;
        let mut role_ids = vec![id.clone()];
        role_ids.extend(current.local_storage_source_role_id.clone());
        role_ids.extend(candidate.local_storage_source_role_id.clone());
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let games = core.read_typed_state_collection::<StateGameRecord>("games")?;
            let mut roles = core.read_typed_state_collection::<StateRoleRecord>("roles")?;
            let current = roles
                .iter()
                .find(|role| role.id == id)
                .cloned()
                .ok_or_else(|| CoreError::Domain {
                    code: "ROLE_NOT_FOUND",
                    message: "Role not found.".to_owned(),
                })?;
            let candidate = crate::domain::update_role(&games, &mut roles, &id, input.clone())?;
            if candidate.local_storage_source_role_id != current.local_storage_source_role_id {
                core.refresh_local_storage_source_before_binding(&candidate)?;
            }
            if candidate.game_id != current.game_id
                || candidate.launch_url != current.launch_url
            {
                core.stop_embedded_role_under_active_lease(&id)?;
            }
            core.mutate_state(StateMutation::RoleUpdate { id, input })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn refresh_local_storage_source_before_binding(
        &self,
        candidate: &StateRoleRecord,
    ) -> CoreResult<()> {
        let Some(source_id) = candidate.local_storage_source_role_id.as_deref() else {
            return Ok(());
        };
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let source = roles
            .iter()
            .find(|role| role.id == source_id)
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_LOCAL_STORAGE_SOURCE_NOT_FOUND",
                message: "The localStorage source role was not found.".to_owned(),
            })?;
        let game = self.state_game(&candidate.game_id)?;
        self.run_effect_plan(vec![effect_step(
            source_id,
            CoreEffectAction::LocalStorageSyncRefresh {
                source_role_id: source.id.clone(),
                source_launch_url: source.launch_url.clone(),
                origin: crate::domain::launch_origin(&source.launch_url)?,
                keys: game.local_storage_sync_keys,
                selectors: game.local_storage_sync_selectors,
                codec: (game.builtin_key.as_deref() == Some("flyff-universe"))
                    .then(|| "flyff-client-settings-v7".to_owned()),
            },
            Duration::from_secs(45),
            None,
        )])?;
        Ok(())
    }

    async fn delete_role_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        self.ensure_role_exists(&id)?;
        self.cancel_embedded_operations(std::slice::from_ref(&id))?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![id.clone()],
                kind: "destructiveMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            core.stop_embedded_role_under_active_lease(&id)?;
            core.delete_role_saga_under_active_lease(&id)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn delete_roles_runtime_aware(self: &Arc<Self>, ids: Vec<String>) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let existing = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| role.id)
            .collect::<std::collections::HashSet<_>>();
        let mut candidates = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            candidates.push(id);
        }
        if candidates.is_empty() {
            return Ok(json!({ "deletedIds": [], "skipped": skipped }));
        }
        self.cancel_embedded_operations(&candidates)?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: candidates.clone(),
                kind: "destructiveMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let mut eligible = Vec::new();
            for id in candidates {
                match core.stop_embedded_role_under_active_lease(&id) {
                    Ok(()) => eligible.push(id),
                    Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
                }
            }
            let mut result = if eligible.is_empty() {
                json!({ "deletedIds": [], "skipped": [] })
            } else {
                core.delete_roles_saga_under_active_lease(eligible)?
            };
            if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
                result_skipped.extend(skipped);
            }
            Ok::<_, CoreError>(result)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = match &result {
            Ok(value) => {
                let deleted_ids = value
                    .get("deletedIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                self.browser_operations
                    .complete_destructive_with_retained_roles(&lease.id, &deleted_ids)
            }
            Err(_) => self.browser_operations.abort(&lease.id),
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn delete_workspace_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        let workspace =
            serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                "launchWorkspaces",
                "id",
                &id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            )?)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let mut operation_role_ids = workspace
            .slots
            .into_iter()
            .filter_map(|slot| slot.role_id)
            .collect::<Vec<_>>();
        operation_role_ids.extend(
            self.browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .snapshot()
                .workspaces
                .into_iter()
                .find(|workspace| workspace.workspace_id == id)
                .into_iter()
                .flat_map(|workspace| workspace.role_ids),
        );
        operation_role_ids.push(workspace_operation_key(&id));
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: operation_role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            core.stop_embedded_workspace_under_active_lease(&id)?;
            core.mutate_state(StateMutation::WorkspaceDelete { id })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

}
