#[test]
fn application_activation_prefers_a_live_last_focused_runtime_window() {
    let target = application_activation_target(Some("window-1"), true);

    assert_eq!(
        complete_application_activation_target(target, true),
        ApplicationActivationTarget::RuntimeWindow("window-1".to_owned())
    );
}

#[test]
fn application_activation_falls_back_to_main_for_unavailable_runtime_windows() {
    for (last_focused_window_id, has_live_tabs) in [
        (None, false),
        (Some(""), true),
        (Some("window-1"), false),
    ] {
        assert_eq!(
            application_activation_target(last_focused_window_id, has_live_tabs),
            ApplicationActivationTarget::MainWindow
        );
    }
}

#[test]
fn application_activation_falls_back_to_main_when_runtime_focus_fails() {
    let target = application_activation_target(Some("window-1"), true);

    assert_eq!(
        complete_application_activation_target(target, false),
        ApplicationActivationTarget::MainWindow
    );
}
