#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibleModifierTransitionRecord {
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "\"physical\" | \"compatible\" | \"focus-cleanup\"")]
    pub source: String,
    pub code: String,
    #[ts(type = "\"rawKeyDown\" | \"keyUp\"")]
    pub phase: String,
    #[ts(type = "\"dispatch\" | \"adoptPhysical\" | \"releaseOwnership\" | \"retained\"")]
    pub disposition: String,
    pub physical_codes: Vec<String>,
    pub core_codes: Vec<String>,
    pub event_modifier_mask: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibleModifierEvidenceRecord {
    pub core_codes_before: Vec<String>,
    pub core_codes_after: Vec<String>,
    pub native_physical_codes: Vec<String>,
    pub physical_codes_before: Vec<String>,
    pub physical_codes_after: Vec<String>,
    pub event_modifier_mask: Option<u8>,
    #[ts(type = "\"dispatch\" | \"adoptPhysical\" | \"releaseOwnership\"")]
    pub disposition: String,
    pub transitions: Vec<CompatibleModifierTransitionRecord>,
    #[ts(type = "number")]
    pub dropped_transition_count: u64,
}

#[cfg(test)]
mod compatible_modifier_tests {
    use super::TrustedInputTerminalEvidenceRecord;

    #[test]
    fn old_terminal_without_compatible_evidence_remains_readable() {
        let legacy = serde_json::json!({
            "capturedAt": "2026-09-15T07:44:43.279Z", "requestId": "request",
            "roleId": "role", "inputEpoch": 1, "surfaceGeneration": 1,
            "intent": "normal", "actionType": "key", "applicationPath": "canvas-compatibility",
            "expectedDomEventCount": 1, "observedDomEventCount": 1,
            "cdpSubmissionCertainty": "not-invoked", "physicalInterleave": "none",
            "terminalCode": "APPLIED", "traceTruncated": false, "droppedTraceStepCount": 0,
            "cleanupOutcome": "not-attempted", "recoveryOutcome": "not-required"
        });
        let terminal: TrustedInputTerminalEvidenceRecord = serde_json::from_value(legacy).unwrap();
        assert!(terminal.compatible_modifier_evidence.is_none());
        let encoded = serde_json::to_value(terminal).unwrap();
        assert!(encoded.get("compatibleModifierEvidence").is_none());
    }
}
