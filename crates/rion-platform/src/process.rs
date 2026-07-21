use std::{
    path::Path,
    process::{Command, Stdio},
    thread::{self, JoinHandle},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, bounded};
use serde::Serialize;

use crate::PlatformError;

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

enum ProcessCommand {
    Terminate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessExit {
    pub exit_code: Option<i32>,
    pub terminated: bool,
}

pub struct ExternalProcessSupervisor {
    pid: u32,
    command: Sender<ProcessCommand>,
    events: Option<Receiver<ExternalProcessExit>>,
    join: Option<JoinHandle<()>>,
}

impl ExternalProcessSupervisor {
    pub fn start(executable: &Path, arguments: &[String]) -> Result<Self, PlatformError> {
        if !executable.is_file() {
            return Err(PlatformError::Operation(format!(
                "Chrome executable does not exist: {}",
                executable.display()
            )));
        }
        let mut child = Command::new(executable)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        let pid = child.id();
        let (command, commands) = bounded(4);
        let (event_sender, events) = bounded(1);
        let join = thread::Builder::new()
            .name(format!("rion-external-chrome-{pid}"))
            .spawn(move || {
                let mut terminated = false;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let _ = event_sender.try_send(ExternalProcessExit {
                                exit_code: status.code(),
                                terminated,
                            });
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            let _ = event_sender.try_send(ExternalProcessExit {
                                exit_code: None,
                                terminated,
                            });
                            break;
                        }
                    }

                    match commands.recv_timeout(PROCESS_POLL_INTERVAL) {
                        Ok(ProcessCommand::Terminate) => {
                            terminated = true;
                            let _ = child.kill();
                            let status = child.wait().ok();
                            let _ = event_sender.try_send(ExternalProcessExit {
                                exit_code: status.and_then(|value| value.code()),
                                terminated,
                            });
                            break;
                        }
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                    }
                }
            })
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        Ok(Self {
            pid,
            command,
            events: Some(events),
            join: Some(join),
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn take_events(&mut self) -> Option<Receiver<ExternalProcessExit>> {
        self.events.take()
    }

    pub fn terminate(&self) {
        let _ = self.command.try_send(ProcessCommand::Terminate);
    }
}

impl Drop for ExternalProcessSupervisor {
    fn drop(&mut self) {
        self.terminate();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn reports_natural_process_exit() {
        let mut supervisor = ExternalProcessSupervisor::start(
            Path::new("/bin/sh"),
            &["-c".to_owned(), "exit 7".to_owned()],
        )
        .unwrap();
        let exit = supervisor
            .take_events()
            .unwrap()
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(exit.exit_code, Some(7));
        assert!(!exit.terminated);
    }

    #[test]
    fn rejects_a_missing_executable() {
        assert!(
            ExternalProcessSupervisor::start(Path::new("rion-missing-executable"), &[]).is_err()
        );
    }
}
