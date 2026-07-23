use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::{
    error::{CoreError, CoreResult},
    model::{
        PressureLevel, ResourceRuntimeCommand, ResourceRuntimeEffectRecord, ResourceRuntimeResult,
        ResourceRuntimeStatusRecord, ResourceRuntimeTargetRecord,
    },
};

#[derive(Clone)]
struct ManagedWorkspace {
    policy_mode: String,
    targets: BTreeMap<String, ResourceRuntimeTargetRecord>,
    unavailable_role_ids: HashSet<String>,
}

pub struct ResourceRuntime {
    hidden_workspace_ids: HashSet<String>,
    macro_role_ids: HashSet<String>,
    pressure_level: PressureLevel,
    pressure_reason: String,
    workspaces: BTreeMap<String, ManagedWorkspace>,
}

impl Default for ResourceRuntime {
    fn default() -> Self {
        Self {
            hidden_workspace_ids: HashSet::new(),
            macro_role_ids: HashSet::new(),
            pressure_level: PressureLevel::Normal,
            pressure_reason: "baseline".to_owned(),
            workspaces: BTreeMap::new(),
        }
    }
}

impl ResourceRuntime {
    pub fn invoke(&mut self, command: ResourceRuntimeCommand) -> CoreResult<ResourceRuntimeResult> {
        let mut release_role_ids = BTreeSet::new();
        match command {
            ResourceRuntimeCommand::Snapshot => {}
            ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id,
                policy_mode,
                targets,
            } => {
                validate_workspace_id(&workspace_id)?;
                if !matches!(policy_mode.as_str(), "adaptive" | "unrestricted") {
                    return Err(CoreError::InvalidInput(
                        "resource policy mode is invalid".to_owned(),
                    ));
                }
                let mut target_map = BTreeMap::new();
                for target in targets {
                    validate_target(&target)?;
                    if target_map.insert(target.role_id.clone(), target).is_some() {
                        return Err(CoreError::InvalidInput(
                            "resource runtime target role ids must be unique".to_owned(),
                        ));
                    }
                }
                if let Some(previous) = self.workspaces.insert(
                    workspace_id,
                    ManagedWorkspace {
                        policy_mode,
                        targets: target_map,
                        unavailable_role_ids: HashSet::new(),
                    },
                ) {
                    release_role_ids.extend(previous.targets.into_keys());
                }
            }
            ResourceRuntimeCommand::DeactivateWorkspace { workspace_id } => {
                if let Some(previous) = self.workspaces.remove(&workspace_id) {
                    release_role_ids.extend(previous.targets.into_keys());
                }
                self.hidden_workspace_ids.remove(&workspace_id);
            }
            ResourceRuntimeCommand::SetMacroRoleIds { role_ids } => {
                self.macro_role_ids = role_ids.into_iter().collect();
            }
            ResourceRuntimeCommand::SetHiddenWorkspaceIds { workspace_ids } => {
                self.hidden_workspace_ids = workspace_ids.into_iter().collect();
            }
            ResourceRuntimeCommand::PrepareWorkspaceForeground { workspace_id } => {
                self.hidden_workspace_ids.remove(&workspace_id);
            }
            ResourceRuntimeCommand::ReconcileRuntimeRoleIds {
                runtime_mode,
                active_role_ids,
            } => {
                if !matches!(runtime_mode.as_str(), "embedded" | "external") {
                    return Err(CoreError::InvalidInput(
                        "resource runtime mode is invalid".to_owned(),
                    ));
                }
                let active = active_role_ids.into_iter().collect::<HashSet<_>>();
                for workspace in self.workspaces.values_mut() {
                    let removed = workspace
                        .targets
                        .iter()
                        .filter(|(_, target)| {
                            target.runtime_mode == runtime_mode && !active.contains(&target.role_id)
                        })
                        .map(|(role_id, _)| role_id.clone())
                        .collect::<Vec<_>>();
                    for role_id in removed {
                        workspace.targets.remove(&role_id);
                        workspace.unavailable_role_ids.remove(&role_id);
                        release_role_ids.insert(role_id);
                    }
                }
            }
            ResourceRuntimeCommand::RefreshTarget {
                workspace_id,
                role_id,
                process_id,
            } => {
                validate_workspace_id(&workspace_id)?;
                if let Some(target) = self
                    .workspaces
                    .get_mut(&workspace_id)
                    .and_then(|workspace| workspace.targets.get_mut(&role_id))
                {
                    target.process_id = process_id;
                }
            }
            ResourceRuntimeCommand::SetPressure { level, reason } => {
                if !matches!(reason.as_str(), "baseline" | "cpu" | "memory" | "thermal") {
                    return Err(CoreError::InvalidInput(
                        "resource pressure reason is invalid".to_owned(),
                    ));
                }
                self.pressure_level = level;
                self.pressure_reason = reason;
            }
            ResourceRuntimeCommand::SetUnavailableRoleIds { role_ids } => {
                let unavailable = role_ids.into_iter().collect::<HashSet<_>>();
                for workspace in self.workspaces.values_mut() {
                    workspace.unavailable_role_ids = workspace
                        .targets
                        .keys()
                        .filter(|role_id| unavailable.contains(*role_id))
                        .cloned()
                        .collect();
                }
            }
        }

        let mut effects = release_role_ids
            .into_iter()
            .map(|role_id| ResourceRuntimeEffectRecord {
                role_ids: vec![role_id],
                cpu_throttle_rate: 1,
                release: true,
            })
            .collect::<Vec<_>>();
        effects.extend(self.effects());
        Ok(ResourceRuntimeResult {
            effects,
            statuses: self.statuses(),
        })
    }

    fn effects(&self) -> Vec<ResourceRuntimeEffectRecord> {
        let mut effects = Vec::new();
        for (workspace_id, workspace) in &self.workspaces {
            let hidden = self.hidden_workspace_ids.contains(workspace_id);
            if workspace.policy_mode == "unrestricted" || !hidden {
                effects.extend(workspace.targets.keys().map(|role_id| {
                    ResourceRuntimeEffectRecord {
                        role_ids: vec![role_id.clone()],
                        cpu_throttle_rate: 1,
                        release: true,
                    }
                }));
                continue;
            }
            for group in create_groups(workspace) {
                let full_speed = group
                    .iter()
                    .any(|role_id| self.macro_role_ids.contains(role_id));
                effects.push(ResourceRuntimeEffectRecord {
                    role_ids: group,
                    cpu_throttle_rate: if full_speed {
                        1
                    } else if self.pressure_level == PressureLevel::Constrained {
                        4
                    } else {
                        2
                    },
                    release: false,
                });
            }
        }
        effects
    }

    fn statuses(&self) -> Vec<ResourceRuntimeStatusRecord> {
        let mut statuses = Vec::new();
        for (workspace_id, workspace) in &self.workspaces {
            if workspace.policy_mode == "unrestricted"
                || !self.hidden_workspace_ids.contains(workspace_id)
            {
                continue;
            }
            for group in create_groups(workspace) {
                let group_has_macro = group
                    .iter()
                    .any(|role_id| self.macro_role_ids.contains(role_id));
                for role_id in group {
                    let status = if workspace.unavailable_role_ids.contains(&role_id) {
                        status(&role_id, "unavailable", 1, None, Some("unavailable"))
                    } else if self.macro_role_ids.contains(&role_id) {
                        status(&role_id, "macro_override", 1, None, Some("macro"))
                    } else if group_has_macro {
                        status(&role_id, "shared_process", 1, None, Some("shared_process"))
                    } else {
                        let constrained = self.pressure_level == PressureLevel::Constrained;
                        status(
                            &role_id,
                            "throttled",
                            if constrained { 4 } else { 2 },
                            Some(if constrained { "constrained" } else { "normal" }),
                            Some(if constrained {
                                &self.pressure_reason
                            } else {
                                "runtime_tab_background"
                            }),
                        )
                    };
                    statuses.push(status);
                }
            }
        }
        statuses.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        statuses
    }
}

fn validate_workspace_id(workspace_id: &str) -> CoreResult<()> {
    if workspace_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "resource runtime workspace id is required".to_owned(),
        ));
    }
    Ok(())
}

fn validate_target(target: &ResourceRuntimeTargetRecord) -> CoreResult<()> {
    if target.role_id.trim().is_empty()
        || !matches!(target.runtime_mode.as_str(), "embedded" | "external")
    {
        return Err(CoreError::InvalidInput(
            "resource runtime target is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn create_groups(workspace: &ManagedWorkspace) -> Vec<Vec<String>> {
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for target in workspace.targets.values() {
        let key = target.process_id.filter(|value| *value > 0).map_or_else(
            || format!("{}:role:{}", target.runtime_mode, target.role_id),
            |process_id| format!("{}:process:{process_id}", target.runtime_mode),
        );
        groups.entry(key).or_default().push(target.role_id.clone());
    }
    groups.into_values().collect()
}

fn status(
    role_id: &str,
    resource_state: &str,
    cpu_throttle_rate: u8,
    resource_pressure_level: Option<&str>,
    resource_reason: Option<&str>,
) -> ResourceRuntimeStatusRecord {
    ResourceRuntimeStatusRecord {
        role_id: role_id.to_owned(),
        resource_state: resource_state.to_owned(),
        cpu_throttle_rate,
        resource_pressure_level: resource_pressure_level.map(str::to_owned),
        resource_reason: resource_reason.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(role_id: &str, process_id: Option<u32>) -> ResourceRuntimeTargetRecord {
        ResourceRuntimeTargetRecord {
            role_id: role_id.to_owned(),
            runtime_mode: "embedded".to_owned(),
            process_id,
        }
    }

    fn invoke(
        runtime: &mut ResourceRuntime,
        command: ResourceRuntimeCommand,
    ) -> ResourceRuntimeResult {
        runtime.invoke(command).unwrap()
    }

    #[test]
    fn visible_roles_are_always_full_speed_and_have_no_status() {
        let mut runtime = ResourceRuntime::default();
        let result = invoke(
            &mut runtime,
            ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id: "w1".to_owned(),
                policy_mode: "adaptive".to_owned(),
                targets: vec![target("r1", None)],
            },
        );
        assert_eq!(result.effects[0].cpu_throttle_rate, 1);
        assert!(result.statuses.is_empty());
    }

    #[test]
    fn ignores_target_invalidation_before_workspace_activation() {
        let mut runtime = ResourceRuntime::default();
        let result = invoke(
            &mut runtime,
            ResourceRuntimeCommand::RefreshTarget {
                workspace_id: "launching-tab".to_owned(),
                role_id: "role-1".to_owned(),
                process_id: Some(42),
            },
        );
        assert!(result.effects.is_empty());
        assert!(result.statuses.is_empty());
    }

    #[test]
    fn hidden_roles_use_pressure_rate_and_macro_process_groups() {
        let mut runtime = ResourceRuntime::default();
        invoke(
            &mut runtime,
            ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id: "w1".to_owned(),
                policy_mode: "adaptive".to_owned(),
                targets: vec![target("r1", Some(42)), target("r2", Some(42))],
            },
        );
        invoke(
            &mut runtime,
            ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                workspace_ids: vec!["w1".to_owned()],
            },
        );
        let result = invoke(
            &mut runtime,
            ResourceRuntimeCommand::SetMacroRoleIds {
                role_ids: vec!["r1".to_owned()],
            },
        );
        assert_eq!(result.effects[0].cpu_throttle_rate, 1);
        assert_eq!(result.statuses[0].resource_state, "macro_override");
        assert_eq!(result.statuses[1].resource_state, "shared_process");

        let result = invoke(
            &mut runtime,
            ResourceRuntimeCommand::SetPressure {
                level: PressureLevel::Constrained,
                reason: "memory".to_owned(),
            },
        );
        assert_eq!(result.effects[0].cpu_throttle_rate, 1);
    }

    #[test]
    fn failed_effects_are_reported_as_unavailable_and_fail_open() {
        let mut runtime = ResourceRuntime::default();
        invoke(
            &mut runtime,
            ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id: "w1".to_owned(),
                policy_mode: "adaptive".to_owned(),
                targets: vec![target("r1", None)],
            },
        );
        invoke(
            &mut runtime,
            ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                workspace_ids: vec!["w1".to_owned()],
            },
        );
        let result = invoke(
            &mut runtime,
            ResourceRuntimeCommand::SetUnavailableRoleIds {
                role_ids: vec!["r1".to_owned()],
            },
        );
        assert_eq!(result.statuses[0].resource_state, "unavailable");
        assert_eq!(result.statuses[0].cpu_throttle_rate, 1);
    }
}
