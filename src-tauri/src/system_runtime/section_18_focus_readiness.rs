#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FocusLaunchReadiness {
    Pending,
    Ready,
    Unavailable,
}

fn focus_launch_readiness(phase: Option<LaunchPhase>) -> FocusLaunchReadiness {
    match phase {
        Some(LaunchPhase::EssentialReady | LaunchPhase::OptionalHydrating | LaunchPhase::Ready) => {
            FocusLaunchReadiness::Ready
        }
        Some(LaunchPhase::Degraded) => FocusLaunchReadiness::Unavailable,
        Some(LaunchPhase::Attaching | LaunchPhase::Navigating) | None => {
            FocusLaunchReadiness::Pending
        }
    }
}

impl SystemRuntimeExecutor {
    fn wait_for_role_input_focus(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        tauri::async_runtime::block_on(self.wait_for_role_input_focus_async(role_id, context))
    }

    async fn wait_for_role_input_focus_async(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        let mut readiness_changed = self.input_readiness.subscribe();
        loop {
            context.ensure_current()?;
            let _ = self.role_webview_for_input(role_id, context)?;
            let tab_id = self
                .state()?
                .native_tab_id_for_role_surface(role_id)
                .cloned()
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role was not found.",
                    )
                })?;
            match focus_launch_readiness(self.presentation.statuses.launch_phase(&tab_id)) {
                FocusLaunchReadiness::Ready => return Ok(()),
                FocusLaunchReadiness::Unavailable => {
                    return Err(RuntimeError::new(
                        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
                        "The role page did not become ready for automatic input.",
                    ));
                }
                FocusLaunchReadiness::Pending => {}
            }

            let remaining = context.remaining(PLATFORM_CALLBACK_TIMEOUT);
            if remaining.is_zero() {
                context.ensure_current()?;
                return Err(RuntimeError::new(
                    "BROWSER_ACTION_DEADLINE",
                    "Browser action deadline expired before the role page became ready.",
                ));
            }
            match tokio::time::timeout(remaining, readiness_changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    return Err(RuntimeError::new(
                        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                        "Role page readiness stopped before automatic input was admitted.",
                    ));
                }
                Err(_) => {
                    context.ensure_current()?;
                    return Err(RuntimeError::new(
                        "BROWSER_ACTION_DEADLINE",
                        "Browser action deadline expired before the role page became ready.",
                    ));
                }
            }
        }
    }
}
