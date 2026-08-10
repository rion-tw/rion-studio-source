impl SystemRuntimeExecutor {
    pub(crate) fn preview_tab_activation_background(
        &self,
        tab_id: &str,
        native_style_applied: bool,
    ) -> Result<(String, bool, String, String), String> {
        let resolved_tab_id = tab_id.to_owned();
        let trigger = if native_style_applied {
            "native-pointer"
        } else {
            "pointer"
        };
        if let Some((window_id, operation_id)) = self
            .request_provisional_tab_presentation(
                &resolved_tab_id,
                NativePresentationFocus::ContentOnly,
                trigger,
                None,
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

}
