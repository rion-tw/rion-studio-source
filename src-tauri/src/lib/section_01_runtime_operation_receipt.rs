pub(crate) fn record_runtime_operation_terminal(
    receipt: &SystemRuntimeOperationSummaryRecord,
) {
    #[cfg(not(feature = "desktop-e2e"))]
    let _ = receipt;
    #[cfg(feature = "desktop-e2e")]
    crate::desktop_e2e::record_event(
        "runtime-operation-terminal",
        receipt.window_id.as_deref(),
        receipt.window_generation,
        receipt.revision,
        serde_json::to_value(receipt).unwrap_or_else(|error| {
            serde_json::json!({
                "failureCode": "DESKTOP_E2E_RECEIPT_SERIALIZATION_FAILED",
                "message": error.to_string(),
                "status": "failed"
            })
        }),
    );
}

pub(crate) fn runtime_operation_receipt_result(
    receipt: SystemRuntimeOperationSummaryRecord,
) -> Result<(), String> {
    record_runtime_operation_terminal(&receipt);
    match receipt.status.as_str() {
        "applied" | "superseded" => Ok(()),
        "degraded" => Err(receipt
            .failure_code
            .unwrap_or_else(|| "SYSTEM_NATIVE_OPERATION_DEGRADED".to_owned())),
        "indeterminate" => Err(receipt
            .failure_code
            .unwrap_or_else(|| "SYSTEM_NATIVE_OPERATION_INDETERMINATE".to_owned())),
        _ => Err(receipt
            .failure_code
            .unwrap_or_else(|| "SYSTEM_NATIVE_OPERATION_FAILED".to_owned())),
    }
}
