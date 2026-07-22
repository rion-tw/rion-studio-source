use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use rion_platform::{ExternalProcessExit, ExternalProcessSupervisor};
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

struct ProcessEntry {
    generation: Uuid,
    supervisor: ExternalProcessSupervisor,
}

type ExitHandler = Arc<dyn Fn(String, ExternalProcessExit) + Send + Sync>;

pub(crate) struct ExternalProcessRuntime {
    entries: Arc<Mutex<HashMap<String, ProcessEntry>>>,
    on_exit: ExitHandler,
}

impl ExternalProcessRuntime {
    pub fn new(on_exit: ExitHandler) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            on_exit,
        }
    }

    pub fn launch(
        &self,
        role_id: String,
        executable: &Path,
        arguments: &[String],
    ) -> CoreResult<u32> {
        if role_id.trim().is_empty() || role_id.len() > 128 {
            return Err(CoreError::InvalidInput(
                "external Chrome roleId is invalid".to_owned(),
            ));
        }
        let mut supervisor = ExternalProcessSupervisor::start(executable, arguments)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        let pid = supervisor.pid();
        let events = supervisor.take_events().ok_or_else(|| {
            CoreError::Internal("external process exit receiver is unavailable".to_owned())
        })?;
        let generation = Uuid::new_v4();
        let previous = self
            .entries
            .lock()
            .map_err(|_| CoreError::Internal("external process registry lock poisoned".to_owned()))?
            .insert(
                role_id.clone(),
                ProcessEntry {
                    generation,
                    supervisor,
                },
            );
        drop(previous);

        let entries = Arc::clone(&self.entries);
        let on_exit = Arc::clone(&self.on_exit);
        thread::Builder::new()
            .name(format!("rion-external-exit-{pid}"))
            .spawn(move || {
                let Ok(event) = events.recv() else { return };
                let is_current = entries
                    .lock()
                    .ok()
                    .and_then(|entries| entries.get(&role_id).map(|entry| entry.generation))
                    == Some(generation);
                if is_current {
                    on_exit(role_id, event);
                }
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(pid)
    }

    pub fn terminate(&self, role_id: &str) -> CoreResult<bool> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| CoreError::Internal("external process registry lock poisoned".to_owned()))?
            .remove(role_id);
        if let Some(entry) = entry {
            entry.supervisor.terminate();
            drop(entry);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn shutdown(&self) {
        let entries = self
            .entries
            .lock()
            .map(|mut entries| entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>())
            .unwrap_or_default();
        for entry in &entries {
            entry.supervisor.terminate();
        }
        drop(entries);
    }
}

impl Drop for ExternalProcessRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use crossbeam_channel::bounded;

    use super::*;

    #[test]
    fn rejects_invalid_role_ids_before_starting_a_process() {
        let runtime = ExternalProcessRuntime::new(Arc::new(|_, _| {}));
        assert_eq!(
            runtime
                .launch(String::new(), Path::new("missing"), &[])
                .unwrap_err()
                .code(),
            "CORE_INPUT_INVALID"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn owns_process_exit_delivery_by_role() {
        let (sender, receiver) = bounded(1);
        let runtime = ExternalProcessRuntime::new(Arc::new(move |role_id, event| {
            let _ = sender.try_send((role_id, event));
        }));
        let (executable, arguments, expected_exit_code) = exit_fixture();
        let pid = runtime
            .launch("role-1".to_owned(), &executable, &arguments)
            .unwrap();
        assert!(pid > 0);
        let (role_id, event) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(role_id, "role-1");
        assert_eq!(event.exit_code, Some(expected_exit_code));
        assert!(!event.terminated);
    }

    #[cfg(unix)]
    fn exit_fixture() -> (PathBuf, Vec<String>, i32) {
        (
            PathBuf::from("/bin/sh"),
            vec!["-c".to_owned(), "exit 7".to_owned()],
            7,
        )
    }

    #[cfg(windows)]
    fn exit_fixture() -> (PathBuf, Vec<String>, i32) {
        let executable = PathBuf::from(std::env::var_os("WINDIR").expect("WINDIR is required"))
            .join("System32")
            .join("cmd.exe");
        assert!(executable.is_file());
        (executable, vec!["/C".to_owned(), "exit 7".to_owned()], 7)
    }
}
