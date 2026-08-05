#[derive(Clone, Debug, PartialEq, Eq)]
enum ApplicationActivationTarget {
    MainWindow,
    RuntimeWindow(String),
}

fn application_activation_target(
    last_focused_window_id: Option<&str>,
    has_live_tabs: bool,
) -> ApplicationActivationTarget {
    match last_focused_window_id {
        Some(window_id) if !window_id.is_empty() && has_live_tabs => {
            ApplicationActivationTarget::RuntimeWindow(window_id.to_owned())
        }
        _ => ApplicationActivationTarget::MainWindow,
    }
}

fn complete_application_activation_target(
    target: ApplicationActivationTarget,
    runtime_focus_succeeded: bool,
) -> ApplicationActivationTarget {
    match target {
        ApplicationActivationTarget::RuntimeWindow(window_id) if runtime_focus_succeeded => {
            ApplicationActivationTarget::RuntimeWindow(window_id)
        }
        _ => ApplicationActivationTarget::MainWindow,
    }
}

pub(crate) fn activate_last_focused_window_or_main(app: &AppHandle, trigger: &'static str) {
    if let Some(state) = app.try_state::<CoreState>() {
        let last_focused_window_id = state
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .ok()
            .and_then(|value| value["lastFocusedWindowId"].as_str().map(str::to_owned));
        let has_live_tabs = last_focused_window_id.as_deref().is_some_and(|window_id| {
            state
                .runtime
                .live_window_tab_ids(window_id)
                .is_ok_and(|tab_ids| !tab_ids.is_empty())
        });
        let target = application_activation_target(last_focused_window_id.as_deref(), has_live_tabs);
        let runtime_focus_succeeded = match &target {
            ApplicationActivationTarget::RuntimeWindow(window_id) => state
                .runtime
                .activate_live_runtime_window(window_id, trigger)
                .is_ok_and(|focused| focused),
            ApplicationActivationTarget::MainWindow => false,
        };
        if matches!(
            complete_application_activation_target(target, runtime_focus_succeeded),
            ApplicationActivationTarget::RuntimeWindow(_)
        ) {
            return;
        }
    }
    request_main_window_show(app, true, trigger);
}
