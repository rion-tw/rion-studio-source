#[cfg(target_os = "macos")]
const READY_SURFACE_VIEWPORT_REFRESH_DELAY: Duration = Duration::from_millis(120);
#[cfg(target_os = "macos")]
const READY_SURFACE_VIEWPORT_REFRESH_SCRIPT: &str = r#"
(() => {
  window.dispatchEvent(new Event("resize"));
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
})();
"#;

impl SystemRuntimeExecutor {
    fn schedule_ready_surface_viewport_refresh(&self, webview: &Webview) {
        #[cfg(target_os = "macos")]
        {
            let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
                return;
            };
            let webview = webview.clone();
            let surface_label = webview.label().to_owned();
            let _ = std::thread::Builder::new()
                .name("rion-ready-viewport".to_owned())
                .spawn(move || {
                    std::thread::sleep(READY_SURFACE_VIEWPORT_REFRESH_DELAY);
                    let tab_id = runtime.state.lock().ok().and_then(|state| {
                        state.tabs.iter().find_map(|(tab_id, tab)| {
                            tab.roles
                                .values()
                                .any(|surface| {
                                    surface.webview.label() == surface_label.as_str()
                                })
                                .then(|| tab_id.clone())
                        })
                    });
                    let Some(tab_id) = tab_id else {
                        return;
                    };
                    // AppKit can finish installing the titlebar/content layout after a restored
                    // WKWebView has navigated. Re-project the authoritative slot geometry, then
                    // notify responsive/WebGL content on the next paint turn. The exact surface
                    // identity fence above prevents a late callback from touching a replacement.
                    if runtime.layout_runtime_tab_inner(&tab_id).is_ok() {
                        let _ = webview.eval(READY_SURFACE_VIEWPORT_REFRESH_SCRIPT);
                    }
                });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = webview;
        }
    }
}
