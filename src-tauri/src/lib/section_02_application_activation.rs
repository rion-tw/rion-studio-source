#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApplicationActivationTarget {
    MainWindow,
}

fn application_activation_target() -> ApplicationActivationTarget {
    // App-level activation without a native window selection targets the control surface.
    // Platform window switchers may still select an individual game-runtime window.
    ApplicationActivationTarget::MainWindow
}

pub(crate) fn activate_main_window(app: &AppHandle, trigger: &'static str) {
    match application_activation_target() {
        ApplicationActivationTarget::MainWindow => request_main_window_show(app, true, trigger),
    }
}
