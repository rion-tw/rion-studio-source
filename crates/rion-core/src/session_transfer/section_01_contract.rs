use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    session_migration::{
        RoleSessionMigrationEngine, RoleSessionMigrationPlatform,
        RoleSessionMigrationTransitionInput,
    },
};

pub const ROLE_SESSION_TRANSFER_VERSION: u32 = 1;
pub const ROLE_SESSION_TRANSFER_MAX_COOKIES: usize = 10_000;
pub const ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ORIGINS: usize = 4_096;
pub const ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ENTRIES: usize = 100_000;
pub const ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES: usize =
    rion_platform::SESSION_TRANSFER_V2_MAX_PLAINTEXT_BYTES;
pub const ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES: usize =
    ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES;

const MAX_COOKIE_NAME_BYTES: usize = 4 * 1024;
const MAX_COOKIE_VALUE_BYTES: usize = 64 * 1024;
const MAX_COOKIE_DOMAIN_BYTES: usize = 255;
const MAX_COOKIE_PATH_BYTES: usize = 4 * 1024;
const MAX_PARTITION_EVIDENCE_BYTES: usize = 4 * 1024;
const MAX_UNSUPPORTED_ATTRIBUTES: usize = 32;
const MAX_UNSUPPORTED_ATTRIBUTE_CODE_BYTES: usize = 64;
const MAX_LOCAL_STORAGE_ORIGIN_BYTES: usize = 2 * 1024;
const MAX_LOCAL_STORAGE_KEY_BYTES: usize = 1024 * 1024;
const MAX_LOCAL_STORAGE_VALUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ABSOLUTE_EXPIRY_UNIX_MS: i64 = 253_402_300_799_999;

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
pub enum RoleSessionTransferFormat {
    #[serde(rename = "rion-role-session-transfer")]
    RionRoleSessionTransfer,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RoleSessionTransferByteEncoding {
    Base64,
    Base64Utf16Le,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferBytesRecord {
    pub encoding: RoleSessionTransferByteEncoding,
    pub data: String,
}

impl RoleSessionTransferBytesRecord {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            encoding: RoleSessionTransferByteEncoding::Base64,
            data: BASE64_STANDARD.encode(bytes),
        }
    }

    pub fn from_utf16_le_code_units(code_units: &[u16]) -> Self {
        let mut bytes = Vec::with_capacity(code_units.len().saturating_mul(2));
        for code_unit in code_units {
            bytes.extend_from_slice(&code_unit.to_le_bytes());
        }
        Self {
            encoding: RoleSessionTransferByteEncoding::Base64Utf16Le,
            data: BASE64_STANDARD.encode(bytes),
        }
    }

    pub fn decoded_bytes(&self) -> CoreResult<Vec<u8>> {
        decode_canonical_base64(self, ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES, self.encoding)
            .map(|decoded| decoded.bytes)
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferMetadataRecord {
    pub format: RoleSessionTransferFormat,
    pub version: u32,
    pub transfer_id: String,
    pub role_id: String,
    pub platform: RoleSessionMigrationPlatform,
    pub source_engine: RoleSessionMigrationEngine,
    pub target_engine: RoleSessionMigrationEngine,
    pub source_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_evidence: Option<RoleSessionTransferSourceEvidenceRecord>,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
pub enum RoleSessionTransferSourceEvidenceKind {
    #[serde(rename = "webview2StorageGetCookies")]
    Webview2StorageGetCookies,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
pub enum RoleSessionTransferCookiePartitionCapability {
    #[serde(rename = "networkCookiePartitionKeyAndOpaque")]
    NetworkCookiePartitionKeyAndOpaque,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferSourceEvidenceRecord {
    pub kind: RoleSessionTransferSourceEvidenceKind,
    pub runtime_version: String,
    pub protocol_version: String,
    pub partition_capability: RoleSessionTransferCookiePartitionCapability,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RoleSessionTransferCookieSameSite {
    Unspecified,
    None,
    Lax,
    Strict,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoleSessionTransferCookieExpiry {
    Session,
    Absolute { unix_ms: i64 },
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoleSessionTransferCookiePartitionEvidence {
    Unpartitioned,
    Partitioned {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partition_key: Option<RoleSessionTransferBytesRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        has_cross_site_ancestor: Option<bool>,
    },
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferCookieRecord {
    pub name: RoleSessionTransferBytesRecord,
    pub value: RoleSessionTransferBytesRecord,
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub secure: bool,
    pub http_only: bool,
    pub expiry: RoleSessionTransferCookieExpiry,
    pub same_site: RoleSessionTransferCookieSameSite,
    pub partition: RoleSessionTransferCookiePartitionEvidence,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsupported_attribute_codes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferLocalStorageEntryRecord {
    pub key: RoleSessionTransferBytesRecord,
    pub value: RoleSessionTransferBytesRecord,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferLocalStorageOriginRecord {
    pub origin: String,
    pub entries: Vec<RoleSessionTransferLocalStorageEntryRecord>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferInventoryRecord {
    pub cookies: Vec<RoleSessionTransferCookieRecord>,
    pub local_storage: Vec<RoleSessionTransferLocalStorageOriginRecord>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionTransferEnvelopeRecord {
    pub metadata: RoleSessionTransferMetadataRecord,
    pub inventory: RoleSessionTransferInventoryRecord,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSessionTransferJournalEvidence {
    pub role_id: String,
    pub transfer_id: String,
    pub envelope_sha256: String,
    pub inventory_sha256: String,
    pub cookie_count: u64,
    pub local_storage_origin_count: u64,
    pub local_storage_entry_count: u64,
}

impl RoleSessionTransferJournalEvidence {
    pub fn apply_to_transition(
        &self,
        input: &mut RoleSessionMigrationTransitionInput,
    ) -> CoreResult<()> {
        if input.role_id != self.role_id || input.transfer_id != self.transfer_id {
            return Err(transfer_error(
                "ROLE_SESSION_TRANSFER_JOURNAL_IDENTITY_MISMATCH",
                "Session-transfer evidence does not match the migration journal identity.",
            ));
        }
        input.envelope_sha256 = Some(self.envelope_sha256.clone());
        input.inventory_sha256 = Some(self.inventory_sha256.clone());
        input.cookie_count = Some(self.cookie_count);
        input.local_storage_origin_count = Some(self.local_storage_origin_count);
        input.local_storage_entry_count = Some(self.local_storage_entry_count);
        Ok(())
    }
}
