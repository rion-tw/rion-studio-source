const INPUT_CLEANUP_RECEIPT_CAPACITY: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ManagedShortcutPressLease {
    code: String,
    input_epoch: u64,
    macro_id: String,
    modifier_codes: Vec<String>,
    press_id: String,
    role_id: String,
    surface_generation: u64,
    webview_label: String,
}

impl ManagedShortcutPressLease {
    fn matches(
        &self,
        webview_label: &str,
        role_id: &str,
        press_id: &str,
        macro_id: &str,
        code: &str,
        modifier_codes: &[String],
    ) -> bool {
        self.webview_label == webview_label
            && self.role_id == role_id
            && self.press_id == press_id
            && self.macro_id == macro_id
            && self.code == code
            && self.modifier_codes == modifier_codes
    }

    fn matches_input_context(
        &self,
        webview_label: &str,
        role_id: &str,
        surface_generation: u64,
        input_epoch: u64,
    ) -> bool {
        self.webview_label == webview_label
            && self.role_id == role_id
            && self.surface_generation == surface_generation
            && input_epoch >= self.input_epoch
    }
}

#[derive(Default)]
struct ManagedShortcutPressRegistry {
    active: HashMap<String, ManagedShortcutPressLease>,
    completed: VecDeque<ManagedShortcutPressLease>,
}

impl ManagedShortcutPressRegistry {
    fn matching(
        &self,
        press_id: &str,
    ) -> Option<(&ManagedShortcutPressLease, bool)> {
        self.active
            .get(press_id)
            .map(|lease| (lease, false))
            .or_else(|| {
                self.completed
                    .iter()
                    .find(|lease| lease.press_id == press_id)
                    .map(|lease| (lease, true))
            })
    }

    fn insert(&mut self, lease: ManagedShortcutPressLease) {
        self.active.insert(lease.press_id.clone(), lease);
    }

    fn complete(&mut self, press_id: &str) {
        let Some(lease) = self.active.remove(press_id) else {
            return;
        };
        self.completed.push_back(lease);
        while self.completed.len() > INPUT_CLEANUP_RECEIPT_CAPACITY {
            self.completed.pop_front();
        }
    }

    fn active_for_role(&self, role_id: &str) -> Vec<ManagedShortcutPressLease> {
        let mut leases = self
            .active
            .values()
            .filter(|lease| lease.role_id == role_id)
            .cloned()
            .collect::<Vec<_>>();
        leases.sort_by(|left, right| left.press_id.cmp(&right.press_id));
        leases
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PhysicalKeyCleanupReceipt {
    codes: Vec<String>,
    handoff_owned_codes: Vec<String>,
    release_id: String,
    released_codes: Vec<String>,
    role_id: String,
    surface_generation: u64,
    webview_label: String,
}

impl PhysicalKeyCleanupReceipt {
    fn matches_request(
        &self,
        codes: &[String],
        role_id: &str,
        surface_generation: u64,
        webview_label: &str,
    ) -> bool {
        self.codes == codes
            && self.role_id == role_id
            && self.surface_generation == surface_generation
            && self.webview_label == webview_label
    }

    fn acknowledgement(&self) -> PhysicalKeyCleanupAcknowledgement {
        PhysicalKeyCleanupAcknowledgement {
            handoff_owned_codes: self.handoff_owned_codes.clone(),
            released_codes: self.released_codes.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhysicalKeyCleanupAcknowledgement {
    handoff_owned_codes: Vec<String>,
    released_codes: Vec<String>,
}

pub(crate) struct ManagedShortcutKeyPhaseDispatch {
    pub(crate) code: String,
    pub(crate) macro_id: String,
    pub(crate) modifier_codes: Vec<String>,
    pub(crate) phase: String,
    pub(crate) press_id: String,
    pub(crate) role_id: String,
    pub(crate) webview_label: String,
}

#[derive(Default)]
struct PhysicalKeyCleanupRegistry {
    completed: VecDeque<PhysicalKeyCleanupReceipt>,
}

impl PhysicalKeyCleanupRegistry {
    fn matching(&self, release_id: &str) -> Option<&PhysicalKeyCleanupReceipt> {
        self.completed
            .iter()
            .find(|receipt| receipt.release_id == release_id)
    }

    fn complete(&mut self, receipt: PhysicalKeyCleanupReceipt) {
        self.completed.push_back(receipt);
        while self.completed.len() > INPUT_CLEANUP_RECEIPT_CAPACITY {
            self.completed.pop_front();
        }
    }
}

#[derive(Default)]
struct ShortcutModifierCleanupRegistry {
    claimed_active: HashSet<(String, String)>,
    completed: VecDeque<RuntimeShortcutModifierHandoff>,
}

impl ShortcutModifierCleanupRegistry {
    fn claim_active(&mut self, handoff: &RuntimeShortcutModifierHandoff) {
        self.claimed_active
            .insert((handoff.window_id.clone(), handoff.source_tab_id.clone()));
    }

    fn take_completed_for_tab(
        &mut self,
        source_tab_id: &str,
    ) -> Option<RuntimeShortcutModifierHandoff> {
        let index = self
            .completed
            .iter()
            .position(|handoff| handoff.source_tab_id == source_tab_id)?;
        self.completed.remove(index)
    }

    fn remember_completed(&mut self, handoff: &RuntimeShortcutModifierHandoff) {
        let key = (handoff.window_id.clone(), handoff.source_tab_id.clone());
        if self.claimed_active.remove(&key) {
            return;
        }
        self.completed.push_back(handoff.clone());
        while self.completed.len() > INPUT_CLEANUP_RECEIPT_CAPACITY {
            self.completed.pop_front();
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn dispatch_managed_shortcut_key_phase(
        &self,
        request: ManagedShortcutKeyPhaseDispatch,
    ) -> RuntimeResult<()> {
        let ManagedShortcutKeyPhaseDispatch {
            code,
            macro_id,
            modifier_codes,
            phase,
            press_id,
            role_id,
            webview_label,
        } = request;
        if phase != "keyUp"
            && !self
                .overlay_webview_is_selected(&webview_label, &role_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_MANAGED_SHORTCUT_FOCUS_STATE_FAILED", message)
                })?
        {
            return Err(RuntimeError::new(
                "SYSTEM_MANAGED_SHORTCUT_UNAUTHORIZED",
                "Managed shortcuts are restricted to the selected role WebView.",
            ));
        }
        if phase == "keyUp" {
            return self.release_managed_shortcut_press(
                &webview_label,
                &role_id,
                &press_id,
                &macro_id,
                &code,
                &modifier_codes,
            );
        }
        self.with_role_input_lane(&role_id, || {
            if phase == "keyDown" {
                let registry = self.managed_shortcut_presses.lock().map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                        "The managed shortcut press registry is unavailable.",
                    )
                })?;
                if let Some((lease, _completed)) = registry.matching(&press_id) {
                    return if lease.matches(
                        &webview_label,
                        &role_id,
                        &press_id,
                        &macro_id,
                        &code,
                        &modifier_codes,
                    ) {
                        Ok(())
                    } else {
                        Err(managed_shortcut_lease_mismatch())
                    };
                }
            }
            let context = self.current_input_context(&role_id, "normal")?;
            let webview = self.role_webview_for_input(&role_id, &context)?;
            if webview.label() != webview_label {
                return Err(managed_shortcut_lease_mismatch());
            }
            self.dispatch_managed_shortcut_effects_in_lane(
                &role_id,
                &webview,
                &code,
                &phase,
                modifier_codes.clone(),
                &context,
            )?;
            if phase == "keyDown" {
                let lease = ManagedShortcutPressLease {
                    code: code.clone(),
                    input_epoch: context.input_epoch,
                    macro_id: macro_id.clone(),
                    modifier_codes,
                    press_id: press_id.clone(),
                    role_id: role_id.clone(),
                    surface_generation: context.surface_generation,
                    webview_label: webview_label.clone(),
                };
                self.managed_shortcut_presses
                    .lock()
                    .map_err(|_| {
                        RuntimeError::new(
                            "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                            "The managed shortcut press registry is unavailable.",
                        )
                    })?
                    .insert(lease);
            }
            Ok(())
        })
    }

    fn dispatch_managed_shortcut_effects_in_lane(
        &self,
        role_id: &str,
        webview: &Webview,
        code: &str,
        phase: &str,
        modifier_codes: Vec<String>,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        let mut executed = Vec::new();
        for effect in managed_shortcut_key_effects(code, phase, modifier_codes)? {
            let dispatch_result = context.ensure_current().and_then(|()| {
                self.dispatch_guarded_macro_key_effect(role_id, webview, &effect, context)
            });
            if let Err(mut error) = dispatch_result {
                if let Some(cleanup_error) =
                    self.compensate_key_prefix(role_id, webview, &executed, context)
                {
                    if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                        error = RuntimeError::new(
                            "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                            format!(
                                "{}; managed shortcut cleanup also failed: {}",
                                error.message, cleanup_error.message
                            ),
                        );
                    } else if cleanup_error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                        error = cleanup_error;
                    }
                }
                if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
                    && !error.input_neutrality_confirmed()
                {
                    self.quarantine_role_input(role_id, &error);
                }
                return Err(error);
            }
            executed.push(effect);
        }
        Ok(())
    }

    fn release_managed_shortcut_press(
        &self,
        webview_label: &str,
        role_id: &str,
        press_id: &str,
        macro_id: &str,
        code: &str,
        modifier_codes: &[String],
    ) -> RuntimeResult<()> {
        self.with_role_input_lane(role_id, || {
            let lease = {
                let registry = self.managed_shortcut_presses.lock().map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                        "The managed shortcut press registry is unavailable.",
                    )
                })?;
                let Some((lease, completed)) = registry.matching(press_id) else {
                    return Err(RuntimeError::new(
                        "SYSTEM_MANAGED_SHORTCUT_LEASE_MISSING",
                        "The managed shortcut keyup has no matching native press lease.",
                    ));
                };
                if !lease.matches(
                    webview_label,
                    role_id,
                    press_id,
                    macro_id,
                    code,
                    modifier_codes,
                ) {
                    return Err(managed_shortcut_lease_mismatch());
                }
                if completed {
                    return Ok(());
                }
                lease.clone()
            };
            self.release_managed_shortcut_lease_in_lane(&lease)?;
            self.managed_shortcut_presses
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                        "The managed shortcut press registry is unavailable.",
                    )
                })?
                .complete(press_id);
            Ok(())
        })
    }

    fn release_managed_shortcut_lease_in_lane(
        &self,
        lease: &ManagedShortcutPressLease,
    ) -> RuntimeResult<()> {
        let context = self.current_input_context(&lease.role_id, "cleanup")?;
        let webview = self.role_webview_for_input(&lease.role_id, &context)?;
        if !lease.matches_input_context(
            webview.label(),
            &lease.role_id,
            context.surface_generation,
            context.input_epoch,
        ) {
            return Err(managed_shortcut_lease_mismatch());
        }
        self.dispatch_managed_shortcut_effects_in_lane(
            &lease.role_id,
            &webview,
            &lease.code,
            "keyUp",
            lease.modifier_codes.clone(),
            &context,
        )
    }

    fn drain_managed_shortcut_presses_in_lane(&self, role_id: &str) -> RuntimeResult<()> {
        let leases = self
            .managed_shortcut_presses
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                    "The managed shortcut press registry is unavailable.",
                )
            })?
            .active_for_role(role_id);
        for lease in leases {
            self.release_managed_shortcut_lease_in_lane(&lease)?;
            self.managed_shortcut_presses
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_MANAGED_SHORTCUT_UNAVAILABLE",
                        "The managed shortcut press registry is unavailable.",
                    )
                })?
                .complete(&lease.press_id);
        }
        Ok(())
    }

    pub(crate) fn cleanup_physical_keys_after_focus_departure(
        &self,
        webview_label: &str,
        role_id: &str,
        release_id: &str,
        codes: Vec<String>,
    ) -> RuntimeResult<PhysicalKeyCleanupAcknowledgement> {
        self.with_role_input_lane(role_id, || {
            let context = self.current_input_context(role_id, "cleanup")?;
            let webview = self.role_webview_for_input(role_id, &context)?;
            if webview.label() != webview_label {
                return Err(RuntimeError::new(
                    "SYSTEM_PHYSICAL_KEY_CLEANUP_STALE",
                    "The physical key cleanup belongs to an obsolete role surface.",
                ));
            }
            {
                let registry = self.physical_key_cleanups.lock().map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_PHYSICAL_KEY_CLEANUP_UNAVAILABLE",
                        "The physical key cleanup registry is unavailable.",
                    )
                })?;
                if let Some(completed) = registry.matching(release_id) {
                    return if completed.matches_request(
                        &codes,
                        role_id,
                        context.surface_generation,
                        webview_label,
                    ) {
                        Ok(completed.acknowledgement())
                    } else {
                        Err(RuntimeError::new(
                            "SYSTEM_PHYSICAL_KEY_CLEANUP_MISMATCH",
                            "The physical key cleanup releaseId was reused with different input.",
                        ))
                    };
                }
            }
            let owned_modifiers =
                self.claim_shortcut_handoff_modifiers(webview_label, &codes);
            let released_codes = codes
                .iter()
                .filter(|code| !owned_modifiers.contains(*code))
                .cloned()
                .collect::<Vec<_>>();
            let mut unproven_error = None;
            for effect in physical_key_cleanup_effects(&codes, &owned_modifiers) {
                if let Err(error) =
                    self.dispatch_guarded_macro_key_effect(role_id, &webview, &effect, &context)
                    && !error.input_neutrality_confirmed()
                    && unproven_error.is_none()
                {
                    unproven_error = Some(error);
                }
            }
            if let Some(error) = unproven_error {
                self.quarantine_role_input(role_id, &error);
                return Err(error);
            }
            let acknowledgement = PhysicalKeyCleanupAcknowledgement {
                handoff_owned_codes: codes
                    .iter()
                    .filter(|code| owned_modifiers.contains(*code))
                    .cloned()
                    .collect(),
                released_codes: released_codes.clone(),
            };
            let receipt = PhysicalKeyCleanupReceipt {
                codes,
                handoff_owned_codes: acknowledgement.handoff_owned_codes.clone(),
                release_id: release_id.to_owned(),
                released_codes,
                role_id: role_id.to_owned(),
                surface_generation: context.surface_generation,
                webview_label: webview_label.to_owned(),
            };
            self.physical_key_cleanups
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_PHYSICAL_KEY_CLEANUP_UNAVAILABLE",
                        "The physical key cleanup registry is unavailable.",
                    )
                })?
                .complete(receipt);
            Ok(acknowledgement)
        })
    }

    fn claim_shortcut_handoff_modifiers(
        &self,
        webview_label: &str,
        requested_codes: &[String],
    ) -> HashSet<String> {
        let source_tab_id = self.state.lock().ok().and_then(|state| {
            state.native_resources.tabs.iter().find_map(|(tab_id, tab)| {
                tab.roles
                    .values()
                    .any(|surface| surface.webview.label() == webview_label)
                    .then(|| tab_id.clone())
            })
        });
        let Some(source_tab_id) = source_tab_id else {
            return HashSet::new();
        };
        let active = self
            .shortcut_modifier_handoffs
            .lock()
            .ok()
            .and_then(|handoffs| {
                handoffs
                    .values()
                    .find(|handoff| handoff.source_tab_id == source_tab_id)
                    .cloned()
            });
        let handoff = if let Some(handoff) = active {
            if let Ok(mut cleanup) = self.shortcut_modifier_cleanups.lock() {
                cleanup.claim_active(&handoff);
            }
            Some(handoff)
        } else {
            self.shortcut_modifier_cleanups
                .lock()
                .ok()
                .and_then(|mut cleanup| cleanup.take_completed_for_tab(&source_tab_id))
        };
        let Some(handoff) = handoff else {
            return HashSet::new();
        };
        requested_codes
            .iter()
            .filter(|code| shortcut_handoff_owns_code(&handoff, code))
            .cloned()
            .collect()
    }

    fn remember_completed_shortcut_handoff(
        &self,
        handoff: &RuntimeShortcutModifierHandoff,
    ) {
        let Ok(mut cleanup) = self.shortcut_modifier_cleanups.lock() else {
            return;
        };
        cleanup.remember_completed(handoff);
    }
}

fn managed_shortcut_lease_mismatch() -> RuntimeError {
    RuntimeError::new(
        "SYSTEM_MANAGED_SHORTCUT_LEASE_MISMATCH",
        "The managed shortcut request does not match its native press lease.",
    )
}

fn physical_key_cleanup_effects(
    codes: &[String],
    handoff_owned_codes: &HashSet<String>,
) -> Vec<EmbeddedKeyEffectRecord> {
    let mut active = codes.iter().cloned().collect::<HashSet<_>>();
    codes
        .iter()
        .filter_map(|code| {
            let active_codes_before = sorted_input_codes(&active);
            active.remove(code);
            if handoff_owned_codes.contains(code) {
                return None;
            }
            Some(EmbeddedKeyEffectRecord {
                phase: "keyUp".to_owned(),
                code: code.clone(),
                active_codes_before,
                active_codes: sorted_input_codes(&active),
                auto_repeat: false,
                suppress_shortcut: !is_modifier_input_code(code),
            })
        })
        .collect()
}

fn shortcut_handoff_owns_code(
    handoff: &RuntimeShortcutModifierHandoff,
    code: &str,
) -> bool {
    #[cfg(windows)]
    {
        handoff.modifier_codes.iter().any(|owned| owned == code)
    }
    #[cfg(not(windows))]
    {
        let _ = handoff;
        matches!(
            code,
            "ControlLeft" | "ControlRight" | "ShiftLeft" | "ShiftRight"
        )
    }
}
