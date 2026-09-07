use super::{Result, native_platform, paths, snapshot};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceRoot {
    pub app_id: String,
    pub path: PathBuf,
}

pub(super) fn store_id(role: &str) -> String {
    let digest = Sha256::digest(format!("rion-studio:wkwebsite-data-store:{role}"));
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    uuid::Uuid::from_bytes(bytes).to_string()
}

pub(super) fn run(
    user_data: &Path,
    roots: &[SourceRoot],
    selected: &[String],
    output: &Path,
    capture: bool,
) -> Result<Value> {
    let platform = native_platform()?;
    let user_data = paths::existing(user_data)?;
    let mut sources = vec![user_data.clone()];
    if roots.is_empty() || roots.len() > 8 {
        return Err("SOURCE_ROOTS_REQUIRED");
    }
    let mut app_ids = std::collections::BTreeSet::new();
    for root in roots {
        if ![
            "com.rionstudio.launcher",
            "com.rionstudio.launcher.dev",
            "rion-tauri",
            "webview2",
        ]
        .contains(&root.app_id.as_str())
            || !app_ids.insert(&root.app_id)
        {
            return Err("SOURCE_APP_ID_INVALID");
        }
        let path = paths::existing(&root.path)?;
        if sources
            .iter()
            .skip(1)
            .any(|other| path.starts_with(other) || other.starts_with(&path))
        {
            return Err("OVERLAPPING_SOURCE_ROOTS");
        }
        sources.push(path);
    }
    for role in selected {
        paths::role_id(role)?;
    }
    let output = paths::create_output(output, &sources)?;
    let _source_lock = snapshot::source_lock(&user_data)?;
    let (state_copy, state_digest) = super::state_snapshot::copy(&user_data, &output)?;
    let database = state_copy.path().join("rion-studio.sqlite3");
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "STATE_DATABASE_READ_FAILED")?;
    connection
        .execute_batch("PRAGMA query_only=ON; BEGIN;")
        .map_err(|_| "STATE_READ_TRANSACTION_FAILED")?;
    let version: u32 = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(|_| "STATE_SCHEMA_UNAVAILABLE")?;
    if !(19..=crate::database::SCHEMA_VERSION).contains(&version) {
        return Err("STATE_SCHEMA_UNSUPPORTED");
    }
    let journal_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='role_session_migrations')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "STATE_SCHEMA_UNAVAILABLE")?;
    let sql = if journal_exists {
        "SELECT r.id, r.name, COALESCE(m.phase,'missing'), m.stable_error_code FROM roles r LEFT JOIN role_session_migrations m ON r.id=m.role_id WHERE m.phase IS NULL OR m.phase!='v23Ready' ORDER BY r.ordinal"
    } else {
        "SELECT id,name,'missing',NULL FROM roles ORDER BY ordinal"
    };
    let counts_sql = if journal_exists {
        "SELECT COALESCE(m.phase,'missing'), COUNT(*) FROM roles r LEFT JOIN role_session_migrations m ON r.id=m.role_id GROUP BY COALESCE(m.phase,'missing')"
    } else {
        "SELECT 'missing',COUNT(*) FROM roles"
    };
    let all_role_phase_counts = connection
        .prepare(counts_sql)
        .map_err(|_| "ROLE_QUERY_FAILED")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| "ROLE_QUERY_FAILED")?
        .collect::<std::result::Result<std::collections::BTreeMap<_, _>, _>>()
        .map_err(|_| "ROLE_QUERY_FAILED")?;
    let mut statement = connection.prepare(sql).map_err(|_| "ROLE_QUERY_FAILED")?;
    let roles = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|_| "ROLE_QUERY_FAILED")?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "ROLE_QUERY_FAILED")?;
    if selected.iter().any(|id| !roles.iter().any(|r| &r.0 == id)) {
        return Err("SELECTED_ROLE_NOT_PENDING");
    }
    let mut results = Vec::new();
    for (id, name, phase, previous_error) in roles {
        if !selected.is_empty() && !selected.contains(&id) {
            continue;
        }
        paths::role_id(&id)?;
        let mut candidates = Vec::new();
        let mut candidate_paths = Vec::new();
        for root in roots {
            let path = if platform == rion_platform::Platform::Macos {
                root.path.join(store_id(&id))
            } else {
                root.path.join(&id).join("browser").join("webview2")
            };
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("SOURCE_METADATA_FAILED"),
                Ok(_) => (),
            }
            let safe = paths::existing(&path)?;
            let files = paths::files(&safe)?;
            let count = |name: &str| {
                files
                    .iter()
                    .filter(|p| p.file_name().is_some_and(|v| v == name))
                    .count()
            };
            let other = files.iter().any(|p| {
                p.components().any(|v| {
                    let text = v.as_os_str().to_string_lossy().to_lowercase();
                    text.contains("indexeddb")
                        || text.contains("serviceworker")
                        || text.contains("service worker")
                })
            });
            candidates.push(json!({"appId": root.app_id, "storeId": if platform == rion_platform::Platform::Macos { store_id(&id) } else { id.clone() },
                "localStorageDatabases": count("localstorage.sqlite3"), "cookieFiles": count("Cookies.binarycookies") + count("Cookies"),
                "otherWebsiteDataPresent": other, "nonCacheFileCount": files.len()}));
            candidate_paths.push(safe);
        }
        // No trusted per-role source provenance exists in current production data.
        // A single existing source is selectable; multiple sources stay ambiguous.
        let mut code = match candidates.len() {
            0 => "SOURCE_MISSING",
            1 => "INVENTORIED_ONLY",
            _ => "SOURCE_AMBIGUOUS",
        };
        let mut assessment = Value::Null;
        let exported_package = if journal_exists {
            super::transfer::assess(&connection, &user_data, &id)
                .unwrap_or_else(|code| json!({"status": "notAdmitted", "code": code}))
        } else {
            json!({"status": "missing"})
        };
        if candidates.len() == 1 && capture {
            match snapshot::capture(&candidate_paths[0], &output, &id, platform) {
                Ok(value) => {
                    code = "SNAPSHOT_ASSESSED";
                    assessment = value;
                }
                Err(error) => code = error,
            }
        }
        results.push(json!({"roleId": id, "roleName": name, "journalPhase": phase, "previousError": previous_error,
            "sourceCandidates": candidates, "sourceAssessment": code, "assessment": assessment,
            "exportedPackage": exported_package,
            "sourceProvenance": "role/application/store mapping only; historical application version unproven",
            "targetReadback": "notRun", "persistence": "notRun", "isolation": "notRun", "login": "notRun",
            "loginEligible": false}));
    }
    drop(statement);
    connection
        .execute_batch("ROLLBACK;")
        .map_err(|_| "STATE_READ_TRANSACTION_FAILED")?;
    drop(connection);
    state_copy.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    if state_digest != super::state_snapshot::digest(&user_data)? {
        return Err("SOURCE_STATE_CHANGED_DURING_DIAGNOSTIC");
    }
    let report = json!({"reportVersion": 1, "createdAt": chrono::Utc::now().to_rfc3339(), "platform": platform,
        "schemaVersion": version, "sourceInstanceLock": "EXCLUSIVELY_HELD",
        "sourceDatabaseAndWalUnchanged": true, "sourceStateSha256": state_digest,
        "sourceAppVersion": "unavailable; schema version is not an application version",
        "productionMutationPerformed": false, "captureRequested": capture, "roleCount": results.len(), "roles": results,
        "allRolePhaseCounts": all_role_phase_counts,
        "limitations": ["Inventory is not migration evidence", "No application downgrade guarantee", "Source snapshots exclude caches", "Unproven source identity or cookie attributes prevent import"],
        "nativeCoverage": {"macos14": "pending", "macos15": "pending", "windows": "pending"}});
    let bytes = serde_json::to_vec_pretty(&report).map_err(|_| "REPORT_SERIALIZATION_FAILED")?;
    fs::write(output.join("inventory.json"), bytes).map_err(|_| "REPORT_WRITE_FAILED")?;
    Ok(report)
}
