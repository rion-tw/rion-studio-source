impl AppCore {
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
                if matches!(presentation.as_str(), "normal" | "maximized" | "fullscreen") =>
            {
            }
            rion_platform::Platform::Windows => {
                return Err(runtime_ui_error(
                    "RUNTIME_WINDOW_PRESENTATION_INVALID",
                    "Only the fenced Windows Chromium host may submit this presentation action.",
                ));
            }
            rion_platform::Platform::Macos
                if matches!(presentation.as_str(), "normal" | "fullscreen") =>
            {
            }
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
        let (status, stage, failure_code, applied_revision) = match native {
            Ok(_) if already_applied => (
                crate::model::SystemRuntimeOperationStatus::Applied,
                "runtimeWindowPresentationNativeReadbackVerified",
                None,
                topology_revision,
            ),
            Ok(_) => {
                let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitPlacement(
                    crate::RuntimeWindowPlacementCommitInput {
                        operation_id: format!("{operation_id}:commit-presentation"),
                        placement: crate::model::GameWindowPlacementRecord {
                            normal_bounds: prior_placement.normal_bounds,
                            saved_work_area: prior_placement.saved_work_area,
                            presentation,
                        },
                        placement_sequence: window.placement_sequence.saturating_add(1).max(1),
                        source: "chromiumWindowsHost".to_owned(),
                        target_display: window.target_display.expect("validated display"),
                        window_generation,
                        window_id: window_id.clone(),
                    },
                ))?;
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
                    match self
                        .project_embedded_runtime_snapshot_without_persistence(Some(&operation_id))
                    {
                        Ok(_) => (
                            crate::model::SystemRuntimeOperationStatus::Applied,
                            "runtimeWindowPresentationApplied",
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
