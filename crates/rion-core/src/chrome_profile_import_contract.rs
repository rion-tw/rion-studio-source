use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::{
    database::OperationJournalRecord,
    error::{CoreError, CoreResult},
    model::{
        ChromeProfileImportUnsupportedCountsRecord, LocalStorageEntryRecord, RolePathsRecord,
        SessionCookieRecord, SessionTransferPayloadRecord,
    },
};

pub const CHROME_PROFILE_IMPORT_CONTRACT_VERSION: u32 = 1;
pub const CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
pub const CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES: usize = 65 * 1024 * 1024;
const MAX_COOKIES: usize = 20_000;
const MAX_LOCAL_STORAGE_ENTRIES: usize = 10_000;
const CAPABILITY_BYTES: usize = 32;
const JOURNAL_KIND: &str = "chrome_profile_import_v2";
const JOURNAL_REVISION_KEY: &str = "chromiumJournalRevision";
const CAPABILITY_HASH_KEY: &str = "freshVerificationCapabilitySha256";
const FRESH_RECEIPT_KEY: &str = "freshVerificationReceipt";
const COMMIT_MARKER_HASH_KEY: &str = "chromiumCommitMarkerSha256";
const BACKUP_FILE: &str = "backup.enc";
const COMMIT_MARKER_FILE: &str = "committed";
#[cfg(test)]
const TEST_LEGACY_PREFIX: &[u8] = b"rion-chrome-import-test-v1\0";
#[cfg(test)]
const TEST_BOUND_PREFIX: &[u8] = b"rion-chrome-import-test-v2\0";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeProfileImportTransactionAcquireInput {
    pub role_id: String,
    pub transaction_id: String,
    pub expected_journal_phase: String,
    pub expected_journal_revision: u64,
    #[serde(default)]
    pub expected_launch_url: Option<String>,
    #[serde(default)]
    pub expected_replace_existing: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeProfileImportTransactionFence {
    pub lease_id: String,
    pub role_id: String,
    pub transaction_id: String,
    pub expected_journal_phase: String,
    pub expected_journal_revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeProfileImportTransactionReleaseInput {
    pub lease_id: String,
    pub role_id: String,
    pub transaction_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeProfileImportFreshVerificationReceipt {
    pub verifier_instance_id: String,
    pub parent_exit_evidence_sha256: String,
    pub surface_drain_evidence_sha256: String,
    pub chromium_path_sha256: String,
    pub inventory_sha256: String,
    pub cookie_count: u32,
    pub local_storage_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileImportTransactionDescriptor {
    pub contract_version: u32,
    pub lease_id: String,
    pub operation_id: String,
    pub transaction_id: String,
    pub role_id: String,
    pub journal_phase: String,
    pub journal_revision: u64,
    pub launch_url: String,
    pub launch_origin: String,
    pub replace_existing: bool,
    pub created_role: bool,
    pub role_paths: RolePathsRecord,
    pub chromium_path_sha256: String,
    pub staging_sha256: String,
    pub staging_bytes: u64,
    pub cookie_count: u32,
    pub local_storage_count: u32,
    pub unsupported: ChromeProfileImportUnsupportedCountsRecord,
    pub warnings: Vec<String>,
    pub commit_marker_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileImportVaultEvidence {
    pub transaction_id: String,
    pub role_id: String,
    pub journal_phase: String,
    pub journal_revision: u64,
    pub protected_sha256: String,
    pub inventory_sha256: String,
    pub cookie_count: u32,
    pub local_storage_count: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct ChromeProfileImportTransactionIdentity {
    pub operation_id: String,
    pub transaction_id: String,
    pub role_id: String,
    pub journal_phase: String,
    pub journal_revision: u64,
    pub launch_url: String,
    pub launch_origin: String,
    pub replace_existing: bool,
    pub created_role: bool,
    pub role_paths: RolePathsRecord,
    pub chromium_path_sha256: String,
    pub staging_sha256: String,
    pub staging_bytes: u64,
    pub cookie_count: u32,
    pub local_storage_count: u32,
    pub unsupported: ChromeProfileImportUnsupportedCountsRecord,
    pub warnings: Vec<String>,
    pub commit_marker_sha256: Option<String>,
}

#[derive(Debug, Clone)]
struct ChromeProfileImportLeaseRecord {
    lease_id: String,
    transaction_id: String,
    role_id: String,
    chromium_path_sha256: String,
}

#[derive(Debug, Default)]
pub(crate) struct ChromeProfileImportContractRuntime {
    leases: HashMap<String, ChromeProfileImportLeaseRecord>,
}

impl ChromeProfileImportContractRuntime {
    pub(crate) fn acquire(
        &mut self,
        identity: &ChromeProfileImportTransactionIdentity,
    ) -> CoreResult<String> {
        if self.leases.values().any(|lease| {
            lease.transaction_id == identity.transaction_id
                || lease.role_id == identity.role_id
                || lease.chromium_path_sha256 == identity.chromium_path_sha256
        }) {
            return Err(domain(
                "CHROME_PROFILE_IMPORT_TRANSACTION_BUSY",
                "The Chrome profile import destination is already under exclusive maintenance.",
            ));
        }
        let lease_id = Uuid::new_v4().to_string();
        self.leases.insert(
            lease_id.clone(),
            ChromeProfileImportLeaseRecord {
                lease_id: lease_id.clone(),
                transaction_id: identity.transaction_id.clone(),
                role_id: identity.role_id.clone(),
                chromium_path_sha256: identity.chromium_path_sha256.clone(),
            },
        );
        Ok(lease_id)
    }

    pub(crate) fn assert_fence(
        &self,
        fence: &ChromeProfileImportTransactionFence,
        identity: &ChromeProfileImportTransactionIdentity,
    ) -> CoreResult<()> {
        let lease = self.leases.get(&fence.lease_id).ok_or_else(|| {
            domain(
                "CHROME_PROFILE_IMPORT_LEASE_NOT_FOUND",
                "The Chrome profile import exclusive lease is not active.",
            )
        })?;
        if lease.lease_id != fence.lease_id
            || lease.transaction_id != fence.transaction_id
            || lease.role_id != fence.role_id
            || lease.chromium_path_sha256 != identity.chromium_path_sha256
            || identity.transaction_id != fence.transaction_id
            || identity.role_id != fence.role_id
            || identity.journal_phase != fence.expected_journal_phase
            || identity.journal_revision != fence.expected_journal_revision
        {
            return Err(domain(
                "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                "The Chrome profile import transaction changed before the operation completed.",
            ));
        }
        Ok(())
    }

    pub(crate) fn release(
        &mut self,
        input: &ChromeProfileImportTransactionReleaseInput,
    ) -> CoreResult<()> {
        let lease = self.leases.get(&input.lease_id).ok_or_else(|| {
            domain(
                "CHROME_PROFILE_IMPORT_LEASE_NOT_FOUND",
                "The Chrome profile import exclusive lease is not active.",
            )
        })?;
        if lease.transaction_id != input.transaction_id || lease.role_id != input.role_id {
            return Err(domain(
                "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                "The Chrome profile import transaction lease identity does not match.",
            ));
        }
        self.leases.remove(&input.lease_id);
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) enum ChromeProfileImportJournalTransition {
    AwaitFreshVerification {
        capability_sha256: String,
    },
    CompleteFreshVerification {
        capability: SecretBytes,
        receipt: ChromeProfileImportFreshVerificationReceipt,
    },
    BeginCommit {
        marker_sha256: String,
    },
}

#[derive(Debug)]
pub(crate) struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    fn as_slice(&self) -> &[u8] {
        &self.0
    }

    fn fill_zero(&mut self) {
        self.0.fill(0);
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.fill_zero();
    }
}

#[derive(Debug)]
pub(crate) struct ChromeProfileImportJournalTransitionInput {
    pub operation_id: String,
    pub role_id: String,
    pub transaction_id: String,
    pub expected_phase: String,
    pub expected_revision: u64,
    pub transition: ChromeProfileImportJournalTransition,
}

#[derive(Debug)]
struct CanonicalPayload {
    bytes: Vec<u8>,
    inventory_sha256: String,
    cookie_count: u32,
    local_storage_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictSessionTransferPayload {
    cookies: Vec<StrictSessionCookie>,
    local_storage: Vec<StrictLocalStorageEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictSessionCookie {
    name: String,
    value: String,
    #[serde(default)]
    domain: Option<String>,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: String,
    #[serde(default)]
    expires_unix_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictLocalStorageEntry {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChromeProfileImportCommitMarker {
    version: u32,
    operation_id: String,
    transaction_id: String,
    role_id: String,
    journal_revision: u64,
    chromium_path_sha256: String,
    staging_sha256: String,
    inventory_sha256: String,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

pub(crate) fn journal_revision(journal: &OperationJournalRecord) -> CoreResult<u64> {
    journal
        .payload
        .get(JOURNAL_REVISION_KEY)
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| {
            domain(
                "CHROME_PROFILE_IMPORT_JOURNAL_UNSUPPORTED",
                "The Chrome profile import journal predates the Chromium transaction contract.",
            )
        })
}

pub(crate) fn journal_fresh_receipt(
    journal: &OperationJournalRecord,
) -> CoreResult<ChromeProfileImportFreshVerificationReceipt> {
    if journal.kind != JOURNAL_KIND || journal.phase != "freshVerified" {
        return Err(fence_error());
    }
    serde_json::from_value(
        journal
            .payload
            .get(FRESH_RECEIPT_KEY)
            .cloned()
            .ok_or_else(fresh_receipt_error)?,
    )
    .map_err(|_| fresh_receipt_error())
}

pub(crate) fn advance_journal(
    journal: &mut OperationJournalRecord,
    next_phase: &str,
) -> CoreResult<()> {
    validate_journal_phase(next_phase)?;
    let allowed = matches!(
        (journal.phase.as_str(), next_phase),
        ("prepared", "snapshotted")
            | ("snapshotted", "applying")
            | ("applying", "verified")
            | ("verified", "awaitingFreshVerification")
            | ("verified", "metadataCommitted")
            | ("awaitingFreshVerification", "freshVerified")
            | ("freshVerified", "metadataCommitted")
            | ("metadataCommitted", "committing")
    );
    if !allowed {
        return Err(fence_error());
    }
    let revision = journal_revision(journal)?;
    journal.phase = next_phase.to_owned();
    journal
        .payload
        .as_object_mut()
        .ok_or_else(journal_invalid)?
        .insert(JOURNAL_REVISION_KEY.to_owned(), json!(revision + 1));
    Ok(())
}

pub(crate) fn resolve_transaction_identity(
    user_data_dir: &Path,
    journal: &OperationJournalRecord,
) -> CoreResult<ChromeProfileImportTransactionIdentity> {
    if journal.kind != JOURNAL_KIND {
        return Err(journal_invalid());
    }
    validate_journal_phase(&journal.phase)?;
    let payload = journal.payload.as_object().ok_or_else(journal_invalid)?;
    let transaction_id = required_string(payload, "transactionId")?;
    let role_id = required_string(payload, "roleId")?;
    validate_uuid(&transaction_id, "transaction")?;
    validate_uuid(&role_id, "role")?;
    if journal.id != format!("chrome-profile-import-{transaction_id}") {
        return Err(journal_invalid());
    }
    let launch_url = required_string(payload, "launchUrl")?;
    let launch_origin = canonical_launch_origin(&launch_url)?;
    if payload.get("launchOrigin").and_then(Value::as_str) != Some(launch_origin.as_str()) {
        return Err(journal_invalid());
    }
    let replace_existing = required_bool(payload, "replaceExisting")?;
    let created_role = required_bool(payload, "createdRole")?;
    let journal_revision = journal_revision(journal)?;
    let staging_sha256 = required_sha256(payload, "stagingSha256")?;
    let staging_bytes = payload
        .get("stagingBytes")
        .and_then(Value::as_u64)
        .filter(|bytes| *bytes > 0 && *bytes <= CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES as u64)
        .ok_or_else(journal_invalid)?;
    let cookie_count = required_u32(payload, "cookieCount")?;
    let local_storage_count = required_u32(payload, "localStorageCount")?;
    if cookie_count as usize > MAX_COOKIES
        || local_storage_count as usize > MAX_LOCAL_STORAGE_ENTRIES
    {
        return Err(payload_limit_error());
    }
    let unsupported = serde_json::from_value(
        payload
            .get("unsupported")
            .cloned()
            .ok_or_else(journal_invalid)?,
    )
    .map_err(|_| journal_invalid())?;
    let warnings = payload
        .get("warnings")
        .and_then(Value::as_array)
        .ok_or_else(journal_invalid)?
        .iter()
        .map(|warning| {
            warning
                .as_str()
                .filter(|warning| warning.len() <= 128 && warning.is_ascii())
                .map(str::to_owned)
                .ok_or_else(journal_invalid)
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let commit_marker_sha256 = payload
        .get(COMMIT_MARKER_HASH_KEY)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(journal_invalid)
                .and_then(|value| {
                    validate_sha256(value)?;
                    Ok(value.to_owned())
                })
        })
        .transpose()?;
    let role_paths = canonical_role_paths(user_data_dir, &role_id)?;
    let chromium_path_sha256 = sha256_hex(role_paths.chromium_user_data_dir.as_bytes());
    let staging_path =
        canonical_transfer_directory(user_data_dir, &transaction_id)?.join("session-transfer.enc");
    let staging_metadata = regular_file_metadata(&staging_path)?;
    if staging_metadata.len() != staging_bytes {
        return Err(staging_identity_error());
    }
    let protected = read_bounded_file(&staging_path, CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES)?;
    if sha256_hex(&protected) != staging_sha256 {
        return Err(staging_identity_error());
    }
    Ok(ChromeProfileImportTransactionIdentity {
        operation_id: journal.id.clone(),
        transaction_id,
        role_id,
        journal_phase: journal.phase.clone(),
        journal_revision,
        launch_url,
        launch_origin,
        replace_existing,
        created_role,
        role_paths,
        chromium_path_sha256,
        staging_sha256,
        staging_bytes,
        cookie_count,
        local_storage_count,
        unsupported,
        warnings,
        commit_marker_sha256,
    })
}

pub(crate) fn descriptor(
    lease_id: String,
    identity: &ChromeProfileImportTransactionIdentity,
) -> ChromeProfileImportTransactionDescriptor {
    ChromeProfileImportTransactionDescriptor {
        contract_version: CHROME_PROFILE_IMPORT_CONTRACT_VERSION,
        lease_id,
        operation_id: identity.operation_id.clone(),
        transaction_id: identity.transaction_id.clone(),
        role_id: identity.role_id.clone(),
        journal_phase: identity.journal_phase.clone(),
        journal_revision: identity.journal_revision,
        launch_url: identity.launch_url.clone(),
        launch_origin: identity.launch_origin.clone(),
        replace_existing: identity.replace_existing,
        created_role: identity.created_role,
        role_paths: identity.role_paths.clone(),
        chromium_path_sha256: identity.chromium_path_sha256.clone(),
        staging_sha256: identity.staging_sha256.clone(),
        staging_bytes: identity.staging_bytes,
        cookie_count: identity.cookie_count,
        local_storage_count: identity.local_storage_count,
        unsupported: identity.unsupported.clone(),
        warnings: identity.warnings.clone(),
        commit_marker_sha256: identity.commit_marker_sha256.clone(),
    }
}

pub(crate) fn validate_acquire_assertions(
    input: &ChromeProfileImportTransactionAcquireInput,
    identity: &ChromeProfileImportTransactionIdentity,
) -> CoreResult<()> {
    if input.role_id != identity.role_id
        || input.transaction_id != identity.transaction_id
        || input.expected_journal_phase != identity.journal_phase
        || input.expected_journal_revision != identity.journal_revision
    {
        return Err(fence_error());
    }
    let descriptor_only_phase = matches!(
        identity.journal_phase.as_str(),
        "awaitingFreshVerification" | "freshVerified" | "metadataCommitted" | "committing"
    );
    match (&input.expected_launch_url, input.expected_replace_existing) {
        (Some(launch_url), Some(replace_existing)) => {
            if launch_url != &identity.launch_url || replace_existing != identity.replace_existing {
                return Err(fence_error());
            }
        }
        (None, None) if descriptor_only_phase => {}
        _ => return Err(fence_error()),
    }
    Ok(())
}

pub(crate) fn read_staging_payload(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
) -> CoreResult<Vec<u8>> {
    let path = canonical_transfer_directory(user_data_dir, &identity.transaction_id)?
        .join("session-transfer.enc");
    let protected = read_bounded_file(&path, CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES)?;
    if protected.len() as u64 != identity.staging_bytes
        || sha256_hex(&protected) != identity.staging_sha256
    {
        return Err(staging_identity_error());
    }
    let mut plaintext =
        unprotect_legacy(platform, &protected).map_err(|_| staging_authentication_error())?;
    let result = canonical_payload(&plaintext, &identity.launch_origin, true);
    plaintext.fill(0);
    let canonical = result?;
    if canonical.cookie_count != identity.cookie_count
        || canonical.local_storage_count != identity.local_storage_count
    {
        return Err(staging_identity_error());
    }
    Ok(canonical.bytes)
}

pub(crate) fn write_backup(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
    plaintext: &mut [u8],
) -> CoreResult<ChromeProfileImportVaultEvidence> {
    let canonical_result = canonical_payload(plaintext, &identity.launch_origin, false);
    plaintext.fill(0);
    let mut canonical = canonical_result?;
    let context = backup_context(identity);
    let protected_result = protect_bound(platform, context.as_bytes(), &canonical.bytes)
        .map_err(|_| backup_protection_error());
    canonical.bytes.fill(0);
    let protected = protected_result?;
    let directory = canonical_transfer_directory(user_data_dir, &identity.transaction_id)?;
    let path = directory.join(BACKUP_FILE);
    if path.exists() {
        let (existing, evidence) = read_backup_canonical(user_data_dir, platform, identity)?;
        let existing_digest = sha256_hex(&existing);
        let expected_digest = canonical.inventory_sha256;
        let mut existing = existing;
        existing.fill(0);
        if existing_digest != expected_digest {
            return Err(domain(
                "CHROME_PROFILE_IMPORT_BACKUP_CONFLICT",
                "A different encrypted rollback snapshot already exists for this transaction.",
            ));
        }
        return Ok(evidence);
    }
    atomic_write_private(&directory, &path, &protected)?;
    Ok(ChromeProfileImportVaultEvidence {
        transaction_id: identity.transaction_id.clone(),
        role_id: identity.role_id.clone(),
        journal_phase: identity.journal_phase.clone(),
        journal_revision: identity.journal_revision,
        protected_sha256: sha256_hex(&protected),
        inventory_sha256: canonical.inventory_sha256,
        cookie_count: canonical.cookie_count,
        local_storage_count: canonical.local_storage_count,
    })
}

pub(crate) fn read_backup(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
) -> CoreResult<Vec<u8>> {
    read_backup_canonical(user_data_dir, platform, identity).map(|(bytes, _)| bytes)
}

fn read_backup_canonical(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
) -> CoreResult<(Vec<u8>, ChromeProfileImportVaultEvidence)> {
    let path =
        canonical_transfer_directory(user_data_dir, &identity.transaction_id)?.join(BACKUP_FILE);
    let protected = read_bounded_file(&path, CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES)?;
    let context = backup_context(identity);
    let mut plaintext = unprotect_bound(platform, context.as_bytes(), &protected)
        .map_err(|_| backup_authentication_error())?;
    let canonical_result = canonical_payload(&plaintext, &identity.launch_origin, false);
    plaintext.fill(0);
    let canonical = canonical_result?;
    let evidence = ChromeProfileImportVaultEvidence {
        transaction_id: identity.transaction_id.clone(),
        role_id: identity.role_id.clone(),
        journal_phase: identity.journal_phase.clone(),
        journal_revision: identity.journal_revision,
        protected_sha256: sha256_hex(&protected),
        inventory_sha256: canonical.inventory_sha256,
        cookie_count: canonical.cookie_count,
        local_storage_count: canonical.local_storage_count,
    };
    Ok((canonical.bytes, evidence))
}

pub(crate) fn new_fresh_verification_capability() -> CoreResult<Vec<u8>> {
    let mut capability = vec![0_u8; CAPABILITY_BYTES];
    getrandom::fill(&mut capability).map_err(|_| {
        domain(
            "CHROME_PROFILE_IMPORT_CAPABILITY_UNAVAILABLE",
            "A secure fresh-process verification capability could not be created.",
        )
    })?;
    Ok(capability)
}

pub(crate) fn capability_sha256(capability: &[u8]) -> CoreResult<String> {
    if capability.len() != CAPABILITY_BYTES {
        return Err(domain(
            "CHROME_PROFILE_IMPORT_CAPABILITY_INVALID",
            "The fresh-process verification capability is invalid.",
        ));
    }
    Ok(sha256_hex(capability))
}

pub(crate) fn validate_fresh_receipt(
    receipt: &ChromeProfileImportFreshVerificationReceipt,
    identity: &ChromeProfileImportTransactionIdentity,
    staging_inventory_sha256: &str,
) -> CoreResult<()> {
    validate_uuid(&receipt.verifier_instance_id, "verifier")?;
    for digest in [
        &receipt.parent_exit_evidence_sha256,
        &receipt.surface_drain_evidence_sha256,
        &receipt.chromium_path_sha256,
        &receipt.inventory_sha256,
    ] {
        validate_sha256(digest).map_err(|_| fresh_receipt_error())?;
    }
    if receipt.chromium_path_sha256 != identity.chromium_path_sha256
        || receipt.inventory_sha256 != staging_inventory_sha256
        || receipt.cookie_count != identity.cookie_count
        || receipt.local_storage_count != identity.local_storage_count
    {
        return Err(fresh_receipt_error());
    }
    Ok(())
}

pub(crate) fn prepare_commit_marker(
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
    inventory_sha256: String,
) -> CoreResult<(Vec<u8>, String)> {
    let marker = ChromeProfileImportCommitMarker {
        version: CHROME_PROFILE_IMPORT_CONTRACT_VERSION,
        operation_id: identity.operation_id.clone(),
        transaction_id: identity.transaction_id.clone(),
        role_id: identity.role_id.clone(),
        journal_revision: identity.journal_revision + 1,
        chromium_path_sha256: identity.chromium_path_sha256.clone(),
        staging_sha256: identity.staging_sha256.clone(),
        inventory_sha256,
    };
    let mut plaintext =
        serde_json::to_vec(&marker).map_err(|error| CoreError::Internal(error.to_string()))?;
    let context = commit_context(identity);
    let protected_result = protect_bound(platform, context.as_bytes(), &plaintext)
        .map_err(|_| commit_protection_error());
    plaintext.fill(0);
    let protected = protected_result?;
    let digest = sha256_hex(&protected);
    Ok((protected, digest))
}

pub(crate) fn write_prepared_commit_marker(
    user_data_dir: &Path,
    identity: &ChromeProfileImportTransactionIdentity,
    protected: &[u8],
) -> CoreResult<()> {
    let directory = canonical_transfer_directory(user_data_dir, &identity.transaction_id)?;
    atomic_write_private(&directory, &directory.join(COMMIT_MARKER_FILE), protected)
}

pub(crate) fn verify_commit_marker(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    identity: &ChromeProfileImportTransactionIdentity,
) -> CoreResult<ChromeProfileImportVaultEvidence> {
    if identity.journal_phase != "committing" {
        return Err(fence_error());
    }
    let expected_sha256 = identity
        .commit_marker_sha256
        .as_deref()
        .ok_or_else(commit_authentication_error)?;
    let path = canonical_transfer_directory(user_data_dir, &identity.transaction_id)?
        .join(COMMIT_MARKER_FILE);
    let protected = read_bounded_file(&path, CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES)?;
    if sha256_hex(&protected) != expected_sha256 {
        return Err(commit_authentication_error());
    }
    let context = commit_context(identity);
    let mut plaintext = unprotect_bound(platform, context.as_bytes(), &protected)
        .map_err(|_| commit_authentication_error())?;
    let marker_result = serde_json::from_slice::<ChromeProfileImportCommitMarker>(&plaintext)
        .map_err(|_| commit_authentication_error());
    plaintext.fill(0);
    let marker = marker_result?;
    if marker.version != CHROME_PROFILE_IMPORT_CONTRACT_VERSION
        || marker.operation_id != identity.operation_id
        || marker.transaction_id != identity.transaction_id
        || marker.role_id != identity.role_id
        || marker.journal_revision != identity.journal_revision
        || marker.chromium_path_sha256 != identity.chromium_path_sha256
        || marker.staging_sha256 != identity.staging_sha256
        || validate_sha256(&marker.inventory_sha256).is_err()
    {
        return Err(commit_authentication_error());
    }
    Ok(ChromeProfileImportVaultEvidence {
        transaction_id: identity.transaction_id.clone(),
        role_id: identity.role_id.clone(),
        journal_phase: identity.journal_phase.clone(),
        journal_revision: identity.journal_revision,
        protected_sha256: sha256_hex(&protected),
        inventory_sha256: marker.inventory_sha256,
        cookie_count: identity.cookie_count,
        local_storage_count: identity.local_storage_count,
    })
}

pub(crate) fn apply_journal_transition(
    connection: &mut rusqlite::Connection,
    mut input: ChromeProfileImportJournalTransitionInput,
) -> CoreResult<OperationJournalRecord> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let row = transaction
        .query_row(
            "SELECT kind, phase, payload_json FROM operation_journal WHERE id=?1",
            rusqlite::params![input.operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| journal_invalid())?;
    let mut journal = OperationJournalRecord {
        id: input.operation_id.clone(),
        kind: row.0,
        phase: row.1,
        payload: serde_json::from_str(&row.2).map_err(|_| journal_invalid())?,
    };
    if journal.kind != JOURNAL_KIND
        || journal.phase != input.expected_phase
        || journal_revision(&journal)? != input.expected_revision
        || journal.payload.get("roleId").and_then(Value::as_str) != Some(&input.role_id)
        || journal.payload.get("transactionId").and_then(Value::as_str)
            != Some(&input.transaction_id)
    {
        zero_transition_secret(&mut input.transition);
        return Err(fence_error());
    }
    let payload = journal
        .payload
        .as_object_mut()
        .ok_or_else(journal_invalid)?;
    let next_phase = match &mut input.transition {
        ChromeProfileImportJournalTransition::AwaitFreshVerification { capability_sha256 } => {
            if journal.phase != "verified" || validate_sha256(capability_sha256).is_err() {
                return Err(fence_error());
            }
            payload.insert(
                CAPABILITY_HASH_KEY.to_owned(),
                Value::String(capability_sha256.clone()),
            );
            payload.remove(FRESH_RECEIPT_KEY);
            "awaitingFreshVerification"
        }
        ChromeProfileImportJournalTransition::CompleteFreshVerification {
            capability,
            receipt,
        } => {
            if journal.phase != "awaitingFreshVerification" {
                capability.fill_zero();
                return Err(fence_error());
            }
            if capability.as_slice().len() != CAPABILITY_BYTES {
                capability.fill_zero();
                return Err(domain(
                    "CHROME_PROFILE_IMPORT_CAPABILITY_INVALID",
                    "The fresh-process verification capability is invalid.",
                ));
            }
            let expected = payload
                .get(CAPABILITY_HASH_KEY)
                .and_then(Value::as_str)
                .and_then(parse_sha256)
                .ok_or_else(fresh_receipt_error)?;
            let actual = Sha256::digest(capability.as_slice());
            let matches = constant_time_equal(&expected, &actual);
            capability.fill_zero();
            if !matches {
                return Err(domain(
                    "CHROME_PROFILE_IMPORT_CAPABILITY_MISMATCH",
                    "The fresh-process verification capability does not match this transaction.",
                ));
            }
            payload.remove(CAPABILITY_HASH_KEY);
            payload.insert(
                FRESH_RECEIPT_KEY.to_owned(),
                serde_json::to_value(receipt).map_err(|_| fresh_receipt_error())?,
            );
            "freshVerified"
        }
        ChromeProfileImportJournalTransition::BeginCommit { marker_sha256 } => {
            if journal.phase != "metadataCommitted" || validate_sha256(marker_sha256).is_err() {
                return Err(fence_error());
            }
            payload.insert(
                COMMIT_MARKER_HASH_KEY.to_owned(),
                Value::String(marker_sha256.clone()),
            );
            "committing"
        }
    };
    let next_revision = input.expected_revision + 1;
    payload.insert(JOURNAL_REVISION_KEY.to_owned(), json!(next_revision));
    journal.phase = next_phase.to_owned();
    let payload_json = serde_json::to_string(&journal.payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let changed = transaction
        .execute(
            "UPDATE operation_journal SET phase=?2, payload_json=?3, updated_at=?4
             WHERE id=?1 AND kind=?5 AND phase=?6 AND payload_json=?7",
            rusqlite::params![
                journal.id,
                journal.phase,
                payload_json,
                chrono::Utc::now().to_rfc3339(),
                JOURNAL_KIND,
                input.expected_phase,
                row.2,
            ],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if changed != 1 {
        return Err(fence_error());
    }
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(journal)
}

pub(crate) fn journal_marker_sha256(journal: &OperationJournalRecord) -> CoreResult<String> {
    required_sha256(
        journal.payload.as_object().ok_or_else(journal_invalid)?,
        COMMIT_MARKER_HASH_KEY,
    )
}

fn canonical_payload(
    bytes: &[u8],
    launch_origin: &str,
    require_nonempty: bool,
) -> CoreResult<CanonicalPayload> {
    if bytes.is_empty() || bytes.len() > CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES {
        return Err(payload_limit_error());
    }
    let strict: StrictSessionTransferPayload =
        serde_json::from_slice(bytes).map_err(|_| payload_invalid_error())?;
    if strict.cookies.len() > MAX_COOKIES
        || strict.local_storage.len() > MAX_LOCAL_STORAGE_ENTRIES
        || (require_nonempty && strict.cookies.is_empty() && strict.local_storage.is_empty())
    {
        return Err(payload_limit_error());
    }
    let origin = Url::parse(launch_origin).map_err(|_| payload_invalid_error())?;
    let host = origin.host_str().ok_or_else(payload_invalid_error)?;
    let secure_origin = origin.scheme() == "https";
    let mut cookies = strict
        .cookies
        .into_iter()
        .map(|cookie| {
            if cookie.name.is_empty()
                || cookie.name.len() > 4096
                || cookie.value.len() > 1024 * 1024
                || cookie
                    .name
                    .bytes()
                    .any(|byte| byte <= 0x20 || matches!(byte, b';' | b',' | b'='))
                || !cookie.path.starts_with('/')
                || cookie.path.len() > 4096
                || !matches!(cookie.same_site.as_str(), "none" | "lax" | "strict")
                || (cookie.secure && !secure_origin)
                || (cookie.same_site == "none" && !cookie.secure)
            {
                return Err(payload_invalid_error());
            }
            if let Some(domain) = &cookie.domain {
                let normalized = domain.strip_prefix('.').unwrap_or(domain);
                if normalized.is_empty()
                    || normalized.contains(['/', ':', '\0'])
                    || !(host.eq_ignore_ascii_case(normalized)
                        || host
                            .to_ascii_lowercase()
                            .ends_with(&format!(".{}", normalized.to_ascii_lowercase())))
                {
                    return Err(payload_invalid_error());
                }
            }
            Ok(SessionCookieRecord {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                http_only: cookie.http_only,
                same_site: cookie.same_site,
                expires_unix_ms: cookie.expires_unix_ms,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    cookies.sort_by(|left, right| {
        (
            left.domain.as_deref().unwrap_or(""),
            left.path.as_str(),
            left.name.as_str(),
        )
            .cmp(&(
                right.domain.as_deref().unwrap_or(""),
                right.path.as_str(),
                right.name.as_str(),
            ))
    });
    if cookies.windows(2).any(|pair| {
        pair[0].name == pair[1].name
            && pair[0].path == pair[1].path
            && pair[0].domain == pair[1].domain
    }) {
        return Err(payload_invalid_error());
    }
    let mut local_storage = strict
        .local_storage
        .into_iter()
        .map(|entry| {
            if entry.key.len() > 1024 * 1024 || entry.value.len() > 10 * 1024 * 1024 {
                return Err(payload_limit_error());
            }
            Ok(LocalStorageEntryRecord {
                key: entry.key,
                value: entry.value,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    local_storage.sort_by(|left, right| left.key.cmp(&right.key));
    if local_storage
        .windows(2)
        .any(|pair| pair[0].key == pair[1].key)
    {
        return Err(payload_invalid_error());
    }
    let cookie_count = u32::try_from(cookies.len()).map_err(|_| payload_limit_error())?;
    let local_storage_count =
        u32::try_from(local_storage.len()).map_err(|_| payload_limit_error())?;
    let canonical = SessionTransferPayloadRecord {
        cookies,
        local_storage,
    };
    let bytes =
        serde_json::to_vec(&canonical).map_err(|error| CoreError::Internal(error.to_string()))?;
    if bytes.len() > CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES {
        return Err(payload_limit_error());
    }
    Ok(CanonicalPayload {
        inventory_sha256: sha256_hex(&bytes),
        bytes,
        cookie_count,
        local_storage_count,
    })
}

fn canonical_role_paths(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    validate_uuid(role_id, "role")?;
    let root_metadata = fs::symlink_metadata(user_data_dir)
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(path_identity_error());
    }
    let canonical_root =
        fs::canonicalize(user_data_dir).map_err(|error| CoreError::Platform(error.to_string()))?;
    // Validate physical paths before serializing the Chromium wire path. On
    // Windows canonical roots retain a verbatim prefix that Chromium omits.
    let physical_target =
        crate::role_browser_data::browser_directory(&canonical_root, role_id).join("chromium");
    validate_path_components(&canonical_root, &physical_target)?;
    let paths = crate::role_browser_data::paths(&canonical_root, role_id)?;
    Ok(paths)
}

fn canonical_transfer_directory(user_data_dir: &Path, transaction_id: &str) -> CoreResult<PathBuf> {
    validate_uuid(transaction_id, "transaction")?;
    let canonical_root =
        fs::canonicalize(user_data_dir).map_err(|error| CoreError::Platform(error.to_string()))?;
    let directory = canonical_root
        .join(".session-transfers")
        .join(transaction_id);
    validate_path_components(&canonical_root, &directory)?;
    Ok(directory)
}

fn validate_path_components(root: &Path, target: &Path) -> CoreResult<()> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| path_identity_error())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(path_identity_error());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(path_identity_error());
            }
            Ok(metadata) if !metadata.is_dir() && current != target => {
                return Err(path_identity_error());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::Platform(error.to_string())),
        }
    }
    Ok(())
}

pub(crate) fn canonical_launch_origin(launch_url: &str) -> CoreResult<String> {
    let parsed = Url::parse(launch_url).map_err(|_| journal_invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(journal_invalid());
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err(journal_invalid());
    }
    Ok(origin)
}

fn atomic_write_private(directory: &Path, path: &Path, bytes: &[u8]) -> CoreResult<()> {
    if bytes.is_empty() || bytes.len() > CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES {
        return Err(payload_limit_error());
    }
    fs::create_dir_all(directory).map_err(|error| CoreError::Platform(error.to_string()))?;
    crate::chrome_profile_import::restrict_directory_internal(directory)?;
    validate_path_components(
        directory.parent().ok_or_else(path_identity_error)?,
        directory,
    )?;
    if path.parent() != Some(directory) {
        return Err(path_identity_error());
    }
    let temporary = directory.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|v| v.to_str()).unwrap_or("vault"),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        rion_platform::atomic_replace_file(&temporary, path)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        #[cfg(unix)]
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_bounded_file(path: &Path, maximum: usize) -> CoreResult<Vec<u8>> {
    let metadata = regular_file_metadata(path)?;
    if metadata.len() == 0 || metadata.len() > maximum as u64 {
        return Err(payload_limit_error());
    }
    let file = File::open(path).map_err(|error| CoreError::Platform(error.to_string()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    if bytes.len() != metadata.len() as usize || bytes.len() > maximum {
        bytes.fill(0);
        return Err(payload_limit_error());
    }
    Ok(bytes)
}

fn regular_file_metadata(path: &Path) -> CoreResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => domain(
            "CHROME_PROFILE_IMPORT_VAULT_NOT_FOUND",
            "The encrypted Chrome profile import transaction data is unavailable.",
        ),
        _ => CoreError::Platform(error.to_string()),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(path_identity_error());
    }
    Ok(metadata)
}

fn backup_context(identity: &ChromeProfileImportTransactionIdentity) -> String {
    format!(
        "chrome-profile-import-backup:v1\0transaction:{}\0role:{}\0origin:{}\0path:{}",
        identity.transaction_id,
        identity.role_id,
        identity.launch_origin,
        identity.chromium_path_sha256
    )
}

fn commit_context(identity: &ChromeProfileImportTransactionIdentity) -> String {
    format!(
        "chrome-profile-import-commit:v1\0transaction:{}\0role:{}\0origin:{}\0path:{}",
        identity.transaction_id,
        identity.role_id,
        identity.launch_origin,
        identity.chromium_path_sha256
    )
}

#[cfg(not(test))]
fn unprotect_legacy(
    platform: rion_platform::Platform,
    protected: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    rion_platform::unprotect_session_transfer(platform, protected)
}

#[cfg(test)]
fn unprotect_legacy(
    _platform: rion_platform::Platform,
    protected: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    protected
        .strip_prefix(TEST_LEGACY_PREFIX)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| {
            rion_platform::PlatformError::Operation(
                "test Chrome import envelope is invalid".to_owned(),
            )
        })
}

#[cfg(test)]
pub(crate) fn protect_legacy_for_test(plaintext: &[u8]) -> Vec<u8> {
    let mut protected = Vec::with_capacity(TEST_LEGACY_PREFIX.len() + plaintext.len());
    protected.extend_from_slice(TEST_LEGACY_PREFIX);
    protected.extend_from_slice(plaintext);
    protected
}

#[cfg(not(test))]
fn protect_bound(
    platform: rion_platform::Platform,
    context: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    rion_platform::protect_session_transfer_v2(platform, context, plaintext)
}

#[cfg(not(test))]
fn unprotect_bound(
    platform: rion_platform::Platform,
    context: &[u8],
    protected: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    rion_platform::unprotect_session_transfer_v2(platform, context, protected)
}

#[cfg(test)]
fn protect_bound(
    _platform: rion_platform::Platform,
    context: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    let mut digest_input = Vec::with_capacity(context.len() + plaintext.len());
    digest_input.extend_from_slice(context);
    digest_input.extend_from_slice(plaintext);
    let digest = Sha256::digest(&digest_input);
    digest_input.fill(0);
    let mut protected =
        Vec::with_capacity(TEST_BOUND_PREFIX.len() + digest.len() + plaintext.len());
    protected.extend_from_slice(TEST_BOUND_PREFIX);
    protected.extend_from_slice(&digest);
    protected.extend_from_slice(plaintext);
    Ok(protected)
}

#[cfg(test)]
fn unprotect_bound(
    _platform: rion_platform::Platform,
    context: &[u8],
    protected: &[u8],
) -> Result<Vec<u8>, rion_platform::PlatformError> {
    let payload = protected.strip_prefix(TEST_BOUND_PREFIX).ok_or_else(|| {
        rion_platform::PlatformError::Operation("test Chrome import envelope is invalid".to_owned())
    })?;
    if payload.len() < 32 {
        return Err(rion_platform::PlatformError::Operation(
            "test Chrome import envelope is invalid".to_owned(),
        ));
    }
    let (expected, plaintext) = payload.split_at(32);
    let mut digest_input = Vec::with_capacity(context.len() + plaintext.len());
    digest_input.extend_from_slice(context);
    digest_input.extend_from_slice(plaintext);
    let actual = Sha256::digest(&digest_input);
    digest_input.fill(0);
    let authenticated = expected
        .iter()
        .zip(actual.iter())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0;
    if !authenticated {
        return Err(rion_platform::PlatformError::Operation(
            "test Chrome import envelope authentication failed".to_owned(),
        ));
    }
    Ok(plaintext.to_vec())
}

fn validate_journal_phase(phase: &str) -> CoreResult<()> {
    if matches!(
        phase,
        "prepared"
            | "snapshotted"
            | "applying"
            | "verified"
            | "metadataCommitted"
            | "awaitingFreshVerification"
            | "freshVerified"
            | "committing"
    ) {
        Ok(())
    } else {
        Err(journal_invalid())
    }
}

fn validate_uuid(value: &str, _label: &str) -> CoreResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| journal_invalid())?;
    if parsed.to_string() != value {
        return Err(journal_invalid());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> CoreResult<()> {
    if parse_sha256(value).is_some() {
        Ok(())
    } else {
        Err(journal_invalid())
    }
}

fn parse_sha256(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut result = [0_u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        result[index] = (high << 4) | low;
    }
    Some(result)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn constant_time_equal(left: &[u8; 32], right: &[u8]) -> bool {
    if right.len() != left.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn required_string(payload: &Map<String, Value>, key: &str) -> CoreResult<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(journal_invalid)
}

fn required_bool(payload: &Map<String, Value>, key: &str) -> CoreResult<bool> {
    payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(journal_invalid)
}

fn required_u32(payload: &Map<String, Value>, key: &str) -> CoreResult<u32> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(journal_invalid)
}

fn required_sha256(payload: &Map<String, Value>, key: &str) -> CoreResult<String> {
    let value = required_string(payload, key)?;
    validate_sha256(&value)?;
    Ok(value)
}

fn zero_transition_secret(transition: &mut ChromeProfileImportJournalTransition) {
    if let ChromeProfileImportJournalTransition::CompleteFreshVerification { capability, .. } =
        transition
    {
        capability.fill_zero();
    }
}

fn domain(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn journal_invalid() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_JOURNAL_INVALID",
        "The Chrome profile import transaction journal is invalid.",
    )
}

fn fence_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
        "The Chrome profile import transaction changed before the operation completed.",
    )
}

fn path_identity_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH",
        "The Chrome profile import destination path identity is unsafe or changed.",
    )
}

fn staging_identity_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_STAGING_IDENTITY_MISMATCH",
        "The encrypted Chrome profile import staging identity changed.",
    )
}

fn staging_authentication_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_STAGING_AUTHENTICATION_FAILED",
        "The encrypted Chrome profile import staging data could not be authenticated.",
    )
}

fn backup_protection_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_BACKUP_PROTECTION_FAILED",
        "The rollback snapshot could not be encrypted.",
    )
}

fn backup_authentication_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_BACKUP_AUTHENTICATION_FAILED",
        "The encrypted rollback snapshot could not be authenticated.",
    )
}

fn commit_protection_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_COMMIT_PROTECTION_FAILED",
        "The Chrome profile import commit marker could not be protected.",
    )
}

fn commit_authentication_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_COMMIT_AUTHENTICATION_FAILED",
        "The Chrome profile import commit marker could not be authenticated.",
    )
}

fn payload_limit_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_PAYLOAD_LIMIT_EXCEEDED",
        "The Chrome profile import payload exceeds its bounded native limit.",
    )
}

fn payload_invalid_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_PAYLOAD_INVALID",
        "The Chrome profile import payload is invalid for the launch origin.",
    )
}

fn fresh_receipt_error() -> CoreError {
    domain(
        "CHROME_PROFILE_IMPORT_FRESH_VERIFICATION_INVALID",
        "The fresh-process Chrome session verification receipt is invalid.",
    )
}

#[cfg(test)]
#[path = "chrome_profile_import_contract/path_identity_tests.rs"]
mod path_identity_tests;
