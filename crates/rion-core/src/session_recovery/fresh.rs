//! First-upgrade Chromium session authority, independent of migration success.
//! The existing role ID and all legacy stores remain unchanged.
use super::{error, uuid};
use crate::{CoreResult, RoleSessionMigrationRecord};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const KIND: &str = "role_session_fresh_v1";
const MARKER: &str = ".rion-fresh-session.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Evidence {
    pub role_id: String,
    pub attempt_id: String,
    pub platform: String,
    pub original_journal: Option<RoleSessionMigrationRecord>,
    pub result: super::types::RoleSessionUpgradeResult,
    pub clean_flush_receipt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_application: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
}
impl Evidence {
    pub fn id(&self) -> String {
        format!("session-fresh-{}", self.attempt_id)
    }
    fn marker(&self, data: &Path) -> CoreResult<PathBuf> {
        uuid(&self.role_id)?;
        uuid(&self.attempt_id)?;
        Ok(data
            .join("roles")
            .join(&self.role_id)
            .join("browser/sessions")
            .join(&self.attempt_id)
            .join("chromium")
            .join(MARKER))
    }
    pub fn prepare(&self, data: &Path, imported: Option<&Path>) -> CoreResult<()> {
        let marker = self.marker(data)?;
        crate::session_source::paths::existing(data).map_err(error)?;
        let mut cursor = data.to_path_buf();
        for name in [
            "roles",
            &self.role_id,
            "browser",
            "sessions",
            &self.attempt_id,
            "chromium",
        ] {
            cursor.push(name);
            match fs::create_dir(&cursor) {
                Ok(()) => rion_platform::restrict_directory_to_current_user(&cursor)
                    .map_err(|_| error("RECOVERY_PATH_PROTECTION_FAILED"))?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(error("RECOVERY_PATH_CREATE_FAILED")),
            }
            crate::session_source::paths::existing(&cursor).map_err(error)?;
            if !cursor.is_dir() {
                return Err(error("RECOVERY_PATH_INVALID"));
            }
        }
        if fs::read_dir(&cursor)
            .map_err(|_| error("RECOVERY_TARGET_UNAVAILABLE"))?
            .next()
            .is_some()
        {
            return Err(error("RECOVERY_TARGET_DATA_CONFLICT"));
        }
        if let Some(imported) = imported {
            crate::session_source::paths::existing(imported).map_err(error)?;
            if self.clean_flush_receipt.is_none() {
                return Err(error("RECOVERY_NATIVE_RECEIPT_INVALID"));
            }
            fs::remove_dir(&cursor).map_err(|_| error("RECOVERY_TARGET_DATA_CONFLICT"))?;
            fs::rename(imported, &cursor).map_err(|_| error("RECOVERY_PROFILE_PUBLISH_FAILED"))?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .map_err(|_| error("RECOVERY_FRESH_MARKER_CONFLICT"))?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| error("RECOVERY_FRESH_WRITE_FAILED"))?;
        #[cfg(unix)]
        fs::File::open(&cursor)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("RECOVERY_FRESH_WRITE_FAILED"))?;
        self.verify(data)?;
        let choice = data
            .join("roles")
            .join(&self.role_id)
            .join("browser/.rion-session-choice");
        let mut file = tempfile::NamedTempFile::new_in(
            choice
                .parent()
                .ok_or_else(|| error("RECOVERY_PATH_INVALID"))?,
        )
        .map_err(|_| error("RECOVERY_FRESH_WRITE_FAILED"))?;
        file.write_all(self.attempt_id.as_bytes())
            .and_then(|()| file.as_file().sync_all())
            .map_err(|_| error("RECOVERY_FRESH_WRITE_FAILED"))?;
        file.persist_noclobber(&choice)
            .map_err(|_| error("RECOVERY_FRESH_MARKER_CONFLICT"))?;
        #[cfg(unix)]
        fs::File::open(
            choice
                .parent()
                .ok_or_else(|| error("RECOVERY_PATH_INVALID"))?,
        )
        .and_then(|directory| directory.sync_all())
        .map_err(|_| error("RECOVERY_FRESH_WRITE_FAILED"))?;
        Ok(())
    }
    pub fn verify(&self, data: &Path) -> CoreResult<()> {
        let marker = self.marker(data)?;
        crate::session_source::paths::existing(&marker).map_err(error)?;
        let mut file =
            fs::File::open(&marker).map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        rion_platform::verify_open_file_identity(&marker, &file)
            .map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        let metadata = file
            .metadata()
            .map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        if !metadata.is_file() || metadata.len() > 8192 {
            return Err(error("RECOVERY_FRESH_EVIDENCE_INVALID"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        let read: Self =
            serde_json::from_slice(&bytes).map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        rion_platform::verify_open_file_identity(&marker, &file)
            .map_err(|_| error("RECOVERY_FRESH_EVIDENCE_INVALID"))?;
        if &read != self {
            return Err(error("RECOVERY_FRESH_EVIDENCE_INVALID"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_marker_is_bound_to_role_attempt_and_platform() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let evidence = Evidence {
            role_id: uuid::Uuid::new_v4().to_string(),
            attempt_id: uuid::Uuid::new_v4().to_string(),
            platform: "macos".to_owned(),
            original_journal: None,
            result: super::super::upgrade::unavailable("SOURCE_MISSING"),
            clean_flush_receipt: None,
            source_application: None,
            source_policy: None,
            source_sha256: None,
        };
        evidence.prepare(temp.path(), None).unwrap();
        evidence.verify(temp.path()).unwrap();
        let mut other = evidence.clone();
        other.role_id = uuid::Uuid::new_v4().to_string();
        assert!(other.verify(temp.path()).is_err());
        other = evidence.clone();
        other.platform = "windows".to_owned();
        assert!(other.verify(temp.path()).is_err());
        other = evidence.clone();
        other.attempt_id = "../escape".to_owned();
        assert!(other.prepare(temp.path(), None).is_err());
        assert!(evidence.prepare(temp.path(), None).is_err());
        evidence.verify(temp.path()).unwrap();
        #[cfg(unix)]
        {
            let marker = evidence.marker(temp.path()).unwrap();
            let saved = temp.path().join("saved");
            fs::rename(&marker, &saved).unwrap();
            std::os::unix::fs::symlink(saved, &marker).unwrap();
            assert!(evidence.verify(temp.path()).is_err());
        }
    }
}
