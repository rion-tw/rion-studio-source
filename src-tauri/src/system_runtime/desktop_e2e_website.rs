impl SystemRuntimeExecutor {
    fn desktop_e2e_focus_website_control(
        &self,
        window_id: &str,
        tab_id: &str,
        role_id: &str,
        control: &str,
    ) -> Result<(), String> {
        let is_card = matches!(control, "youtube" | "iqiyi");
        let selector = match control {
            "iqiyi" => "[data-workspace-start-site='iqiyi']",
            "youtube" => "[data-workspace-start-site='youtube']",
            "home" => "#home",
            "back" => "#back",
            "forward" => "#forward",
            "reload" => "#reload",
            _ => return Err("Unsupported website focus target".to_owned()),
        };
        let (window, webview) = {
            let state = self.state().map_err(|error| error.message)?;
            let window = state.native_resources.display_hosts.get(window_id)
                .ok_or("Website window is unavailable")?.window.clone();
            let surface = state.native_resources.tabs.get(tab_id)
                .and_then(|tab| tab.roles.get(role_id)).ok_or("Website surface is unavailable")?;
            let website = surface.workspace_web.as_ref().ok_or("Surface is not a website")?;
            if (control == "back" && !website.can_go_back)
                || (control == "forward" && !website.can_go_forward)
            {
                return Err(format!("Website {control} is disabled in native history at {}", website.document_epoch));
            }
            (window, if is_card { surface.webview.clone() }
                else { website.chrome.webview.clone() })
        };
        let catalog_evidence = if is_card {
            "categories: [...document.querySelectorAll('[data-workspace-start-category]')].map(group => ({ id: group.dataset.workspaceStartCategory, title: group.querySelector('h2').innerText, count: group.querySelectorAll('a').length })), imagesLoaded: [...document.images].every(image => image.complete && image.naturalWidth > 0),"
        } else { "" };
        let fixture = if is_card {
            let origin = std::env::var("RION_STUDIO_E2E_FIXTURE_ORIGIN")
                .map_err(|error| error.to_string())?;
            let url = Url::parse(&origin).map_err(|error| error.to_string())?;
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
                return Err("Website fixture must use the local E2E server".to_owned());
            }
            format!("element.href = {};", serde_json::to_string(
                &format!("{origin}/role/e2e-website-entrance")).map_err(|error| error.to_string())?)
        } else { String::new() };
        request_platform_window_show_foreground(&window).map_err(|error| error.message)?;
        webview.set_focus().map_err(|error| error.to_string())?;
        // Only deterministic response/focus preconditions. Real platform Enter
        // activates the visible link/button; this hook never calls click/navigate.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        webview.eval_with_callback(format!(
            "(() => {{ const element = document.querySelector({}); const error = document.querySelector('#location[aria-invalid=true]')?.title; if (error || !element || element.disabled || !element.getClientRects().length) return {{ error: error || 'Website control is not visible' }}; {fixture} element.scrollIntoView({{ block: 'center' }}); element.focus(); return {{ {catalog_evidence} focused: document.activeElement === element }}; }})();",
            serde_json::to_string(selector).map_err(|error| error.to_string())?
        ), move |value| { let _ = sender.send(value); }).map_err(|error| error.to_string())?;
        let value = receiver.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_str(&value).map_err(|error| error.to_string())?;
        if value.get("focused").and_then(Value::as_bool) != Some(true) {
            return Err(format!("Website {control} focus was not acknowledged: {value}"));
        }
        if is_card {
            crate::desktop_e2e::record_event("website-entrance-catalog", None, None, None, value);
        }
        Ok(())
    }
}
