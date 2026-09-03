#[derive(Clone, Copy)]
struct RoleSessionContractTarget<'a> {
    role_id: &'a str,
    url: &'a str,
    webview2_user_data_dir: &'a str,
    webkit_data_store_identifier: &'a str,
}

impl<'a> RoleSessionContractTarget<'a> {
    fn new(
        role_id: &'a str,
        url: &'a str,
        webview2_user_data_dir: &'a str,
        webkit_data_store_identifier: &'a str,
    ) -> Self {
        Self {
            role_id,
            url,
            webview2_user_data_dir,
            webkit_data_store_identifier,
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn clear_global_web_profile(&self) -> RuntimeResult<()> {
        let state = self.state()?;
        let has_live_surface = state.native_resources.tabs.values().any(|tab| {
            tab.roles.keys().any(|surface_id| surface_id.starts_with("web-"))
        }) || state.native_resources.surface_registry.values().any(|surface| {
            surface
                .role_id
                .as_deref()
                .is_some_and(|surface_id| surface_id.starts_with("web-"))
        });
        drop(state);
        if has_live_surface {
            return Err(RuntimeError::new(
                "GLOBAL_WEB_PROFILE_IN_USE",
                "Close every workspace Web surface and popup before clearing the shared Web profile.",
            ));
        }
        let paths = global_web_session_paths(&self.user_data_dir);
        let webview2 = paths.webview2.to_string_lossy().into_owned();
        let webkit = uuid::Uuid::from_bytes(paths.webkit_identifier).to_string();
        self.clear_role_browser_data("global-web", &webview2, &webkit, None)
    }

    fn clear_role_browser_data_contract(
        &self,
        effect_id: &str,
        operation_id: &str,
        role_id: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "clearRoleBrowserData",
            NAVIGATION_TIMEOUT,
        )
        .with_role(role_id);
        let result = self.clear_role_browser_data(
            role_id,
            webview2_user_data_dir,
            webkit_data_store_identifier,
            Some((effect_id, operation_id)),
        );
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionDataCleared",
            &result,
        ));
        result.map(|()| None)
    }

    fn snapshot_role_session_contract(
        &self,
        transaction_id: &str,
        target: RoleSessionContractTarget<'_>,
        replace_existing: bool,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "snapshotRoleSession",
            NAVIGATION_TIMEOUT,
        )
        .with_role(target.role_id);
        let result = self.snapshot_role_session_transfer(
            transaction_id,
            target.role_id,
            target.url,
            target.webview2_user_data_dir,
            target.webkit_data_store_identifier,
            replace_existing,
        );
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionSnapshot",
            &result,
        ));
        result.map(|()| None)
    }

    fn apply_role_session_contract(
        &self,
        transaction_id: String,
        target: RoleSessionContractTarget<'_>,
        replace_existing: bool,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "applyRoleSessionTransfer",
            NAVIGATION_TIMEOUT,
        )
        .with_role(target.role_id);
        let transfer = self
            .load_session_transfer(&transaction_id)
            .and_then(|payload| {
                self.apply_role_session_transfer(RoleSessionTransferRequest {
                    role_id: target.role_id,
                    launch_url: target.url,
                    webview2_user_data_dir: target.webview2_user_data_dir,
                    webkit_data_store_identifier: target.webkit_data_store_identifier,
                    replace_existing,
                    payload,
                    backup_transaction_id: Some(&transaction_id),
                })
            });
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionTransferApplied",
            &transfer,
        ));
        let (inserted_cookie_count, backup) = transfer?;
        self.state()?
            .session_import_backups
            .insert(transaction_id, backup);
        Ok(Some(
            json!({ "insertedCookieCount": inserted_cookie_count }).to_string(),
        ))
    }

    fn verify_role_session_contract(
        &self,
        target: RoleSessionContractTarget<'_>,
        authenticated_path: &str,
        login_path: &str,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "verifyRoleSession",
            NAVIGATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::RuntimeProbe)
        .with_role(target.role_id);
        let result = self.verify_role_authentication(
            target.role_id,
            target.url,
            authenticated_path,
            login_path,
            target.webview2_user_data_dir,
            target.webkit_data_store_identifier,
        );
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionVerified",
            &result,
        ));
        result
    }

    fn rollback_role_session_contract(
        &self,
        transaction_id: &str,
        target: RoleSessionContractTarget<'_>,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "rollbackRoleSessionTransfer",
            NAVIGATION_TIMEOUT,
        )
        .with_role(target.role_id);
        let result = self.rollback_role_session_transfer(
            transaction_id,
            target.role_id,
            target.url,
            target.webview2_user_data_dir,
            target.webkit_data_store_identifier,
        );
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionTransferRolledBack",
            &result,
        ));
        result.map(|()| None)
    }

    fn commit_role_session_contract(
        &self,
        transaction_id: &str,
    ) -> RuntimeResult<Option<String>> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Session,
            "commitRoleSessionTransfer",
            PLATFORM_CALLBACK_TIMEOUT,
        );
        let result = self.commit_role_session_transfer(transaction_id);
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "sessionTransferCommitted",
            &result,
        ));
        result.map(|()| None)
    }
}
