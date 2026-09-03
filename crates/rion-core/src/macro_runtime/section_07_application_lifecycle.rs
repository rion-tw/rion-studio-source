impl MacroRuntime {
    /// Fences every role participating in automatic input and terminalizes the
    /// current invocation tree before the application enters OS suspension.
    ///
    /// The lifecycle lane is deliberately event-bound: cancellation waits for
    /// exact cleanup browser-action receipts. Elapsed time is only the existing
    /// native-action failure boundary and can never turn suspension into
    /// success.
    pub fn suspend_for_application_lifecycle(
        &self,
    ) -> CoreResult<Vec<MacroInputEpochRecord>> {
        let _lifecycle = self
            .shared
            .application_lifecycle_lock
            .lock()
            .map_err(|_| CoreError::Internal("macro lifecycle lock poisoned".to_owned()))?;
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        if self
            .shared
            .application_suspended
            .swap(true, Ordering::AcqRel)
        {
            if !self
                .shared
                .application_suspend_completed
                .load(Ordering::Acquire)
            {
                return Err(application_suspend_incomplete_error());
            }
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            return Ok(application_suspend_records(&inner));
        }
        self.shared
            .application_suspend_completed
            .store(false, Ordering::Release);

        let pending_role_ids = self
            .shared
            .pending
            .lock()
            .map_err(|_| CoreError::Internal("macro action result lock poisoned".to_owned()))?
            .values()
            .map(|pending| pending.role_id.clone())
            .collect::<HashSet<_>>();
        let (controls, records) = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let mut role_ids = pending_role_ids;
            role_ids.extend(inner.statuses.values().map(|status| status.role_id.clone()));
            role_ids.extend(inner.held_keys.values().map(|held| held.role_id.clone()));
            role_ids.extend(
                inner
                    .input_recoveries
                    .values()
                    .map(|recovery| recovery.role_id.clone()),
            );
            for control in inner.invocations.values() {
                role_ids.extend(control.role_ids.iter().cloned());
            }

            let mut ordered_role_ids = role_ids.into_iter().collect::<Vec<_>>();
            ordered_role_ids.sort();
            for role_id in ordered_role_ids {
                inner.quiesced_role_ids.insert(role_id.clone());
                let current_input_epoch = {
                    let input_epoch = inner.input_epochs.entry(role_id.clone()).or_default();
                    *input_epoch = input_epoch.saturating_add(1);
                    *input_epoch
                };
                inner
                    .application_suspend_epochs
                    .insert(role_id, current_input_epoch);
            }
            inner.input_recoveries.clear();
            inner.input_recovery_by_role.clear();
            inner.recovering_role_ids.clear();
            inner.early_releases.clear();
            inner.transferring_role_ids.clear();
            (
                inner.invocations.values().cloned().collect::<Vec<_>>(),
                application_suspend_records(&inner),
            )
        };
        self.shared.role_transfer_changed.notify_all();
        cancel_and_wait_all(&controls)?;
        self.shared
            .application_suspend_completed
            .store(true, Ordering::Release);
        Ok(records)
    }

    /// Releases only the exact input epochs retained by the preceding
    /// application-suspend transaction. Macro invocations are never replayed;
    /// a later user action starts a fresh invocation from its first step.
    pub fn resume_after_application_lifecycle(
        &self,
    ) -> CoreResult<Vec<MacroInputEpochRecord>> {
        let _lifecycle = self
            .shared
            .application_lifecycle_lock
            .lock()
            .map_err(|_| CoreError::Internal("macro lifecycle lock poisoned".to_owned()))?;
        if !self.shared.application_suspended.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }
        if !self
            .shared
            .application_suspend_completed
            .load(Ordering::Acquire)
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let failed_role_ids = inner
                .application_suspend_epochs
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            inner.application_suspend_epochs.clear();
            inner
                .restart_required_role_ids
                .extend(failed_role_ids.iter().cloned());
            drop(inner);
            self.shared
                .application_suspended
                .store(false, Ordering::Release);
            return Err(application_suspend_incomplete_error());
        }
        let pending = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            application_suspend_records(&inner)
        };
        let mut resumed = Vec::new();
        let mut failed_role_ids = Vec::new();
        for record in pending {
            if self.resume_role_input(&record.role_id, record.input_epoch)? {
                self.shared
                    .inner
                    .lock()
                    .map_err(|_| {
                        CoreError::Internal("macro runtime lock poisoned".to_owned())
                    })?
                    .application_suspend_epochs
                    .remove(&record.role_id);
                resumed.push(record);
            } else {
                failed_role_ids.push(record.role_id);
            }
        }
        if !failed_role_ids.is_empty() {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            for role_id in &failed_role_ids {
                inner.application_suspend_epochs.remove(role_id);
                inner.restart_required_role_ids.insert(role_id.clone());
            }
        }
        self.shared
            .application_suspend_completed
            .store(false, Ordering::Release);
        self.shared
            .application_suspended
            .store(false, Ordering::Release);
        if !failed_role_ids.is_empty() {
            return Err(CoreError::Domain {
                code: "SYSTEM_LIFECYCLE_INPUT_RESUME_FAILED",
                message: format!(
                    "Automatic input did not resume for the exact suspended roles: {}.",
                    failed_role_ids.join(", ")
                ),
            });
        }
        Ok(resumed)
    }
}

fn application_suspend_records(inner: &Inner) -> Vec<MacroInputEpochRecord> {
    let mut records = inner
        .application_suspend_epochs
        .iter()
        .map(|(role_id, input_epoch)| MacroInputEpochRecord {
            role_id: role_id.clone(),
            input_epoch: *input_epoch,
            current: true,
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.role_id.cmp(&right.role_id));
    records
}

fn application_suspend_incomplete_error() -> CoreError {
    CoreError::Domain {
        code: "SYSTEM_LIFECYCLE_INPUT_SUSPEND_FAILED",
        message: "Automatic input did not reach an exact suspended terminal state.".to_owned(),
    }
}
