use std::{
    collections::HashMap,
    sync::Arc,
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crossbeam_channel::{Receiver, Sender, bounded, select, tick as channel_tick};
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{BrowserAction, BrowserActionRequest, BrowserActionResult, CoreEvent},
};

const COMMAND_CAPACITY: usize = 256;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_STALL: Duration = Duration::from_secs(15);
const PROBE_INTERVAL: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

enum Command {
    Register(String, Sender<CoreResult<()>>),
    Heartbeat(String, bool, Sender<CoreResult<()>>),
    Remove(String, Sender<CoreResult<()>>),
    Suspend(bool, Sender<CoreResult<()>>),
    Results(Vec<BrowserActionResult>),
    Shutdown(Sender<()>),
}

struct Session {
    health: &'static str,
    last_heartbeat: Instant,
    last_probe: Instant,
    page_hidden: bool,
}

pub struct ExternalHealthRuntime {
    sender: Sender<Command>,
    join: Option<JoinHandle<()>>,
}

impl ExternalHealthRuntime {
    pub fn new(emit: Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>) -> CoreResult<Self> {
        let (sender, receiver) = bounded(COMMAND_CAPACITY);
        let join = thread::Builder::new()
            .name("rion-external-health".to_owned())
            .spawn(move || run(receiver, emit))
            .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn register(&self, role_id: String) -> CoreResult<()> {
        request(&self.sender, |response| {
            Command::Register(role_id, response)
        })
    }

    pub fn heartbeat(&self, role_id: String, page_hidden: bool) -> CoreResult<()> {
        request(&self.sender, |response| {
            Command::Heartbeat(role_id, page_hidden, response)
        })
    }

    pub fn remove(&self, role_id: String) -> CoreResult<()> {
        request(&self.sender, |response| Command::Remove(role_id, response))
    }

    pub fn suspend(&self, suspended: bool) -> CoreResult<()> {
        request(&self.sender, |response| {
            Command::Suspend(suspended, response)
        })
    }

    pub fn dispatch_results(&self, results: Vec<BrowserActionResult>) {
        let _ = self.sender.try_send(Command::Results(results));
    }

    pub fn shutdown(&mut self) {
        let (response, receiver) = bounded(1);
        let _ = self.sender.send(Command::Shutdown(response));
        let _ = receiver.recv_timeout(Duration::from_secs(2));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for ExternalHealthRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn request(
    sender: &Sender<Command>,
    create: impl FnOnce(Sender<CoreResult<()>>) -> Command,
) -> CoreResult<()> {
    let (response, receiver) = bounded(1);
    sender
        .send(create(response))
        .map_err(|_| CoreError::ShuttingDown)?;
    receiver.recv().map_err(|_| CoreError::ShuttingDown)?
}

fn run(receiver: Receiver<Command>, emit: Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>) {
    let mut sessions = HashMap::<String, Session>::new();
    let mut pending = HashMap::<String, String>::new();
    let mut suspended = false;
    let ticker = channel_tick(HEARTBEAT_INTERVAL);
    loop {
        select! {
          recv(receiver) -> command => match command {
            Ok(Command::Register(role_id, response)) => {
                let now = Instant::now();
                sessions.insert(
                    role_id,
                    Session {
                        health: "healthy",
                        last_heartbeat: now,
                        last_probe: now.checked_sub(PROBE_INTERVAL).unwrap_or(now),
                        page_hidden: false,
                    },
                );
                let _ = response.send(Ok(()));
            }
            Ok(Command::Heartbeat(role_id, page_hidden, response)) => {
                let result = sessions.get_mut(&role_id).map_or_else(
                    || {
                        Err(CoreError::ExternalChrome(
                            "health role is not registered".to_owned(),
                        ))
                    },
                    |session| {
                        session.last_heartbeat = Instant::now();
                        session.page_hidden = page_hidden;
                        if session.health != "healthy" {
                            session.health = "healthy";
                            emit(vec![CoreEvent::ExternalHealthChanged {
                                role_id: role_id.clone(),
                                health: "healthy".to_owned(),
                            }]);
                        }
                        Ok(())
                    },
                );
                let _ = response.send(result);
            }
            Ok(Command::Remove(role_id, response)) => {
                sessions.remove(&role_id);
                pending.retain(|_, pending_role_id| pending_role_id != &role_id);
                let _ = response.send(Ok(()));
            }
            Ok(Command::Suspend(value, response)) => {
                suspended = value;
                if !suspended {
                    let now = Instant::now();
                    for session in sessions.values_mut() {
                        session.last_heartbeat = now;
                    }
                }
                let _ = response.send(Ok(()));
            }
            Ok(Command::Results(results)) => handle_results(results, &mut pending, &emit),
            Ok(Command::Shutdown(response)) => {
                let _ = response.send(());
                break;
            }
            Err(_) => break,
          },
          recv(ticker) -> _ => {
            if !suspended {
                tick(&mut sessions, &mut pending, &emit);
            }
          }
        }
    }
}

fn tick(
    sessions: &mut HashMap<String, Session>,
    pending: &mut HashMap<String, String>,
    emit: &Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>,
) {
    let now = Instant::now();
    let mut events = Vec::new();
    let mut actions = Vec::new();
    for (role_id, session) in sessions.iter_mut() {
        if !session.page_hidden
            && session.health == "healthy"
            && now.duration_since(session.last_heartbeat) >= HEARTBEAT_STALL
        {
            session.health = "unresponsive";
            events.push(CoreEvent::ExternalHealthChanged {
                role_id: role_id.clone(),
                health: "unresponsive".to_owned(),
            });
        }
        if now.duration_since(session.last_probe) >= PROBE_INTERVAL {
            session.last_probe = now;
            let request_id = format!("external-health:{}", Uuid::new_v4());
            pending.insert(request_id.clone(), role_id.clone());
            actions.push(BrowserActionRequest {
                request_id,
                role_id: role_id.clone(),
                origin: "external_health".to_owned(),
                scheduled_at_ms: epoch_ms(),
                deadline_ms: epoch_ms().saturating_add(PROBE_TIMEOUT.as_millis() as u64),
                action: BrowserAction::Evaluate {
                    source: "void 0".to_owned(),
                },
            });
        }
    }
    if !actions.is_empty() {
        events.push(CoreEvent::BrowserActions { actions });
    }
    if !events.is_empty() {
        emit(events);
    }
}

fn handle_results(
    results: Vec<BrowserActionResult>,
    pending: &mut HashMap<String, String>,
    emit: &Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>,
) {
    let mut events = Vec::new();
    for result in results {
        let Some(role_id) = pending.remove(&result.request_id) else {
            continue;
        };
        if !result.ok {
            events.push(CoreEvent::ExternalHealthProbeFailed {
                role_id,
                error_code: result
                    .error_code
                    .unwrap_or_else(|| "BROWSER_ACTION_FAILED".to_owned()),
                error_message: result
                    .error_message
                    .unwrap_or_else(|| "External Chrome health probe failed".to_owned()),
            });
        }
    }
    if !events.is_empty() {
        emit(events);
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn tick_marks_visible_stalled_roles_and_batches_a_probe() {
        let now = Instant::now();
        let mut sessions = HashMap::from([(
            "role-1".to_owned(),
            Session {
                health: "healthy",
                last_heartbeat: now.checked_sub(HEARTBEAT_STALL).unwrap(),
                last_probe: now.checked_sub(PROBE_INTERVAL).unwrap(),
                page_hidden: false,
            },
        )]);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&captured);
        let emit: Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync> = Arc::new(move |events| {
            output.lock().unwrap().extend(events);
        });
        let mut pending = HashMap::new();

        tick(&mut sessions, &mut pending, &emit);

        let events = captured.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            CoreEvent::ExternalHealthChanged { health, .. } if health == "unresponsive"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            CoreEvent::BrowserActions { actions } if actions.len() == 1
        )));
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn hidden_roles_are_probed_but_never_marked_unresponsive() {
        let now = Instant::now();
        let mut sessions = HashMap::from([(
            "role-1".to_owned(),
            Session {
                health: "healthy",
                last_heartbeat: now.checked_sub(HEARTBEAT_STALL).unwrap(),
                last_probe: now.checked_sub(PROBE_INTERVAL).unwrap(),
                page_hidden: true,
            },
        )]);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&captured);
        let emit: Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync> = Arc::new(move |events| {
            output.lock().unwrap().extend(events);
        });

        tick(&mut sessions, &mut HashMap::new(), &emit);

        assert!(
            !captured
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, CoreEvent::ExternalHealthChanged { .. }))
        );
    }
}
