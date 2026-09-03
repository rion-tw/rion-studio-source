use super::*;

#[test]
fn native_handle_requires_exact_pointer_width_native_endian_bytes() {
    let address = 0x1000usize;
    let decoded = decode_native_view_handle(&address.to_ne_bytes()).unwrap();
    assert_eq!(decoded.as_ptr() as usize, address);
    assert!(decode_native_view_handle(&[0; 4]).is_err());
    assert!(decode_native_view_handle(&0usize.to_ne_bytes()).is_err());
    assert!(decode_native_view_handle(&1usize.to_ne_bytes()).is_err());
}

#[test]
fn host_identity_rejects_ambiguous_or_zero_generation_values() {
    assert!(
        ValidatedHostIdentity::validate(AppKitRuntimeHostIdentity {
            logical_window_id: "window-1".to_owned(),
            launch_generation: "launch-1".to_owned(),
            native_generation: 1,
        })
        .is_ok()
    );
    for logical_window_id in ["", " window", "window/1", "window\\1"] {
        assert!(
            ValidatedHostIdentity::validate(AppKitRuntimeHostIdentity {
                logical_window_id: logical_window_id.to_owned(),
                launch_generation: "launch-1".to_owned(),
                native_generation: 1,
            })
            .is_err()
        );
    }
    assert!(
        ValidatedHostIdentity::validate(AppKitRuntimeHostIdentity {
            logical_window_id: "window-1".to_owned(),
            launch_generation: "launch-1".to_owned(),
            native_generation: 0,
        })
        .is_err()
    );
}

#[test]
fn expected_identity_fences_all_three_native_ownership_dimensions() {
    let identity = ValidatedHostIdentity {
        logical_window_id: "window-1".to_owned(),
        launch_generation: "launch-1".to_owned(),
        native_generation: 3,
    };
    assert!(identity.matches(&AppKitRuntimeHostIdentity {
        logical_window_id: "window-1".to_owned(),
        launch_generation: "launch-1".to_owned(),
        native_generation: 3,
    }));
    assert!(!identity.matches(&AppKitRuntimeHostIdentity {
        logical_window_id: "window-1".to_owned(),
        launch_generation: "launch-1".to_owned(),
        native_generation: 2,
    }));
}

#[test]
fn projection_revision_requires_canonical_positive_u64_text() {
    assert_eq!(validate_projection_revision("1").unwrap(), 1);
    assert_eq!(
        validate_projection_revision("18446744073709551615").unwrap(),
        u64::MAX
    );
    for revision in [
        "",
        "0",
        "01",
        "+1",
        " 1",
        "1 ",
        "-1",
        "18446744073709551616",
    ] {
        assert!(
            validate_projection_revision(revision).is_err(),
            "{revision:?}"
        );
    }
}

#[test]
fn tab_projection_requires_bounded_unique_metadata_and_exact_active_identity() {
    let tab = || AppKitRuntimeTabProjection {
        tab_id: "tab-1".to_owned(),
        name: "Primary".to_owned(),
        phase: "ready".to_owned(),
        tab_type: "role".to_owned(),
        workspace_template: None,
    };
    let validated = validate_tab_projection(vec![tab()], Some("tab-1")).unwrap();
    assert_eq!(validated.len(), 1);
    assert_eq!(validated[0].tab_id, "tab-1");
    assert!(
        validate_tab_projection(
            vec![AppKitRuntimeTabProjection {
                tab_id: "popup-1".to_owned(),
                name: "Controlled Popup".to_owned(),
                tab_type: "popup".to_owned(),
                ..tab()
            }],
            Some("popup-1")
        )
        .is_ok()
    );

    assert!(validate_tab_projection(vec![tab()], None).is_err());
    assert!(validate_tab_projection(vec![tab()], Some("tab-2")).is_err());
    assert!(validate_tab_projection(vec![tab(), tab()], Some("tab-1")).is_err());
    assert!(
        validate_tab_projection(
            vec![AppKitRuntimeTabProjection {
                tab_type: "html".to_owned(),
                ..tab()
            }],
            Some("tab-1")
        )
        .is_err()
    );
    assert!(validate_tab_projection(Vec::new(), None).is_ok());
}

#[test]
fn workspace_divider_projection_requires_exact_contained_unique_geometry() {
    let bounds = AppKitWorkspaceDividerBounds {
        x: 0,
        y: 40,
        width: 960,
        height: 640,
    };
    let divider = || AppKitRuntimeWorkspaceDividerProjection {
        tab_id: "tab-1".to_owned(),
        attempt_generation: "attempt-1".to_owned(),
        divider_index: 0,
        axis: "vertical".to_owned(),
        bounds: AppKitWorkspaceDividerBounds {
            x: 478,
            y: 40,
            width: 4,
            height: 640,
        },
        visible: true,
    };
    let validated = validate_workspace_divider_projection(bounds.clone(), vec![divider()]).unwrap();
    assert_eq!(validated.dividers.len(), 1);
    assert_eq!(validated.dividers[0].axis, "vertical");

    assert!(
        validate_workspace_divider_projection(bounds.clone(), vec![divider(), divider()]).is_err()
    );
    assert!(
        validate_workspace_divider_projection(
            bounds,
            vec![AppKitRuntimeWorkspaceDividerProjection {
                bounds: AppKitWorkspaceDividerBounds {
                    x: 958,
                    y: 40,
                    width: 4,
                    height: 640,
                },
                ..divider()
            }]
        )
        .is_err()
    );
}

#[test]
fn native_exports_retain_the_bounded_callback_boundary_in_test_builds() {
    assert_eq!(APPKIT_EVENT_QUEUE_CAPACITY, 64);
    std::hint::black_box((
        MAX_NATIVE_FIELD_BYTES,
        MAX_NATIVE_JSON_BYTES,
        MAX_SERIALIZED_EVENT_BYTES,
    ));
    let _ = attach_appkit_runtime_host;
    let _ = appkit_layout_callback;
    let _ = appkit_action_callback;
    let _ = AppKitCallbackContext::emit;
    let _ = CallbackFailure::InvalidNativeEvent as u8;
    let identity = ValidatedHostIdentity {
        logical_window_id: "window-1".to_owned(),
        launch_generation: "launch-1".to_owned(),
        native_generation: 1,
    };
    assert_eq!(identity.json()["nativeGeneration"], 1);
}

#[cfg(feature = "desktop-e2e")]
#[test]
fn desktop_e2e_show_menu_export_is_identity_and_tab_fenced() {
    let operation: fn(NonNull<c_void>, &CStr) -> Result<bool> = desktop_e2e_accessibility_show_menu;
    std::hint::black_box(operation);

    const SOURCE: &str = include_str!("../appkit_runtime_host.rs");
    let export = SOURCE
        .split("#[napi(js_name = \"desktopE2eAccessibilityShowMenu\")]")
        .nth(1)
        .and_then(|source| source.split("#[napi(js_name =").next())
        .expect("missing desktop-E2E accessibility show-menu export");
    assert!(export.contains("validate_identifier(&tab_id, \"tab\")"));
    assert!(export.contains("self.with_live_controller(&expected"));
    assert!(export.contains("desktop_e2e_accessibility_show_menu(controller, &tab_id)"));
}
