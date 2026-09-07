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
                apply_to_all_roles: false,
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

#[test]
fn extension_all_roles_survives_restart_and_applies_to_future_leases() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = core_for_platform_contract(platform, 23);
        let role = create_role(&core, &first_game_id(&core), 1);
        // Read a pre-feature catalogue to prove the additive field defaults to false.
        let id = "b".repeat(32);
        core.with_runtime(|r| r.state.replace_scalar("extensions".to_owned(), json!({
            "revision": 1, "roles": [], "installed": [{ "id": id, "name": "Legacy", "version": "1",
            "permissions": [], "sha256": "0".repeat(64), "directory": directory.path().join("extensions").join("fixture"),
            "enabledRoleIds": [role], "removed": false }]
        }))).unwrap();
        let invoke = |input: Value| core.invoke(command(json!({"type":"extensions","command": input})));
        assert_eq!(invoke(json!({"type":"snapshot"})).unwrap()["snapshot"]["installed"][0]["applyToAllRoles"], false);
        let active = invoke(json!({"type":"acquire","roleId":role})).unwrap();
        let all = invoke(json!({"type":"configure","id":id,"roleIds":["ignored"],"applyToAllRoles":true})).unwrap();
        assert_eq!(all["snapshot"]["installed"][0]["enabledRoleIds"], json!([]));
        assert_eq!(all["snapshot"]["installed"][0]["applyToAllRoles"], true);
        assert!(invoke(json!({"type":"configure","id":id,"roleIds":["missing"],"applyToAllRoles":false})).is_err());
        assert!(invoke(json!({"type":"configure","id":id,"roleIds":[role,role],"applyToAllRoles":false})).is_err());
        assert_eq!(invoke(json!({"type":"snapshot"})).unwrap()["snapshot"]["installed"][0]["applyToAllRoles"], true);
        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_extension_write BEFORE INSERT ON settings WHEN NEW.key='extensions' BEGIN SELECT RAISE(ABORT, 'fixture rejects extension persistence'); END;").unwrap();
        assert!(invoke(json!({"type":"configure","id":id,"roleIds":[]})).is_err());
        assert_eq!(invoke(json!({"type":"snapshot"})).unwrap()["snapshot"]["installed"][0]["applyToAllRoles"], true);
        connection.execute_batch("DROP TRIGGER reject_extension_write").unwrap();
        drop(connection);
        assert_eq!(all["snapshot"]["roles"][0]["leaseId"], active["lease"]["leaseId"]);
        core.shutdown();
        let restored = AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(), build_commit: None, packaged: false,
            platform: platform.to_owned(), runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        }).unwrap();
        let future = create_role(&restored, &first_game_id(&restored), 2);
        let invoke = |input: Value| restored.invoke(command(json!({"type":"extensions","command":input})));
        let acquired = invoke(json!({"type":"acquire","roleId":future})).unwrap();
        assert_eq!(acquired["lease"]["extensionIds"], json!([id]));
        let selected = invoke(json!({"type":"configure","id":id,"roleIds":[role]})).unwrap();
        assert_eq!(selected["snapshot"]["installed"][0]["applyToAllRoles"], false);
        assert_eq!(selected["snapshot"]["roles"][0]["extensionIds"], json!([id]));
        invoke(json!({"type":"release","roleId":future,"leaseId":acquired["lease"]["leaseId"]})).unwrap();
        assert_eq!(invoke(json!({"type":"acquire","roleId":future})).unwrap()["lease"]["extensionIds"], json!([]));
        invoke(json!({"type":"configure","id":id,"roleIds":[],"applyToAllRoles":true})).unwrap();
        let held = invoke(json!({"type":"acquire","roleId":role})).unwrap();
        let removed = invoke(json!({"type":"remove","id":id})).unwrap();
        assert_eq!(removed["snapshot"]["installed"][0]["applyToAllRoles"], false);
        assert_eq!(held["lease"]["extensionIds"], json!([id]));
        let later = create_role(&restored, &first_game_id(&restored), 3);
        assert_eq!(invoke(json!({"type":"acquire","roleId":later})).unwrap()["lease"]["extensionIds"], json!([]));
        restored.shutdown();
    }
}
