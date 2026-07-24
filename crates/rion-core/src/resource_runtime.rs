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
                targets,
            } => {
                validate_workspace_id(&workspace_id)?;
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
            if !hidden {
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
                let (unavailable, available): (Vec<_>, Vec<_>) = group
                    .into_iter()
                    .partition(|role_id| workspace.unavailable_role_ids.contains(role_id));
                effects.extend(unavailable.into_iter().map(|role_id| {
                    ResourceRuntimeEffectRecord {
                        role_ids: vec![role_id],
                        cpu_throttle_rate: 1,
                        release: true,
                    }
                }));
                if available.is_empty() {
                    continue;
                }
                let full_speed = available
                    .iter()
                    .any(|role_id| self.macro_role_ids.contains(role_id));
                effects.push(ResourceRuntimeEffectRecord {
                    role_ids: available,
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
            if !self.hidden_workspace_ids.contains(workspace_id) {
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
    use crate::v1_case;

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

    #[test]
    fn hidden_single_role_tabs_use_adaptive_throttling() {
        crate::v1_case!("resource-platform-dafdc0585039", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "role-tab".to_owned(),
                    targets: vec![target("r1", None)],
                },
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["role-tab".to_owned()],
                },
            );

            assert_eq!(result.effects[0].cpu_throttle_rate, 2);
            assert!(!result.effects[0].release);
            assert_eq!(result.statuses[0].resource_state, "throttled");
            assert_eq!(
                result.statuses[0].resource_reason.as_deref(),
                Some("runtime_tab_background")
            );
        });
    }

    #[test]
    fn preserves_v1_workspace_resource_coordination_contracts() {
        {
            let mut runtime = ResourceRuntime::default();
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "visible".to_owned(),
                    targets: vec![target("r1", None), target("r2", None)],
                },
            );
            assert!(result.statuses.is_empty());
            assert_eq!(result.effects.len(), 2);
            assert!(
                result
                    .effects
                    .iter()
                    .all(|effect| { effect.release && effect.cpu_throttle_rate == 1 })
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetPressure {
                    level: PressureLevel::Constrained,
                    reason: "cpu".to_owned(),
                },
            );
            assert!(result.statuses.is_empty());
            assert!(result.effects.iter().all(|effect| effect.release));
        }

        v1_case!("resource-platform-4de9ca596dee", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "adaptive".to_owned(),
                    targets: vec![target("r1", None)],
                },
            );
            let normal = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["adaptive".to_owned()],
                },
            );
            assert_eq!(normal.effects[0].cpu_throttle_rate, 2);
            assert_eq!(normal.statuses[0].resource_state, "throttled");
            assert_eq!(
                normal.statuses[0].resource_reason.as_deref(),
                Some("runtime_tab_background")
            );
            let constrained = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetPressure {
                    level: PressureLevel::Constrained,
                    reason: "memory".to_owned(),
                },
            );
            assert_eq!(constrained.effects[0].cpu_throttle_rate, 4);
            assert_eq!(
                constrained.statuses[0].resource_pressure_level.as_deref(),
                Some("constrained")
            );
            assert_eq!(
                constrained.statuses[0].resource_reason.as_deref(),
                Some("memory")
            );
        });

        v1_case!("resource-platform-c06f9afb7ed3", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "macro".to_owned(),
                    targets: vec![target("r1", None), target("r2", None)],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["macro".to_owned()],
                },
            );
            let active = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetMacroRoleIds {
                    role_ids: vec!["r2".to_owned()],
                },
            );
            let active_status = active
                .statuses
                .iter()
                .find(|status| status.role_id == "r2")
                .unwrap();
            assert_eq!(active_status.resource_state, "macro_override");
            assert_eq!(active_status.cpu_throttle_rate, 1);
            let inactive = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetMacroRoleIds {
                    role_ids: Vec::new(),
                },
            );
            let inactive_status = inactive
                .statuses
                .iter()
                .find(|status| status.role_id == "r2")
                .unwrap();
            assert_eq!(inactive_status.resource_state, "throttled");
            assert_eq!(inactive_status.cpu_throttle_rate, 2);
        });

        v1_case!("resource-platform-bbfb276cd2a9", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "shared".to_owned(),
                    targets: vec![target("r1", Some(101)), target("r2", Some(101))],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["shared".to_owned()],
                },
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetMacroRoleIds {
                    role_ids: vec!["r1".to_owned()],
                },
            );
            let sibling = result
                .statuses
                .iter()
                .find(|status| status.role_id == "r2")
                .unwrap();
            assert_eq!(sibling.resource_state, "shared_process");
            assert_eq!(sibling.cpu_throttle_rate, 1);
            assert_eq!(sibling.resource_reason.as_deref(), Some("shared_process"));
        });

        v1_case!("resource-platform-d62f2ca98a7b", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "refresh".to_owned(),
                    targets: vec![target("r1", Some(101)), target("r2", Some(101))],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["refresh".to_owned()],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::RefreshTarget {
                    workspace_id: "refresh".to_owned(),
                    role_id: "r2".to_owned(),
                    process_id: Some(202),
                },
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetUnavailableRoleIds {
                    role_ids: vec!["r2".to_owned()],
                },
            );
            let unavailable = result
                .statuses
                .iter()
                .find(|status| status.role_id == "r2")
                .unwrap();
            assert_eq!(unavailable.resource_state, "unavailable");
            assert_eq!(unavailable.cpu_throttle_rate, 1);
            assert_eq!(unavailable.resource_reason.as_deref(), Some("unavailable"));
            assert!(result.effects.iter().any(|effect| {
                effect.role_ids == ["r2"] && effect.cpu_throttle_rate == 1 && effect.release
            }));
        });

        v1_case!("resource-platform-308caa9fe2ea", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "foreground".to_owned(),
                    targets: vec![target("r1", None)],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["foreground".to_owned()],
                },
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::PrepareWorkspaceForeground {
                    workspace_id: "foreground".to_owned(),
                },
            );
            assert!(result.statuses.is_empty());
            assert_eq!(result.effects.len(), 1);
            assert!(result.effects[0].release);
        });

        v1_case!("resource-platform-378cb6d68a6d", {
            let mut runtime = ResourceRuntime::default();
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::ActivateWorkspace {
                    workspace_id: "reconcile".to_owned(),
                    targets: vec![target("r1", None), target("r2", None)],
                },
            );
            invoke(
                &mut runtime,
                ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                    workspace_ids: vec!["reconcile".to_owned()],
                },
            );
            let result = invoke(
                &mut runtime,
                ResourceRuntimeCommand::ReconcileRuntimeRoleIds {
                    runtime_mode: "embedded".to_owned(),
                    active_role_ids: vec!["r2".to_owned()],
                },
            );
            assert_eq!(result.statuses.len(), 1);
            assert_eq!(result.statuses[0].role_id, "r2");
            assert!(
                result
                    .effects
                    .iter()
                    .any(|effect| { effect.role_ids == ["r1"] && effect.release })
            );
        });
    }
}
