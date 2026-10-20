#[test]
fn workspace_web_navigation_after_a_failure_returns_the_tab_to_ready() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) =
            core_for_runtime_contract(platform, CHROMIUM_RUNTIME_CONTRACT_VERSION);
        let mut registration = chromium_registration(platform, true);
        registration.contract_version = CHROMIUM_RUNTIME_CONTRACT_VERSION;
        core.invoke(CoreCommand::BrowserRuntimeRegister { registration }).unwrap();
        let workspace_id = create_web_only_workspace(&core, &format!("Recover Web {platform}"));
        let (_launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("recover-web-window-{platform}")),
            None,
        );
        let tab = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .expect("Web launch creates an exact tab");
        let surface_id = tab.roles[0].role.id.clone();
        let slot_id = tab.workspace_slots[0].id.clone();
        let tab_id = tab.tab_id.clone();
        let window_id = tab.target.window_id.clone();
        let attempt_generation = tab.attempt_generation.clone().unwrap();
        let window_generation =
            core.browser_runtime.snapshot().unwrap().windows[&window_id].window_generation;
        let phase = || core.browser_runtime.snapshot().unwrap().tab_activations[&tab_id].phase;
        let fail = |operation_id: &str| {
            let (receipt, _, _) = drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWorkspaceWebSurfaceFailed {
                    operation_id: operation_id.to_owned(),
                    surface_id: surface_id.clone(),
                    surface_generation: 1,
                    tab_id: tab_id.clone(),
                    window_id: window_id.clone(),
                    expected_attempt_generation: attempt_generation.clone(),
                    expected_window_generation: window_generation,
                },
                None,
            );
            assert_eq!(receipt.unwrap()["status"], "accepted", "{platform}");
        };
        let navigate = |operation_id: &str, url: &str| {
            let (receipt, _, _) = drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWorkspaceWebNavigationCommitted {
                    operation_id: operation_id.to_owned(),
                    surface_id: surface_id.clone(),
                    surface_generation: 1,
                    slot_id: slot_id.clone(),
                    tab_id: tab_id.clone(),
                    window_id: window_id.clone(),
                    expected_attempt_generation: attempt_generation.clone(),
                    expected_window_generation: window_generation,
                    url: url.to_owned(),
                },
                None,
            );
            receipt.unwrap()
        };

        fail(&format!("web-recover-failure-{platform}"));
        assert_eq!(phase(), crate::model::RuntimeTabActivationPhaseRecord::Degraded, "{platform}");
        // Going back to the page the slot already remembers still recovers.
        let receipt = navigate(&format!("web-recover-nav-{platform}"), "https://example.test/docs");
        assert_eq!(receipt["status"], "unchanged", "{platform}");
        assert_eq!(phase(), crate::model::RuntimeTabActivationPhaseRecord::Ready, "{platform}");

        // A later navigation without a failure leaves the phase alone, and a
        // new failure degrades the tab again until the next navigation.
        navigate(&format!("web-recover-nav-2-{platform}"), "https://example.test/next");
        assert_eq!(phase(), crate::model::RuntimeTabActivationPhaseRecord::Ready, "{platform}");
        fail(&format!("web-recover-failure-2-{platform}"));
        assert_eq!(phase(), crate::model::RuntimeTabActivationPhaseRecord::Degraded, "{platform}");
        navigate(&format!("web-recover-nav-3-{platform}"), "https://example.test/again");
        assert_eq!(phase(), crate::model::RuntimeTabActivationPhaseRecord::Ready, "{platform}");
        core.shutdown();
    }
}
