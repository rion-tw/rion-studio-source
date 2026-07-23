use std::{
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, bounded};
use serde::Deserialize;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        CoreEffectAction, CoreEffectTarget, CoreEvent, ResourceRuntimeCommand,
        ResourceRuntimeEffectRecord, ResourceRuntimeResult,
    },
    operation_actor::{OperationActor, OperationEffect, OperationPlan, OperationStep},
    resource_runtime::ResourceRuntime,
};

const COMMAND_CAPACITY: usize = 256;
const EFFECT_TIMEOUT: Duration = Duration::from_secs(10);

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;

enum Command {
    Invoke(
        ResourceRuntimeCommand,
        Sender<CoreResult<ResourceRuntimeResult>>,
    ),
    Enqueue(ResourceRuntimeCommand),
    Shutdown(Sender<()>),
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceEffectResult {
    #[serde(default)]
    unavailable_role_ids: Vec<String>,
}

pub struct ResourceController {
    sender: Sender<Command>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl ResourceController {
    pub fn start(operation_actor: Arc<OperationActor>, events: EventSink) -> CoreResult<Self> {
        let (sender, receiver) = bounded(COMMAND_CAPACITY);
        let join = thread::Builder::new()
            .name("rion-resource-controller".to_owned())
            .spawn(move || run(receiver, operation_actor, events))
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(Self {
            sender,
            join: Mutex::new(Some(join)),
        })
    }

    pub fn invoke(&self, command: ResourceRuntimeCommand) -> CoreResult<ResourceRuntimeResult> {
        let (response, receiver) = bounded(1);
        self.sender
            .send(Command::Invoke(command, response))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn enqueue(&self, command: ResourceRuntimeCommand) -> CoreResult<()> {
        self.sender
            .try_send(Command::Enqueue(command))
            .map_err(|error| match error {
                crossbeam_channel::TrySendError::Full(_) => CoreError::Domain {
                    code: "RESOURCE_COMMAND_BACKPRESSURE",
                    message: "The resource command queue is full.".to_owned(),
                },
                crossbeam_channel::TrySendError::Disconnected(_) => CoreError::ShuttingDown,
            })
    }

    pub fn snapshot(&self) -> CoreResult<ResourceRuntimeResult> {
        self.invoke(ResourceRuntimeCommand::Snapshot)
    }

    pub fn shutdown(&self) {
        let mut join = match self.join.lock() {
            Ok(join) => join,
            Err(_) => return,
        };
        let Some(worker) = join.take() else {
            return;
        };
        let (response, receiver) = bounded(1);
        let _ = self.sender.send(Command::Shutdown(response));
        let _ = receiver.recv_timeout(Duration::from_secs(2));
        let _ = worker.join();
    }
}

impl Drop for ResourceController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run(receiver: Receiver<Command>, actor: Arc<OperationActor>, events: EventSink) {
    let mut runtime = ResourceRuntime::default();
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Invoke(command, response) => {
                let _ = response.send(apply(&mut runtime, &actor, &events, command));
            }
            Command::Enqueue(command) => {
                let _ = apply(&mut runtime, &actor, &events, command);
            }
            Command::Shutdown(response) => {
                let release = runtime
                    .invoke(ResourceRuntimeCommand::ReconcileRuntimeRoleIds {
                        runtime_mode: "embedded".to_owned(),
                        active_role_ids: Vec::new(),
                    })
                    .ok();
                if let Some(result) = release {
                    let _ = execute_effects(&actor, result.effects);
                }
                let _ = response.send(());
                break;
            }
        }
    }
}

fn apply(
    runtime: &mut ResourceRuntime,
    actor: &OperationActor,
    events: &EventSink,
    command: ResourceRuntimeCommand,
) -> CoreResult<ResourceRuntimeResult> {
    let emit_statuses = !matches!(&command, ResourceRuntimeCommand::Snapshot);
    let mut result = runtime.invoke(command)?;
    if !result.effects.is_empty() {
        let unavailable_role_ids = execute_effects(actor, result.effects.clone())?;
        if !unavailable_role_ids.is_empty() {
            let fallback = runtime.invoke(ResourceRuntimeCommand::SetUnavailableRoleIds {
                role_ids: unavailable_role_ids,
            })?;
            let _ = execute_effects(actor, fallback.effects.clone());
            result = fallback;
        }
    }
    if emit_statuses {
        events(vec![CoreEvent::ResourceStatuses {
            statuses: result.statuses.clone(),
        }]);
    }
    Ok(result)
}

fn execute_effects(
    actor: &OperationActor,
    effects: Vec<ResourceRuntimeEffectRecord>,
) -> CoreResult<Vec<String>> {
    if effects.is_empty() {
        return Ok(Vec::new());
    }
    let handle = actor.start(OperationPlan {
        steps: vec![OperationStep {
            effect: OperationEffect {
                target: CoreEffectTarget {
                    kind: "app".to_owned(),
                    handle_id: "resource-runtime".to_owned(),
                },
                action: CoreEffectAction::EmbeddedApplyResourceEffects { effects },
                timeout: EFFECT_TIMEOUT,
            },
            compensation: None,
        }],
    })?;
    let outcome = handle
        .outcome
        .blocking_recv()
        .map_err(|_| CoreError::Internal("resource effect operation stopped".to_owned()))?;
    if let Some(error) = outcome.error {
        return Err(CoreError::Effect {
            code: error.code,
            message: error.message,
        });
    }
    let value = outcome
        .results
        .last()
        .and_then(|result| result.value_json.as_deref())
        .unwrap_or("{}");
    serde_json::from_str::<ResourceEffectResult>(value)
        .map(|result| result.unavailable_role_ids)
        .map_err(|error| CoreError::Internal(format!("resource effect result is invalid: {error}")))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use crate::{
        model::{CoreEffectRequest, CoreEffectResult, ResourceRuntimeTargetRecord},
        operation_actor::OperationActor,
    };

    use super::*;

    #[test]
    fn serializes_resource_commands_and_fails_open_after_effect_errors() {
        let (effect_sender, effect_receiver) = mpsc::channel::<Vec<CoreEffectRequest>>();
        let actor = Arc::new(OperationActor::new(Arc::new(move |effects| {
            effect_sender.send(effects).unwrap();
        })));
        let captured = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&captured);
        let controller = Arc::new(
            ResourceController::start(
                Arc::clone(&actor),
                Arc::new(move |events| output.lock().unwrap().extend(events)),
            )
            .unwrap(),
        );
        controller
            .invoke(ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                workspace_ids: vec!["workspace-1".to_owned()],
            })
            .unwrap();
        let invoking = Arc::clone(&controller);
        let operation = thread::spawn(move || {
            invoking.invoke(ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id: "workspace-1".to_owned(),
                policy_mode: "adaptive".to_owned(),
                targets: vec![ResourceRuntimeTargetRecord {
                    role_id: "role-1".to_owned(),
                    runtime_mode: "embedded".to_owned(),
                    process_id: Some(42),
                }],
            })
        });

        let request = effect_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        actor
            .dispatch_results(vec![CoreEffectResult {
                effect_id: request.effect_id.clone(),
                operation_id: request.operation_id.clone(),
                ok: true,
                value_json: Some(serde_json::json!({"unavailableRoleIds":["role-1"]}).to_string()),
                error: None,
            }])
            .unwrap();
        let fallback = effect_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        actor
            .dispatch_results(vec![CoreEffectResult {
                effect_id: fallback.effect_id,
                operation_id: fallback.operation_id,
                ok: true,
                value_json: Some(serde_json::json!({"unavailableRoleIds":[]}).to_string()),
                error: None,
            }])
            .unwrap();

        let result = operation.join().unwrap().unwrap();
        assert_eq!(result.statuses[0].resource_state, "unavailable");
        assert!(captured.lock().unwrap().iter().any(|event| matches!(
            event,
            CoreEvent::ResourceStatuses { statuses }
                if statuses.first().is_some_and(|status| status.resource_state == "unavailable")
        )));
        actor.shutdown();
        controller.shutdown();
    }
}
