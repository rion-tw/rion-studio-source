#[test]
fn source_macro_overlay_shortcut_statuses_are_local_to_the_requesting_role() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let a = create_role(&core, &game_id, 1);
    let b = create_role(&core, &game_id, 2);
    let mut ids = Vec::new();
    for (name, mode, scope, key) in [
        ("dynamic", "source_role", "all_roles", "F1"),
        ("fixed", "selected_roles", "all_execution_roles", "F2"),
    ] {
        let id = core
            .invoke(command(json!({
                "type":"macroCreate", "input": {
                    "name":name,"executionMode":mode,"roleIds":[a,b],
                    "shortcutSourceScope":{"type":scope},
                    "trigger":{"code":key,"ctrl":false,"alt":false,"shift":false,"meta":false},
                    "steps":[{"type":"delay","ms":1000}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        core.macro_runtime.seed_running_status(&id, &a).unwrap();
        core.macro_runtime.seed_running_status(&id, &b).unwrap();
        ids.push(id);
    }
    let overlay = core.overlay_view_model(&a, None, None).unwrap();
    let dynamic = overlay
        .shortcut_statuses
        .iter()
        .filter(|status| status.macro_id == ids[0])
        .collect::<Vec<_>>();
    assert_eq!(dynamic.len(), 1);
    assert_eq!(dynamic[0].role_id, a);
    assert_eq!(
        overlay
            .shortcut_statuses
            .iter()
            .filter(|status| status.macro_id == ids[1])
            .count(),
        2
    );
}
