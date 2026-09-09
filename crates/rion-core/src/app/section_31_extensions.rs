impl AppCore {
    fn extensions_snapshot(
        &self,
        runtime: &crate::extensions::ExtensionRuntime,
    ) -> CoreResult<crate::model::ExtensionSnapshotRecord> {
        let value = self.with_runtime(|r| r.state.read_scalar("extensions".to_owned()))?;
        let mut snapshot: crate::model::ExtensionSnapshotRecord = value
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| CoreError::Internal(e.to_string()))?
            .unwrap_or_default();
        snapshot.revision = snapshot.revision.max(runtime.revision);
        snapshot.roles = runtime.roles.values().cloned().collect();
        snapshot.roles.sort_by(|a, b| a.role_id.cmp(&b.role_id));
        Ok(snapshot)
    }

    fn extensions_command(&self, command: crate::model::ExtensionCommand) -> CoreResult<Value> {
        use crate::model::{
            ExtensionCommand as Command, ExtensionResultRecord, ExtensionRoleRecord,
        };
        use std::sync::atomic::Ordering;
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Err(CoreError::Domain {
                code: "EXTENSIONS_UNSUPPORTED",
                message: "Extensions require Chromium.".to_owned(),
            });
        }
        if let Command::Prepare { id, operation_id } = &command {
            uuid::Uuid::parse_str(operation_id).map_err(|_| {
                CoreError::InvalidInput("Invalid extension operation ID".to_owned())
            })?;
            let cancelled = Arc::new(AtomicBool::new(false));
            {
                let mut runtime = self
                    .extensions
                    .lock()
                    .map_err(|_| CoreError::Internal("Extension lock poisoned".to_owned()))?;
                if runtime.cancelled.contains(operation_id) {
                    return Err(CoreError::Domain {
                        code: "EXTENSIONS_CANCELLED",
                        message: "Extension installation cancelled.".to_owned(),
                    });
                }
                if runtime.downloads.len() + runtime.prepared.len() >= 8
                    || runtime.downloads.contains_key(operation_id)
                    || runtime.prepared.contains_key(operation_id)
                {
                    return Err(CoreError::InvalidInput(
                        "Extension operation duplicate or capacity reached".to_owned(),
                    ));
                }
                runtime
                    .downloads
                    .insert(operation_id.clone(), Arc::clone(&cancelled));
            }
            let prepared =
                crate::extensions::prepare(&self.user_data_dir, id, operation_id, &cancelled);
            let mut runtime = self
                .extensions
                .lock()
                .map_err(|_| CoreError::Internal("Extension lock poisoned".to_owned()))?;
            runtime.downloads.remove(operation_id);
            if cancelled.load(Ordering::Acquire) || self.shutdown_started.load(Ordering::Acquire) {
                return Err(CoreError::Domain {
                    code: "EXTENSIONS_CANCELLED",
                    message: "Extension installation cancelled.".to_owned(),
                });
            }
            let (prepared, directory) = prepared.map_err(|e| CoreError::Domain {
                code: "EXTENSIONS_PACKAGE_FAILED",
                message: e.to_string(),
            })?;
            runtime
                .prepared
                .insert(operation_id.clone(), (prepared.clone(), directory));
            return serde_json::to_value(ExtensionResultRecord {
                snapshot: self.extensions_snapshot(&runtime)?,
                prepared: Some(prepared),
                lease: None,
            })
            .map_err(|e| CoreError::Internal(e.to_string()));
        }
        let _guard = self.state_mutation_guard()?;
        let mut runtime = self
            .extensions
            .lock()
            .map_err(|_| CoreError::Internal("Extension lock poisoned".to_owned()))?;
        let mut snapshot = self.extensions_snapshot(&runtime)?;
        let mut lease = None;
        let mut changed = false;
        let mut persisted = false;
        let persist_configuration =
            matches!(&command, Command::Configure { .. } | Command::Remove { .. });
        let validate_roles = |ids: &[String]| -> CoreResult<()> {
            let mut unique = std::collections::HashSet::new();
            for id in ids {
                if !unique.insert(id) {
                    return Err(CoreError::InvalidInput("Duplicate role".to_owned()));
                }
                self.read_state_record("roles", "id", id, "ROLE_NOT_FOUND", "Role not found.")?;
            }
            Ok(())
        };
        match command {
            Command::Snapshot => {}
            Command::Prepare { .. } => unreachable!(),
            Command::Cancel { operation_id } => {
                uuid::Uuid::parse_str(&operation_id).map_err(|_| {
                    CoreError::InvalidInput("Invalid extension operation ID".to_owned())
                })?;
                if !runtime.downloads.contains_key(&operation_id)
                    && !runtime.prepared.contains_key(&operation_id)
                {
                    if runtime.cancelled.len() >= 256 {
                        return Err(CoreError::InvalidInput(
                            "Extension cancellation capacity reached".to_owned(),
                        ));
                    }
                    runtime.cancelled.insert(operation_id.clone());
                }
                if let Some(token) = runtime.downloads.get(&operation_id) {
                    token.store(true, Ordering::Release);
                }
                runtime.prepared.remove(&operation_id);
            }
            Command::Install {
                operation_id,
                role_ids,
                apply_to_all_roles,
            } => {
                let role_ids = if apply_to_all_roles { vec![] } else { role_ids };
                validate_roles(&role_ids)?;
                let (prepared, directory) =
                    runtime.prepared.get(&operation_id).ok_or_else(|| {
                        CoreError::InvalidInput("Prepared extension unavailable".to_owned())
                    })?;
                if snapshot
                    .installed
                    .iter()
                    .any(|p| p.id == prepared.package.id)
                {
                    return Err(CoreError::InvalidInput(
                        "Extension already installed or awaiting removal".to_owned(),
                    ));
                }
                let mut package = prepared.package.clone();
                let target = self
                    .user_data_dir
                    .join("extensions")
                    .join(format!("{}-{}", package.id, operation_id));
                if target.exists() {
                    return Err(CoreError::InvalidInput(
                        "Extension destination exists".to_owned(),
                    ));
                }
                std::fs::rename(directory.path(), &target)
                    .map_err(|e| CoreError::Internal(e.to_string()))?;
                package.directory = target.to_string_lossy().into_owned();
                package.enabled_role_ids = role_ids;
                package.apply_to_all_roles = apply_to_all_roles;
                snapshot.installed.push(package);
                // The destination is recorded atomically before the staging ownership is released.
                let mut durable = snapshot.clone();
                durable.roles.clear();
                durable.revision += 1;
                if let Err(error) = self.with_runtime(|r| {
                    r.state.replace_scalar(
                        "extensions".to_owned(),
                        serde_json::to_value(&durable).unwrap(),
                    )
                }) {
                    let _ = std::fs::rename(&target, directory.path());
                    return Err(error);
                }
                runtime.prepared.remove(&operation_id);
                persisted = true;
                changed = true;
            }
            Command::Configure { id, role_ids, apply_to_all_roles } => {
                let role_ids = if apply_to_all_roles { vec![] } else { role_ids };
                validate_roles(&role_ids)?;
                let package = snapshot
                    .installed
                    .iter_mut()
                    .find(|p| p.id == id && !p.removed)
                    .ok_or_else(|| CoreError::InvalidInput("Extension not installed".to_owned()))?;
                package.enabled_role_ids = role_ids;
                package.apply_to_all_roles = apply_to_all_roles;
                changed = true;
            }
            Command::Remove { id } => {
                let package = snapshot
                    .installed
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or_else(|| CoreError::InvalidInput("Extension not installed".to_owned()))?;
                package.removed = true;
                package.enabled_role_ids.clear();
                package.apply_to_all_roles = false;
                changed = true;
            }
            Command::Acquire { role_id } => {
                validate_roles(std::slice::from_ref(&role_id))?;
                if runtime.roles.contains_key(&role_id) {
                    return Err(CoreError::InvalidInput(
                        "Extension role lease already active".to_owned(),
                    ));
                }
                let record = ExtensionRoleRecord {
                    role_id: role_id.clone(),
                    lease_id: uuid::Uuid::new_v4().to_string(),
                    extension_ids: snapshot
                        .installed
                        .iter()
                        .filter(|p| !p.removed && (p.apply_to_all_roles || p.enabled_role_ids.contains(&role_id)))
                        .map(|p| p.id.clone())
                        .collect(),
                    status: "loading".to_owned(),
                };
                runtime.roles.insert(role_id, record.clone());
                lease = Some(record);
                changed = true;
            }
            Command::Complete {
                role_id,
                lease_id,
                status,
            } => {
                if !matches!(status.as_str(), "loaded" | "failed") {
                    return Err(CoreError::InvalidInput(
                        "Invalid extension status".to_owned(),
                    ));
                }
                let record = runtime
                    .roles
                    .get_mut(&role_id)
                    .filter(|r| r.lease_id == lease_id)
                    .ok_or_else(|| CoreError::InvalidInput("Stale extension lease".to_owned()))?;
                if record.status == "loading" {
                    record.status = status;
                    changed = true;
                }
            }
            Command::Release { role_id, lease_id } => {
                if runtime
                    .roles
                    .get(&role_id)
                    .is_some_and(|r| r.lease_id == lease_id)
                {
                    runtime.roles.remove(&role_id);
                    changed = true;
                }
            }
        }
        if changed {
            snapshot.revision += 1;
            snapshot.roles = runtime.roles.values().cloned().collect();
            snapshot.roles.sort_by(|a, b| a.role_id.cmp(&b.role_id));
            if !persisted && persist_configuration {
                let mut durable = snapshot.clone();
                durable.roles.clear();
                self.with_runtime(|r| {
                    r.state.replace_scalar(
                        "extensions".to_owned(),
                        serde_json::to_value(durable).unwrap(),
                    )
                })?;
            }
            runtime.revision = snapshot.revision;
            self.emit(vec![CoreEvent::ExtensionsChanged {
                snapshot: snapshot.clone(),
            }]);
            if snapshot.installed.iter().any(|p| p.removed) {
                let candidates: Vec<_> = snapshot
                    .installed
                    .iter()
                    .filter(|p| {
                        p.removed
                            && !runtime
                                .roles
                                .values()
                                .any(|r| r.extension_ids.contains(&p.id))
                    })
                    .cloned()
                    .collect();
                let before_cleanup = snapshot.installed.len();
                for package in candidates {
                    let path = std::path::Path::new(&package.directory);
                    if path.parent() != Some(self.user_data_dir.join("extensions").as_path()) {
                        continue;
                    }
                    match std::fs::remove_dir_all(path) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => continue,
                    }
                    snapshot.installed.retain(|p| p.id != package.id);
                }
                if snapshot.installed.len() != before_cleanup {
                    let mut durable = snapshot.clone();
                    durable.roles.clear();
                    durable.revision += 1;
                    self.with_runtime(|r| {
                        r.state.replace_scalar(
                            "extensions".to_owned(),
                            serde_json::to_value(durable).unwrap(),
                        )
                    })?;
                    snapshot.revision += 1;
                    runtime.revision = snapshot.revision;
                    self.emit(vec![CoreEvent::ExtensionsChanged {
                        snapshot: snapshot.clone(),
                    }]);
                }
            }
        }
        serde_json::to_value(ExtensionResultRecord {
            snapshot,
            prepared: None,
            lease,
        })
        .map_err(|e| CoreError::Internal(e.to_string()))
    }
}
