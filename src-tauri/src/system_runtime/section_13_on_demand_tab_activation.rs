#[derive(Clone, Debug)]
pub(crate) struct DormantTabActivationRequest {
    pub(crate) audio_muted: bool,
    pub(crate) role_slots: Vec<GameWindowRoleSlotRecord>,
    pub(crate) source_id: String,
    pub(crate) tab_id: String,
    pub(crate) tab_type: String,
    pub(crate) target: EmbeddedLaunchTargetRecord,
}

fn failed_tab_status_identity_matches(
    current: Option<&RuntimeTabStatusIdentityRecord>,
    requested: &RuntimeTabStatusIdentityRecord,
) -> bool {
    requested.phase == RuntimeTabActivationPhaseRecord::Failed && current == Some(requested)
}

impl SystemRuntimeExecutor {
    pub(crate) fn active_failed_tab_status_identity(
        &self,
        window_id: &str,
    ) -> Option<RuntimeTabStatusIdentityRecord> {
        let snapshot = self.core.runtime_kernel().snapshot().ok()?;
        let window = snapshot.windows.get(window_id)?;
        let tab_id = window.selected_tab_id.as_ref()?;
        let activation = snapshot.tab_activations.get(tab_id.as_str())?;
        let host_generation = self
            .state
            .lock()
            .ok()?
            .native_resources
            .display_hosts
            .get(window_id)?
            .generation;
        (activation.phase == RuntimeTabActivationPhaseRecord::Failed
            && activation.owner_window_id == window_id
            && activation.window_generation.0 == host_generation)
            .then(|| RuntimeTabStatusIdentityRecord {
                attempt_id: activation.attempt_id.as_str().to_owned(),
                tab_id: activation.tab_id.as_str().to_owned(),
                window_id: activation.owner_window_id.clone(),
                window_generation: activation.window_generation.0,
                phase: activation.phase,
            })
    }

    pub(crate) fn failed_tab_status_identity_is_current(
        &self,
        identity: &RuntimeTabStatusIdentityRecord,
    ) -> bool {
        let current = self.active_failed_tab_status_identity(&identity.window_id);
        failed_tab_status_identity_matches(current.as_ref(), identity)
    }

    pub(crate) fn adjacent_runtime_tab_id(
        &self,
        window_id: &str,
        direction: &str,
    ) -> Result<String, String> {
        let presentation = self.presentation.coordinator(window_id)?;
        let candidates = presentation.tab_ids();
        if candidates.is_empty() {
            return Err("The runtime window has no selectable tabs.".to_owned());
        }
        let current = presentation
            .selected_tab_id
            .as_ref()
            .and_then(|active_id| candidates.iter().position(|tab_id| tab_id == active_id))
            .unwrap_or(0);
        let target_index = if direction == "previous" {
            (current + candidates.len() - 1) % candidates.len()
        } else {
            (current + 1) % candidates.len()
        };
        Ok(candidates[target_index].clone())
    }

    pub(crate) fn seed_dormant_runtime_tabs(
        &self,
        window_id: &str,
        tab_ids: Vec<String>,
    ) -> Result<(), String> {
        if tab_ids.is_empty() {
            return Ok(());
        }
        self.seed_kernel_dormant_tabs(window_id, tab_ids)
            .map_err(|error| error.message)?;
        self.publish_projection();
        Ok(())
    }

    pub(crate) fn claim_runtime_tab_activation(
        &self,
        tab_id: &str,
    ) -> Result<Option<DormantTabActivationRequest>, String> {
        let snapshot = self
            .core
            .runtime_kernel()
            .snapshot()
            .map_err(|error| error.to_string())?;
        let (window_id, window, tab) = snapshot
            .windows
            .iter()
            .find_map(|(window_id, window)| {
                window
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .map(|tab| (window_id.clone(), window.clone(), tab.clone()))
            })
            .ok_or_else(|| "Runtime tab is no longer available for activation.".to_owned())?;
        let target = self
            .state()
            .map_err(|error| error.message)?
            .native_resources
            .display_hosts
            .get(&window_id)
            .map(|host| host.target.clone())
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
        let attempt_id = OperationId::new(uuid::Uuid::new_v4().to_string())?;
        let commit = self
            .activate_kernel_tab(
                window.revision,
                attempt_id.clone(),
                RuntimeTabId::new(tab_id.to_owned())?,
                window_id.clone(),
            )
            .map_err(|error| error.message)?;
        if commit.status != RuntimeCommitStatus::Applied {
            return Ok(None);
        }
        let requested = commit.desired_effects.iter().any(|effect| {
            matches!(
                effect,
                rion_core::RuntimeDesiredEffect::ActivateTab {
                    activation_attempt_id,
                    tab_id: requested_tab_id,
                    window_id: requested_window_id,
                } if activation_attempt_id == &attempt_id
                    && requested_tab_id.as_str() == tab_id
                    && requested_window_id == &window_id
            )
        });
        if !requested {
            return Ok(None);
        }
        self.presentation.statuses.set_presentation_phase(
            tab_id,
            TabRuntimePhase::Activating,
        );
        self.publish_projection();
        Ok(Some(DormantTabActivationRequest {
            audio_muted: tab.audio_muted,
            role_slots: tab.role_slots,
            source_id: tab.source_id,
            tab_id: tab.id,
            tab_type: tab.tab_type,
            target,
        }))
    }

    pub(crate) fn set_authoritative_tab_activation_phase(
        &self,
        tab_id: &str,
        phase: rion_core::RuntimeTabActivationPhaseRecord,
    ) -> bool {
        let activation = self
            .core
            .runtime_kernel()
            .snapshot()
            .ok()
            .and_then(|snapshot| snapshot.tab_activations.get(tab_id).cloned());
        let Some(activation) = activation else {
            return false;
        };
        self.set_kernel_tab_activation_phase(
            activation.attempt_id,
            phase,
            activation.tab_id,
        )
        .is_ok_and(|status| status == rion_core::RuntimeCommitStatus::Applied)
    }

    pub(crate) fn mark_runtime_tab_activation_failed(&self, tab_id: &str) {
        self.presentation
            .statuses
            .set_presentation_phase(tab_id, TabRuntimePhase::Failed);
        self.set_authoritative_tab_activation_phase(
            tab_id,
            rion_core::RuntimeTabActivationPhaseRecord::Failed,
        );
        if let Ok(Some(window_id)) = self.presentation.tab_window(tab_id) {
            let _ = self.reconcile_window_presentation(&window_id, "tab-activation-failed");
        }
        self.publish_projection();
    }

    pub(crate) fn mark_runtime_tab_activation_degraded(&self, tab_id: &str) {
        self.presentation
            .statuses
            .set_presentation_phase(tab_id, TabRuntimePhase::Degraded);
        self.set_authoritative_tab_activation_phase(
            tab_id,
            rion_core::RuntimeTabActivationPhaseRecord::Degraded,
        );
        self.publish_projection();
    }

    pub(crate) fn authoritative_tab_activation_phase(
        &self,
        tab_id: &str,
    ) -> Option<rion_core::RuntimeTabActivationPhaseRecord> {
        self.core
            .runtime_kernel()
            .snapshot()
            .ok()?
            .tab_activations
            .get(tab_id)
            .map(|activation| activation.phase)
    }
}
