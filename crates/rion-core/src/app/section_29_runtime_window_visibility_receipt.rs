struct RuntimeWindowVisibilityNativeExpectation<'a> {
    platform: rion_platform::Platform,
    window_id: &'a str,
    window_generation: u64,
    topology_revision: u64,
    lifecycle_epoch: u64,
    appkit_identity: Option<&'a crate::model::AppKitRuntimeHostIdentityRecord>,
    visible: bool,
}

fn runtime_window_visibility_native_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn runtime_window_visibility_native_failure_is_indeterminate(error: &CoreError) -> bool {
    matches!(
        error.code(),
        "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_MISSING"
            | "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_INVALID"
            | "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_STALE"
    ) || error.code().contains("COMPENSATION")
        || error.code().contains("INDETERMINATE")
        || error.code().contains("QUARANTINE")
        || error.code().contains("UNKNOWN")
}

fn valid_runtime_window_visibility_native_observation(
    observation: &crate::model::RuntimeWindowVisibilityNativeObservationRecord,
    expected: &RuntimeWindowVisibilityNativeExpectation<'_>,
) -> bool {
    let expected_platform = match expected.platform {
        rion_platform::Platform::Macos => "macos",
        rion_platform::Platform::Windows => "windows",
    };
    let source_valid = matches!(
        observation.source.as_str(),
        "blur" | "focus" | "hide" | "initial" | "minimize" | "restore" | "show"
    );
    let appkit_identity_valid = match expected.platform {
        rion_platform::Platform::Macos => {
            observation
                .appkit_identity
                .as_ref()
                .is_some_and(|identity| {
                    identity.logical_window_id == expected.window_id
                        && valid_runtime_ui_identifier(&identity.launch_generation)
                        && identity.native_generation > 0
                        && u64::from(identity.native_generation) == observation.native_generation
                        && expected
                            .appkit_identity
                            .is_none_or(|expected_identity| expected_identity == identity)
                })
        }
        rion_platform::Platform::Windows => {
            expected.appkit_identity.is_none() && observation.appkit_identity.is_none()
        }
    };
    observation.platform == expected_platform
        && source_valid
        && observation.sequence > 0
        && observation.lifecycle_epoch == expected.lifecycle_epoch
        && observation.logical_window_id == expected.window_id
        && observation.native_host_id > 0
        && observation.native_generation > 0
        && observation.window_generation == expected.window_generation
        && observation.topology_revision == expected.topology_revision
        && observation.visible == expected.visible
        && (!expected.visible || !observation.minimized)
        && (!observation.focused
            || (observation.visible && !observation.minimized && observation.foreground))
        && (expected.platform != rion_platform::Platform::Macos
            || observation.focused == observation.foreground)
        && appkit_identity_valid
        && observation.failure_code.is_none()
}

fn parse_runtime_window_visibility_native_receipt(
    outcome: crate::operation_actor::OperationOutcome,
    expected: RuntimeWindowVisibilityNativeExpectation<'_>,
) -> CoreResult<crate::model::RuntimeWindowVisibilityNativeReceiptRecord> {
    let result = (outcome.results.len() == 1
        && outcome.compensation_results.is_empty()
        && outcome.compensation_failures.is_empty()
        && outcome.error.is_none())
    .then(|| &outcome.results[0])
    .ok_or_else(|| {
        runtime_window_visibility_native_error(
            "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_INVALID",
            "Chromium returned an ambiguous runtime-window visibility outcome.",
        )
    })?;
    if !result.ok || result.error.is_some() {
        return Err(runtime_window_visibility_native_error(
            "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_INVALID",
            "Chromium rejected its runtime-window visibility receipt.",
        ));
    }
    let value_json = result.value_json.as_deref().ok_or_else(|| {
        runtime_window_visibility_native_error(
            "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_MISSING",
            "Chromium omitted its terminal runtime-window visibility receipt.",
        )
    })?;
    let receipt = serde_json::from_str::<crate::model::RuntimeWindowVisibilityNativeReceiptRecord>(
        value_json,
    )
    .map_err(|_| {
        runtime_window_visibility_native_error(
            "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_INVALID",
            "Chromium returned an invalid runtime-window visibility receipt.",
        )
    })?;
    let identity_matches = receipt.effect_id == result.effect_id
        && receipt.operation_id == result.operation_id
        && receipt.operation_id == outcome.operation_id
        && receipt.lifecycle_epoch == expected.lifecycle_epoch;
    let terminal_matches = match receipt.status.as_str() {
        "applied" => {
            receipt.windows.len() == 1
                && valid_runtime_window_visibility_native_observation(
                    &receipt.windows[0],
                    &expected,
                )
        }
        "superseded" => receipt.windows.is_empty(),
        _ => false,
    };
    if !identity_matches || !terminal_matches {
        return Err(runtime_window_visibility_native_error(
            "RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_STALE",
            "Chromium returned mismatched runtime-window visibility evidence.",
        ));
    }
    Ok(receipt)
}
