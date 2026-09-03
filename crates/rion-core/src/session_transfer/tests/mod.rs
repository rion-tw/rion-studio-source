//! Focused behavior tests for the canonical session-transfer contract.

use std::fmt::Debug;

use super::*;
use crate::session_migration::RoleSessionMigrationPhase;

fn test_metadata() -> RoleSessionTransferMetadataRecord {
    RoleSessionTransferMetadataRecord {
        format: RoleSessionTransferFormat::RionRoleSessionTransfer,
        version: ROLE_SESSION_TRANSFER_VERSION,
        transfer_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        role_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        platform: RoleSessionMigrationPlatform::Macos,
        source_engine: RoleSessionMigrationEngine::Wkwebview,
        target_engine: RoleSessionMigrationEngine::Chromium,
        source_revision: 7,
        source_evidence: None,
    }
}

fn test_cookie(
    name: &[u8],
    value: &[u8],
    domain: &str,
    path: &str,
) -> RoleSessionTransferCookieRecord {
    RoleSessionTransferCookieRecord {
        name: RoleSessionTransferBytesRecord::from_bytes(name),
        value: RoleSessionTransferBytesRecord::from_bytes(value),
        domain: domain.to_owned(),
        path: path.to_owned(),
        host_only: true,
        secure: true,
        http_only: true,
        expiry: RoleSessionTransferCookieExpiry::Session,
        same_site: RoleSessionTransferCookieSameSite::Unspecified,
        partition: RoleSessionTransferCookiePartitionEvidence::Unpartitioned,
        unsupported_attribute_codes: Vec::new(),
    }
}

fn test_local_storage_entry(
    key: &[u16],
    value: &[u16],
) -> RoleSessionTransferLocalStorageEntryRecord {
    RoleSessionTransferLocalStorageEntryRecord {
        key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(key),
        value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(value),
    }
}

fn test_envelope() -> RoleSessionTransferEnvelopeRecord {
    let mut persistent_cookie =
        test_cookie(&[0xff, b'a'], &[0x00, 0xfe, b'v'], "www.example.com", "/z");
    persistent_cookie.expiry = RoleSessionTransferCookieExpiry::Absolute {
        unix_ms: 1_900_000_000_000,
    };
    persistent_cookie.same_site = RoleSessionTransferCookieSameSite::Lax;

    RoleSessionTransferEnvelopeRecord {
        metadata: test_metadata(),
        inventory: RoleSessionTransferInventoryRecord {
            cookies: vec![
                persistent_cookie,
                test_cookie(b"sid", b"secret-two", "example.com", "/"),
            ],
            local_storage: vec![
                RoleSessionTransferLocalStorageOriginRecord {
                    origin: "https://z.example.com".to_owned(),
                    entries: vec![test_local_storage_entry(&[0xd800], &[0x0041, 0x0000])],
                },
                RoleSessionTransferLocalStorageOriginRecord {
                    origin: "https://a.example.com".to_owned(),
                    entries: vec![
                        test_local_storage_entry(&[0x0062], &[0x0062]),
                        test_local_storage_entry(&[0x0061], &[0xdfff]),
                    ],
                },
            ],
        },
    }
}

fn expect_error<T: Debug>(result: CoreResult<T>, expected_code: &str) -> String {
    let error = result.expect_err("validation should fail closed");
    assert_eq!(error.code(), expected_code);
    error.to_string()
}

include!("behavior_01_canonical.rs");
include!("behavior_02_validation.rs");
include!("behavior_03_journal.rs");
include!("behavior_04_vault.rs");
include!("behavior_05_webview2_source.rs");
