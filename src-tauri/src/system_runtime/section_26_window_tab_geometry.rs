impl SystemRuntimeExecutor {
    #[cfg(windows)]
    fn windows_tab_strip_height(&self, window: &Window, toolbar_revealed: bool) -> f64 {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let always_show = self
            .core
            .invoke(CoreCommand::RuntimeWindowPreferencesGet)
            .ok()
            .and_then(|value| value["alwaysShowToolbarInFullScreen"].as_bool())
            .unwrap_or(false);
        if fullscreen && !always_show && !toolbar_revealed {
            2.0
        } else {
            WINDOWS_TAB_STRIP_HEIGHT
        }
    }
}
