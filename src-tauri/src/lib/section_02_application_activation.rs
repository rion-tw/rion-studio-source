#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApplicationActivationTarget {
    MainWindow,
}

fn application_activation_target() -> ApplicationActivationTarget {
    // The Dock/taskbar entry represents the Rion Studio control surface, not a
    // previously focused game-runtime window.
    ApplicationActivationTarget::MainWindow
}

pub(crate) fn activate_main_window(app: &AppHandle, trigger: &'static str) {
    match application_activation_target() {
        ApplicationActivationTarget::MainWindow => request_main_window_show(app, true, trigger),
    }
}
