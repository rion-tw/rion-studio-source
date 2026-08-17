impl MacroRuntime {
    pub fn ensure_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
    ) -> CoreResult<MacroInputRecoveryTicket> {
        let recovery_id = recovery_id.trim();
        let role_id = role_id.trim();
        if recovery_id.is_empty() || role_id.is_empty() {
            return Err(CoreError::InvalidInput(
                "macro input recovery identifiers are required".to_owned(),
            ));
        }
        let (ticket, controls) = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if let Some(active_id) = inner.input_recovery_by_role.get(role_id).cloned()
                && let Some(active) = inner.input_recoveries.get(&active_id)
            {
                return Ok(recovery_ticket(&active_id, active));
            }

            let directly_affected = inner
                .invocations
                .values()
                .filter(|control| control.role_ids.contains(role_id))
                .cloned()
                .collect::<Vec<_>>();
            let mut roots = HashMap::new();
            let mut controls = HashMap::new();
            for control in directly_affected {
                controls.insert(control.id.clone(), Arc::clone(&control));
                let root = root_invocation_control(control);
                controls.insert(root.id.clone(), Arc::clone(&root));
                roots.insert(root.id.clone(), root);
            }
            let mut intents = roots
                .values()
                .filter_map(|control| {
                    control
                        .restart_intent
                        .lock()
                        .ok()
                        .and_then(|intent| intent.clone())
                })
                .collect::<Vec<_>>();
            intents.sort_by_key(|intent| intent.sequence);
            intents.dedup_by(|left, right| left.sequence == right.sequence);

            inner.quiesced_role_ids.insert(role_id.to_owned());
            inner.recovering_role_ids.insert(role_id.to_owned());
            inner.restart_required_role_ids.remove(role_id);
            let epoch = inner.input_epochs.entry(role_id.to_owned()).or_default();
            *epoch = epoch.saturating_add(1);
            let input_epoch = *epoch;
            let recovery = MacroInputRecovery {
                input_epoch,
                intents: intents.clone(),
                role_id: role_id.to_owned(),
            };
            inner
                .input_recovery_by_role
                .insert(role_id.to_owned(), recovery_id.to_owned());
            inner
                .input_recoveries
                .insert(recovery_id.to_owned(), recovery);
            install_recovering_statuses(&mut inner, recovery_id, &roots, &intents);
            let ticket = MacroInputRecoveryTicket {
                input_epoch,
                pending_macro_restart_count: intents.len().min(u32::MAX as usize) as u32,
                recovery_id: recovery_id.to_owned(),
                role_id: role_id.to_owned(),
            };
            (ticket, controls.into_values().collect::<Vec<_>>())
        };
        controls.iter().for_each(|control| cancel_control(control));
        self.shared.role_transfer_changed.notify_all();
        self.emit_statuses();
        Ok(ticket)
    }

    pub(crate) fn take_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
    ) -> CoreResult<Vec<MacroRestartIntent>> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        if inner.input_recovery_by_role.get(role_id).map(String::as_str) != Some(recovery_id) {
            return Ok(Vec::new());
        }
        let Some(recovery) = inner.input_recoveries.remove(recovery_id) else {
            return Ok(Vec::new());
        };
        inner.input_recovery_by_role.remove(role_id);
        inner.recovering_role_ids.remove(role_id);
        inner.restart_required_role_ids.remove(role_id);
        remove_recovery_statuses(&mut inner, recovery_id);
        drop(inner);
        self.emit_statuses();
        Ok(recovery.intents)
    }

    pub fn fail_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
        message: &str,
    ) -> CoreResult<bool> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        if inner.input_recovery_by_role.get(role_id).map(String::as_str) != Some(recovery_id) {
            return Ok(false);
        }
        inner.input_recovery_by_role.remove(role_id);
        inner.input_recoveries.remove(recovery_id);
        inner.recovering_role_ids.remove(role_id);
        inner.restart_required_role_ids.insert(role_id.to_owned());
        let prefix = recovery_status_prefix(recovery_id);
        let now = Utc::now().to_rfc3339();
        for (key, status) in &mut inner.statuses {
            if key.starts_with(&prefix) {
                status.state = "failed".to_owned();
                status.error = Some(message.to_owned());
                status.updated_at = now.clone();
            }
        }
        drop(inner);
        self.emit_statuses();
        Ok(true)
    }

    pub fn input_recovery_for_role(
        &self,
        role_id: &str,
    ) -> CoreResult<Option<MacroInputRecoveryTicket>> {
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        Ok(inner
            .input_recovery_by_role
            .get(role_id)
            .and_then(|recovery_id| {
                inner
                    .input_recoveries
                    .get(recovery_id)
                    .map(|recovery| recovery_ticket(recovery_id, recovery))
            }))
    }

    fn cancel_input_recovery_for_role(&self, role_id: &str) -> CoreResult<bool> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        let removed = cancel_recovery_for_role(&mut inner, role_id);
        drop(inner);
        if removed {
            self.emit_statuses();
        }
        Ok(removed)
    }

    fn cancel_input_restarts_for_macros(&self, macro_ids: &HashSet<String>) -> CoreResult<bool> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        let changed = cancel_recovery_intents_for_macros(&mut inner, macro_ids);
        drop(inner);
        if changed {
            self.emit_statuses();
        }
        Ok(changed)
    }
}

fn recovery_ticket(recovery_id: &str, recovery: &MacroInputRecovery) -> MacroInputRecoveryTicket {
    MacroInputRecoveryTicket {
        input_epoch: recovery.input_epoch,
        pending_macro_restart_count: recovery.intents.len().min(u32::MAX as usize) as u32,
        recovery_id: recovery_id.to_owned(),
        role_id: recovery.role_id.clone(),
    }
}

fn root_invocation_control(mut control: Arc<InvocationControl>) -> Arc<InvocationControl> {
    loop {
        let owner = control
            .owner_signal
            .lock()
            .ok()
            .and_then(|owner| owner.as_ref().and_then(Weak::upgrade));
        let Some(owner) = owner else {
            return control;
        };
        control = owner;
    }
}

fn install_recovering_statuses(
    inner: &mut Inner,
    recovery_id: &str,
    roots: &HashMap<String, Arc<InvocationControl>>,
    intents: &[MacroRestartIntent],
) {
    let now = Utc::now().to_rfc3339();
    for intent in intents {
        let Some(root) = roots.values().find(|root| {
            root.restart_intent.lock().ok().is_some_and(|candidate| {
                candidate.as_ref().is_some_and(|candidate| candidate.sequence == intent.sequence)
            })
        }) else {
            continue;
        };
        for role_id in &root.role_ids {
            inner.statuses.insert(
                format!(
                    "{}{}|{}|{}",
                    recovery_status_prefix(recovery_id),
                    intent.sequence,
                    role_id,
                    intent.macro_id
                ),
                MacroRunStatus {
                    role_id: role_id.clone(),
                    macro_id: intent.macro_id.clone(),
                    state: "recovering".to_owned(),
                    iteration: Some(0),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now.clone(),
                    error: None,
                },
            );
        }
    }
}

fn cancel_recovery_intents_for_macros(inner: &mut Inner, macro_ids: &HashSet<String>) -> bool {
    let mut changed = false;
    let mut affected_recoveries = HashSet::new();
    for (recovery_id, recovery) in &mut inner.input_recoveries {
        let before = recovery.intents.len();
        recovery
            .intents
            .retain(|intent| !macro_ids.contains(&intent.macro_id));
        if recovery.intents.len() != before {
            changed = true;
            affected_recoveries.insert(recovery_id.clone());
        }
    }
    if changed {
        inner.statuses.retain(|key, status| {
            !affected_recoveries
                .iter()
                .any(|recovery_id| key.starts_with(&recovery_status_prefix(recovery_id)))
                || !macro_ids.contains(&status.macro_id)
        });
    }
    changed
}

fn cancel_recovery_for_role(inner: &mut Inner, role_id: &str) -> bool {
    let Some(recovery_id) = inner.input_recovery_by_role.remove(role_id) else {
        inner.recovering_role_ids.remove(role_id);
        inner.restart_required_role_ids.remove(role_id);
        return false;
    };
    inner.input_recoveries.remove(&recovery_id);
    inner.recovering_role_ids.remove(role_id);
    inner.restart_required_role_ids.remove(role_id);
    remove_recovery_statuses(inner, &recovery_id);
    true
}

fn remove_recovery_statuses(inner: &mut Inner, recovery_id: &str) {
    let prefix = recovery_status_prefix(recovery_id);
    inner.statuses.retain(|key, _| !key.starts_with(&prefix));
}

fn recovery_status_prefix(recovery_id: &str) -> String {
    format!("macro-recovery:{recovery_id}|")
}
