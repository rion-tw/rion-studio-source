impl MacroRuntime {
    pub fn new(events: EventSink) -> Self {
        Self::new_with_waiter(events, Arc::new(default_wait))
    }

    fn new_with_waiter(events: EventSink, waiter: Waiter) -> Self {
        Self::new_with_waiter_and_timeout(events, waiter, ACTION_TIMEOUT)
    }

    fn new_with_waiter_and_timeout(
        events: EventSink,
        waiter: Waiter,
        action_timeout: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                action_timeout,
                action_role_locks: Mutex::new(HashMap::new()),
                events,
                inner: Mutex::new(Inner::default()),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                last_presentation_status_emit: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                input_sequence_role_locks: Mutex::new(HashMap::new()),
                toggle_serial: Mutex::new(()),
                waiter,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn seed_running_status(&self, macro_id: &str, role_id: &str) -> CoreResult<()> {
        let now = Utc::now().to_rfc3339();
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .insert(
                format!("test-invocation|{role_id}|{macro_id}"),
                MacroRunStatus {
                    role_id: role_id.to_owned(),
                    macro_id: macro_id.to_owned(),
                    state: "running".to_owned(),
                    iteration: Some(1),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now,
                    error: None,
                },
            );
        Ok(())
    }

    pub fn start(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
        self.start_internal(request, false)
            .map(|(statuses, _)| statuses)
    }

    pub fn toggle(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
        let _toggle = self
            .shared
            .toggle_serial
            .lock()
            .map_err(|_| CoreError::Internal("macro toggle lock poisoned".to_owned()))?;
        let macro_id = request.macro_id.clone();
        let running = !self
            .controls_matching(|control| {
                control
                    .macro_ids
                    .lock()
                    .is_ok_and(|ids| ids.contains(&macro_id))
            })?
            .is_empty();
        if running {
            self.stop_macro(&macro_id)?;
            return Ok(Vec::new());
        }
        self.start_internal(request, false)
            .map(|(statuses, _)| statuses)
    }

    pub fn press(&self, request: MacroPressRequest) -> CoreResult<Vec<MacroRunStatus>> {
        validate_press_id(&request.press_id)?;
        let source_role_id = request.start.source_role_id.as_deref().ok_or_else(|| {
            CoreError::InvalidInput("macro press requires sourceRoleId".to_owned())
        })?;
        let lease_key = lease_key(source_role_id, &request.start.macro_id);
        let release_key =
            early_release_key(source_role_id, &request.start.macro_id, &request.press_id);
        let mut early_release = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .early_releases
            .remove(&release_key);
        if early_release.as_deref() == Some("immediate") {
            return Ok(Vec::new());
        }
        {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if let Some(existing) = inner.leases.get(&lease_key) {
                if existing.press_id == request.press_id {
                    return Ok(inner
                        .statuses
                        .values()
                        .filter(|status| status.macro_id == request.start.macro_id)
                        .cloned()
                        .collect());
                }
                return Err(CoreError::InvalidInput(
                    "macro shortcut is already held for this role".to_owned(),
                ));
            }
        }
        let macro_definition = request
            .start
            .macros
            .iter()
            .find(|definition| definition.id == request.start.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        if macro_definition
            .activation_mode
            .as_deref()
            .unwrap_or("toggle")
            != "while_held"
        {
            return Err(CoreError::InvalidInput(
                "macro does not use while-held activation".to_owned(),
            ));
        }
        let press_id = request.press_id;
        let (statuses, control) = self.start_internal(request.start, true)?;
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            early_release = inner.early_releases.remove(&release_key).or(early_release);
        }
        if early_release.as_deref() == Some("immediate") {
            cancel_control(&control);
            wait_finished(&control)?;
            return Ok(Vec::new());
        }
        if early_release.as_deref() == Some("complete_first_iteration") {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
        }
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .leases
            .insert(
                lease_key,
                HeldLease {
                    invocation_id: control.id.clone(),
                    press_id,
                },
            );
        mark_invocation_ready(&control);
        Ok(statuses)
    }

    pub fn release(&self, request: MacroReleaseRequest) -> CoreResult<()> {
        validate_press_id(&request.press_id)?;
        if !matches!(
            request.mode.as_str(),
            "complete_first_iteration" | "immediate"
        ) {
            return Err(CoreError::InvalidInput(
                "macro release mode is invalid".to_owned(),
            ));
        }
        let key = lease_key(&request.source_role_id, &request.macro_id);
        let control = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let Some(lease) = inner.leases.get(&key) else {
                inner.early_releases.insert(
                    early_release_key(
                        &request.source_role_id,
                        &request.macro_id,
                        &request.press_id,
                    ),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            };
            if lease.press_id != request.press_id {
                inner.early_releases.insert(
                    early_release_key(
                        &request.source_role_id,
                        &request.macro_id,
                        &request.press_id,
                    ),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            }
            let invocation_id = lease.invocation_id.clone();
            inner.leases.remove(&key);
            inner.invocations.get(&invocation_id).cloned()
        };
        let Some(control) = control else {
            return Ok(());
        };
        if request.mode == "immediate" || control.first_iteration_completed.load(Ordering::Acquire)
        {
            cancel_control(&control);
            wait_finished(&control)?;
        } else {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
            wait_finished(&control)?;
        }
        Ok(())
    }

    pub fn stop_macro(&self, macro_id: &str) -> CoreResult<()> {
        let controls = self.controls_matching(|control| {
            control
                .macro_ids
                .lock()
                .is_ok_and(|ids| ids.contains(macro_id))
        })?;
        cancel_and_wait_all(&controls)?;
        self.remove_statuses(|status| status.macro_id == macro_id)?;
        Ok(())
    }

    pub fn stop_macro_from_role(&self, macro_id: &str, _source_role_id: &str) -> CoreResult<()> {
        self.stop_macro(macro_id)
    }

    pub fn stop_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_role_matching(role_id, None)
    }

    /// Fences new work for a role and requests cancellation without waiting for
    /// every invocation worker to finish its bounded native cleanup.
    ///
    /// Browser teardown must be able to proceed while a worker is unwinding: the
    /// cancellation flag is the safety boundary, whereas joining the worker is
    /// resource cleanup and can take up to `INVOCATION_STOP_TIMEOUT`.
    pub fn request_stop_role(&self, role_id: &str) -> CoreResult<()> {
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner.stopping_role_ids.insert(role_id.to_owned());
            inner
                .invocations
                .values()
                .filter(|control| control.role_ids.contains(role_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        controls.iter().for_each(|control| cancel_control(control));
        Ok(())
    }

    pub fn allow_role_after_launch(&self, role_id: &str) {
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.stopping_role_ids.remove(role_id);
        }
    }

    pub fn release_role(&self, role_id: &str) -> CoreResult<()> {
        let releases = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner
                .leases
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{role_id}|")))
                .map(|(key, lease)| (key.clone(), lease.invocation_id.clone()))
                .collect::<Vec<_>>()
        };
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            releases
                .into_iter()
                .filter_map(|(key, invocation_id)| {
                    inner.leases.remove(&key);
                    inner.invocations.get(&invocation_id).cloned()
                })
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls)?;
        Ok(())
    }

    pub fn statuses(&self) -> CoreResult<Vec<MacroRunStatus>> {
        let mut statuses = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .values()
            .cloned()
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.role_id.cmp(&right.role_id))
                .then_with(|| left.macro_id.cmp(&right.macro_id))
        });
        Ok(statuses)
    }

    pub fn acquire_mutation(
        &self,
        macro_ids: Vec<String>,
        stop_active: bool,
    ) -> CoreResult<String> {
        let macro_ids = macro_ids
            .into_iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>();
        if macro_ids.is_empty() {
            return Err(CoreError::InvalidInput(
                "macro mutation requires at least one macro id".to_owned(),
            ));
        }
        let lease_id = format!(
            "macro-mutation-{}",
            self.shared.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if !inner.mutating_macro_ids.is_disjoint(&macro_ids) {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "Another macro mutation is already in progress.".to_owned(),
                });
            }
            let active = inner.statuses.values().any(|status| {
                macro_ids.contains(&status.macro_id)
                    && matches!(status.state.as_str(), "running" | "stopping")
            });
            if active && !stop_active {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "Stop affected macros before importing.".to_owned(),
                });
            }
            let controls = inner
                .invocations
                .values()
                .filter(|control| {
                    control
                        .macro_ids
                        .lock()
                        .is_ok_and(|ids| !ids.is_disjoint(&macro_ids))
                })
                .cloned()
                .collect::<Vec<_>>();
            inner.mutating_macro_ids.extend(macro_ids.iter().cloned());
            inner
                .mutation_leases
                .insert(lease_id.clone(), macro_ids.clone());
            controls
        };
        if stop_active {
            if let Err(error) = cancel_and_wait_all(&controls) {
                if let Ok(mut inner) = self.shared.inner.lock() {
                    inner.mutation_leases.remove(&lease_id);
                    for id in &macro_ids {
                        inner.mutating_macro_ids.remove(id);
                    }
                }
                return Err(error);
            }
            self.remove_statuses(|status| macro_ids.contains(&status.macro_id))?;
        }
        Ok(lease_id)
    }

    pub fn release_mutation(&self, lease_id: &str) -> CoreResult<()> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        let ids = inner.mutation_leases.remove(lease_id).ok_or_else(|| {
            CoreError::InvalidInput("macro mutation lease was not found".to_owned())
        })?;
        for id in ids {
            inner.mutating_macro_ids.remove(&id);
        }
        Ok(())
    }

    pub fn dispatch_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        for result in results {
            validate_result(&result)?;
            if let Some(sender) = self
                .shared
                .pending
                .lock()
                .map_err(|_| CoreError::Internal("macro result lock poisoned".to_owned()))?
                .remove(&result.request_id)
            {
                let _ = sender.send(result);
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if self.shared.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let controls = self
            .shared
            .inner
            .lock()
            .map(|inner| inner.invocations.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let _ = cancel_and_wait_all(&controls);
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.held_keys.clear();
            inner.invocations.clear();
            inner.leases.clear();
            inner.early_releases.clear();
            inner.mutation_leases.clear();
            inner.mutating_macro_ids.clear();
            inner.stopping_role_ids.clear();
            inner.statuses.clear();
        }
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.clear();
        }
    }

    fn start_internal(
        &self,
        request: MacroStartRequest,
        defer_execution: bool,
    ) -> CoreResult<(Vec<MacroRunStatus>, Arc<InvocationControl>)> {
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        validate_start_request(&request)?;
        let macros = request
            .macros
            .into_iter()
            .map(|definition| (definition.id.clone(), definition))
            .collect::<HashMap<_, _>>();
        let root = macros
            .get(&request.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        let invocation_macro_ids = collect_invocation_macro_ids(&request.macro_id, &macros);
        if !root.enabled {
            return Err(CoreError::InvalidInput(DISABLED_MACRO_MESSAGE.to_owned()));
        }
        if invocation_macro_ids.iter().any(|macro_id| {
            macros
                .get(macro_id)
                .is_some_and(|definition| definition.role_ids.is_empty())
        }) {
            return Err(CoreError::InvalidInput(
                UNASSIGNED_WORKFLOW_MESSAGE.to_owned(),
            ));
        }
        if let Some(source_role_id) = &request.source_role_id
            && !root.role_ids.contains(source_role_id)
        {
            return Err(CoreError::InvalidInput(
                "macro is not assigned to the requested role".to_owned(),
            ));
        }
        let active_role_ids = request.active_role_ids.into_iter().collect::<HashSet<_>>();
        let roles = assigned_active_roles(root, &active_role_ids);
        if roles.is_empty() {
            return Err(CoreError::InvalidInput(UNAVAILABLE_ROLE_MESSAGE.to_owned()));
        }
        let invocation_number = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let invocation_id = format!("macro-invocation-{invocation_number}");
        let control = new_invocation_control(
            invocation_id.clone(),
            request.macro_id.clone(),
            roles.iter().cloned().collect(),
        );
        let started_at = Utc::now().to_rfc3339();
        let statuses = roles
            .iter()
            .map(|role_id| MacroRunStatus {
                role_id: role_id.clone(),
                macro_id: request.macro_id.clone(),
                state: "running".to_owned(),
                iteration: Some(0),
                last_click: None,
                started_at: started_at.clone(),
                updated_at: started_at.clone(),
                error: None,
            })
            .collect::<Vec<_>>();
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if !inner.mutating_macro_ids.is_disjoint(&invocation_macro_ids) {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "The macro is being changed and cannot be started.".to_owned(),
                });
            }
            if roles
                .iter()
                .any(|role_id| inner.stopping_role_ids.contains(role_id))
            {
                return Err(CoreError::Domain {
                    code: "MACRO_ROLE_STOPPING",
                    message: STOPPING_ROLE_MESSAGE.to_owned(),
                });
            }
            if inner.invocations.len() >= MAX_ACTIVE_INVOCATIONS {
                return Err(CoreError::InvalidInput(
                    "too many macro invocations are active".to_owned(),
                ));
            }
            if inner.invocations.values().any(|existing| {
                existing
                    .macro_ids
                    .lock()
                    .is_ok_and(|ids| ids.contains(&request.macro_id))
            }) {
                return Err(CoreError::InvalidInput(
                    "macro is already running for this role".to_owned(),
                ));
            }
            inner.statuses.retain(|_, status| {
                status.macro_id != request.macro_id || !roles.contains(&status.role_id)
            });
            inner
                .invocations
                .insert(invocation_id.clone(), Arc::clone(&control));
        }
        let focus_actions = roles
            .iter()
            .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
            .collect();
        if let Err(error) =
            perform_actions_with_control(&self.shared, &control, focus_actions, false)
        {
            discard_unstarted_invocation(&self.shared, &control);
            return Err(CoreError::Domain {
                code: "MACRO_INPUT_FAILED",
                message: error,
            });
        }
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if control.cancelled.load(Ordering::Acquire) {
                drop(inner);
                discard_unstarted_invocation(&self.shared, &control);
                return Err(CoreError::InvalidInput("macro run cancelled".to_owned()));
            }
            for status in &statuses {
                inner.statuses.insert(
                    status_key(&invocation_id, &status.role_id, &status.macro_id),
                    status.clone(),
                );
            }
        }
        self.emit_statuses();
        let shared = Arc::clone(&self.shared);
        let macro_id = request.macro_id;
        let context = ExecutionContext {
            active_role_ids: Arc::new(active_role_ids),
            control: Arc::clone(&control),
            macros: Arc::new(macros),
            settings: request.settings,
            waiter: Arc::clone(&self.shared.waiter),
        };
        let control_for_run = Arc::clone(&control);
        let worker = thread::Builder::new()
            .name(format!("rion-macro-{invocation_number}"))
            .spawn(move || {
                let result = wait_for_invocation_ready(&control_for_run).and_then(|_| {
                    execute_macro(
                        &shared,
                        &context,
                        &macro_id,
                        &roles,
                        &mut Vec::new(),
                        true,
                        false,
                    )
                });
                finish_invocation(&shared, &context.control, result);
            })
            .map_err(|error| {
                discard_unstarted_invocation(&self.shared, &control);
                CoreError::Internal(error.to_string())
            })?;
        *control
            .worker
            .lock()
            .map_err(|_| CoreError::Internal("macro worker lock poisoned".to_owned()))? =
            Some(worker);
        if !defer_execution {
            mark_invocation_ready(&control);
        }
        Ok((statuses, control))
    }

    fn controls_matching(
        &self,
        predicate: impl Fn(&InvocationControl) -> bool,
    ) -> CoreResult<Vec<Arc<InvocationControl>>> {
        Ok(self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .invocations
            .values()
            .filter(|control| predicate(control))
            .cloned()
            .collect())
    }

    fn remove_statuses(&self, predicate: impl Fn(&MacroRunStatus) -> bool) -> CoreResult<()> {
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .retain(|_, status| !predicate(status));
        self.emit_statuses();
        Ok(())
    }

}
