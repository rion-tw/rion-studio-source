use super::Result;
use crate::{session_migration, session_transfer};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::Path;

/// Authenticates an already-exported v22 vault using its source journal. This
/// reader neither constructs AppCore for real data nor rewrites the journal.
pub(super) fn assess(connection: &Connection, source: &Path, role: &str) -> Result<Value> {
    let journal = session_migration::read(connection, role)
        .map_err(|_| "EXPORTED_JOURNAL_INVALID")?
        .ok_or("EXPORTED_JOURNAL_MISSING")?;
    if journal.envelope_sha256.is_none() {
        return Err("EXPORTED_PACKAGE_NOT_COMMITTED");
    }
    let envelope =
        session_transfer::read_session_transfer_vault(source, super::native_platform()?, &journal)
            .map_err(|_| "EXPORTED_PACKAGE_AUTHENTICATION_OR_COMPLETENESS_FAILED")?;
    let evidence = envelope
        .journal_evidence()
        .map_err(|_| "EXPORTED_PACKAGE_INVALID")?;
    let expired = envelope
        .inventory
        .cookies
        .iter()
        .filter(|cookie| match cookie.expiry {
            session_transfer::RoleSessionTransferCookieExpiry::Absolute { unix_ms } => {
                unix_ms <= chrono::Utc::now().timestamp_millis()
            }
            _ => false,
        })
        .count();
    Ok(
        json!({"status": "authenticated", "formatVersion": envelope.metadata.version,
        "sourceEngine": envelope.metadata.source_engine, "sourceRevision": journal.source_revision,
        "cookies": evidence.cookie_count, "localStorageOrigins": evidence.local_storage_origin_count,
        "localStorageEntries": evidence.local_storage_entry_count, "expiredCookies": expired,
        "inventorySha256": evidence.inventory_sha256, "targetReadback": "notRun",
        "loginEligible": false}),
    )
}
