//! Real retained sources enter only new offline targets, never production Core.
use super::{Result, inventory, native_platform, paths};
use crate::{
    session_recovery::{source, stage},
    session_source::local_storage,
    session_transfer::*,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn source_path(home: &Path, role: &str, application: &str) -> Result<PathBuf> {
    paths::role_id(role)?;
    if ![
        "com.rionstudio.launcher",
        "com.rionstudio.launcher.dev",
        "rion-tauri",
    ]
    .contains(&application)
    {
        return Err("SOURCE_APP_ID_INVALID");
    }
    Ok(home
        .join("Library/WebKit")
        .join(application)
        .join("WebsiteDataStore")
        .join(inventory::store_id(role)))
}

pub(super) fn prepare(
    role: &str,
    application: &str,
    output: &Path,
    current_data: Option<&Path>,
) -> Result<Value> {
    let platform = native_platform()?;
    if !source::native_support(platform) {
        return Err("NATIVE_PLATFORM_VALIDATION_PENDING");
    }
    let home = std::env::var_os("HOME").ok_or("SOURCE_ROOT_UNAVAILABLE")?;
    let source = paths::existing(&source_path(Path::new(&home), role, application)?)?;
    let root = paths::create_output(output, std::slice::from_ref(&source))?;
    let before = source::digest(&source).map_err(|_| "SOURCE_DIGEST_FAILED")?;
    let capture = local_storage::capture(&source, &root, role, platform)?;
    let origins = capture.origins;
    let cookies = capture.cookies;
    let errors = capture.local_storage_reasons;
    let cookie_errors = capture.cookie_reasons;
    let snapshot_digest = capture.source_sha256;
    if source::digest(&source).map_err(|_| "SOURCE_DIGEST_FAILED")? != before {
        return Err("SOURCE_CHANGED_DURING_DIAGNOSTIC");
    }
    if origins.is_empty() {
        return Err("LOCAL_STORAGE_SOURCE_MISSING_UNPROVEN");
    }
    let comparison = current_data
        .map(|data| super::comparison::compare(data, role, &root, &origins))
        .transpose()?;
    if let (Some(data), Some(comp)) = (current_data, comparison.as_ref()) {
        super::repair::prepare(
            &root,
            data,
            role,
            comp["currentSourceSha256"]
                .as_str()
                .ok_or("COMPARISON_DIGEST_MISSING")?,
            &source,
            &before,
        )?;
    }
    let origin_summaries: Vec<_> = origins
        .iter()
        .map(|origin| {
            json!({
                "originSha256": hex::encode(Sha256::digest(origin.origin.as_bytes())),
                "entries": origin.entries.len()
            })
        })
        .collect();
    let envelope = RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: ROLE_SESSION_TRANSFER_VERSION,
            role_id: role.to_owned(),
            transfer_id: uuid::Uuid::new_v4().to_string(),
            platform: crate::RoleSessionMigrationPlatform::Macos,
            source_engine: crate::RoleSessionMigrationEngine::Wkwebview,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 0,
            source_evidence: None,
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies,
            local_storage: origins,
        },
    };
    let stage = stage::prepare(&root, &uuid::Uuid::new_v4().to_string(), platform, envelope)
        .map_err(|_| "ISOLATED_STAGE_FAILED")?;
    let envelope = read_session_transfer_vault(&stage.root, platform, &stage.journal)
        .map_err(|_| "ISOLATED_VAULT_FAILED")?;
    let assessment = json!({"synthetic":false,"roleId":role,"application":application,
        "sourceSha256":before,"snapshotSha256":snapshot_digest,"sourceUnchanged":true,
        "comparison":comparison,"origins":origin_summaries,"errors":errors,
        "cookieCount":envelope.inventory.cookies.len(),"cookieReasons":cookie_errors,
        "cookies":"partiallyTransferred","login":"notRun",
        "productionMutationPerformed":false,"sourceSelectedForProduction":false});
    std::fs::write(
        root.join("source-assessment.json"),
        serde_json::to_vec_pretty(&assessment).map_err(|_| "REPORT_SERIALIZATION_FAILED")?,
    )
    .map_err(|_| "REPORT_WRITE_FAILED")?;
    // Secret-bearing pipe response: the driver retains only `assessment` in its report.
    Ok(
        json!({"assessment":assessment,"journal":stage.journal,"rolePaths":stage.paths,
        "evidence":envelope.journal_evidence().map_err(|_| "ISOLATED_EVIDENCE_FAILED")?,
        "canonicalEnvelopeBase64":STANDARD.encode(envelope.canonical_envelope_json()
            .map_err(|_| "ISOLATED_CANONICAL_FAILED")?)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_selection_is_bound_to_known_application_and_role_store() {
        let home = Path::new("/synthetic");
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        assert_ne!(
            source_path(home, a, "com.rionstudio.launcher").unwrap(),
            source_path(home, b, "com.rionstudio.launcher").unwrap()
        );
        assert_ne!(
            source_path(home, a, "com.rionstudio.launcher").unwrap(),
            source_path(home, a, "com.rionstudio.launcher.dev").unwrap()
        );
        assert_eq!(
            source_path(home, a, "../other").unwrap_err(),
            "SOURCE_APP_ID_INVALID"
        );
        assert_eq!(
            source_path(home, "../other", "rion-tauri").unwrap_err(),
            "INVALID_ROLE_ID"
        );
    }
}
