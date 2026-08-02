#[cfg(windows)]
impl PresentationRegistry {
    fn acknowledge_tab_chrome(&self, webview_label: &str, revision: u64) {
        if let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() {
            let applied = acknowledgements.entry(webview_label.to_owned()).or_default();
            *applied = (*applied).max(revision);
            self.tab_chrome_changed.notify_all();
        }
    }

    fn wait_for_tab_chrome_acknowledgement(
        &self,
        webview_label: &str,
        revision: u64,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() else {
            return false;
        };
        while acknowledgements.get(webview_label).copied().unwrap_or_default() < revision {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, wait)) = self
                .tab_chrome_changed
                .wait_timeout(acknowledgements, remaining)
            else {
                return false;
            };
            acknowledgements = next;
            if wait.timed_out()
                && acknowledgements.get(webview_label).copied().unwrap_or_default() < revision
            {
                return false;
            }
        }
        true
    }
}
