use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Condvar, Mutex},
};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{BrowserOperationLease, BrowserOperationRequest},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationKind {
    Normal,
    RecoverableMutation,
    DestructiveMutation,
}

impl OperationKind {
    fn parse(value: &str) -> CoreResult<Self> {
        match value {
            "normal" => Ok(Self::Normal),
            "recoverableMutation" => Ok(Self::RecoverableMutation),
            "destructiveMutation" => Ok(Self::DestructiveMutation),
            _ => Err(domain(
                "BROWSER_OPERATION_KIND_INVALID",
                "Browser operation kind is invalid.",
            )),
        }
    }
}

#[derive(Debug)]
struct OperationTicket {
    kind: OperationKind,
    role_ids: Vec<String>,
    queued_versions: HashMap<String, u64>,
}

#[derive(Default)]
struct CoordinatorState {
    blocked_role_ids: HashSet<String>,
    queues: HashMap<String, VecDeque<String>>,
    role_versions: HashMap<String, u64>,
    shutting_down: bool,
    tickets: HashMap<String, OperationTicket>,
}

#[derive(Default)]
pub struct BrowserOperationCoordinator {
    changed: Condvar,
    state: Mutex<CoordinatorState>,
}

impl BrowserOperationCoordinator {
    pub fn acquire(&self, request: BrowserOperationRequest) -> CoreResult<BrowserOperationLease> {
        let kind = OperationKind::parse(&request.kind)?;
        let mut role_ids = request
            .role_ids
            .into_iter()
            .filter(|role_id| !role_id.trim().is_empty())
            .collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        if role_ids.is_empty() {
            return Err(domain(
                "BROWSER_OPERATION_ROLES_REQUIRED",
                "Browser operation requires at least one role.",
            ));
        }

        let id = Uuid::new_v4().to_string();
        let mut state = self
            .state
            .lock()
            .map_err(|_| CoreError::Internal("browser operation lock poisoned".to_owned()))?;
        if state.shutting_down {
            return Err(CoreError::ShuttingDown);
        }
        let queued_versions = role_ids
            .iter()
            .map(|role_id| {
                (
                    role_id.clone(),
                    state
                        .role_versions
                        .get(role_id)
                        .copied()
                        .unwrap_or_default(),
                )
            })
            .collect();
        state.tickets.insert(
            id.clone(),
            OperationTicket {
                kind,
                role_ids: role_ids.clone(),
                queued_versions,
            },
        );
        for role_id in &role_ids {
            state
                .queues
                .entry(role_id.clone())
                .or_default()
                .push_back(id.clone());
        }

        loop {
            if state.shutting_down {
                Self::remove_ticket(&mut state, &id);
                self.changed.notify_all();
                return Err(CoreError::ShuttingDown);
            }
            let is_ready = role_ids.iter().all(|role_id| {
                state
                    .queues
                    .get(role_id)
                    .and_then(|queue| queue.front())
                    .is_some_and(|candidate| candidate == &id)
            });
            if !is_ready {
                state = self.changed.wait(state).map_err(|_| {
                    CoreError::Internal("browser operation lock poisoned".to_owned())
                })?;
                continue;
            }

            if role_ids
                .iter()
                .any(|role_id| state.blocked_role_ids.contains(role_id))
            {
                Self::remove_ticket(&mut state, &id);
                self.changed.notify_all();
                return Err(domain(
                    "ROLE_MUTATION_BLOCKED",
                    "Role is blocked by a destructive mutation.",
                ));
            }
            let ticket = state.tickets.get(&id).expect("queued ticket exists");
            if ticket.kind == OperationKind::Normal
                && ticket.role_ids.iter().any(|role_id| {
                    state
                        .role_versions
                        .get(role_id)
                        .copied()
                        .unwrap_or_default()
                        != ticket
                            .queued_versions
                            .get(role_id)
                            .copied()
                            .unwrap_or_default()
                })
            {
                Self::remove_ticket(&mut state, &id);
                self.changed.notify_all();
                return Err(domain(
                    "ROLE_DATA_CHANGED",
                    "Role data changed while the operation was queued.",
                ));
            }
            match kind {
                OperationKind::Normal => {}
                OperationKind::RecoverableMutation => {
                    for role_id in &role_ids {
                        *state.role_versions.entry(role_id.clone()).or_default() += 1;
                    }
                }
                OperationKind::DestructiveMutation => {
                    state.blocked_role_ids.extend(role_ids.iter().cloned());
                }
            }
            return Ok(BrowserOperationLease { id, role_ids });
        }
    }

    pub fn complete(&self, id: &str) -> CoreResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CoreError::Internal("browser operation lock poisoned".to_owned()))?;
        if !state.tickets.contains_key(id) {
            return Err(domain(
                "BROWSER_OPERATION_NOT_FOUND",
                "Browser operation lease was not found.",
            ));
        }
        Self::remove_ticket(&mut state, id);
        self.changed.notify_all();
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.shutting_down = true;
            self.changed.notify_all();
        }
    }

    fn remove_ticket(state: &mut CoordinatorState, id: &str) {
        let Some(ticket) = state.tickets.remove(id) else {
            return;
        };
        for role_id in ticket.role_ids {
            if let Some(queue) = state.queues.get_mut(&role_id) {
                queue.retain(|candidate| candidate != id);
                if queue.is_empty() {
                    state.queues.remove(&role_id);
                }
            }
        }
    }
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread, time::Duration};

    use super::*;

    fn request(role_ids: &[&str], kind: &str) -> BrowserOperationRequest {
        BrowserOperationRequest {
            role_ids: role_ids.iter().map(|value| (*value).to_owned()).collect(),
            kind: kind.to_owned(),
        }
    }

    #[test]
    fn orders_overlapping_roles_but_allows_disjoint_roles() {
        let coordinator = Arc::new(BrowserOperationCoordinator::default());
        let first = coordinator.acquire(request(&["r1"], "normal")).unwrap();
        let waiting = Arc::clone(&coordinator);
        let thread = thread::spawn(move || waiting.acquire(request(&["r1", "r2"], "normal")));
        thread::sleep(Duration::from_millis(10));
        let disjoint = coordinator.acquire(request(&["r3"], "normal")).unwrap();
        coordinator.complete(&disjoint.id).unwrap();
        coordinator.complete(&first.id).unwrap();
        let second = thread.join().unwrap().unwrap();
        coordinator.complete(&second.id).unwrap();
    }

    #[test]
    fn rejects_stale_operations_and_permanently_blocks_destructive_roles() {
        let coordinator = Arc::new(BrowserOperationCoordinator::default());
        let first = coordinator.acquire(request(&["r1"], "normal")).unwrap();
        let mutating = Arc::clone(&coordinator);
        let mutation =
            thread::spawn(move || mutating.acquire(request(&["r1"], "recoverableMutation")));
        while coordinator
            .state
            .lock()
            .unwrap()
            .queues
            .get("r1")
            .map_or(0, VecDeque::len)
            < 2
        {
            thread::yield_now();
        }
        let waiting = Arc::clone(&coordinator);
        let stale = thread::spawn(move || waiting.acquire(request(&["r1"], "normal")));
        while coordinator
            .state
            .lock()
            .unwrap()
            .queues
            .get("r1")
            .map_or(0, VecDeque::len)
            < 3
        {
            thread::yield_now();
        }
        coordinator.complete(&first.id).unwrap();
        let mutation = mutation.join().unwrap().unwrap();
        coordinator.complete(&mutation.id).unwrap();
        assert_eq!(
            stale.join().unwrap().unwrap_err().code(),
            "ROLE_DATA_CHANGED"
        );

        let destructive = coordinator
            .acquire(request(&["r2"], "destructiveMutation"))
            .unwrap();
        coordinator.complete(&destructive.id).unwrap();
        assert_eq!(
            coordinator
                .acquire(request(&["r2"], "normal"))
                .unwrap_err()
                .code(),
            "ROLE_MUTATION_BLOCKED"
        );
    }

    #[test]
    fn shutdown_releases_waiters() {
        let coordinator = Arc::new(BrowserOperationCoordinator::default());
        let first = coordinator.acquire(request(&["r1"], "normal")).unwrap();
        let waiting = Arc::clone(&coordinator);
        let thread = thread::spawn(move || waiting.acquire(request(&["r1"], "normal")));
        thread::sleep(Duration::from_millis(10));
        coordinator.shutdown();
        assert_eq!(
            thread.join().unwrap().unwrap_err().code(),
            "CORE_SHUTTING_DOWN"
        );
        assert!(coordinator.complete(&first.id).is_ok());
    }
}
