use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender, bounded};
use tokio::sync::oneshot;

use crate::error::{CoreError, CoreResult};

const MAX_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

type WaitResponse = oneshot::Sender<CoreResult<()>>;

enum Request {
    Schedule {
        duration: Duration,
        id: String,
        response: WaitResponse,
    },
    Cancel(String),
    Shutdown(Sender<()>),
}

pub struct MonotonicScheduler {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl MonotonicScheduler {
    pub fn start() -> CoreResult<Self> {
        let (sender, receiver) = bounded(512);
        let join = thread::Builder::new()
            .name("rion-monotonic-scheduler".to_owned())
            .spawn(move || run_scheduler(receiver))
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn schedule(
        &self,
        id: String,
        duration_ms: u32,
    ) -> CoreResult<oneshot::Receiver<CoreResult<()>>> {
        if id.trim().is_empty() || id.len() > 200 {
            return Err(CoreError::InvalidInput(
                "scheduled wait id is invalid".to_owned(),
            ));
        }
        let duration = Duration::from_millis(u64::from(duration_ms));
        if duration > MAX_WAIT {
            return Err(CoreError::InvalidInput(
                "scheduled wait duration is too large".to_owned(),
            ));
        }
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(Request::Schedule {
                duration,
                id,
                response,
            })
            .map_err(|_| CoreError::ShuttingDown)?;
        Ok(receiver)
    }

    pub fn cancel(&self, id: String) -> CoreResult<()> {
        self.sender
            .send(Request::Cancel(id))
            .map_err(|_| CoreError::ShuttingDown)
    }

    pub fn shutdown(&mut self) {
        let (sender, receiver) = bounded(1);
        let _ = self.sender.send(Request::Shutdown(sender));
        let _ = receiver.recv_timeout(Duration::from_secs(3));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for MonotonicScheduler {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_scheduler(receiver: Receiver<Request>) {
    let mut generation = 0_u64;
    let mut deadlines = BinaryHeap::<Reverse<(Instant, u64, String)>>::new();
    let mut pending = HashMap::<String, (u64, WaitResponse)>::new();
    loop {
        resolve_expired(&mut deadlines, &mut pending);
        let timeout = deadlines
            .peek()
            .map(|Reverse((deadline, _, _))| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));
        match receiver.recv_timeout(timeout) {
            Ok(Request::Schedule {
                duration,
                id,
                response,
            }) => {
                generation = generation.wrapping_add(1);
                if let Some((_, previous)) = pending.remove(&id) {
                    let _ = previous.send(Err(CoreError::WaitCancelled));
                }
                let deadline = Instant::now() + duration;
                deadlines.push(Reverse((deadline, generation, id.clone())));
                pending.insert(id, (generation, response));
            }
            Ok(Request::Cancel(id)) => {
                if let Some((_, response)) = pending.remove(&id) {
                    let _ = response.send(Err(CoreError::WaitCancelled));
                }
            }
            Ok(Request::Shutdown(response)) => {
                for (_, (_, wait)) in pending.drain() {
                    let _ = wait.send(Err(CoreError::ShuttingDown));
                }
                let _ = response.send(());
                break;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn resolve_expired(
    deadlines: &mut BinaryHeap<Reverse<(Instant, u64, String)>>,
    pending: &mut HashMap<String, (u64, WaitResponse)>,
) {
    let now = Instant::now();
    while deadlines
        .peek()
        .is_some_and(|Reverse((deadline, _, _))| *deadline <= now)
    {
        let Reverse((_, generation, id)) = deadlines.pop().unwrap();
        if pending
            .get(&id)
            .is_some_and(|(current, _)| *current == generation)
            && let Some((_, response)) = pending.remove(&id)
        {
            let _ = response.send(Ok(()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_and_cancels_monotonic_waits() {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async {
                let mut scheduler = MonotonicScheduler::start().unwrap();
                scheduler
                    .schedule("immediate".to_owned(), 0)
                    .unwrap()
                    .await
                    .unwrap()
                    .unwrap();
                let cancelled = scheduler.schedule("cancel".to_owned(), 60_000).unwrap();
                scheduler.cancel("cancel".to_owned()).unwrap();
                assert!(matches!(
                    cancelled.await.unwrap(),
                    Err(CoreError::WaitCancelled)
                ));
                scheduler.shutdown();
            });
    }

    #[test]
    fn replacing_an_id_cancels_the_previous_wait() {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async {
                let mut scheduler = MonotonicScheduler::start().unwrap();
                let previous = scheduler.schedule("same".to_owned(), 60_000).unwrap();
                let replacement = scheduler.schedule("same".to_owned(), 0).unwrap();
                assert!(matches!(
                    previous.await.unwrap(),
                    Err(CoreError::WaitCancelled)
                ));
                replacement.await.unwrap().unwrap();
                scheduler.shutdown();
            });
    }
}
