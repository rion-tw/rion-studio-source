#[test]
fn extension_configuration_is_durable_and_active_leases_are_frozen() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = core_for_platform_contract(platform, 23);
        let role = create_role(&core, &first_game_id(&core), 1);
        let root = directory.path().join("extensions");
        std::fs::create_dir_all(&root).unwrap();
        let staging = tempfile::tempdir_in(&root).unwrap();
        std::fs::write(staging.path().join("manifest.json"), b"{}").unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        let id = "a".repeat(32);
        let prepared = crate::model::ExtensionPreparedRecord {
            operation_id: operation.clone(),
            package: crate::model::ExtensionPackageRecord {
                id: id.clone(),
                name: "Fixture".to_owned(),
                version: "1.0".to_owned(),
                permissions: vec![],
                sha256: "0".repeat(64),
                directory: staging.path().to_string_lossy().into_owned(),
                enabled_role_ids: vec![],
                removed: false,
            },
        };
        core.extensions
            .lock()
            .unwrap()
            .prepared
            .insert(operation.clone(), (prepared, staging));
        let installed = core.invoke(command(json!({"type":"extensions","command":{"type":"install","operationId":operation,"roleIds":[role]}}))).unwrap();
        let package_path = installed["snapshot"]["installed"][0]["directory"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(std::path::Path::new(&package_path).is_dir());
        let acquired = core
            .invoke(command(
                json!({"type":"extensions","command":{"type":"acquire","roleId":role}}),
            ))
            .unwrap();
        let lease = acquired["lease"]["leaseId"].as_str().unwrap();
        assert_eq!(acquired["lease"]["extensionIds"], json!([id]));
        assert!(core.invoke(command(json!({"type":"extensions","command":{"type":"complete","roleId":role,"leaseId":"stale","status":"loaded"}}))).is_err());
        core.invoke(command(json!({"type":"extensions","command":{"type":"complete","roleId":role,"leaseId":lease,"status":"loaded"}}))).unwrap();
        let configured = core
            .invoke(command(
                json!({"type":"extensions","command":{"type":"configure","id":id,"roleIds":[]}}),
            ))
            .unwrap();
        assert_eq!(
            configured["snapshot"]["installed"][0]["enabledRoleIds"],
            json!([])
        );
        assert_eq!(
            configured["snapshot"]["roles"][0]["extensionIds"],
            json!([id])
        );
        let removed = core
            .invoke(command(
                json!({"type":"extensions","command":{"type":"remove","id":id}}),
            ))
            .unwrap();
        assert_eq!(removed["snapshot"]["installed"][0]["removed"], true);
        assert!(std::path::Path::new(&package_path).is_dir());
        let released = core.invoke(command(json!({"type":"extensions","command":{"type":"release","roleId":role,"leaseId":lease}}))).unwrap();
        assert_eq!(released["snapshot"]["installed"], json!([]));
        assert!(!std::path::Path::new(&package_path).exists());
        let scalar = core
            .with_runtime(|r| r.state.read_scalar("extensions".to_owned()))
            .unwrap()
            .unwrap();
        assert_eq!(scalar["roles"], json!([]));
        assert_eq!(scalar["installed"], json!([]));
        core.shutdown();
    }
}

#[test]
fn extensions_are_unavailable_in_the_stable_shell() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 22);
        let error = core
            .invoke(command(
                json!({"type":"extensions","command":{"type":"snapshot"}}),
            ))
            .unwrap_err();
        assert!(error.to_string().contains("Chromium"));
        core.shutdown();
    }
}
