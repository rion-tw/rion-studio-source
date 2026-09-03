fn browser_tab_audio_role_fences(
    snapshot: &crate::model::BrowserRuntimeSnapshot,
    tab_id: &str,
) -> Vec<crate::model::EmbeddedTabAudioMuteRoleEffectRecord> {
    let mut roles = snapshot
        .roles
        .iter()
        .filter(|role| role.owner.tab_id == tab_id)
        .map(|role| crate::model::EmbeddedTabAudioMuteRoleEffectRecord {
            role_id: role.role_id.clone(),
            owner_generation: role.owner.generation,
        })
        .collect::<Vec<_>>();
    roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
    roles
}

struct BrowserTabAudioSummaryInput {
    platform: rion_platform::Platform,
    operation_id: String,
    accepted_at: String,
    started: Instant,
    tab_id: String,
    window_id: String,
    role_id: Option<String>,
    revision: Option<u64>,
    status: crate::model::SystemRuntimeOperationStatus,
    stage: &'static str,
    failure_code: Option<String>,
    rollback_error_count: Option<u32>,
}

fn browser_tab_audio_summary(
    input: BrowserTabAudioSummaryInput,
) -> crate::model::SystemRuntimeOperationSummaryRecord {
    crate::model::SystemRuntimeOperationSummaryRecord {
        accepted_at: input.accepted_at,
        captured_at: chrono::Utc::now().to_rfc3339(),
        completion_policy: crate::model::OperationCompletionPolicy::EventBound,
        deadline_at: None,
        platform: match input.platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        }
        .to_owned(),
        subsystem: crate::model::SystemRuntimeOperationSubsystem::Audio,
        status: input.status,
        stage: input.stage.to_owned(),
        completion_scope: crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
        operation_id: input.operation_id,
        trigger: "setGameWindowTabMuted".to_owned(),
        elapsed_ms: input
            .started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
        timeout_ms: None,
        revision: input.revision,
        topology_revision: None,
        window_generation: None,
        lifecycle_epoch: None,
        surface_generation: None,
        role_id: input.role_id,
        tab_id: Some(input.tab_id),
        window_id: Some(input.window_id),
        parent_operation_id: None,
        session_id: None,
        failure_code: input.failure_code,
        rollback_error_count: input.rollback_error_count,
    }
}

impl AppCore {
    fn persist_saved_browser_tab_audio_muted(
        &self,
        window_id: &str,
        tab_id: &str,
        muted: bool,
    ) -> CoreResult<bool> {
        let _guard = self.state_mutation_guard()?;
        let Some(mut window) = self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .into_iter()
            .find(|window| window.id == window_id)
        else {
            return Ok(false);
        };
        let Some(tab) = window.tabs.iter_mut().find(|tab| tab.id == tab_id) else {
            return Ok(false);
        };
        if tab.audio_muted == muted {
            return Ok(true);
        }
        tab.audio_muted = muted;
        self.mutate_state_under_guard(StateMutation::GameWindowUpdate {
            id: window_id.to_owned(),
            input: GameWindowUpdateInputRecord {
                tabs: Some(window.tabs),
                ..Default::default()
            },
        })?;
        Ok(true)
    }

    fn browser_tab_audio_identity(
        &self,
        tab_id: &str,
    ) -> CoreResult<(
        crate::model::BrowserRuntimeTabRecord,
        Vec<crate::model::EmbeddedTabAudioMuteRoleEffectRecord>,
    )> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let tab = snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .cloned()
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        if tab.window_id.trim().is_empty() || tab.attempt_generation.as_deref().is_none_or(str::is_empty)
        {
            return Err(CoreError::Domain {
                code: "RUNTIME_TAB_AUDIO_IDENTITY_MISSING",
                message: "Runtime tab audio identity is incomplete.".to_owned(),
            });
        }
        let roles = browser_tab_audio_role_fences(&snapshot, tab_id);
        if roles.is_empty() && tab.web_surfaces.is_empty() {
            return Err(CoreError::Domain {
                code: "RUNTIME_TAB_AUDIO_SURFACES_MISSING",
                message: "Runtime tab has no owned Chromium surface.".to_owned(),
            });
        }
        Ok((tab, roles))
    }

    fn set_browser_tab_audio_muted(
        &self,
        tab_id: String,
        muted: bool,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        if tab_id.trim().is_empty() || tab_id != tab_id.trim() {
            return Err(CoreError::InvalidInput(
                "runtime tab ID is invalid".to_owned(),
            ));
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let parent_operation_id = uuid::Uuid::new_v4().to_string();
        let (queued_tab, queued_roles) = self.browser_tab_audio_identity(&tab_id)?;
        let queued_web_surfaces = queued_tab.web_surfaces.clone();
        let lease = if queued_roles.is_empty() {
            None
        } else {
            Some(self.browser_operations.acquire(BrowserOperationRequest {
                role_ids: queued_roles
                    .iter()
                    .map(|role| role.role_id.clone())
                    .collect(),
                kind: "recoverableMutation".to_owned(),
            })?)
        };

        let result = (|| {
            let (tab, roles) = self.browser_tab_audio_identity(&tab_id)?;
            if tab.window_id != queued_tab.window_id
                || tab.attempt_generation != queued_tab.attempt_generation
                || roles != queued_roles
                || tab.web_surfaces != queued_web_surfaces
            {
                return Ok(browser_tab_audio_summary(BrowserTabAudioSummaryInput {
                    platform: self.platform,
                    operation_id: parent_operation_id.clone(),
                    accepted_at: accepted_at.clone(),
                    started,
                    tab_id: tab_id.clone(),
                    window_id: queued_tab.window_id.clone(),
                    role_id: (queued_roles.len() == 1)
                        .then(|| queued_roles[0].role_id.clone()),
                    revision: None,
                    status: crate::model::SystemRuntimeOperationStatus::Superseded,
                    stage: "audioMuteSuperseded",
                    failure_code: Some("RUNTIME_TAB_AUDIO_STALE".to_owned()),
                    rollback_error_count: None,
                }));
            }
            let attempt_generation = tab.attempt_generation.clone().ok_or_else(|| {
                CoreError::Domain {
                    code: "RUNTIME_TAB_AUDIO_IDENTITY_MISSING",
                    message: "Runtime tab audio identity is incomplete.".to_owned(),
                }
            })?;
            let previous_muted = tab.audio_muted;
            self.invoke_browser_runtime(BrowserRuntimeCommand::SetTabAudioMuted {
                tab_id: tab_id.clone(),
                window_id: tab.window_id.clone(),
                attempt_generation: attempt_generation.clone(),
                expected_audio_muted: previous_muted,
                audio_muted: muted,
                role_generations: roles.clone(),
                web_surfaces: tab.web_surfaces.clone(),
            })?;

            let native = self.run_embedded_runtime_effect(
                &tab_id,
                CoreEffectAction::EmbeddedSetTabAudioMuted {
                    tab_id: tab_id.clone(),
                    window_id: tab.window_id.clone(),
                    attempt_generation: attempt_generation.clone(),
                    roles: roles.clone(),
                    web_surfaces: tab.web_surfaces.clone(),
                    previous_muted,
                    muted,
                },
                None,
                Some(&parent_operation_id),
            );
            if let Err(error) = native {
                let rollback = self.invoke_browser_runtime(
                    BrowserRuntimeCommand::SetTabAudioMuted {
                        tab_id: tab_id.clone(),
                        window_id: tab.window_id.clone(),
                        attempt_generation,
                        expected_audio_muted: muted,
                        audio_muted: previous_muted,
                        role_generations: roles.clone(),
                        web_surfaces: tab.web_surfaces.clone(),
                    },
                );
                let native_is_indeterminate = error.code()
                    == "BROWSER_RUNTIME_AUDIO_ROLLBACK_FAILED";
                let indeterminate = rollback.is_err() || native_is_indeterminate;
                return Ok(browser_tab_audio_summary(BrowserTabAudioSummaryInput {
                    platform: self.platform,
                    operation_id: parent_operation_id.clone(),
                    accepted_at: accepted_at.clone(),
                    started,
                    tab_id: tab_id.clone(),
                    window_id: tab.window_id.clone(),
                    role_id: (roles.len() == 1).then(|| roles[0].role_id.clone()),
                    revision: None,
                    status: if indeterminate {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    },
                    stage: "audioMuteFailed",
                    failure_code: Some(if rollback.is_err() {
                        "RUNTIME_TAB_AUDIO_ROLLBACK_FAILED".to_owned()
                    } else {
                        error.code().to_owned()
                    }),
                    rollback_error_count: indeterminate.then_some(1),
                }));
            }

            let persistence = self.persist_saved_browser_tab_audio_muted(
                &tab.window_id,
                &tab_id,
                muted,
            );
            Ok(browser_tab_audio_summary(BrowserTabAudioSummaryInput {
                platform: self.platform,
                operation_id: parent_operation_id.clone(),
                accepted_at: accepted_at.clone(),
                started,
                tab_id: tab_id.clone(),
                window_id: tab.window_id.clone(),
                role_id: (roles.len() == 1).then(|| roles[0].role_id.clone()),
                revision: None,
                status: if persistence.is_ok() {
                    crate::model::SystemRuntimeOperationStatus::Applied
                } else {
                    crate::model::SystemRuntimeOperationStatus::Degraded
                },
                stage: if persistence.is_ok() {
                    "audioMuteApplied"
                } else {
                    "audioMutePersistenceDegraded"
                },
                failure_code: persistence
                    .is_err()
                    .then(|| "RUNTIME_TAB_AUDIO_PERSIST_FAILED".to_owned()),
                rollback_error_count: None,
            }))
        })();

        let completed = lease
            .as_ref()
            .map_or(Ok(()), |lease| self.browser_operations.complete(&lease.id));
        match (result, completed) {
            (Ok(summary), Ok(())) => Ok(summary),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }
}
