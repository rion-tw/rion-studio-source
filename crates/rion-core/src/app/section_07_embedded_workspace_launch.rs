impl AppCore {
    fn launch_embedded_workspace(
        &self,
        workspace_id: &str,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let workspace =
            serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                "launchWorkspaces",
                "id",
                workspace_id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            )?)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let expected_role_ids = workspace
            .slots
            .iter()
            .filter_map(|slot| slot.role_id.clone())
            .collect::<Vec<_>>();
        self.launch_embedded_workspace_for_roles(workspace_id, &expected_role_ids, target)
    }

    fn launch_embedded_workspace_for_roles(
        &self,
        workspace_id: &str,
        expected_role_ids: &[String],
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        match self.start_embedded_workspace_for_roles(
            workspace_id,
            expected_role_ids,
            EmbeddedWorkspaceLaunchRequest {
                target,
                launch_preview_id: None,
                launch_tab_id: None,
                launch_attempt_id: uuid::Uuid::new_v4().to_string(),
                presentation_intent: EmbeddedLaunchPresentationIntent::Foreground,
                restore_role_slots: None,
            },
        )? {
            EmbeddedWorkspaceLaunchStart::Completed(value) => Ok(value),
            EmbeddedWorkspaceLaunchStart::Pending(pending) => {
                let lease_id = pending.lease_id.clone();
                let result = self.settle_embedded_workspace_launch_blocking(*pending);
                let completion = self.browser_operations.complete(&lease_id);
                match (result, completion) {
                    (Ok(value), Ok(())) => Ok(value),
                    (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                }
            }
        }
    }
}
