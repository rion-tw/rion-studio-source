#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsChromiumHeldKeyContinuityInput {
    pub operation_id: String,
    pub role_id: String,
    pub tab_id: String,
    pub expected_owner_generation: u64,
    pub surface_generation: u64,
    pub document_instance_id: String,
    pub loss_reason: String,
    pub loss_revision: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsChromiumHeldKeyContinuityReceipt {
    pub operation_id: String,
    pub role_id: String,
    pub tab_id: String,
    pub expected_owner_generation: u64,
    pub surface_generation: u64,
    pub document_instance_id: String,
    pub loss_reason: String,
    pub loss_revision: u64,
    pub input_epoch: u64,
    pub status: String,
    pub reasserted_key_count: usize,
    pub request_ids: Vec<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl WindowsChromiumHeldKeyContinuityInput {
    fn validate(&self) -> CoreResult<()> {
        for (value, field) in [
            (&self.operation_id, "operationId"),
            (&self.role_id, "roleId"),
            (&self.tab_id, "tabId"),
            (&self.document_instance_id, "documentInstanceId"),
        ] {
            if value.is_empty()
                || value.len() > 256
                || value.trim() != value
                || value.chars().any(char::is_control)
            {
                return Err(CoreError::InvalidInput(format!(
                    "Windows Chromium held-key continuity {field} is invalid"
                )));
            }
        }
        if self.expected_owner_generation == 0
            || self.surface_generation == 0
            || self.loss_revision == 0
            || !matches!(self.loss_reason.as_str(), "blur" | "hidden")
        {
            return Err(CoreError::InvalidInput(
                "Windows Chromium held-key continuity fences are invalid".to_owned(),
            ));
        }
        Ok(())
    }

    fn receipt(
        &self,
        status: &str,
        input_epoch: u64,
    ) -> WindowsChromiumHeldKeyContinuityReceipt {
        WindowsChromiumHeldKeyContinuityReceipt {
            operation_id: self.operation_id.clone(),
            role_id: self.role_id.clone(),
            tab_id: self.tab_id.clone(),
            expected_owner_generation: self.expected_owner_generation,
            surface_generation: self.surface_generation,
            document_instance_id: self.document_instance_id.clone(),
            loss_reason: self.loss_reason.clone(),
            loss_revision: self.loss_revision,
            input_epoch,
            status: status.to_owned(),
            reasserted_key_count: 0,
            request_ids: Vec::new(),
            error_code: None,
            error_message: None,
        }
    }
}

impl AppCore {
    pub fn restore_windows_chromium_held_keys_internal(
        &self,
        input: WindowsChromiumHeldKeyContinuityInput,
    ) -> CoreResult<WindowsChromiumHeldKeyContinuityReceipt> {
        input.validate()?;
        let registration = self.browser_runtime_registration()?;
        let capability_available = self.platform == rion_platform::Platform::Windows
            && self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION
            && registration.available
            && registration.engine == crate::model::ResolvedBrowserEngine::Chromium
            && registration.capabilities.trusted_input
                == crate::model::EngineCapabilityStatus::Supported
            && registration.capabilities.background_input
                == crate::model::EngineCapabilityStatus::Supported;
        if !capability_available {
            return Err(CoreError::Domain {
                code: "WINDOWS_CHROMIUM_BACKGROUND_INPUT_UNAVAILABLE",
                message: "Windows Chromium background trusted input is unavailable.".to_owned(),
            });
        }
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let snapshot = self.browser_runtime.snapshot()?;
        let owner_is_current = snapshot.browser_runtime.roles.iter().any(|role| {
            role.role_id == input.role_id
                && role.runtime == "embedded"
                && role.state == "running"
                && role.owner.tab_id == input.tab_id
                && role.owner.generation == input.expected_owner_generation
        });
        let presentation_matches = snapshot.windows.values().any(|window| {
            let contains_tab = window.tabs.iter().any(|tab| tab.id == input.tab_id);
            if !contains_tab {
                return false;
            }
            match input.loss_reason.as_str() {
                "hidden" => {
                    window.selected_tab_id.is_some()
                        && window.selected_tab_id.as_deref() != Some(input.tab_id.as_str())
                        && window.hidden_tab_ids.contains(&input.tab_id)
                }
                "blur" => {
                    window.selected_tab_id.as_deref() == Some(input.tab_id.as_str())
                        && !window.hidden_tab_ids.contains(&input.tab_id)
                }
                _ => false,
            }
        });
        if !owner_is_current || !presentation_matches {
            return Ok(input.receipt("superseded", 0));
        }
        let dispatched = self
            .macro_runtime
            .reassert_held_keys_after_context_loss(
                crate::macro_runtime::HeldKeyContinuityDispatch {
                    operation_id: &input.operation_id,
                    role_id: &input.role_id,
                    surface_generation: input.surface_generation,
                    document_instance_id: &input.document_instance_id,
                    loss_reason: &input.loss_reason,
                    loss_revision: input.loss_revision,
                },
            )?;
        Ok(WindowsChromiumHeldKeyContinuityReceipt {
            operation_id: input.operation_id,
            role_id: input.role_id,
            tab_id: input.tab_id,
            expected_owner_generation: input.expected_owner_generation,
            surface_generation: input.surface_generation,
            document_instance_id: input.document_instance_id,
            loss_reason: input.loss_reason,
            loss_revision: input.loss_revision,
            input_epoch: dispatched.input_epoch,
            status: dispatched.status.to_owned(),
            reasserted_key_count: dispatched.reasserted_key_count,
            request_ids: dispatched.request_ids,
            error_code: dispatched.error_code,
            error_message: dispatched.error_message,
        })
    }
}
