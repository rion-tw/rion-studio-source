impl SystemRuntimeExecutor {
    #[cfg(target_os = "macos")]
    fn workspace_web_history_restored(&self, label: &str, url: &Url) {
        let navigation = self.state.lock().ok().and_then(|state| {
            state.native_resources.tabs.values().flat_map(|tab| tab.roles.values())
                .find(|surface| surface.webview.label() == label && surface.workspace_web.is_some())
                .map(|surface| Arc::clone(&surface.navigation))
        });
        let Some(navigation) = navigation else { return; };
        for event in [PageLoadEvent::Started, PageLoadEvent::Finished] {
            navigation.page_event(event, url);
            self.workspace_web_navigation_event(label, event, url);
        }
        self.finish_controlled_navigations(&[label.to_owned()]);
    }

    fn publish_workspace_start_appearance(&self) {
        let language = self.language.lock().map(|value| value.clone()).unwrap_or_default();
        let theme = self.resolved_theme.lock().map(|value| value.clone()).unwrap_or_default();
        let script = crate::workspace_start::appearance_script(&language, &theme);
        let views = self.state.lock().map(|state| {
            state.native_resources.tabs.values().flat_map(|tab| tab.roles.values())
                .filter(|surface| surface.workspace_web.is_some() && surface.current_url.as_ref()
                    .is_some_and(|url| crate::workspace_start::is_start_url(url.as_str())))
                .map(|surface| surface.webview.clone()).collect::<Vec<_>>()
        }).unwrap_or_default();
        for view in views { let _ = view.eval(&script); }
    }
}
