const RETAINED_CONTROLLED_ROLE_RELOAD_RECEIPTS: usize = 80;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ControlledRoleReloadPhase {
    Fenced,
    Prepared,
    Drained,
    CommitSubmitted,
}

#[derive(Clone)]
struct ActiveControlledRoleReload {
    actor_operation_id: Option<String>,
    fingerprint: String,
    phase: ControlledRoleReloadPhase,
    reload_operation_id: String,
    roles: Vec<crate::model::EmbeddedRoleReloadFenceRecord>,
    provisional_restart_role_ids: std::collections::HashSet<String>,
    superseded_reason: Option<String>,
}

#[derive(Clone)]
struct ControlledRoleReloadTerminalEntry {
    fingerprint: String,
    receipt: crate::model::BrowserTabReloadReceiptRecord,
}

#[derive(Default)]
struct ControlledRoleReloadState {
    active: std::collections::HashMap<String, ActiveControlledRoleReload>,
    latest_by_role: std::collections::HashMap<String, String>,
    terminal: std::collections::HashMap<String, ControlledRoleReloadTerminalEntry>,
    terminal_order: std::collections::VecDeque<String>,
}

#[derive(Default)]
struct ControlledRoleReloadCoordinator {
    state: Mutex<ControlledRoleReloadState>,
    terminal_changed: std::sync::Condvar,
}

enum ControlledRoleReloadLookup {
    New,
    Active,
    Terminal(Box<crate::model::BrowserTabReloadReceiptRecord>),
}

struct SupersededControlledRoleReload {
    actor_operation_id: Option<String>,
    phase: ControlledRoleReloadPhase,
    reload_operation_id: String,
    roles: Vec<crate::model::EmbeddedRoleReloadFenceRecord>,
}

fn controlled_role_reload_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

impl ControlledRoleReloadCoordinator {
    fn lookup(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<ControlledRoleReloadLookup> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        if let Some(entry) = state.terminal.get(operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_OPERATION_ID_REUSED",
                    "A controlled reload operation identity was reused for different fences.",
                ));
            }
            return Ok(ControlledRoleReloadLookup::Terminal(Box::new(
                entry.receipt.clone(),
            )));
        }
        if let Some(entry) = state.active.get(operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_OPERATION_ID_REUSED",
                    "A controlled reload operation identity was reused for different fences.",
                ));
            }
            return Ok(ControlledRoleReloadLookup::Active);
        }
        Ok(ControlledRoleReloadLookup::New)
    }

    fn wait_for_terminal(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<crate::model::BrowserTabReloadReceiptRecord> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        loop {
            if let Some(entry) = state.terminal.get(operation_id) {
                if entry.fingerprint != fingerprint {
                    return Err(controlled_role_reload_error(
                        "RUNTIME_TAB_RELOAD_OPERATION_ID_REUSED",
                        "A controlled reload operation identity was reused for different fences.",
                    ));
                }
                return Ok(entry.receipt.clone());
            }
            if !state.active.contains_key(operation_id) {
                return Err(CoreError::Internal(
                    "controlled role reload ended without a terminal receipt".to_owned(),
                ));
            }
            state = self.terminal_changed.wait(state).map_err(|_| {
                CoreError::Internal("controlled role reload ledger poisoned".to_owned())
            })?;
        }
    }

    fn admit(&self, entry: ActiveControlledRoleReload) -> CoreResult<Vec<String>> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let mut older_operation_ids = entry
            .roles
            .iter()
            .filter_map(|role| state.latest_by_role.get(&role.role_id).cloned())
            .filter(|operation_id| operation_id != &entry.reload_operation_id)
            .collect::<Vec<_>>();
        older_operation_ids.sort();
        older_operation_ids.dedup();
        let mut actor_operation_ids = Vec::new();
        for operation_id in &older_operation_ids {
            if let Some(older) = state.active.get_mut(operation_id) {
                older.superseded_reason = Some("replacementReload".to_owned());
                if let Some(actor_operation_id) = older.actor_operation_id.clone() {
                    actor_operation_ids.push(actor_operation_id);
                }
            }
        }
        for role in &entry.roles {
            state
                .latest_by_role
                .insert(role.role_id.clone(), entry.reload_operation_id.clone());
        }
        state
            .active
            .insert(entry.reload_operation_id.clone(), entry);
        Ok(actor_operation_ids)
    }

    fn set_phase(
        &self,
        reload_operation_id: &str,
        phase: ControlledRoleReloadPhase,
    ) -> CoreResult<bool> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let Some(entry) = state.active.get_mut(reload_operation_id) else {
            return Ok(false);
        };
        entry.phase = phase;
        Ok(entry.superseded_reason.is_none())
    }

    fn set_actor_operation(
        &self,
        reload_operation_id: &str,
        actor_operation_id: String,
        phase: ControlledRoleReloadPhase,
    ) -> CoreResult<bool> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let Some(entry) = state.active.get_mut(reload_operation_id) else {
            return Ok(false);
        };
        entry.phase = phase;
        entry.actor_operation_id = Some(actor_operation_id);
        Ok(entry.superseded_reason.is_none())
    }

    fn clear_actor_operation(
        &self,
        reload_operation_id: &str,
        actor_operation_id: &str,
    ) -> CoreResult<()> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        if let Some(entry) = state.active.get_mut(reload_operation_id)
            && entry.actor_operation_id.as_deref() == Some(actor_operation_id)
        {
            entry.actor_operation_id = None;
        }
        Ok(())
    }

    fn is_current(&self, reload_operation_id: &str) -> CoreResult<bool> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let Some(entry) = state.active.get(reload_operation_id) else {
            return Ok(false);
        };
        Ok(entry.superseded_reason.is_none()
            && entry.roles.iter().all(|role| {
                state.latest_by_role.get(&role.role_id) == Some(&entry.reload_operation_id)
            }))
    }

    fn superseded_reason(&self, reload_operation_id: &str) -> CoreResult<Option<String>> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        Ok(state
            .active
            .get(reload_operation_id)
            .and_then(|entry| entry.superseded_reason.clone()))
    }

    fn supersede_roles(
        &self,
        role_ids: &[String],
        reason: &str,
    ) -> CoreResult<Vec<SupersededControlledRoleReload>> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let mut operation_ids = role_ids
            .iter()
            .filter_map(|role_id| state.latest_by_role.get(role_id).cloned())
            .collect::<Vec<_>>();
        operation_ids.sort();
        operation_ids.dedup();
        let mut superseded = Vec::new();
        for operation_id in operation_ids {
            let Some(entry) = state.active.get_mut(&operation_id) else {
                continue;
            };
            entry.superseded_reason = Some(reason.to_owned());
            superseded.push(SupersededControlledRoleReload {
                actor_operation_id: entry.actor_operation_id.clone(),
                phase: entry.phase,
                reload_operation_id: entry.reload_operation_id.clone(),
                roles: entry.roles.clone(),
            });
            let owned_role_ids = entry
                .roles
                .iter()
                .map(|role| role.role_id.clone())
                .collect::<Vec<_>>();
            for role_id in owned_role_ids {
                if state.latest_by_role.get(&role_id) == Some(&operation_id) {
                    state.latest_by_role.remove(&role_id);
                }
            }
        }
        Ok(superseded)
    }

    fn active_role_ids(&self) -> CoreResult<Vec<String>> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let mut role_ids = state.latest_by_role.keys().cloned().collect::<Vec<_>>();
        role_ids.sort();
        Ok(role_ids)
    }

    fn active_operations_for_roles(
        &self,
        role_ids: &[String],
        excluding_operation_id: &str,
    ) -> CoreResult<Vec<(String, String)>> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let role_ids = role_ids.iter().collect::<std::collections::HashSet<_>>();
        let mut operations = state
            .active
            .values()
            .filter(|entry| entry.reload_operation_id != excluding_operation_id)
            .filter(|entry| {
                entry
                    .roles
                    .iter()
                    .any(|role| role_ids.contains(&role.role_id))
            })
            .map(|entry| (entry.reload_operation_id.clone(), entry.fingerprint.clone()))
            .collect::<Vec<_>>();
        operations.sort_by(|left, right| left.0.cmp(&right.0));
        operations.dedup_by(|left, right| left.0 == right.0);
        Ok(operations)
    }

    fn record_provisional_restart(
        &self,
        reload_operation_id: &str,
        role_id: &str,
    ) -> CoreResult<()> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        let entry = state.active.get_mut(reload_operation_id).ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDED",
                "The controlled reload ended before restart ownership was recorded.",
            )
        })?;
        entry
            .provisional_restart_role_ids
            .insert(role_id.to_owned());
        Ok(())
    }

    fn owns_provisional_restart(
        &self,
        reload_operation_id: &str,
        role_id: &str,
    ) -> CoreResult<bool> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        Ok(state
            .active
            .get(reload_operation_id)
            .is_some_and(|entry| entry.provisional_restart_role_ids.contains(role_id)))
    }

    fn finish(
        &self,
        operation_id: String,
        fingerprint: String,
        receipt: crate::model::BrowserTabReloadReceiptRecord,
    ) -> CoreResult<crate::model::BrowserTabReloadReceiptRecord> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("controlled role reload ledger poisoned".to_owned())
        })?;
        if let Some(existing) = state.terminal.get(&operation_id) {
            if existing.fingerprint != fingerprint {
                return Err(controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_OPERATION_ID_REUSED",
                    "A controlled reload operation identity was reused for different fences.",
                ));
            }
            return Ok(existing.receipt.clone());
        }
        if let Some(active) = state.active.remove(&operation_id) {
            for role in active.roles {
                if state.latest_by_role.get(&role.role_id) == Some(&operation_id) {
                    state.latest_by_role.remove(&role.role_id);
                }
            }
        }
        state.terminal_order.push_back(operation_id.clone());
        state.terminal.insert(
            operation_id,
            ControlledRoleReloadTerminalEntry {
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        while state.terminal_order.len() > RETAINED_CONTROLLED_ROLE_RELOAD_RECEIPTS {
            if let Some(expired) = state.terminal_order.pop_front() {
                state.terminal.remove(&expired);
            }
        }
        self.terminal_changed.notify_all();
        Ok(receipt)
    }
}

impl AppCore {
    fn supersede_controlled_role_reloads(
        &self,
        role_ids: &[String],
        reason: &str,
    ) -> CoreResult<std::sync::MutexGuard<'_, ()>> {
        let admission = self.controlled_role_reload_admission.lock().map_err(|_| {
            CoreError::Internal("controlled reload admission lock poisoned".to_owned())
        })?;
        #[cfg(test)]
        if let Some(hook) = self
            .controlled_role_reload_mutation_admitted_hook
            .lock()
            .map_err(|_| {
                CoreError::Internal(
                    "controlled reload mutation admission test hook poisoned".to_owned(),
                )
            })?
            .clone()
        {
            hook();
        }
        if role_ids.is_empty() {
            return Ok(admission);
        }
        let superseded = self
            .controlled_role_reloads
            .supersede_roles(role_ids, reason)?;
        for operation in superseded {
            if let Some(actor_operation_id) = operation.actor_operation_id {
                self.operation_actor.cancel(&actor_operation_id)?;
            }
            let retained_surface = matches!(
                reason,
                "tabMove" | "tabHide" | "applicationLifecycle" | "surfaceRecovery"
            );
            if operation.phase >= ControlledRoleReloadPhase::CommitSubmitted && retained_surface {
                for role in &operation.roles {
                    let restart_marked = self
                        .require_controlled_role_reload_restart(&role.role_id, role.input_epoch)?;
                    if !restart_marked {
                        return Err(controlled_role_reload_error(
                            "RUNTIME_TAB_RELOAD_RESTART_MARK_STALE",
                            "The retained Role surface could not assume restart ownership.",
                        ));
                    }
                    self.controlled_role_reloads.record_provisional_restart(
                        &operation.reload_operation_id,
                        &role.role_id,
                    )?;
                }
            }
        }
        Ok(admission)
    }

    fn supersede_all_controlled_role_reloads(
        &self,
        reason: &str,
    ) -> CoreResult<std::sync::MutexGuard<'_, ()>> {
        let role_ids = self.controlled_role_reloads.active_role_ids()?;
        self.supersede_controlled_role_reloads(&role_ids, reason)
    }
}
