impl AppCore {
    fn persist_acknowledged_runtime_window_presentation(
        &self,
        snapshot: &crate::RuntimeSnapshot,
        window_id: &str,
        window_generation: u64,
        revision: u64,
    ) -> CoreResult<bool> {
        let window = snapshot.windows.get(window_id).ok_or_else(|| {
            runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_SNAPSHOT_MISSING",
                "The acknowledged presentation has no captured logical window.",
            )
        })?;
        if window.window_generation != window_generation || window.revision != revision {
            return Err(runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_SNAPSHOT_STALE",
                "The captured presentation does not match its acknowledged Core revision.",
            ));
        }
        let saved = self.read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?;
        let Some(saved) = saved.iter().find(|saved| saved.id == window_id) else {
            // Changing an unsaved host must not create a saved Game Window.
            return Ok(true);
        };
        let placement = window.placement.clone().ok_or_else(|| {
            runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_CONTEXT_MISSING",
                "The acknowledged presentation has no captured placement.",
            )
        })?;
        let target_display = window.target_display.clone().ok_or_else(|| {
            runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_CONTEXT_MISSING",
                "The acknowledged presentation has no captured display.",
            )
        })?;
        let ownership = snapshot
            .browser_runtime
            .tabs
            .iter()
            .map(|tab| (tab.id.as_str(), tab))
            .collect();
        let batch = self.commit_runtime_window_snapshot_batch_inner(vec![
            GameWindowRuntimeSnapshotCommitInputRecord {
                snapshot: runtime_window_tab_snapshot(window, &ownership),
                name: saved.name.clone(),
                target_display,
                placement,
            },
        ])?;
        let receipt = batch.receipts.first().ok_or_else(|| {
            runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_PERSISTENCE_RECEIPT_MISSING",
                "The acknowledged presentation has no persistence receipt.",
            )
        })?;
        if receipt.window_id != window_id
            || receipt.window_generation != window_generation
            || receipt.revision != revision
        {
            return Err(runtime_ui_error(
                "RUNTIME_WINDOW_PRESENTATION_PERSISTENCE_RECEIPT_INVALID",
                "The presentation persistence receipt lost its exact Core fence.",
            ));
        }
        if receipt.status == "applied" {
            return Ok(true);
        }
        let revisions = self
            .runtime_window_persistence_revisions
            .lock()
            .map_err(|_| {
                CoreError::Internal("runtime window persistence revision lock poisoned".to_owned())
            })?;
        if receipt.status == "superseded"
            && revisions
                .get(window_id)
                .is_some_and(|(saved_generation, saved_revision)| {
                    *saved_generation > window_generation
                        || (*saved_generation == window_generation && *saved_revision > revision)
                })
        {
            return Ok(false);
        }
        Err(runtime_ui_error(
            "RUNTIME_WINDOW_PRESENTATION_PERSISTENCE_NOT_VERIFIED",
            "The acknowledged presentation has no applied or strictly newer durable revision.",
        ))
    }

    fn apply_runtime_window_presentation_action(
        &self,
        operation_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
        presentation: String,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&window_id])?;
        match self.platform {
            rion_platform::Platform::Windows
                if matches!(presentation.as_str(), "normal" | "maximized" | "fullscreen") => {}
            rion_platform::Platform::Windows => {
                return Err(runtime_ui_error(
                    "RUNTIME_WINDOW_PRESENTATION_INVALID",
                    "Only the fenced Windows Chromium host may submit this presentation action.",
                ));
            }
            rion_platform::Platform::Macos
                if matches!(presentation.as_str(), "normal" | "fullscreen") => {}
            rion_platform::Platform::Macos if presentation == "maximized" => {
                return Err(runtime_ui_error(
                    "RUNTIME_WINDOW_PRESENTATION_INVALID",
                    "The retained macOS AppKit Chromium host supports normal and fullscreen presentation, not maximized presentation.",
                ));
            }
            rion_platform::Platform::Macos => {
                return Err(runtime_ui_error(
                    "RUNTIME_WINDOW_PRESENTATION_INVALID",
                    "The retained macOS AppKit Chromium host supports only normal and fullscreen presentation.",
                ));
            }
        }
        let fingerprint = format!(
            "presentation:{window_id}:{window_generation}:{topology_revision}:{presentation}"
        );
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_runtime_ui_action(&operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot.windows.get(&window_id).cloned() else {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "toggleGameWindowFullscreen",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                window_id,
                tab_id: None,
                window_generation,
                topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        };
        if window.window_generation != window_generation
            || window.revision != topology_revision
            || window.placement.is_none()
            || window.target_display.is_none()
        {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "toggleGameWindowFullscreen",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                window_id,
                tab_id: None,
                window_generation,
                topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        }
        let prior_placement = window.placement.expect("validated placement");
        let already_applied = prior_placement.presentation == presentation;
        let native = self.run_embedded_runtime_effect(
            &window_id,
            CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
                window_id: window_id.clone(),
                window_generation,
                topology_revision,
                presentation: presentation.clone(),
            },
            Some(CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
                window_id: window_id.clone(),
                window_generation,
                topology_revision,
                presentation: prior_placement.presentation.clone(),
            }),
            Some(&operation_id),
        );
        let mut persistence_result = None;
        let (mut status, mut stage, mut failure_code, applied_revision) = match native {
            Ok(_) => {
                let (commit, captured) = {
                    // Capture placement, tabs and ownership at this exact commit. Launch
                    // completion may advance Kernel revisions outside the UI lane.
                    let _authority_guard =
                        self.runtime_authority_barrier.write().map_err(|_| {
                            CoreError::Internal("runtime authority barrier poisoned".to_owned())
                        })?;
                    let commit = self.browser_runtime.apply(
                        crate::RuntimeIntent::SetWindowPresentation {
                            operation_id: format!("{operation_id}:commit-presentation"),
                            expected_revision: topology_revision,
                            presentation,
                            window_generation,
                            window_id: window_id.clone(),
                        },
                    )?;
                    (commit, self.browser_runtime.snapshot()?)
                };
                if commit.status == crate::RuntimeCommitStatus::Superseded {
                    let current = self
                        .browser_runtime
                        .snapshot()?
                        .windows
                        .get(&window_id)
                        .cloned();
                    let compensation = current.and_then(|current| {
                        current
                            .placement
                            .clone()
                            .map(|placement| (current, placement))
                    });
                    let Some((current, current_placement)) = compensation else {
                        return self.retain_runtime_ui_action(
                            operation_id.clone(),
                            fingerprint,
                            runtime_ui_action_summary(
                                self.platform,
                                RuntimeUiSummaryInput {
                                    accepted_at,
                                    started,
                                    operation_id,
                                    trigger: "toggleGameWindowFullscreen",
                                    subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                                    completion_scope: crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
                                    status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                                    stage: "runtimeWindowPresentationCompensationStateMissing",
                                    window_id,
                                    tab_id: None,
                                    window_generation,
                                    topology_revision: commit.revision,
                                    failure_code: Some(
                                        "RUNTIME_WINDOW_PRESENTATION_COMPENSATION_STATE_MISSING".to_owned(),
                                    ),
                                },
                            ),
                        );
                    };
                    let reverse = self.run_embedded_runtime_effect(
                        &window_id,
                        CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
                            window_id: window_id.clone(),
                            window_generation: current.window_generation,
                            topology_revision: current.revision,
                            presentation: current_placement.presentation,
                        },
                        None,
                        Some(&operation_id),
                    );
                    match reverse {
                        Ok(_) => match self.project_embedded_runtime_snapshot_without_persistence(
                            Some(&operation_id),
                        ) {
                            Ok(_) => (
                                crate::model::SystemRuntimeOperationStatus::Failed,
                                "runtimeWindowPresentationCommitSupersededCompensated",
                                Some("RUNTIME_WINDOW_PRESENTATION_COMMIT_STALE".to_owned()),
                                current.revision,
                            ),
                            Err(error) => (
                                crate::model::SystemRuntimeOperationStatus::Indeterminate,
                                "runtimeWindowPresentationCompensationProjectionFailed",
                                Some(error.code().to_owned()),
                                current.revision,
                            ),
                        },
                        Err(error) => (
                            crate::model::SystemRuntimeOperationStatus::Indeterminate,
                            "runtimeWindowPresentationCompensationFailed",
                            Some(error.code().to_owned()),
                            current.revision,
                        ),
                    }
                } else {
                    // Native acknowledgement and the captured Kernel commit already
                    // establish placement. A later follower projection cannot undo it.
                    persistence_result =
                        Some(self.persist_acknowledged_runtime_window_presentation(
                            &captured,
                            &window_id,
                            window_generation,
                            commit.revision,
                        ));
                    match self
                        .project_embedded_runtime_snapshot_without_persistence(Some(&operation_id))
                    {
                        Ok(_) => (
                            crate::model::SystemRuntimeOperationStatus::Applied,
                            if already_applied {
                                "runtimeWindowPresentationNativeReadbackVerified"
                            } else {
                                "runtimeWindowPresentationApplied"
                            },
                            None,
                            commit.revision,
                        ),
                        Err(error) => (
                            crate::model::SystemRuntimeOperationStatus::Indeterminate,
                            "runtimeWindowPresentationProjectionFailed",
                            Some(error.code().to_owned()),
                            commit.revision,
                        ),
                    }
                }
            }
            Err(error) => (
                if error.code().contains("QUARANTINE") || error.code().contains("UNKNOWN") {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                } else {
                    crate::model::SystemRuntimeOperationStatus::Failed
                },
                "runtimeWindowPresentationFailed",
                Some(error.code().to_owned()),
                topology_revision,
            ),
        };
        if status == crate::model::SystemRuntimeOperationStatus::Applied
            && let Some(persistence) = persistence_result
        {
            match persistence {
                Ok(true) => {}
                Ok(false) => {
                    status = crate::model::SystemRuntimeOperationStatus::Superseded;
                    stage = "runtimeWindowPresentationPersistenceSuperseded";
                }
                Err(error) => {
                    // Native success is already authoritative; failed persistence cannot
                    // reverse the visible presentation or claim it will survive reopening.
                    status = crate::model::SystemRuntimeOperationStatus::Degraded;
                    stage = "runtimeWindowPresentationPersistenceFailed";
                    failure_code = Some(error.code().to_owned());
                }
            }
        }
        let receipt = runtime_ui_action_summary(
            self.platform,
            RuntimeUiSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "toggleGameWindowFullscreen",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                completion_scope:
                    crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
                status,
                stage,
                window_id,
                tab_id: None,
                window_generation,
                topology_revision: applied_revision,
                failure_code,
            },
        );
        self.retain_runtime_ui_action(operation_id, fingerprint, receipt)
    }
}
