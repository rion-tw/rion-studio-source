#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibleModifierTransitionRecord {
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "\"physical\" | \"compatible\" | \"focus-cleanup\" | \"physical-reconcile\"")]
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
    use super::{CompatibleModifierTransitionRecord, TrustedInputTerminalEvidenceRecord};

    #[test]
    fn physical_reconcile_transition_round_trips_without_changing_legacy_sources() {
        for source in ["physical", "compatible", "focus-cleanup", "physical-reconcile"] {
            let evidence = serde_json::json!({
                "sequence": 1, "source": source, "code": "AltLeft", "phase": "keyUp",
                "disposition": "dispatch", "physicalCodes": [], "coreCodes": [],
                "eventModifierMask": 0
            });
            let decoded: CompatibleModifierTransitionRecord =
                serde_json::from_value(evidence.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), evidence);
        }
    }


    #[test]
    fn rejected_receipt_claims_round_trip_separately_from_validated_delivery() {
        let value = serde_json::json!({
            "reason": "identity", "field": "sequence", "expected": "555", "received": "554",
            "expectedEventCount": 1, "reportedEventCount": 1, "reportedStatus": "applied",
            "reportedModifierMask": 12
        });
        let decoded: super::CompatibleReceiptValidationRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }

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
        assert!(terminal.compatible_receipt_validation.is_none());
        let encoded = serde_json::to_value(terminal).unwrap();
        assert!(encoded.get("compatibleModifierEvidence").is_none());
    }
}

/// Bounded, unverified receipt claims. These never establish input delivery.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibleReceiptValidationRecord {
    pub reason: String,
    pub field: String,
    pub expected: String,
    pub received: String,
    pub expected_event_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reported_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reported_event_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reported_modifier_mask: Option<u8>,
}
