fn validate_applied_page_zoom(zoom_factor: f64) -> RuntimeResult<f64> {
    if zoom_factor.is_finite() && zoom_factor > 0.0 {
        Ok(zoom_factor)
    } else {
        Err(RuntimeError::new(
            "BROWSER_PAGE_ZOOM_UNAVAILABLE",
            "The System WebView reported an invalid applied page zoom.",
        ))
    }
}

impl SystemRuntimeExecutor {
    fn overlay_coordinate_identity(
        &self,
        webview_label: &str,
        role_id: &str,
    ) -> RuntimeResult<(u64, u64)> {
        let bound_role_id = self.role_id_for_webview(webview_label).map_err(|message| {
            RuntimeError::new("BROWSER_COORDINATE_CONTEXT_SUPERSEDED", message)
        })?;
        if bound_role_id != role_id {
            return Err(RuntimeError::new(
                "BROWSER_COORDINATE_CONTEXT_SUPERSEDED",
                "The coordinate measurement WebView changed roles.",
            ));
        }
        let surface_generation = self.surface_generation_for_role(role_id).ok_or_else(|| {
            RuntimeError::new(
                "BROWSER_COORDINATE_CONTEXT_SUPERSEDED",
                "The coordinate measurement surface is no longer live.",
            )
        })?;
        Ok((surface_generation, self.live_topology_revision()))
    }

    pub fn overlay_coordinate_context(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<MacroCoordinateContextRecord> {
        let before = self.overlay_coordinate_identity(webview.label(), role_id)?;
        let applied_page_zoom = platform_page_zoom(webview)?;
        let after = self.overlay_coordinate_identity(webview.label(), role_id)?;
        if before != after {
            return Err(RuntimeError::new(
                "BROWSER_COORDINATE_CONTEXT_SUPERSEDED",
                "The coordinate measurement surface changed while its page zoom was read.",
            ));
        }
        Ok(MacroCoordinateContextRecord {
            applied_page_zoom,
            surface_generation: after.0,
            topology_revision: after.1,
        })
    }
}
