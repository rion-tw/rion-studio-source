impl SystemRuntimeExecutor {
    pub(crate) fn preview_tab_activation_background(
        &self,
        tab_id: &str,
        native_style_applied: bool,
    ) -> Result<(String, bool, String, String), String> {
        let resolved_tab_id = self
            .presentation
            .resolve_tab_alias(tab_id)
            .unwrap_or_else(|| tab_id.to_owned());
        let trigger = if native_style_applied {
            "native-pointer"
        } else {
            "pointer"
        };
        if let Some((window_id, operation_id)) = self
            .request_provisional_tab_presentation_with_transaction(
                &resolved_tab_id,
                NativePresentationFocus::ContentOnly,
                trigger,
                None,
                false,
            )?
        {
            return Ok((window_id, true, resolved_tab_id, operation_id));
        }
        self.request_tab_presentation_with_window_visibility(
            &resolved_tab_id,
            NativePresentationFocus::ContentOnly,
            trigger,
            None,
        )
        .map(|(window_id, _, operation_id)| {
            (window_id, false, resolved_tab_id, operation_id)
        })
    }

    pub(crate) fn preview_adjacent_tab_activation_background(
        &self,
        window_id: &str,
        direction: &str,
    ) -> Result<(String, bool, String), String> {
        let (candidates, current_tab_id) = {
            let presentation = self.presentation.coordinator(window_id)?;
            let window = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            (window.tab_ids(), window.selected_tab_id.clone())
        };
        if candidates.is_empty() {
            return Err("The runtime window has no selectable tabs.".to_owned());
        }
        let current = current_tab_id
            .as_ref()
            .and_then(|active_id| candidates.iter().position(|tab_id| tab_id == active_id))
            .unwrap_or(0);
        let target_index = if direction == "previous" {
            (current + candidates.len() - 1) % candidates.len()
        } else {
            (current + 1) % candidates.len()
        };
        let target_id = candidates[target_index].clone();
        let provisional = self.request_provisional_tab_presentation_with_transaction(
            &target_id,
            NativePresentationFocus::ContentOnly,
            "shortcut",
            None,
            false,
        )?;
        let (provisional, operation_id) = if let Some((_, operation_id)) = provisional {
            (true, operation_id)
        } else {
            let (_, _, operation_id) = self.request_tab_presentation_with_window_visibility(
                &target_id,
                NativePresentationFocus::ContentOnly,
                "shortcut",
                None,
            )?;
            (false, operation_id)
        };
        Ok((target_id, provisional, operation_id))
    }
}
