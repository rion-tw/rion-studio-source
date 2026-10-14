impl AppCore {
    fn apply_appkit_window_state(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        placement_sequence: u64,
    ) -> CoreResult<AppKitEventReceipt> {
        let committed = {
            let _authority_guard = self.runtime_authority_barrier.write().map_err(|_| {
                CoreError::Internal("runtime authority barrier poisoned".to_owned())
            })?;
            let before = self.browser_runtime.snapshot()?;
            if !appkit_observations_match(&event.hosts, &before) {
                None
            } else {
                let commit = self
                    .browser_runtime
                    .apply(crate::RuntimeIntent::CommitPlacement(
                        crate::RuntimeWindowPlacementCommitInput {
                            operation_id: event.event_id.clone(),
                            placement: crate::model::GameWindowPlacementRecord {
                                normal_bounds: primary.normal_bounds.clone(),
                                saved_work_area: primary.saved_work_area.clone(),
                                presentation: primary.presentation.clone(),
                            },
                            placement_sequence,
                            source: "appKit".to_owned(),
                            target_display: primary.target_display.clone(),
                            window_generation: primary.window_generation,
                            window_id: primary.identity.logical_window_id.clone(),
                        },
                    ))?;
                Some((commit, self.browser_runtime.snapshot()?))
            }
        };
        let Some((commit, captured)) = committed else {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        };
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.reconcile_appkit_superseded(
                &event,
                &primary,
                Some("APPKIT_PLACEMENT_STALE"),
            );
        }
        let window_id = primary.identity.logical_window_id.clone();
        let window_generation = primary.window_generation;
        let persistence = self.persist_acknowledged_runtime_window_presentation(
            &captured,
            &window_id,
            window_generation,
            commit.revision,
        );
        let mut receipt = self.finish_appkit_projection(event, primary, false)?;
        if receipt.status == crate::model::SystemRuntimeOperationStatus::Applied {
            match persistence {
                Ok(true) => {}
                Ok(false) => {
                    receipt.status = crate::model::SystemRuntimeOperationStatus::Superseded
                }
                Err(error) => {
                    receipt.status = crate::model::SystemRuntimeOperationStatus::Degraded;
                    receipt.failure_code = Some(error.code().to_owned());
                }
            }
        }
        Ok(receipt)
    }
}
