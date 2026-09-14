use crate::error::{CoreError, CoreResult};
use std::{
    collections::{HashSet, VecDeque},
    sync::{Condvar, Mutex},
};

#[derive(Default)]
pub(crate) struct RuntimeScopedSequence {
    state: Mutex<State>,
    ready: Condvar,
}

#[derive(Default)]
struct State {
    next: u64,
    active: HashSet<String>,
    pending: VecDeque<(u64, HashSet<String>)>,
}

pub(crate) struct RuntimeScopedPermit<'a> {
    sequence: &'a RuntimeScopedSequence,
    scopes: HashSet<String>,
}

impl RuntimeScopedSequence {
    /// Orders overlapping mutations without blocking an unrelated native host.
    pub(crate) fn acquire(&self, scopes: Vec<String>) -> CoreResult<RuntimeScopedPermit<'_>> {
        let scopes: HashSet<_> = scopes.into_iter().collect();
        if scopes.is_empty() {
            return Err(CoreError::InvalidInput(
                "An event needs an exact window scope.".into(),
            ));
        }
        let mut state = self.state.lock().map_err(|_| poisoned())?;
        let ticket = state.next;
        state.next = state.next.wrapping_add(1);
        state.pending.push_back((ticket, scopes.clone()));
        loop {
            let blocked = !state.active.is_disjoint(&scopes)
                || state
                    .pending
                    .iter()
                    .take_while(|(id, _)| *id != ticket)
                    .any(|(_, prior)| !prior.is_disjoint(&scopes));
            if !blocked {
                break;
            }
            state = self.ready.wait(state).map_err(|_| poisoned())?;
        }
        state.pending.retain(|(id, _)| *id != ticket);
        state.active.extend(scopes.iter().cloned());
        Ok(RuntimeScopedPermit {
            sequence: self,
            scopes,
        })
    }
}

fn poisoned() -> CoreError {
    CoreError::Internal("Runtime scoped sequence poisoned".into())
}

impl Drop for RuntimeScopedPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.sequence.state.lock() {
            state.active.retain(|scope| !self.scopes.contains(scope));
            self.sequence.ready.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_window_can_complete_while_another_is_held() {
        let sequence = RuntimeScopedSequence::default();
        let first = sequence.acquire(vec!["a".into()]).unwrap();
        let independent = sequence.acquire(vec!["b".into()]).unwrap();
        drop(independent);
        drop(first);
        let both = sequence.acquire(vec!["b".into(), "a".into()]).unwrap();
        drop(both);
    }
}
