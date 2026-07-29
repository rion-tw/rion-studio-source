use std::thread::JoinHandle;

mod bootstrap;
mod legacy;
mod logs;
mod portable_recovery;
mod state;

pub(crate) const LEGACY_STATE_FILES: &[&str] = &[
    "games.json",
    "roles.json",
    "profiles.json",
    "launch-workspaces.json",
    "macros.json",
    "game-browser-settings.json",
    "macro-settings.json",
    "runtime-window-preferences.json",
    "legal-acceptance.json",
    "game-compatibility.json",
    "background-activity-migration.json",
    "portable-import-transaction.json",
];

pub use bootstrap::{DatabasePaths, bootstrap_databases, create_online_startup_backup};
pub use logs::LogDatabaseWorker;
pub use state::StateDatabaseWorker;
pub(crate) use state::{
    LegacySessionRestoreState, OperationJournalRecord, SCHEMA_VERSION, StateMutation,
};

fn join_worker_if_finished(join: &mut Option<JoinHandle<()>>) {
    let Some(worker) = join.take() else {
        return;
    };
    if worker.is_finished() {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod worker_tests {
    use std::{sync::mpsc, thread};

    use super::join_worker_if_finished;

    #[test]
    fn unfinished_worker_is_detached_instead_of_joined() {
        let (release, wait) = mpsc::channel();
        let mut worker = Some(thread::spawn(move || {
            let _ = wait.recv();
        }));

        join_worker_if_finished(&mut worker);

        assert!(worker.is_none());
        release.send(()).unwrap();
    }
}
