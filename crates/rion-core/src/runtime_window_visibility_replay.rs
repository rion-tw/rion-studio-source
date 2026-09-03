use std::{
    collections::{HashMap, VecDeque},
    sync::{Condvar, Mutex},
};

use crate::{CoreError, CoreErrorPayload, CoreResult};

const RETAINED_TERMINAL_VISIBILITY_REPLAYS: usize = 512;

#[derive(Clone)]
struct ActiveReplay {
    fingerprint: String,
}

#[derive(Clone)]
struct TerminalReplay<T> {
    fingerprint: String,
    result: Result<T, CoreErrorPayload>,
}

struct ReplayState<T> {
    active: HashMap<String, ActiveReplay>,
    terminal: HashMap<String, TerminalReplay<T>>,
    terminal_order: VecDeque<String>,
}

impl<T> Default for ReplayState<T> {
    fn default() -> Self {
        Self {
            active: HashMap::new(),
            terminal: HashMap::new(),
            terminal_order: VecDeque::new(),
        }
    }
}

pub(crate) struct RuntimeWindowVisibilityReplay<T> {
    state: Mutex<ReplayState<T>>,
    terminal_changed: Condvar,
}

impl<T> Default for RuntimeWindowVisibilityReplay<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(ReplayState::default()),
            terminal_changed: Condvar::new(),
        }
    }
}

pub(crate) enum VisibilityReplayAdmission<'a, T> {
    Owner(VisibilityReplayOwner<'a, T>),
    Join,
    Terminal(Result<T, CoreErrorPayload>),
}

pub(crate) struct VisibilityReplayOwner<'a, T> {
    coordinator: &'a RuntimeWindowVisibilityReplay<T>,
    operation_id: String,
    fingerprint: String,
    finished: bool,
}

fn replay_error(code: &str, message: &str) -> CoreError {
    CoreError::Effect {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

pub(crate) fn visibility_replay_result<T>(result: Result<T, CoreErrorPayload>) -> CoreResult<T> {
    result.map_err(|error| CoreError::Effect {
        code: error.code,
        message: error.message,
    })
}

impl<T: Clone> RuntimeWindowVisibilityReplay<T> {
    pub(crate) fn admit(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<VisibilityReplayAdmission<'_, T>> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("runtime-window visibility replay ledger poisoned".to_owned())
        })?;
        if let Some(entry) = state.terminal.get(operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(replay_error(
                    "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED",
                    "A runtime-window visibility identity was reused for different work.",
                ));
            }
            return Ok(VisibilityReplayAdmission::Terminal(entry.result.clone()));
        }
        if let Some(entry) = state.active.get(operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(replay_error(
                    "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED",
                    "A runtime-window visibility identity was reused for different work.",
                ));
            }
            return Ok(VisibilityReplayAdmission::Join);
        }
        state.active.insert(
            operation_id.to_owned(),
            ActiveReplay {
                fingerprint: fingerprint.to_owned(),
            },
        );
        Ok(VisibilityReplayAdmission::Owner(VisibilityReplayOwner {
            coordinator: self,
            operation_id: operation_id.to_owned(),
            fingerprint: fingerprint.to_owned(),
            finished: false,
        }))
    }

    pub(crate) fn wait_terminal(&self, operation_id: &str, fingerprint: &str) -> CoreResult<T> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("runtime-window visibility replay ledger poisoned".to_owned())
        })?;
        loop {
            if let Some(entry) = state.terminal.get(operation_id) {
                if entry.fingerprint != fingerprint {
                    return Err(replay_error(
                        "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED",
                        "A runtime-window visibility identity was reused for different work.",
                    ));
                }
                return visibility_replay_result(entry.result.clone());
            }
            let Some(entry) = state.active.get(operation_id) else {
                return Err(replay_error(
                    "RUNTIME_WINDOW_VISIBILITY_REPLAY_LOST",
                    "A joined visibility operation ended without a terminal result.",
                ));
            };
            if entry.fingerprint != fingerprint {
                return Err(replay_error(
                    "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED",
                    "A runtime-window visibility identity was reused for different work.",
                ));
            }
            state = self.terminal_changed.wait(state).map_err(|_| {
                CoreError::Internal("runtime-window visibility replay ledger poisoned".to_owned())
            })?;
        }
    }

    fn finish(
        &self,
        operation_id: &str,
        fingerprint: &str,
        result: Result<T, CoreErrorPayload>,
    ) -> CoreResult<()> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("runtime-window visibility replay ledger poisoned".to_owned())
        })?;
        let active = state.active.get(operation_id).ok_or_else(|| {
            replay_error(
                "RUNTIME_WINDOW_VISIBILITY_REPLAY_LOST",
                "The visibility owner lost its active replay identity.",
            )
        })?;
        if active.fingerprint != fingerprint {
            return Err(replay_error(
                "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED",
                "A runtime-window visibility identity was reused for different work.",
            ));
        }
        state.active.remove(operation_id);
        if !state.terminal.contains_key(operation_id) {
            state.terminal_order.push_back(operation_id.to_owned());
        }
        state.terminal.insert(
            operation_id.to_owned(),
            TerminalReplay {
                fingerprint: fingerprint.to_owned(),
                result,
            },
        );
        while state.terminal_order.len() > RETAINED_TERMINAL_VISIBILITY_REPLAYS {
            if let Some(expired) = state.terminal_order.pop_front() {
                state.terminal.remove(&expired);
            }
        }
        self.terminal_changed.notify_all();
        Ok(())
    }
}

impl<T: Clone> VisibilityReplayOwner<'_, T> {
    pub(crate) fn finish(mut self, result: Result<T, CoreErrorPayload>) -> CoreResult<()> {
        self.coordinator
            .finish(&self.operation_id, &self.fingerprint, result)?;
        self.finished = true;
        Ok(())
    }
}

impl<T> Drop for VisibilityReplayOwner<'_, T> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut state) = self.coordinator.state.lock()
            && state
                .active
                .get(&self.operation_id)
                .is_some_and(|entry| entry.fingerprint == self.fingerprint)
        {
            state.active.remove(&self.operation_id);
            self.coordinator.terminal_changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn duplicate_joins_one_owner_and_replays_the_exact_terminal_value() {
        let coordinator = Arc::new(RuntimeWindowVisibilityReplay::default());
        let owner = match coordinator.admit("operation-1", "hide:window-1").unwrap() {
            VisibilityReplayAdmission::Owner(owner) => owner,
            _ => panic!("first admission must own the operation"),
        };
        assert!(matches!(
            coordinator.admit("operation-1", "hide:window-1").unwrap(),
            VisibilityReplayAdmission::Join
        ));
        owner.finish(Ok("superseded".to_owned())).unwrap();
        assert_eq!(
            coordinator
                .wait_terminal("operation-1", "hide:window-1")
                .unwrap(),
            "superseded"
        );
        assert!(matches!(
            coordinator.admit("operation-1", "hide:window-1").unwrap(),
            VisibilityReplayAdmission::Terminal(Ok(value)) if value == "superseded"
        ));
    }

    #[test]
    fn active_identity_reuse_fails_without_replacing_the_owner() {
        let coordinator = RuntimeWindowVisibilityReplay::<String>::default();
        let owner = match coordinator.admit("operation-1", "hide:window-1").unwrap() {
            VisibilityReplayAdmission::Owner(owner) => owner,
            _ => panic!("first admission must own the operation"),
        };
        let reused = match coordinator.admit("operation-1", "show:window-1") {
            Err(error) => error,
            Ok(_) => panic!("a different active fingerprint must be rejected"),
        };
        assert_eq!(
            reused.code(),
            "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED"
        );
        owner.finish(Ok("applied".to_owned())).unwrap();
    }

    #[test]
    fn dropped_owner_wakes_joiners_without_inventing_a_terminal_receipt() {
        let coordinator = Arc::new(RuntimeWindowVisibilityReplay::<String>::default());
        let owner = match coordinator.admit("operation-1", "hide:window-1").unwrap() {
            VisibilityReplayAdmission::Owner(owner) => owner,
            _ => panic!("first admission must own the operation"),
        };
        let joiner = {
            let coordinator = Arc::clone(&coordinator);
            std::thread::spawn(move || coordinator.wait_terminal("operation-1", "hide:window-1"))
        };
        drop(owner);
        assert_eq!(
            joiner.join().unwrap().unwrap_err().code(),
            "RUNTIME_WINDOW_VISIBILITY_REPLAY_LOST"
        );
    }
}
