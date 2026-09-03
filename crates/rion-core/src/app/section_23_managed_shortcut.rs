const MAX_MANAGED_SHORTCUT_RECEIPTS: usize = 4_096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActiveManagedShortcutState {
    Provisional,
    Held,
    Uncertain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ActiveManagedShortcut {
    code: String,
    document_instance_id: String,
    expected_owner_generation: u64,
    macro_id: String,
    modifier_codes: Vec<String>,
    press_id: String,
    role_id: String,
    surface_generation: u64,
    tab_id: String,
    state: ActiveManagedShortcutState,
}

#[derive(Default)]
struct ManagedShortcutRuntime {
    active_by_shortcut: std::collections::HashMap<String, ActiveManagedShortcut>,
    receipt_operation_order: std::collections::VecDeque<String>,
    receipts_by_operation:
        std::collections::HashMap<String, crate::model::ManagedShortcutPhaseReceiptRecord>,
    operation_by_phase_key: std::collections::HashMap<String, String>,
    role_locks: std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>,
}

impl ManagedShortcutRuntime {
    fn role_lock(&mut self, role_id: &str) -> Arc<Mutex<()>> {
        self.role_locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = self
            .role_locks
            .get(role_id)
            .and_then(std::sync::Weak::upgrade)
        {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        self.role_locks
            .insert(role_id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn remember(
        &mut self,
        phase_key: Option<String>,
        receipt: crate::model::ManagedShortcutPhaseReceiptRecord,
    ) {
        if self
            .receipts_by_operation
            .contains_key(&receipt.operation_id)
        {
            return;
        }
        if let Some(phase_key) = phase_key {
            self.operation_by_phase_key
                .entry(phase_key)
                .or_insert_with(|| receipt.operation_id.clone());
        }
        self.receipt_operation_order
            .push_back(receipt.operation_id.clone());
        self.receipts_by_operation
            .insert(receipt.operation_id.clone(), receipt);
        while self.receipts_by_operation.len() > MAX_MANAGED_SHORTCUT_RECEIPTS {
            let Some(operation_id) = self.receipt_operation_order.pop_front() else {
                break;
            };
            self.receipts_by_operation.remove(&operation_id);
            self.operation_by_phase_key
                .retain(|_, retained| retained != &operation_id);
        }
    }
}

#[derive(Clone)]
struct ManagedShortcutPhaseInput {
    operation_id: String,
    role_id: String,
    tab_id: String,
    surface_generation: u64,
    document_instance_id: String,
    expected_owner_generation: u64,
    press_id: String,
    macro_id: String,
    code: String,
    phase: String,
    modifier_codes: Vec<String>,
}

impl ManagedShortcutPhaseInput {
    fn validate(&self) -> CoreResult<()> {
        for (value, name, maximum) in [
            (&self.operation_id, "operationId", 256),
            (&self.role_id, "roleId", 256),
            (&self.tab_id, "tabId", 256),
            (&self.document_instance_id, "documentInstanceId", 256),
            (&self.press_id, "pressId", 160),
            (&self.macro_id, "macroId", 256),
            (&self.code, "code", 64),
        ] {
            if value.is_empty()
                || value.len() > maximum
                || value.trim() != value
                || value.chars().any(|character| character.is_control())
            {
                return Err(CoreError::Domain {
                    code: "MANAGED_SHORTCUT_INVALID",
                    message: format!("Managed shortcut {name} is invalid."),
                });
            }
        }
        if self.surface_generation == 0
            || self.expected_owner_generation == 0
            || !matches!(self.phase.as_str(), "replay" | "keyDown" | "keyUp")
            || self.modifier_codes.len() > 4
        {
            return Err(CoreError::Domain {
                code: "MANAGED_SHORTCUT_INVALID",
                message: "Managed shortcut phase or surface generation is invalid.".to_owned(),
            });
        }
        let mut seen = std::collections::HashSet::new();
        if self.modifier_codes.iter().any(|code| {
            !matches!(
                code.as_str(),
                "AltLeft"
                    | "AltRight"
                    | "ControlLeft"
                    | "ControlRight"
                    | "MetaLeft"
                    | "MetaRight"
                    | "ShiftLeft"
                    | "ShiftRight"
            ) || !seen.insert(code)
        }) {
            return Err(CoreError::Domain {
                code: "MANAGED_SHORTCUT_INVALID",
                message: "Managed shortcut modifiers are invalid.".to_owned(),
            });
        }
        Ok(())
    }

    fn active(&self, state: ActiveManagedShortcutState) -> ActiveManagedShortcut {
        ActiveManagedShortcut {
            code: self.code.clone(),
            document_instance_id: self.document_instance_id.clone(),
            expected_owner_generation: self.expected_owner_generation,
            macro_id: self.macro_id.clone(),
            modifier_codes: self.modifier_codes.clone(),
            press_id: self.press_id.clone(),
            role_id: self.role_id.clone(),
            surface_generation: self.surface_generation,
            tab_id: self.tab_id.clone(),
            state,
        }
    }

    fn phase_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.role_id,
            self.tab_id,
            self.surface_generation,
            self.document_instance_id,
            self.expected_owner_generation,
            self.macro_id,
            self.code,
            self.press_id,
            self.phase
        )
    }

    fn shortcut_key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.role_id, self.macro_id, self.code)
    }

    fn matches_active(&self, active: &ActiveManagedShortcut) -> bool {
        active.code == self.code
            && active.document_instance_id == self.document_instance_id
            && active.expected_owner_generation == self.expected_owner_generation
            && active.macro_id == self.macro_id
            && active.press_id == self.press_id
            && active.role_id == self.role_id
            && active.surface_generation == self.surface_generation
            && active.tab_id == self.tab_id
    }

    fn receipt(
        &self,
        status: &str,
        request_ids: Vec<String>,
    ) -> crate::model::ManagedShortcutPhaseReceiptRecord {
        crate::model::ManagedShortcutPhaseReceiptRecord {
            code: self.code.clone(),
            document_instance_id: self.document_instance_id.clone(),
            expected_owner_generation: self.expected_owner_generation,
            macro_id: self.macro_id.clone(),
            operation_id: self.operation_id.clone(),
            phase: self.phase.clone(),
            press_id: self.press_id.clone(),
            request_ids,
            role_id: self.role_id.clone(),
            status: status.to_owned(),
            surface_generation: self.surface_generation,
            tab_id: self.tab_id.clone(),
        }
    }
}

impl AppCore {
    fn dispatch_managed_shortcut_phase(
        &self,
        input: ManagedShortcutPhaseInput,
    ) -> CoreResult<crate::model::ManagedShortcutPhaseReceiptRecord> {
        input.validate()?;
        let role_lock = self
            .managed_shortcut_runtime
            .lock()
            .map_err(|_| CoreError::Internal("managed shortcut runtime lock poisoned".to_owned()))?
            .role_lock(&input.role_id);
        let _role_guard = role_lock
            .lock()
            .map_err(|_| CoreError::Internal("managed shortcut role lock poisoned".to_owned()))?;
        let phase_key = input.phase_key();
        {
            let mut runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
                CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
            })?;
            if let Some(receipt) = runtime.receipts_by_operation.get(&input.operation_id) {
                let exact = receipt.role_id == input.role_id
                    && receipt.tab_id == input.tab_id
                    && receipt.surface_generation == input.surface_generation
                    && receipt.document_instance_id == input.document_instance_id
                    && receipt.expected_owner_generation == input.expected_owner_generation
                    && receipt.press_id == input.press_id
                    && receipt.macro_id == input.macro_id
                    && receipt.code == input.code
                    && receipt.phase == input.phase;
                if !exact {
                    return Err(CoreError::Domain {
                        code: "MANAGED_SHORTCUT_OPERATION_REUSED",
                        message: "The managed shortcut operation identity was reused.".to_owned(),
                    });
                }
                let mut duplicate = receipt.clone();
                duplicate.status = "duplicate".to_owned();
                return Ok(duplicate);
            }
            if let Some(operation_id) = runtime.operation_by_phase_key.get(&phase_key)
                && let Some(receipt) = runtime.receipts_by_operation.get(operation_id)
            {
                let mut duplicate = receipt.clone();
                duplicate.operation_id = input.operation_id.clone();
                duplicate.status = "duplicate".to_owned();
                runtime.remember(None, duplicate.clone());
                return Ok(duplicate);
            }
        }
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let runtime_snapshot = self.browser_runtime.snapshot()?;
        let owner_is_current = runtime_snapshot.browser_runtime.roles.iter().any(|role| {
            role.role_id == input.role_id
                && role.runtime == "embedded"
                && role.state == "running"
                && role.owner.tab_id == input.tab_id
                && role.owner.generation == input.expected_owner_generation
        });
        let owner_tab_is_active = runtime_snapshot
            .windows
            .values()
            .any(|window| window.selected_tab_id.as_deref() == Some(input.tab_id.as_str()));
        let requires_active_owner = input.phase != "keyUp";
        if !owner_is_current || (requires_active_owner && !owner_tab_is_active) {
            let receipt = input.receipt("superseded", Vec::new());
            self.managed_shortcut_runtime
                .lock()
                .map_err(|_| {
                    CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
                })?
                .remember(None, receipt.clone());
            return Ok(receipt);
        }
        {
            let mut runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
                CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
            })?;
            let shortcut_key = input.shortcut_key();
            let active = runtime.active_by_shortcut.get(&shortcut_key);
            let exact_active = active.is_some_and(|active| input.matches_active(active));
            let superseded = match input.phase.as_str() {
                "keyDown" => active.is_some(),
                "keyUp" => !exact_active,
                "replay" => active.is_some(),
                _ => unreachable!(),
            };
            if superseded {
                let receipt = input.receipt("superseded", Vec::new());
                runtime.remember(None, receipt.clone());
                return Ok(receipt);
            }
            if input.phase == "keyDown" {
                runtime.active_by_shortcut.insert(
                    shortcut_key,
                    input.active(ActiveManagedShortcutState::Provisional),
                );
            }
        }

        let request_ids =
            match self
                .macro_runtime
                .dispatch_managed_shortcut_phase(ManagedShortcutPhaseDispatch {
                    operation_id: &input.operation_id,
                    role_id: &input.role_id,
                    surface_generation: input.surface_generation,
                    document_instance_id: &input.document_instance_id,
                    press_id: &input.press_id,
                    code: &input.code,
                    phase: &input.phase,
                    modifier_codes: &input.modifier_codes,
                }) {
                Ok(request_ids) => request_ids,
                Err(error) => {
                    if input.phase == "keyDown" {
                        let mut runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
                            CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
                        })?;
                        let shortcut_key = input.shortcut_key();
                        if let Some(active) = runtime.active_by_shortcut.get_mut(&shortcut_key)
                            && input.matches_active(active)
                        {
                            if error.code() == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                                active.state = ActiveManagedShortcutState::Uncertain;
                            } else {
                                runtime.active_by_shortcut.remove(&shortcut_key);
                            }
                        }
                    }
                    return Err(error);
                }
            };
        let receipt = input.receipt("accepted", request_ids);
        let mut runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
            CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
        })?;
        match input.phase.as_str() {
            "keyDown" => {
                if let Some(active) = runtime.active_by_shortcut.get_mut(&input.shortcut_key())
                    && input.matches_active(active)
                {
                    active.state = ActiveManagedShortcutState::Held;
                }
            }
            "keyUp" => {
                runtime.active_by_shortcut.remove(&input.shortcut_key());
            }
            "replay" => {}
            _ => unreachable!(),
        }
        runtime.remember(Some(phase_key), receipt.clone());
        Ok(receipt)
    }

    fn validate_managed_shortcut_surface_retirement(
        role_id: &str,
        surface_generation: u64,
        document_instance_id: &str,
    ) -> CoreResult<()> {
        ManagedShortcutPhaseInput {
            operation_id: "retire-validation".to_owned(),
            role_id: role_id.to_owned(),
            tab_id: "retire-validation".to_owned(),
            surface_generation,
            document_instance_id: document_instance_id.to_owned(),
            expected_owner_generation: 1,
            press_id: "retire-validation".to_owned(),
            macro_id: "retire-validation".to_owned(),
            code: "retire-validation".to_owned(),
            phase: "keyUp".to_owned(),
            modifier_codes: Vec::new(),
        }
        .validate()
    }

    fn retire_managed_shortcut_surface(
        &self,
        role_id: &str,
        surface_generation: u64,
        document_instance_id: &str,
    ) -> CoreResult<crate::model::ManagedShortcutSurfaceRetirementReceiptRecord> {
        Self::validate_managed_shortcut_surface_retirement(
            role_id,
            surface_generation,
            document_instance_id,
        )?;
        let role_lock = self
            .managed_shortcut_runtime
            .lock()
            .map_err(|_| CoreError::Internal("managed shortcut runtime lock poisoned".to_owned()))?
            .role_lock(role_id);
        let _role_guard = role_lock
            .lock()
            .map_err(|_| CoreError::Internal("managed shortcut role lock poisoned".to_owned()))?;
        let active = {
            let runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
                CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
            })?;
            runtime
                .active_by_shortcut
                .values()
                .filter(|active| {
                    active.role_id == role_id
                        && active.surface_generation == surface_generation
                        && active.document_instance_id == document_instance_id
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let cleanup_request_ids = self.macro_runtime.retire_managed_shortcut_surface(
            role_id,
            surface_generation,
            document_instance_id,
            &active
                .iter()
                .map(|active| {
                    (
                        active.press_id.clone(),
                        active.code.clone(),
                        active.modifier_codes.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        )?;
        let mut runtime = self.managed_shortcut_runtime.lock().map_err(|_| {
            CoreError::Internal("managed shortcut runtime lock poisoned".to_owned())
        })?;
        let mut retired_press_ids = active
            .iter()
            .map(|active| active.press_id.clone())
            .collect::<Vec<_>>();
        retired_press_ids.sort();
        retired_press_ids.dedup();
        runtime.active_by_shortcut.retain(|_, active| {
            active.role_id != role_id
                || active.surface_generation != surface_generation
                || active.document_instance_id != document_instance_id
        });
        Ok(
            crate::model::ManagedShortcutSurfaceRetirementReceiptRecord {
                cleanup_request_ids,
                document_instance_id: document_instance_id.to_owned(),
                retired_press_ids,
                role_id: role_id.to_owned(),
                surface_generation,
                terminal: true,
            },
        )
    }
}
