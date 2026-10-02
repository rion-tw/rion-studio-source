impl AppCore {
    fn execute_runtime_role_zoom_native(
        &self,
        request: &crate::model::RuntimeRoleZoomRequestRecord,
        zoom_factor: f64,
        window_zoom_factor: f64,
    ) -> CoreResult<()> {
        let outcome = self.run_embedded_runtime_effect(
            &request.window_id,
            CoreEffectAction::EmbeddedSetRuntimeRoleZoom {
                request: request.clone(), zoom_factor, window_zoom_factor,
            },
            None,
            Some(&request.operation_id),
        )?;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct NativeReceipt {
            request: crate::model::RuntimeRoleZoomRequestRecord,
            zoom_factor: f64,
        }
        let observed = outcome.results.first().and_then(|result| result.value_json.as_deref())
            .and_then(|value| serde_json::from_str::<NativeReceipt>(value).ok());
        if outcome.results.len() != 1 || !observed.is_some_and(|receipt|
            receipt.request == *request && receipt.zoom_factor == zoom_factor) {
            return Err(runtime_ui_error("RUNTIME_ROLE_ZOOM_RECEIPT_INVALID",
                "Chromium did not return the exact Role zoom readback."));
        }
        Ok(())
    }

    fn apply_runtime_role_zoom_action(
        &self,
        request: crate::model::RuntimeRoleZoomRequestRecord,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        use crate::model::{SystemRuntimeOperationStatus as Status,
            SystemRuntimeOperationSubsystem as Subsystem};
        self.validate_runtime_ui_action_identity(&request.operation_id,
            &[&request.window_id, &request.tab_id, &request.role_id])?;
        if !matches!(request.action.as_str(), "in" | "out" | "reset")
            || !request.previous_zoom_factor.is_finite()
            || !(0.25..=5.0).contains(&request.previous_zoom_factor)
            || request.surface_generation == 0 || request.owner_generation == 0 {
            return Err(runtime_ui_error("RUNTIME_ROLE_ZOOM_INVALID", "Invalid Role zoom observation."));
        }
        let fingerprint = format!("role-zoom:{}", serde_json::to_string(&request)
            .map_err(|error| CoreError::Internal(error.to_string()))?);
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_runtime_ui_action(&request.operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let before = self.browser_runtime.snapshot()?;
        let window = before.windows.get(&request.window_id);
        let slot = window.and_then(|window| window.tabs.iter().find(|tab| tab.id == request.tab_id))
            .and_then(|tab| tab.role_slots.iter().find(|slot| slot.role_id == request.role_id));
        let exact = window.is_some_and(|window|
            window.window_generation == request.window_generation && window.revision == request.topology_revision
            && window.selected_tab_id.as_deref() == Some(request.tab_id.as_str())
            && !window.tab_is_hidden(&request.tab_id))
            && slot.is_some_and(|slot| slot.browser_zoom_percent.is_none_or(|percent|
                (percent / 100.0 - request.previous_zoom_factor).abs() < 1e-9))
            && before.browser_runtime.roles.iter().any(|role|
                role.role_id == request.role_id && role.owner.tab_id == request.tab_id
                && role.owner.generation == request.owner_generation);
        let mut revision = window.map_or(request.topology_revision, |window| window.revision);
        let (status, failure_code) = if !exact {
            (Status::Superseded, Some("RUNTIME_ROLE_ZOOM_STALE".to_owned()))
        } else {
            let window_factor = window.unwrap().window_zoom_factor.unwrap_or(1.0);
            let next = runtime_window_zoom_factor(request.previous_zoom_factor, &request.action);
            let native = self.execute_runtime_role_zoom_native(&request, next, window_factor);
            match native {
                Err(error) if error.code() != "RUNTIME_ROLE_ZOOM_RECEIPT_INVALID" => (
                    if error.code().contains("INDETERMINATE") || error.code().contains("UNKNOWN") {
                        Status::Indeterminate
                    } else { Status::Failed }, Some(error.code().to_owned())),
                result => {
                    let committed = result.and_then(|()| self.apply_runtime_intent(crate::RuntimeIntent::SetRoleZoom {
                        browser_zoom_percent: Some(next * 100.0),
                        expected_revision: Some(request.topology_revision),
                        operation_id: format!("{}:commit", request.operation_id),
                        role_id: request.role_id.clone(), tab_id: request.tab_id.clone(),
                        window_id: request.window_id.clone(),
                    }));
                    match committed {
                        Ok(commit) if commit.status == crate::RuntimeCommitStatus::Applied => {
                            revision = commit.revision;
                            match self.project_embedded_runtime_snapshot_without_persistence(Some(&request.operation_id)) {
                                Err(error) => (Status::Indeterminate, Some(error.code().to_owned())),
                                Ok(_) => match self.persist_runtime_ui_windows(std::slice::from_ref(&request.window_id)) {
                                    Ok(()) => (Status::Applied, None),
                                    Err(error) => (Status::Degraded, Some(error.code().to_owned())),
                                },
                            }
                        }
                        other => {
                            let failure = other.err().map_or_else(|| "RUNTIME_ROLE_ZOOM_COMMIT_STALE".to_owned(),
                                |error| error.code().to_owned());
                            let reverse = crate::model::RuntimeRoleZoomRequestRecord {
                                previous_zoom_factor: next, ..request.clone()
                            };
                            match self.execute_runtime_role_zoom_native(&reverse, request.previous_zoom_factor, window_factor) {
                                Ok(()) => (Status::Failed, Some(failure)),
                                Err(error) => (Status::Indeterminate, Some(error.code().to_owned())),
                            }
                        }
                    }
                }
            }
        };
        let mut receipt = runtime_ui_action_summary(self.platform, RuntimeUiSummaryInput {
            accepted_at, started, operation_id: request.operation_id.clone(), trigger: "runtimeRoleZoom",
            subsystem: Subsystem::Presentation, completion_scope: Subsystem::Presentation.default_completion_scope(),
            status, stage: "runtimeRoleZoomTerminal", window_id: request.window_id,
            tab_id: Some(request.tab_id), window_generation: request.window_generation,
            topology_revision: revision, failure_code,
        });
        receipt.role_id = Some(request.role_id);
        receipt.surface_generation = Some(request.surface_generation);
        self.retain_runtime_ui_action(request.operation_id, fingerprint, receipt)
    }
}
