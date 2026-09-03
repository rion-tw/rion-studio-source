fn windows_runtime_placement_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn valid_windows_runtime_placement_event(
    event: &crate::model::WindowsRuntimeWindowPlacementEventRecord,
) -> bool {
    let fingerprint_valid = event
        .target_display
        .fingerprint
        .as_ref()
        .is_some_and(|fingerprint| {
            !fingerprint.label.trim().is_empty()
                && fingerprint.label.trim() == fingerprint.label
                && valid_pixel_bounds(&fingerprint.bounds)
                && fingerprint.resolution.width > 0
                && fingerprint.resolution.height > 0
                && fingerprint.scale_factor.is_finite()
                && fingerprint.scale_factor > 0.0
        });
    uuid::Uuid::parse_str(&event.event_id).is_ok()
        && valid_runtime_ui_identifier(&event.window_id)
        && event.adapter_sequence > 0
        && event.native_host_id > 0
        && event.native_generation > 0
        && event.window_generation > 0
        && event.topology_revision > 0
        && event.target_display.id >= 0
        && fingerprint_valid
        && valid_pixel_bounds(&event.placement.normal_bounds)
        && valid_pixel_bounds(&event.placement.saved_work_area)
        && matches!(
            event.placement.presentation.as_str(),
            "normal" | "maximized" | "fullscreen"
        )
}

fn windows_runtime_placement_receipt(
    event: &crate::model::WindowsRuntimeWindowPlacementEventRecord,
    topology_revision: u64,
    status: &str,
    persistence_status: &str,
    core_projection_applied: bool,
    failure_code: Option<String>,
) -> crate::model::WindowsRuntimeWindowPlacementReceiptRecord {
    crate::model::WindowsRuntimeWindowPlacementReceiptRecord {
        event_id: event.event_id.clone(),
        adapter_sequence: event.adapter_sequence,
        native_host_id: event.native_host_id,
        native_generation: event.native_generation,
        window_id: event.window_id.clone(),
        window_generation: event.window_generation,
        source_topology_revision: event.topology_revision,
        topology_revision,
        status: status.to_owned(),
        persistence_status: persistence_status.to_owned(),
        core_projection_applied,
        failure_code,
    }
}

impl AppCore {
    fn persist_windows_runtime_window_placement(
        &self,
        event: &crate::model::WindowsRuntimeWindowPlacementEventRecord,
        committed_revision: u64,
    ) -> CoreResult<String> {
        let app = self.app_snapshot()?;
        let logical = app
            .logical_windows
            .iter()
            .find(|window| window.window_id == event.window_id)
            .ok_or_else(|| {
                windows_runtime_placement_error(
                    "WINDOWS_RUNTIME_PLACEMENT_LOGICAL_WINDOW_MISSING",
                    "The committed Windows placement lost its logical window snapshot.",
                )
            })?;
        let saved = app
            .state
            .game_windows
            .iter()
            .find(|window| window.id == event.window_id)
            .ok_or_else(|| {
                windows_runtime_placement_error(
                    "WINDOWS_RUNTIME_PLACEMENT_SAVED_WINDOW_MISSING",
                    "The committed Windows placement has no saved Game Window.",
                )
            })?;
        if logical.window_generation != event.window_generation
            || logical.revision != committed_revision
            || logical.presentation.as_deref()
                != Some(event.placement.presentation.as_str())
        {
            return Err(windows_runtime_placement_error(
                "WINDOWS_RUNTIME_PLACEMENT_COMMIT_STALE",
                "The Windows placement changed before its exact persistence snapshot.",
            ));
        }
        let batch = self.commit_runtime_window_snapshot_batch_inner(vec![
            crate::model::GameWindowRuntimeSnapshotCommitInputRecord {
                snapshot: logical.clone(),
                name: saved.name.clone(),
                target_display: event.target_display.clone(),
                placement: event.placement.clone(),
            },
        ])?;
        let receipt = batch.receipts.first().ok_or_else(|| {
            windows_runtime_placement_error(
                "WINDOWS_RUNTIME_PLACEMENT_PERSISTENCE_RECEIPT_MISSING",
                "Core omitted the exact Windows placement persistence receipt.",
            )
        })?;
        if receipt.window_id != event.window_id
            || receipt.window_generation != event.window_generation
            || receipt.revision != committed_revision
            || !matches!(receipt.status.as_str(), "applied" | "superseded")
        {
            return Err(windows_runtime_placement_error(
                "WINDOWS_RUNTIME_PLACEMENT_PERSISTENCE_RECEIPT_INVALID",
                "Core returned a mismatched Windows placement persistence receipt.",
            ));
        }
        Ok(receipt.status.clone())
    }

    fn commit_windows_runtime_window_placement(
        &self,
        event: crate::model::WindowsRuntimeWindowPlacementEventRecord,
    ) -> CoreResult<crate::model::WindowsRuntimeWindowPlacementReceiptRecord> {
        let registration = self.browser_runtime_registration()?;
        if self.platform != rion_platform::Platform::Windows
            || self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION
            || registration.platform != "windows"
            || registration.engine != crate::model::ResolvedBrowserEngine::Chromium
        {
            return Err(windows_runtime_placement_error(
                "WINDOWS_RUNTIME_PLACEMENT_UNAVAILABLE",
                "The Windows Chromium placement lane is unavailable.",
            ));
        }
        if !valid_windows_runtime_placement_event(&event) {
            return Err(windows_runtime_placement_error(
                "WINDOWS_RUNTIME_PLACEMENT_EVENT_INVALID",
                "The Windows placement event has an invalid native or Core fence.",
            ));
        }

        let _lane = self.embedded_runtime_sequence.acquire()?;
        let before = self.browser_runtime.snapshot()?;
        let Some(window) = before.windows.get(&event.window_id) else {
            return Ok(windows_runtime_placement_receipt(
                &event,
                event.topology_revision,
                "superseded",
                "superseded",
                false,
                Some("WINDOWS_RUNTIME_PLACEMENT_STALE".to_owned()),
            ));
        };
        if window.window_generation != event.window_generation
            || window.revision != event.topology_revision
            || event.adapter_sequence <= window.placement_sequence
        {
            return Ok(windows_runtime_placement_receipt(
                &event,
                window.revision,
                "superseded",
                "superseded",
                false,
                Some("WINDOWS_RUNTIME_PLACEMENT_STALE".to_owned()),
            ));
        }

        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitPlacement(
            crate::RuntimeWindowPlacementCommitInput {
                operation_id: event.event_id.clone(),
                placement: event.placement.clone(),
                placement_sequence: event.adapter_sequence,
                source: "chromiumWindowsHost".to_owned(),
                target_display: event.target_display.clone(),
                window_generation: event.window_generation,
                window_id: event.window_id.clone(),
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Ok(windows_runtime_placement_receipt(
                &event,
                commit.revision,
                "superseded",
                "superseded",
                false,
                Some("WINDOWS_RUNTIME_PLACEMENT_STALE".to_owned()),
            ));
        }

        let persistence = self.persist_windows_runtime_window_placement(
            &event,
            commit.revision,
        );
        let projection = self.project_embedded_runtime_snapshot_without_persistence(
            Some(&event.event_id),
        );
        match (persistence, projection) {
            (Ok(persistence_status), Ok(_)) => {
                let status = if persistence_status == "applied" {
                    "applied"
                } else {
                    "superseded"
                };
                Ok(windows_runtime_placement_receipt(
                    &event,
                    commit.revision,
                    status,
                    &persistence_status,
                    true,
                    None,
                ))
            }
            (Err(error), Ok(_)) => Ok(windows_runtime_placement_receipt(
                &event,
                commit.revision,
                "degraded",
                "failed",
                true,
                Some(error.code().to_owned()),
            )),
            (Ok(persistence_status), Err(error)) => Ok(windows_runtime_placement_receipt(
                &event,
                commit.revision,
                "indeterminate",
                &persistence_status,
                false,
                Some(error.code().to_owned()),
            )),
            (Err(_), Err(error)) => Ok(windows_runtime_placement_receipt(
                &event,
                commit.revision,
                "indeterminate",
                "failed",
                false,
                Some(error.code().to_owned()),
            )),
        }
    }
}
