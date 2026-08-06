#[test]
fn application_activation_always_targets_the_rion_studio_main_window() {
    assert_eq!(
        application_activation_target(),
        ApplicationActivationTarget::MainWindow
    );
}
