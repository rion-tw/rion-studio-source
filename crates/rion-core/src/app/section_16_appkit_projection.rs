impl AppCore {
    fn finish_appkit_projection(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        topology_committed: bool,
    ) -> CoreResult<AppKitEventReceipt> {
        let projection = self.build_appkit_projection(&event)?;
        let quarantine_scope = projection.windows.clone();
        let native = self.run_embedded_runtime_effect(
            &primary.identity.logical_window_id,
            CoreEffectAction::EmbeddedApplyAppKitProjection {
                projection: Box::new(projection),
            },
            None,
            None,
        );
        match native {
            Err(error)
                if error.code() == "ELECTRON_MACOS_APPKIT_PROJECTION_SUPERSEDED"
                    && !topology_committed
                    && self.appkit_layout_projection_was_superseded(&event, &quarantine_scope)? =>
            {
                self.appkit_superseded_receipt(&event, &primary, Some(error.code()))
            }
            Ok(_) => self.appkit_receipt(
                &event,
                &primary,
                crate::model::SystemRuntimeOperationStatus::Applied,
                topology_committed,
                true,
                None,
            ),
            Err(error) if appkit_projection_failure_requires_quarantine(error.code()) => {
                let native_failure_code = error.code().to_owned();
                match self
                    .reconcile_appkit_projection_quarantine(&event.event_id, &quarantine_scope)
                {
                    Ok(()) => self.appkit_receipt(
                        &event,
                        &primary,
                        crate::model::SystemRuntimeOperationStatus::Failed,
                        false,
                        false,
                        Some(native_failure_code),
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
                if topology_committed {
                    crate::model::SystemRuntimeOperationStatus::Degraded
                } else {
                    crate::model::SystemRuntimeOperationStatus::Failed
                },
                topology_committed,
                false,
                Some(error.code().to_owned()),
            ),
        }
    }

    fn appkit_layout_projection_was_superseded(
        &self,
        event: &crate::model::AppKitRuntimeEventRecord,
        projected: &[crate::model::AppKitRuntimeWindowProjectionRecord],
    ) -> CoreResult<bool> {
        if !matches!(event.action, crate::model::AppKitRuntimeEventActionRecord::Layout { .. }) {
            return Ok(false);
        }
        let snapshot = self.browser_runtime.snapshot()?;
        let mut advanced = false;
        for projection in projected {
            let Some(current) = snapshot.windows.get(&projection.identity.logical_window_id) else {
                return Ok(false);
            };
            if current.window_generation != projection.window_generation
                || current.revision < projection.topology_revision
            {
                return Ok(false);
            }
            advanced |= current.revision > projection.topology_revision;
        }
        Ok(advanced)
    }

}
