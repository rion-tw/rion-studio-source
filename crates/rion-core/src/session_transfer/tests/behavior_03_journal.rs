#[test]
fn journal_evidence_contains_only_counts_digests_and_identity() {
    let envelope = test_envelope();
    let evidence = envelope.journal_evidence().unwrap();

    assert_eq!(evidence.role_id, envelope.metadata.role_id);
    assert_eq!(evidence.transfer_id, envelope.metadata.transfer_id);
    assert_eq!(evidence.cookie_count, 2);
    assert_eq!(evidence.local_storage_origin_count, 2);
    assert_eq!(evidence.local_storage_entry_count, 3);
    assert_eq!(
        evidence.envelope_sha256,
        envelope.envelope_sha256().unwrap()
    );
    assert_eq!(
        evidence.inventory_sha256,
        envelope.inventory_sha256().unwrap()
    );

    let mut transition = test_transition(&envelope.metadata);
    evidence.apply_to_transition(&mut transition).unwrap();
    assert_eq!(transition.envelope_sha256, Some(evidence.envelope_sha256));
    assert_eq!(transition.inventory_sha256, Some(evidence.inventory_sha256));
    assert_eq!(transition.cookie_count, Some(2));
    assert_eq!(transition.local_storage_origin_count, Some(2));
    assert_eq!(transition.local_storage_entry_count, Some(3));
}

#[test]
fn journal_evidence_rejects_mismatched_identity_before_mutation() {
    const MISMATCHED_ID: &str = "33333333-3333-4333-8333-333333333333";
    let envelope = test_envelope();
    let evidence = envelope.journal_evidence().unwrap();
    let mut transition = test_transition(&envelope.metadata);
    transition.transfer_id = MISMATCHED_ID.to_owned();

    let message = expect_error(
        evidence.apply_to_transition(&mut transition),
        "ROLE_SESSION_TRANSFER_JOURNAL_IDENTITY_MISMATCH",
    );
    assert!(!message.contains(MISMATCHED_ID));
    assert_eq!(transition.envelope_sha256, None);
    assert_eq!(transition.inventory_sha256, None);
    assert_eq!(transition.cookie_count, None);
    assert_eq!(transition.local_storage_origin_count, None);
    assert_eq!(transition.local_storage_entry_count, None);
}

fn test_transition(
    metadata: &RoleSessionTransferMetadataRecord,
) -> RoleSessionMigrationTransitionInput {
    RoleSessionMigrationTransitionInput {
        role_id: metadata.role_id.clone(),
        transfer_id: metadata.transfer_id.clone(),
        transition_id: "44444444-4444-4444-8444-444444444444".to_owned(),
        expected_phase: RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: 1,
        next_phase: RoleSessionMigrationPhase::Exported,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: "2026-08-30T01:02:03Z".to_owned(),
    }
}
