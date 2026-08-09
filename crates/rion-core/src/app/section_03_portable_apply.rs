impl AppCore {
    /// Applies a prepared portable import while coordinating browser and macro leases.
    fn apply_portable_import(
        &self,
        import_id: String,
        selection: crate::model::PortableDataSelectionRecord,
        resolutions: Vec<crate::model::PortableMacroConflictResolutionRecord>,
    ) -> CoreResult<Value> {
    let runtime_snapshot = self
        .browser_runtime
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
        .snapshot;
    let running_role_ids = runtime_snapshot
        .roles
        .iter()
        .filter(|role| role.runtime == "embedded")
        .map(|role| role.role_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let running_workspace_ids = runtime_snapshot
        .workspaces
        .iter()
        .filter(|workspace| workspace.runtime == "embedded")
        .map(|workspace| workspace_operation_key(&workspace.workspace_id))
        .collect::<std::collections::HashSet<_>>();
    if selection.game_windows && !running_role_ids.is_empty() {
        return Err(CoreError::Domain {
            code: "PORTABLE_IMPORT_GAME_WINDOWS_RUNNING",
            message: "Stop all running roles before importing Game Windows.".to_owned(),
        });
    }
    let (before, prepared) = {
        let _guard = self.state_mutation_guard()?;
        let snapshot = self.read_typed_snapshot()?;
        let prepared = self.portable()?.prepare_apply(
            &import_id,
            selection,
            resolutions,
            snapshot.clone(),
        )?;
        (snapshot, prepared)
    };
    let operation_role_ids = portable_operation_role_ids(&before, &prepared.snapshot)?;
    if operation_role_ids
        .iter()
        .any(|id| running_role_ids.contains(id) || running_workspace_ids.contains(id))
    {
        return Err(CoreError::Domain {
            code: "PORTABLE_IMPORT_ROLES_RUNNING",
            message:
                "Stop affected roles before importing Games, Roles, or Workspaces."
                    .to_owned(),
        });
    }
    let browser_lease = if operation_role_ids.is_empty() {
        None
    } else {
        Some(self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: operation_role_ids,
            kind: "recoverableMutation".to_owned(),
        })?)
    };
    let macro_lease_id = if prepared.affected_macro_ids.is_empty() {
        None
    } else {
        match self
            .macro_runtime
            .acquire_mutation(prepared.affected_macro_ids.clone(), false)
        {
            Ok(lease_id) => Some(lease_id),
            Err(CoreError::Domain {
                code: "MACRO_MUTATION_BUSY",
                ..
            }) => {
                if let Some(lease) = &browser_lease {
                    let _ = self.browser_operations.abort(&lease.id);
                }
                return Err(CoreError::Domain {
                    code: "PORTABLE_IMPORT_BUSY",
                    message: "Stop affected macros before importing.".to_owned(),
                });
            }
            Err(error) => {
                if let Some(lease) = &browser_lease {
                    let _ = self.browser_operations.abort(&lease.id);
                }
                return Err(error);
            }
        }
    };
    let result = (|| {
        let _guard = self.state_mutation_guard()?;
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let current = self.read_typed_snapshot()?;
        if serde_json::to_value(&current)
            .map_err(|error| CoreError::Internal(error.to_string()))?
            != serde_json::to_value(&before)
                .map_err(|error| CoreError::Internal(error.to_string()))?
        {
            return Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_STATE_CHANGED",
                message: "App data changed while the import was waiting. Review and apply the import again."
                    .to_owned(),
            });
        }
        let snapshot = serde_json::to_value(&prepared.snapshot)
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        let (revision, changed) =
            self.with_runtime(|runtime| runtime.state.replace_snapshot(snapshot))?;
        self.portable()?.discard(&import_id);
        if changed {
            self.emit(vec![CoreEvent::StateChanged {
                revision,
                changed_collections: vec![
                    StateCollection::Games,
                    StateCollection::Roles,
                    StateCollection::LaunchWorkspaces,
                    StateCollection::GameWindows,
                    StateCollection::Macros,
                ],
            }]);
        }
        serde_json::to_value(prepared.result)
            .map_err(|error| CoreError::Internal(error.to_string()))
    })();
    let macro_completion = macro_lease_id.as_deref().map_or(Ok(()), |lease_id| {
        self.macro_runtime.release_mutation(lease_id)
    });
    let browser_completion = match (&browser_lease, result.is_ok()) {
        (Some(lease), true) => self.browser_operations.complete(&lease.id),
        (Some(lease), false) => self.browser_operations.abort(&lease.id),
        (None, _) => Ok(()),
    };
    match (result, macro_completion, browser_completion) {
        (Ok(value), Ok(()), Ok(())) => Ok(value),
        (Err(error), _, _) | (Ok(_), Err(error), _) | (Ok(_), Ok(()), Err(error)) => {
            Err(error)
        }
    }

    }
}
