use crate::model::{PressureLevel, ResourcePolicyDecision, ResourcePolicyInput};

pub fn resolve_resource_policy(input: &ResourcePolicyInput) -> ResourcePolicyDecision {
    if !input.workspace_hidden {
        return ResourcePolicyDecision {
            cpu_throttle_rate: 1,
            resource_state: "full_speed".to_owned(),
            resource_reason: None,
        };
    }
    if input.macro_active {
        return ResourcePolicyDecision {
            cpu_throttle_rate: 1,
            resource_state: "macro_override".to_owned(),
            resource_reason: Some("macro".to_owned()),
        };
    }
    if input.shares_process_with_macro {
        return ResourcePolicyDecision {
            cpu_throttle_rate: 1,
            resource_state: "shared_process".to_owned(),
            resource_reason: Some("shared_process".to_owned()),
        };
    }
    let constrained = input.pressure_level == PressureLevel::Constrained;
    ResourcePolicyDecision {
        cpu_throttle_rate: if constrained { 4 } else { 2 },
        resource_state: "throttled".to_owned(),
        resource_reason: Some(if constrained {
            "system_pressure".to_owned()
        } else {
            "runtime_tab_background".to_owned()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_throttles_visible_roles() {
        let decision = resolve_resource_policy(&ResourcePolicyInput {
            workspace_hidden: false,
            macro_active: false,
            shares_process_with_macro: false,
            pressure_level: PressureLevel::Constrained,
        });
        assert_eq!(decision.cpu_throttle_rate, 1);
    }

    #[test]
    fn protects_macro_roles_in_hidden_workspaces() {
        let decision = resolve_resource_policy(&ResourcePolicyInput {
            workspace_hidden: true,
            macro_active: true,
            shares_process_with_macro: false,
            pressure_level: PressureLevel::Constrained,
        });
        assert_eq!(decision.resource_state, "macro_override");
        assert_eq!(decision.cpu_throttle_rate, 1);
    }
}
