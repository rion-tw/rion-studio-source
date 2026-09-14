use super::*;

pub(super) fn restore_retry_record(
    action_type: &str,
    action: &mut serde_json::Map<String, serde_json::Value>,
) {
    // Slot retry uses the existing bounded identity JSON field across the C ABI.
    if action_type == "retryWorkspaceSlot"
        && let Some(record) = action.remove("statusIdentity")
    {
        action.insert("record".to_owned(), record);
    }
}

#[napi]
impl NativeAppKitRuntimeHost {
    #[napi(js_name = "applyWorkspaceSlotLoads")]
    pub fn apply_workspace_slot_loads(
        &self,
        expected: AppKitRuntimeHostIdentity,
        projection_json: String,
    ) -> Result<bool> {
        self.require_identity(&expected)?;
        self.require_exact_native_window()?;
        let value: serde_json::Value =
            serde_json::from_str(&projection_json).map_err(|_| malformed_projection_error())?;
        let tab_id = value
            .get("tabId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(malformed_projection_error)?;
        validate_identifier(tab_id, "slot tab")?;
        let slots = value
            .get("slots")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(malformed_projection_error)?;
        if slots.len() > 128 || projection_json.len() > 64 * 1024 {
            return Err(malformed_projection_error());
        }
        for slot in slots {
            let record: rion_core::WorkspaceSlotLoadRecord =
                serde_json::from_value(slot["record"].clone())
                    .map_err(|_| malformed_projection_error())?;
            if record.tab_id != tab_id
                || record.window_id != expected.logical_window_id
                || record.revision < 1
            {
                return Err(malformed_projection_error());
            }
            for field in ["x", "y", "width", "height"] {
                if !slot["bounds"][field]
                    .as_u64()
                    .is_some_and(|value| value <= i32::MAX as u64)
                {
                    return Err(malformed_projection_error());
                }
            }
        }
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        if !state.projected_tab_ids.iter().any(|id| id == tab_id) {
            return Ok(false);
        }
        platform::apply_workspace_slot_loads(
            controller,
            &CString::new(projection_json).map_err(|_| malformed_projection_error())?,
        )
    }
}
