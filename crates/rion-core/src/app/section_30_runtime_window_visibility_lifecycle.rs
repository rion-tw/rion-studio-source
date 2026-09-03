struct PendingRuntimeWindowVisibilityNative {
    handle: crate::operation_actor::OperationHandle,
    platform: rion_platform::Platform,
    window_id: String,
    window_generation: u64,
    topology_revision: u64,
    lifecycle_epoch: u64,
    appkit_identity: Option<crate::model::AppKitRuntimeHostIdentityRecord>,
    visible: bool,
}

impl PendingRuntimeWindowVisibilityNative {
    fn wait_for_dispatch(&mut self) -> CoreResult<()> {
        self.handle.wait_for_first_effect_dispatch()
    }
}

fn finish_runtime_window_visibility_replay<T: Clone>(
    owner: crate::runtime_window_visibility_replay::VisibilityReplayOwner<'_, T>,
    result: CoreResult<T>,
) -> CoreResult<T> {
    match result {
        Ok(value) => {
            owner.finish(Ok(value.clone()))?;
            Ok(value)
        }
        Err(error) => {
            owner.finish(Err(error.payload()))?;
            Err(error)
        }
    }
}

fn runtime_window_visibility_host_was_quarantined(error: &CoreError) -> bool {
    error.code() == "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED"
}

impl AppCore {
    fn handle_appkit_window_visibility_event(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        visible: bool,
    ) -> CoreResult<crate::model::AppKitRuntimeEventReceiptRecord> {
        let fingerprint = serde_json::to_string(&event).map_err(|error| {
            CoreError::Internal(format!(
                "could not fingerprint the AppKit visibility event: {error}"
            ))
        })?;
        let lane = self.appkit_event_sequence.acquire()?;
        let owner = match self
            .appkit_window_visibility_replay
            .admit(&event.event_id, &fingerprint)?
        {
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Terminal(
                result,
            ) => {
                drop(lane);
                return crate::runtime_window_visibility_replay::visibility_replay_result(result);
            }
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Join => {
                drop(lane);
                return self
                    .appkit_window_visibility_replay
                    .wait_terminal(&event.event_id, &fingerprint);
            }
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Owner(owner) => {
                owner
            }
        };
        let result = (|| {
            if !self.accept_appkit_event_sequence(&primary.identity, event.adapter_sequence)? {
                return self.appkit_superseded_receipt(&event, &primary, None);
            }
            let before = self.browser_runtime.snapshot()?;
            if !appkit_observations_match(&event.hosts, &before) {
                return self.appkit_superseded_receipt(
                    &event,
                    &primary,
                    Some("APPKIT_EVENT_STALE"),
                );
            }
            if primary.visible == visible
                && (!visible || (!primary.minimized && primary.focused))
            {
                return self.finish_appkit_projection(event, primary, false);
            }
            let lifecycle_epoch = self.application_lifecycle_epoch.load(Ordering::Acquire);
            let mut pending = self.start_runtime_window_visibility_native(
                &event.event_id,
                &primary.identity.logical_window_id,
                primary.window_generation,
                primary.topology_revision,
                lifecycle_epoch,
                Some(primary.identity.clone()),
                visible,
            )?;
            let dispatch = pending.wait_for_dispatch();
            drop(lane);
            let native = self.finish_dispatched_runtime_window_visibility_native(pending, dispatch);
            match native {
                Ok(receipt) => self.appkit_receipt(
                    &event,
                    &primary,
                    if receipt.status == "applied" {
                        crate::model::SystemRuntimeOperationStatus::Applied
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Superseded
                    },
                    false,
                    receipt.status == "applied",
                    None,
                ),
                Err(error) if runtime_window_visibility_host_was_quarantined(&error) => {
                    match self.reconcile_runtime_window_visibility_quarantine(
                        &event.event_id,
                        &primary.identity.logical_window_id,
                        primary.window_generation,
                        primary.topology_revision,
                    ) {
                        Ok(()) => self.appkit_receipt(
                            &event,
                            &primary,
                            crate::model::SystemRuntimeOperationStatus::Failed,
                            false,
                            false,
                            Some(error.code().to_owned()),
                        ),
                        Err(reconciliation_error) => self.appkit_receipt(
                            &event,
                            &primary,
                            crate::model::SystemRuntimeOperationStatus::Indeterminate,
                            false,
                            false,
                            Some(reconciliation_error.code().to_owned()),
                        ),
                    }
                }
                Err(error) => self.appkit_receipt(
                    &event,
                    &primary,
                    if runtime_window_visibility_native_failure_is_indeterminate(&error) {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    },
                    false,
                    false,
                    Some(error.code().to_owned()),
                ),
            }
        })();
        finish_runtime_window_visibility_replay(owner, result)
    }

    #[allow(clippy::too_many_arguments)]
    fn start_runtime_window_visibility_native(
        &self,
        parent_operation_id: &str,
        window_id: &str,
        window_generation: u64,
        topology_revision: u64,
        lifecycle_epoch: u64,
        appkit_identity: Option<crate::model::AppKitRuntimeHostIdentityRecord>,
        visible: bool,
    ) -> CoreResult<PendingRuntimeWindowVisibilityNative> {
        let step = effect_step(
            window_id,
            crate::model::CoreEffectAction::EmbeddedSetRuntimeWindowVisibility {
                lifecycle_epoch,
                window_id: window_id.to_owned(),
                window_generation,
                topology_revision,
                appkit_identity: appkit_identity.clone(),
                visible,
            },
            Duration::from_secs(15),
            None,
        );
        let handle = self.operation_actor.start_with_parent(
            crate::operation_actor::OperationPlan { steps: vec![step] },
            parent_operation_id.to_owned(),
        )?;
        Ok(PendingRuntimeWindowVisibilityNative {
            handle,
            platform: self.platform,
            window_id: window_id.to_owned(),
            window_generation,
            topology_revision,
            lifecycle_epoch,
            appkit_identity,
            visible,
        })
    }

    fn finish_runtime_window_visibility_native(
        &self,
        pending: PendingRuntimeWindowVisibilityNative,
    ) -> CoreResult<crate::model::RuntimeWindowVisibilityNativeReceiptRecord> {
        let PendingRuntimeWindowVisibilityNative {
            handle,
            platform,
            window_id,
            window_generation,
            topology_revision,
            lifecycle_epoch,
            appkit_identity,
            visible,
        } = pending;
        let outcome = self.finish_effect_plan_for_roles(handle, &[])?;
        parse_runtime_window_visibility_native_receipt(
            outcome,
            RuntimeWindowVisibilityNativeExpectation {
                platform,
                window_id: &window_id,
                window_generation,
                topology_revision,
                lifecycle_epoch,
                appkit_identity: appkit_identity.as_ref(),
                visible,
            },
        )
    }

    fn finish_dispatched_runtime_window_visibility_native(
        &self,
        pending: PendingRuntimeWindowVisibilityNative,
        dispatch: CoreResult<()>,
    ) -> CoreResult<crate::model::RuntimeWindowVisibilityNativeReceiptRecord> {
        let native = self.finish_runtime_window_visibility_native(pending);
        match dispatch {
            Ok(()) => native,
            Err(dispatch_error) => Err(dispatch_error),
        }
    }

    fn reconcile_runtime_window_visibility_quarantine(
        &self,
        parent_operation_id: &str,
        window_id: &str,
        window_generation: u64,
        topology_revision: u64,
    ) -> CoreResult<()> {
        let snapshot = self.browser_runtime.snapshot()?;
        let window = snapshot.windows.get(window_id).ok_or_else(|| {
            runtime_window_visibility_native_error(
                "RUNTIME_WINDOW_VISIBILITY_QUARANTINE_STALE",
                "The quarantined Chromium window is no longer in the exact Core topology.",
            )
        })?;
        if window.window_generation != window_generation || window.revision != topology_revision {
            return Err(runtime_window_visibility_native_error(
                "RUNTIME_WINDOW_VISIBILITY_QUARANTINE_STALE",
                "The quarantined Chromium window changed before Core teardown.",
            ));
        }
        let request = crate::model::RuntimeWindowStopRequestRecord {
            parent_operation_id: format!(
                "{parent_operation_id}:runtime-window-visibility-quarantine:{window_id}"
            ),
            window_id: window_id.to_owned(),
            window_generation,
            topology_revision,
            tab_ids: window.tab_ids(),
            intent_origin: "runtimeWindowVisibilityQuarantine".to_owned(),
            admission_id: None,
            closing_tabs: Vec::new(),
        };
        self.stop_embedded_window(&request, false)?;

        let after_native = self.browser_runtime.snapshot()?;
        let current = after_native.windows.get(window_id).ok_or_else(|| {
            runtime_window_visibility_native_error(
                "RUNTIME_WINDOW_VISIBILITY_QUARANTINE_STALE",
                "The quarantined Chromium window disappeared before Core removal.",
            )
        })?;
        if current.window_generation != window_generation
            || current.revision != topology_revision
            || current.tab_ids() != request.tab_ids
        {
            return Err(runtime_window_visibility_native_error(
                "RUNTIME_WINDOW_VISIBILITY_QUARANTINE_STALE",
                "The quarantined Chromium window changed during Core teardown.",
            ));
        }
        let removal = self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
            operation_id: format!(
                "{parent_operation_id}:remove-quarantined-runtime-window:{window_id}"
            ),
            window_id: window_id.to_owned(),
        })?;
        if removal.status == crate::RuntimeCommitStatus::Superseded {
            return Err(runtime_window_visibility_native_error(
                "RUNTIME_WINDOW_VISIBILITY_QUARANTINE_STALE",
                "The quarantined Chromium window no longer owned its Core removal.",
            ));
        }
        Ok(())
    }
}
