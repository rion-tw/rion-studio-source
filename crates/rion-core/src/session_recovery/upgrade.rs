use super::{error, source, stage, types::RoleSessionUpgradeResult};
use crate::{CoreResult, RoleSessionMigrationRecord, session_transfer::*};
use std::path::Path;

pub(crate) struct SourceEvidence {
    pub application: String,
    pub policy: String,
    pub sha256: String,
}

pub(crate) struct ReadResult {
    pub envelope: Option<RoleSessionTransferEnvelopeRecord>,
    pub result: RoleSessionUpgradeResult,
    pub source: Option<SourceEvidence>,
}

pub(crate) fn unavailable(code: &str) -> RoleSessionUpgradeResult {
    RoleSessionUpgradeResult {
        cookies: "unavailable".to_owned(),
        local_storage: "unavailable".to_owned(),
        cookie_count: 0,
        local_storage_origin_count: 0,
        local_storage_entry_count: 0,
        reasons: vec![code.to_owned()],
    }
}

pub(crate) fn read(
    data: &Path,
    role: &str,
    attempt: &str,
    platform: rion_platform::Platform,
    previous: Option<&RoleSessionMigrationRecord>,
) -> CoreResult<ReadResult> {
    if !source::native_support(platform) {
        return Ok(ReadResult {
            envelope: None,
            result: unavailable("NATIVE_PLATFORM_VALIDATION_PENDING"),
            source: None,
        });
    }
    let Some(mut candidate) = source::automatic(data, platform, role, previous)? else {
        return Ok(ReadResult {
            envelope: None,
            result: unavailable("RECOVERY_SOURCE_MISSING_UNPROVEN"),
            source: None,
        });
    };
    if candidate.envelope.is_some() {
        let mut envelope = candidate
            .envelope
            .take()
            .ok_or_else(|| error("RECOVERY_SOURCE_COMPLETENESS_UNPROVEN"))?;
        let before = envelope.inventory.cookies.len();
        envelope.inventory.cookies.retain(|cookie| !matches!(cookie.expiry, RoleSessionTransferCookieExpiry::Absolute { unix_ms } if unix_ms <= chrono::Utc::now().timestamp_millis()));
        let mut result = unavailable("OTHER_WEBSITE_DATA_NOT_MIGRATED");
        result.cookies = if before == envelope.inventory.cookies.len() {
            "pending"
        } else {
            "partialPending"
        }
        .to_owned();
        if before != envelope.inventory.cookies.len() {
            result
                .reasons
                .push("COOKIE_EXPIRED_BEFORE_VERIFICATION".to_owned());
        }
        result.local_storage = "pending".to_owned();
        envelope.canonical_envelope_json()?;
        return Ok(ReadResult {
            source: Some(SourceEvidence {
                application: candidate.view.application,
                policy: "authenticatedRSP2".to_owned(),
                sha256: source::digest(&candidate.path)?,
            }),
            envelope: Some(envelope),
            result,
        });
    }
    let base = data.join(".session-upgrade");
    stage::private_directory(&base)?;
    let output = base.join(attempt);
    stage::private_directory(&output)?;
    let (origins, cookies, local_storage_reasons, mut cookie_reasons, source_sha256) =
        match platform {
            rion_platform::Platform::Macos => {
                let capture = crate::session_source::local_storage::capture(
                    &candidate.path,
                    &output,
                    role,
                    platform,
                )
                .map_err(error)?;
                (
                    capture.origins,
                    capture.cookies,
                    capture.local_storage_reasons,
                    capture.cookie_reasons,
                    capture.source_sha256,
                )
            }
            rion_platform::Platform::Windows => {
                let capture = crate::session_source::windows::capture(
                    &candidate.path,
                    &output,
                    role,
                    platform,
                )
                .map_err(error)?;
                (
                    capture.origins,
                    capture.cookies,
                    capture.local_storage_reasons,
                    capture.cookie_reasons,
                    capture.source_sha256,
                )
            }
        };
    let mut reasons = local_storage_reasons.clone();
    reasons.append(&mut cookie_reasons);
    reasons.push("OTHER_WEBSITE_DATA_NOT_MIGRATED".to_owned());
    reasons.sort();
    reasons.dedup();
    let mut result = unavailable("COOKIE_RAW_SOURCE_BEST_EFFORT");
    result.reasons = reasons;
    result.cookies = if cookies.is_empty() {
        "unavailable"
    } else {
        "partialPending"
    }
    .to_owned();
    result.local_storage = if origins.is_empty() {
        "unavailable"
    } else if local_storage_reasons.is_empty() {
        "pending"
    } else {
        "partialPending"
    }
    .to_owned();
    if origins.is_empty() && cookies.is_empty() {
        return Ok(ReadResult {
            envelope: None,
            result,
            source: Some(SourceEvidence {
                application: candidate.view.application,
                policy: "v84RoleStore".to_owned(),
                sha256: source_sha256,
            }),
        });
    }
    let envelope = RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: ROLE_SESSION_TRANSFER_VERSION,
            role_id: role.to_owned(),
            transfer_id: uuid::Uuid::new_v4().to_string(),
            platform: match platform {
                rion_platform::Platform::Macos => crate::RoleSessionMigrationPlatform::Macos,
                rion_platform::Platform::Windows => crate::RoleSessionMigrationPlatform::Windows,
            },
            source_engine: match platform {
                rion_platform::Platform::Macos => crate::RoleSessionMigrationEngine::Wkwebview,
                rion_platform::Platform::Windows => crate::RoleSessionMigrationEngine::Webview2,
            },
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 0,
            source_evidence: (platform == rion_platform::Platform::Windows).then_some(
                RoleSessionTransferSourceEvidenceRecord {
                    kind: RoleSessionTransferSourceEvidenceKind::Webview2ProfileSnapshot,
                    runtime_version: "legacy-webview2-profile".to_owned(),
                    protocol_version: "1.0".to_owned(),
                    partition_capability:
                        RoleSessionTransferCookiePartitionCapability::ProfileDatabaseBestEffort,
                },
            ),
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies,
            local_storage: origins,
        },
    };
    envelope.canonical_envelope_json()?;
    Ok(ReadResult {
        envelope: Some(envelope),
        result,
        source: Some(SourceEvidence {
            application: candidate.view.application,
            policy: "v84RoleStore".to_owned(),
            sha256: source_sha256,
        }),
    })
}

pub(crate) fn verified(
    result: &mut RoleSessionUpgradeResult,
    envelope: &RoleSessionTransferEnvelopeRecord,
    cookie_count: usize,
) {
    for status in [&mut result.cookies, &mut result.local_storage] {
        *status = match status.as_str() {
            "pending" => "transferred",
            "partialPending" => "partiallyTransferred",
            other => other,
        }
        .to_owned();
    }
    result.cookie_count = cookie_count;
    result.local_storage_origin_count = envelope.inventory.local_storage.len();
    result.local_storage_entry_count = envelope
        .inventory
        .local_storage
        .iter()
        .map(|origin| origin.entries.len())
        .sum();
}
pub(crate) fn failed(result: &mut RoleSessionUpgradeResult, code: &str) {
    for status in [&mut result.cookies, &mut result.local_storage] {
        if status == "pending" || status == "partialPending" {
            *status = "failed".to_owned();
        }
    }
    result.reasons.push(code.to_owned());
    result.cookie_count = 0;
    result.local_storage_origin_count = 0;
    result.local_storage_entry_count = 0;
}
