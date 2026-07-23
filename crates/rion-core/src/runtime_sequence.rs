use std::sync::{Condvar, Mutex};

use crate::error::{CoreError, CoreResult};

#[derive(Default)]
pub struct RuntimeOperationSequence {
    state: Mutex<SequenceState>,
    ready: Condvar,
}

#[derive(Default)]
struct SequenceState {
    next_ticket: u64,
    serving_ticket: u64,
}

pub struct RuntimeOperationPermit<'a> {
    sequence: &'a RuntimeOperationSequence,
}

impl RuntimeOperationSequence {
    pub fn acquire(&self) -> CoreResult<RuntimeOperationPermit<'_>> {
        let ticket = {
            let mut state = self.state()?;
            let ticket = state.next_ticket;
            state.next_ticket = state.next_ticket.wrapping_add(1);
            ticket
        };
        let mut state = self.state()?;
        while state.serving_ticket != ticket {
            state = self.ready.wait(state).map_err(|_| {
                CoreError::Internal("runtime operation sequence poisoned".to_owned())
            })?;
        }
        drop(state);
        Ok(RuntimeOperationPermit { sequence: self })
    }

    fn state(&self) -> CoreResult<std::sync::MutexGuard<'_, SequenceState>> {
        self.state
            .lock()
            .map_err(|_| CoreError::Internal("runtime operation sequence poisoned".to_owned()))
    }
}

impl Drop for RuntimeOperationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.sequence.state.lock() {
            state.serving_ticket = state.serving_ticket.wrapping_add(1);
            self.sequence.ready.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use super::*;

    #[test]
    fn serializes_operations_without_holding_the_state_mutex() {
        let sequence = Arc::new(RuntimeOperationSequence::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = {
            let sequence = Arc::clone(&sequence);
            let order = Arc::clone(&order);
            thread::spawn(move || {
                let _permit = sequence.acquire().unwrap();
                order.lock().unwrap().push("first-start");
                thread::sleep(Duration::from_millis(20));
                order.lock().unwrap().push("first-end");
            })
        };
        thread::sleep(Duration::from_millis(5));
        let second = {
            let sequence = Arc::clone(&sequence);
            let order = Arc::clone(&order);
            thread::spawn(move || {
                let _permit = sequence.acquire().unwrap();
                order.lock().unwrap().push("second");
            })
        };
        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            ["first-start", "first-end", "second"]
        );
    }
}
