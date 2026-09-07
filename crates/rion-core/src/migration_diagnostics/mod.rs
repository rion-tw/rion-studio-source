//! Offline migration research, compiled only by the explicit diagnostic feature.
//! This module never opens the production AppCore or grants a launch receipt.
mod comparison;
mod inventory;
mod repair;
mod retained;
mod state_snapshot;
mod synthetic;
mod transfer;
use crate::session_source::{paths, snapshot, webkit};
#[cfg(test)]
use crate::session_source::{webkit_sqlite, windows};

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Inventory {
        user_data_dir: PathBuf,
        source_roots: Vec<inventory::SourceRoot>,
        #[serde(default)]
        role_ids: Vec<String>,
        output_dir: PathBuf,
        #[serde(default)]
        capture: bool,
    },
    RetainedWebkit {
        role_id: String,
        application: String,
        output_dir: PathBuf,
        #[serde(default)]
        current_user_data: Option<PathBuf>,
    },
    PublishLocalStorage {
        output_dir: PathBuf,
        expected_clone_sha256: String,
    },
    DigestLocalStorageClone {
        output_dir: PathBuf,
    },
    DecodeWebkit {
        serialization: String,
    },
    Synthetic {
        output_dir: PathBuf,
        #[serde(default)]
        serialization: Option<String>,
        #[serde(default)]
        second_role: bool,
    },
}

/// stdin/stdout boundary for the feature-gated executable. Failures contain no source data.
pub fn run(bytes: &[u8]) -> Result<Vec<u8>> {
    let request: Request = serde_json::from_slice(bytes).map_err(|_| "INVALID_REQUEST")?;
    let result = match request {
        Request::Inventory {
            user_data_dir,
            source_roots,
            role_ids,
            output_dir,
            capture,
        } => inventory::run(
            &user_data_dir,
            &source_roots,
            &role_ids,
            &output_dir,
            capture,
        )?,
        Request::RetainedWebkit {
            role_id,
            application,
            output_dir,
            current_user_data,
        } => retained::prepare(
            &role_id,
            &application,
            &output_dir,
            current_user_data.as_deref(),
        )?,
        Request::PublishLocalStorage {
            output_dir,
            expected_clone_sha256,
        } => repair::publish(&output_dir, &expected_clone_sha256)?,
        Request::DigestLocalStorageClone { output_dir } => {
            json!({"sha256": crate::session_recovery::source::digest(&output_dir.join("current-local-storage/chromium-copy/Local Storage")).map_err(|_| "CLONE_DIGEST_FAILED")?})
        }
        Request::DecodeWebkit { serialization } => {
            let bytes = STANDARD
                .decode(serialization)
                .map_err(|_| "INVALID_BASE64")?;
            json!({"localStorage": webkit::decode_export(&bytes)?})
        }
        Request::Synthetic {
            output_dir,
            serialization,
            second_role,
        } => synthetic::prepare(&output_dir, synthetic(serialization, second_role)?)?,
    };
    serde_json::to_vec_pretty(&result).map_err(|_| "REPORT_SERIALIZATION_FAILED")
}

pub(crate) fn native_platform() -> Result<rion_platform::Platform> {
    if cfg!(target_os = "macos") {
        Ok(rion_platform::Platform::Macos)
    } else if cfg!(windows) {
        Ok(rion_platform::Platform::Windows)
    } else {
        Err("NATIVE_PLATFORM_REQUIRED")
    }
}

fn synthetic(serialization: Option<String>, second_role: bool) -> Result<Value> {
    use crate::session_transfer::*;
    let platform = native_platform()?;
    let local_storage = match serialization {
        Some(data) => webkit::decode_export(&STANDARD.decode(data).map_err(|_| "INVALID_BASE64")?)?,
        None => vec![RoleSessionTransferLocalStorageOriginRecord {
            origin: "https://migration-one.invalid".to_owned(),
            entries: vec![RoleSessionTransferLocalStorageEntryRecord {
                key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(
                    &"character".encode_utf16().collect::<Vec<_>>(),
                ),
                value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(
                    &(if second_role {
                        "independent-role-B"
                    } else {
                        "角色\0測試"
                    })
                    .encode_utf16()
                    .collect::<Vec<_>>(),
                ),
            }],
        }],
    };
    let is_windows = platform == rion_platform::Platform::Windows;
    let envelope = RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: ROLE_SESSION_TRANSFER_VERSION,
            role_id: uuid::Uuid::new_v4().to_string(),
            transfer_id: uuid::Uuid::new_v4().to_string(),
            platform: if is_windows { crate::RoleSessionMigrationPlatform::Windows } else { crate::RoleSessionMigrationPlatform::Macos },
            source_engine: if is_windows { crate::RoleSessionMigrationEngine::Webview2 } else { crate::RoleSessionMigrationEngine::Wkwebview },
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
            source_evidence: is_windows.then(|| RoleSessionTransferSourceEvidenceRecord {
                kind: RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
                runtime_version: "143.0.3650.75".to_owned(),
                protocol_version: "1.3".to_owned(),
                partition_capability: RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
            }),
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies: vec![RoleSessionTransferCookieRecord {
                name: RoleSessionTransferBytesRecord::from_bytes(b"session"),
                value: RoleSessionTransferBytesRecord::from_bytes(if second_role { b"synthetic-B" } else { b"synthetic-A" }),
                domain: "migration-one.invalid".to_owned(), path: "/".to_owned(),
                host_only: true, secure: true, http_only: true,
                expiry: RoleSessionTransferCookieExpiry::Absolute { unix_ms: chrono::Utc::now().timestamp() * 1000 + 86_400_000 },
                same_site: RoleSessionTransferCookieSameSite::Lax,
                partition: RoleSessionTransferCookiePartitionEvidence::Unpartitioned,
                unsupported_attribute_codes: Vec::new(),
            }],
            local_storage,
        },
    }.canonicalized().map_err(|_| "SYNTHETIC_ENVELOPE_INVALID")?;
    Ok(
        json!({"synthetic": true, "envelope": envelope, "evidence": envelope.journal_evidence().map_err(|_| "SYNTHETIC_EVIDENCE_INVALID")?}),
    )
}
