use std::collections::HashMap;

use crate::{
    error::{CoreError, CoreResult},
    model::{ExternalSessionCommand, ExternalSessionRecord, ExternalSessionResult},
};

#[derive(Clone, Default)]
pub struct ExternalSessionRuntime {
    sessions: HashMap<String, ExternalSessionRecord>,
}

impl ExternalSessionRuntime {
    pub fn invoke(&mut self, command: ExternalSessionCommand) -> CoreResult<ExternalSessionResult> {
        let previous = self.clone();
        match self.invoke_inner(command) {
            Ok(result) => Ok(result),
            Err(error) => {
                *self = previous;
                Err(error)
            }
        }
    }

    fn invoke_inner(
        &mut self,
        command: ExternalSessionCommand,
    ) -> CoreResult<ExternalSessionResult> {
        match command {
            ExternalSessionCommand::Snapshot => {}
            ExternalSessionCommand::Begin {
                role,
                bounds,
                physical_bounds,
                workspace_id,
                notice,
                zoom_factor,
            } => {
                if self.sessions.contains_key(&role.id) {
                    return Err(domain(
                        "ROLE_ALREADY_RUNNING",
                        "External Chrome role is already running.",
                    ));
                }
                validate_bounds(&bounds)?;
                if let Some(bounds) = &physical_bounds {
                    validate_bounds(bounds)?;
                }
                if !zoom_factor.is_finite() || zoom_factor <= 0.0 {
                    return Err(domain(
                        "EXTERNAL_ZOOM_INVALID",
                        "External Chrome zoom factor is invalid.",
                    ));
                }
                self.sessions.insert(
                    role.id.clone(),
                    ExternalSessionRecord {
                        role,
                        bounds,
                        physical_bounds,
                        workspace_id,
                        notice,
                        zoom_factor,
                        state: "launching".to_owned(),
                        launched_at: None,
                        automation_available: false,
                        cdn_active: false,
                        page_health: None,
                        page_hidden: false,
                        last_cdp_timeout_at_ms: None,
                    },
                );
            }
            ExternalSessionCommand::UpdateRole { role } => {
                let session = self.get_mut(&role.id)?;
                session.role = role;
            }
            ExternalSessionCommand::SetNotice { role_id, notice } => {
                self.get_mut(&role_id)?.notice = notice;
            }
            ExternalSessionCommand::SetAutomation {
                role_id,
                available,
                cdn_active,
            } => {
                let session = self.get_mut(&role_id)?;
                session.automation_available = available;
                session.cdn_active = available && cdn_active;
                if !available {
                    session.page_health = None;
                }
            }
            ExternalSessionCommand::SetRunning {
                role_id,
                launched_at,
            } => {
                let session = self.get_mut(&role_id)?;
                if session.state != "launching" {
                    return Err(domain(
                        "EXTERNAL_TRANSITION_INVALID",
                        "External Chrome session cannot enter running state.",
                    ));
                }
                session.state = "running".to_owned();
                session.launched_at = Some(launched_at);
            }
            ExternalSessionCommand::SetStopping { role_id } => {
                let session = self.get_mut(&role_id)?;
                if !matches!(session.state.as_str(), "launching" | "running" | "stopping") {
                    return Err(domain(
                        "EXTERNAL_TRANSITION_INVALID",
                        "External Chrome session cannot enter stopping state.",
                    ));
                }
                session.state = "stopping".to_owned();
            }
            ExternalSessionCommand::SetHealth {
                role_id,
                health,
                page_hidden,
            } => {
                if health
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "healthy" | "unresponsive"))
                {
                    return Err(domain(
                        "EXTERNAL_HEALTH_INVALID",
                        "External Chrome page health is invalid.",
                    ));
                }
                let session = self.get_mut(&role_id)?;
                session.page_health = health;
                session.page_hidden = page_hidden;
            }
            ExternalSessionCommand::RecordCdpTimeout { role_id, at_ms } => {
                self.get_mut(&role_id)?.last_cdp_timeout_at_ms = Some(at_ms);
            }
            ExternalSessionCommand::Remove { role_id, .. } => {
                self.sessions.remove(&role_id);
            }
        }
        Ok(ExternalSessionResult {
            sessions: self.snapshot(),
        })
    }

    pub fn get(&self, role_id: &str) -> Option<&ExternalSessionRecord> {
        self.sessions.get(role_id)
    }

    pub fn workspace_has_sessions(&self, workspace_id: &str) -> bool {
        self.sessions
            .values()
            .any(|session| session.workspace_id.as_deref() == Some(workspace_id))
    }

    fn get_mut(&mut self, role_id: &str) -> CoreResult<&mut ExternalSessionRecord> {
        self.sessions.get_mut(role_id).ok_or_else(|| {
            domain(
                "EXTERNAL_SESSION_NOT_FOUND",
                "External Chrome role is not running.",
            )
        })
    }

    pub fn snapshot(&self) -> Vec<ExternalSessionRecord> {
        let mut sessions = self.sessions.values().cloned().collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.role.id.cmp(&right.role.id));
        sessions
    }
}

fn validate_bounds(bounds: &crate::model::StatePixelBoundsRecord) -> CoreResult<()> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return Err(domain(
            "EXTERNAL_BOUNDS_INVALID",
            "External Chrome bounds must have a positive size.",
        ));
    }
    Ok(())
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn command(value: serde_json::Value) -> ExternalSessionCommand {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn owns_external_session_transitions_health_and_diagnostics_state() {
        let mut runtime = ExternalSessionRuntime::default();
        let begin = runtime
            .invoke(command(json!({
                "type":"begin",
                "role":{
                    "id":"r1","gameId":"g1","name":"Main","launchUrl":"https://example.com",
                    "notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },
                "bounds":{"x":0,"y":0,"width":800,"height":600},
                "workspaceId":"w1","zoomFactor":1.0
            })))
            .unwrap();
        assert_eq!(begin.sessions[0].state, "launching");
        runtime
            .invoke(command(json!({
                "type":"setAutomation","roleId":"r1","available":true,"cdnActive":true
            })))
            .unwrap();
        runtime
            .invoke(command(json!({
                "type":"setHealth","roleId":"r1","health":"healthy","pageHidden":false
            })))
            .unwrap();
        let running = runtime
            .invoke(command(json!({
                "type":"setRunning","roleId":"r1","launchedAt":"2026-01-01T00:00:01Z"
            })))
            .unwrap();
        assert!(running.sessions[0].automation_available);
        assert!(running.sessions[0].cdn_active);
        assert_eq!(running.sessions[0].page_health.as_deref(), Some("healthy"));
    }

    #[test]
    fn rejects_duplicate_sessions_and_invalid_transitions_without_partial_mutation() {
        let mut runtime = ExternalSessionRuntime::default();
        let begin = json!({
            "type":"begin",
            "role":{
                "id":"r1","gameId":"g1","name":"Main","launchUrl":"https://example.com",
                "notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            },
            "bounds":{"x":0,"y":0,"width":800,"height":600},"zoomFactor":1.0
        });
        runtime.invoke(command(begin.clone())).unwrap();
        assert_eq!(
            runtime.invoke(command(begin)).unwrap_err().code(),
            "ROLE_ALREADY_RUNNING"
        );
        runtime
            .invoke(command(json!({"type":"setStopping","roleId":"r1"})))
            .unwrap();
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"setRunning","roleId":"r1","launchedAt":"later"
                })))
                .unwrap_err()
                .code(),
            "EXTERNAL_TRANSITION_INVALID"
        );
        assert_eq!(runtime.get("r1").unwrap().state, "stopping");
    }
}
