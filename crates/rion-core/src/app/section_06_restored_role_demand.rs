struct RestoredRoleDemandRequest {
    role: StateRoleRecord,
    runtime_role: crate::model::BrowserRuntimeRoleRecord,
    target: EmbeddedLaunchTargetRecord,
    launch_preview_id: Option<String>,
    launch_tab_id: Option<String>,
    launch_attempt_id: String,
    restore_role_slot: GameWindowRoleSlotRecord,
    runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
}

impl AppCore {
    fn create_restored_role_demand(
        &self,
        request: RestoredRoleDemandRequest,
    ) -> CoreResult<EmbeddedRoleLaunchStart> {
        let RestoredRoleDemandRequest {
            role,
            runtime_role,
            target,
            launch_preview_id,
            launch_tab_id,
            launch_attempt_id,
            restore_role_slot,
            runtime_snapshot,
        } = request;
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let audio_muted =
            self.saved_game_window_tab_audio_muted(&target.window_id, "role", &role.id)?;
        let created = self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: launch_tab_id.or(self.saved_game_window_tab_id(
                &target.window_id,
                "role",
                &role.id,
            )?),
            source_id: role.id.clone(),
            name: role.name.clone(),
            tab_type: "role".to_owned(),
            workspace_id: None,
            audio_muted,
            attempt_generation: Some(launch_attempt_id.clone()),
            window_id: target.window_id.clone(),
            role_slots: vec![RuntimeRoleSlotInputRecord {
                slot_id: restore_role_slot.slot_id.clone(),
                role_id: role.id.clone(),
                rect: restore_role_slot.rect.clone(),
                browser_zoom_percent: restore_role_slot.browser_zoom_percent,
            }],
            web_surfaces: Vec::new(),
        })?;
        let tab_id = created
            .created_tab_id
            .clone()
            .ok_or_else(|| CoreError::Internal("restored role tab was not created".to_owned()))?;
        let runtime_slot = created
            .snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .and_then(|tab| {
                tab.slots
                    .iter()
                    .find(|slot| slot.slot_id == restore_role_slot.slot_id)
            })
            .cloned()
            .ok_or_else(|| CoreError::Internal("restored role slot was not created".to_owned()))?;
        let zoom_factor = restore_role_slot
            .browser_zoom_percent
            .unwrap_or(100.0)
            .clamp(25.0, 500.0)
            / 100.0;
        let tab = EmbeddedTabEffectRecord {
            appkit_window_generation: None,
            appkit_topology_revision: None,
            tab_id: tab_id.clone(),
            audio_muted,
            attempt_generation: Some(launch_attempt_id),
            launch_preview_id,
            source_id: role.id.clone(),
            name: role.name.clone(),
            workspace_id: None,
            workspace_template: None,
            workspace_slots: Vec::new(),
            workspace_appearance: settings.workspace,
            target,
            slots: vec![EmbeddedRoleSlotEffectRecord {
                slot_id: runtime_slot.slot_id,
                role: role.clone(),
                web: None,
                rect: runtime_slot.rect,
                zoom_factor,
                zoom_mode: "fixed".to_owned(),
                state: runtime_slot.state,
                owner: runtime_slot.owner,
            }],
            roles: Vec::new(),
        };
        let window_id = tab.target.window_id.clone();
        let (_, resolved_engine, _) = self.expected_browser_runtime_identity();
        let handle = self.start_system_launch(SystemLaunchRequest {
            tab_id: &tab_id,
            tab,
            roles: &[],
            runtime_snapshot,
            global_web_profile: None,
            presentation_intent: EmbeddedLaunchPresentationIntent::RestoreHydration,
            resolved_engine,
        })?;
        if let Err(error) = self.commit_embedded_runtime_snapshot_without_native_effect(
            &std::collections::HashSet::new(),
        ) {
            let _ = self.operation_actor.cancel(&handle.operation_id);
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        if let Err(error) = self.finish_system_launch(handle, &[]) {
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        if self.complete_chromium_runtime_launch(&tab_id, &[])? {
            self.project_completed_chromium_runtime_launch(
                &tab_id,
                EmbeddedLaunchPresentationIntent::RestoreHydration,
            )?;
        }
        if let Err(error) =
            self.persist_runtime_ui_windows(std::slice::from_ref(&window_id))
        {
            let _ = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        Ok(EmbeddedRoleLaunchStart::Completed(vec![
            embedded_launch_result(
                &role.id,
                runtime_role
                    .launched_at
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            ),
        ]))
    }
}

fn validate_restored_role_slot(
    role_id: &str,
    restore_role_slots: Option<&[GameWindowRoleSlotRecord]>,
) -> CoreResult<Option<GameWindowRoleSlotRecord>> {
    let Some(restore_role_slots) = restore_role_slots else {
        return Ok(None);
    };
    if restore_role_slots.len() != 1 || restore_role_slots[0].role_id != role_id {
        return Err(CoreError::Domain {
            code: "ROLE_RESTORE_SLOT_INVALID",
            message: "A restored role tab must contain exactly one matching role slot.".to_owned(),
        });
    }
    Ok(restore_role_slots.first().cloned())
}
