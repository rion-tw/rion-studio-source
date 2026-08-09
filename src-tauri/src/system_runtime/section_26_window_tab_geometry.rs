impl SystemRuntimeExecutor {
    #[cfg(windows)]
    fn windows_tab_strip_height(&self, window: &Window, toolbar_revealed: bool) -> f64 {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        self.windows_tab_strip_height_for_state(fullscreen, toolbar_revealed)
    }

    #[cfg(windows)]
    fn windows_tab_strip_height_for_state(
        &self,
        fullscreen: bool,
        toolbar_revealed: bool,
    ) -> f64 {
        let always_show = self
            .projection_metadata()
            .window_preferences
            .always_show_toolbar_in_full_screen;
        if fullscreen && !always_show && !toolbar_revealed {
            2.0
        } else {
            WINDOWS_TAB_STRIP_HEIGHT
        }
    }
}
