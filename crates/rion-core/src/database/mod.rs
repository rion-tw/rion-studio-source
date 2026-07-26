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
pub(crate) use state::{OperationJournalRecord, SCHEMA_VERSION, StateMutation};
