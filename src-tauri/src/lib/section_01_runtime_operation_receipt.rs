pub(crate) fn runtime_operation_receipt_result(
    receipt: SystemRuntimeOperationSummaryRecord,
) -> Result<(), String> {
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
