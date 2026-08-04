use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crossbeam_channel::{Receiver, RecvTimeoutError, SendTimeoutError, Sender, bounded};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::database::{join_worker_if_finished, portable_recovery};
use crate::domain::{
    assign_role_game_ids, clear_macro_role, clear_workspace_role, create_game, create_game_window,
    create_macro, create_role, create_workspace, default_game_browser_settings,
    default_macro_settings, default_runtime_window_preferences, delete_game, delete_game_window,
    delete_game_window_if_unchanged, delete_macro, delete_macros, delete_workspace,
    macro_shortcut_source_role_ids, normalize_game_browser_settings, normalize_macro_settings,
    reorder_game_windows, reorder_roles,
    reorder_workspaces, reset_builtin_game, save_runtime_game_window, update_game,
    update_game_window, update_macro, update_role, update_workspace,
    validate_game_window_collection,
};
use crate::error::{CoreError, CoreResult};
use crate::macro_graph::validate_macro_graph;
use crate::model::{
    GameBrowserSettingsRecord, GameCreateInputRecord, GameUpdateInputRecord,
    GameWindowCreateInputRecord, GameWindowDisplayRemapRecord, GameWindowSaveRuntimeInputRecord,
    GameWindowUpdateInputRecord,
    LogLevel, MacroBadgePositionRecord, MacroCreateInputRecord, MacroDefinition,
    MacroRuntimeSettings, MacroSettingsRecord, MacroUpdateInputRecord, RoleCreateInputRecord,
    RoleGameAssignmentRecord, RoleUpdateInputRecord, RuntimeWindowPreferencesRecord,
    StateCollection, StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord,
    StateMacroRecord, StateRoleRecord, WorkspaceCreateInputRecord, WorkspaceUpdateInputRecord,
};

pub(crate) const SCHEMA_VERSION: u32 = 25;
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub(crate) struct OperationJournalRecord {
    pub id: String,
    pub kind: String,
    pub phase: String,
    pub payload: Value,
}

enum Request {
    Snapshot(Sender<CoreResult<Value>>),
    ReadCollection(String, Sender<CoreResult<Value>>),
    ReadRecord {
        collection: String,
        id: String,
        response: Sender<CoreResult<Option<Value>>>,
    },
    ReadScalar(String, Sender<CoreResult<Option<Value>>>),
    ReplaceScalar(String, Value, Sender<CoreResult<u64>>),
    ReplaceSnapshot(Value, Sender<CoreResult<(u64, bool)>>),
    DomainMutation(Box<StateMutation>, Sender<CoreResult<Value>>),
    Metadata(Sender<CoreResult<Value>>),
    MacroConfiguration(Sender<CoreResult<(Vec<MacroDefinition>, MacroRuntimeSettings)>>),
    OverlayConfiguration(Sender<CoreResult<(Vec<MacroDefinition>, MacroBadgePositionRecord)>>),
    RecoverPortableImport(PathBuf, Sender<CoreResult<bool>>),
    OperationJournals(Sender<CoreResult<Vec<OperationJournalRecord>>>),
    OperationJournalPut(OperationJournalRecord, Sender<CoreResult<()>>),
    OperationJournalDelete(String, Sender<CoreResult<()>>),
    Shutdown(Sender<()>),
}

pub(crate) enum StateMutation {
    GameCreate(GameCreateInputRecord),
    GameUpdate {
        id: String,
        input: GameUpdateInputRecord,
    },
    GameResetBuiltin {
        id: String,
    },
    GameDelete {
        id: String,
    },
    GamesDelete {
        ids: Vec<String>,
    },
    RoleCreate(RoleCreateInputRecord),
    RoleCreateWithId {
        id: String,
        input: RoleCreateInputRecord,
    },
    RoleUpdate {
        id: String,
        input: RoleUpdateInputRecord,
    },
    RoleReorder {
        ordered_ids: Vec<String>,
    },
    RoleDelete {
        id: String,
        operation_id: Option<String>,
    },
    RolesDelete {
        ids: Vec<String>,
        operation_ids: HashMap<String, String>,
    },
    RoleBrowserDataReset {
        id: String,
        operation_id: String,
    },
    RoleAssignGameIds(Vec<RoleGameAssignmentRecord>),
    WorkspaceCreate(WorkspaceCreateInputRecord),
    WorkspaceUpdate {
        id: String,
        input: WorkspaceUpdateInputRecord,
    },
    WorkspaceReorder {
        ordered_ids: Vec<String>,
    },
    WorkspaceDelete {
        id: String,
    },
    WorkspacesDelete {
        ids: Vec<String>,
    },
    WorkspaceClearRole {
        role_id: String,
    },
    WorkspaceSetRoleBrowserZoom {
        workspace_id: String,
        role_id: String,
        browser_zoom_percent: f64,
    },
    GameWindowCreate(GameWindowCreateInputRecord),
    GameWindowSaveRuntime(GameWindowSaveRuntimeInputRecord),
    GameWindowUpdate {
        id: String,
        input: GameWindowUpdateInputRecord,
    },
    GameWindowsDisplayRemap {
        updates: Vec<GameWindowDisplayRemapRecord>,
    },
    GameWindowReorder {
        ordered_ids: Vec<String>,
    },
    GameWindowDelete {
        id: String,
    },
    GameWindowDeleteIfUnchanged {
        id: String,
        updated_at: String,
    },
    GameWindowsRuntimeSync {
        windows: Vec<StateGameWindowRecord>,
    },
    MacroCreate(MacroCreateInputRecord),
    MacroUpdate {
        id: String,
        input: MacroUpdateInputRecord,
    },
    MacroDelete {
        id: String,
    },
    MacrosDelete {
        ids: Vec<String>,
    },
    MacrosClearRole {
        role_id: String,
    },
}

impl StateMutation {
    pub(crate) fn changed_collections(&self) -> Vec<StateCollection> {
        use StateCollection::{GameWindows, Games, LaunchWorkspaces, Macros, Roles};

        match self {
            Self::GameCreate(_) | Self::GameUpdate { .. } | Self::GameResetBuiltin { .. } => {
                vec![Games]
            }
            Self::GameDelete { .. } | Self::GamesDelete { .. } => vec![Games],
            Self::RoleCreate(_)
            | Self::RoleCreateWithId { .. }
            | Self::RoleUpdate { .. }
            | Self::RoleReorder { .. }
            | Self::RoleBrowserDataReset { .. }
            | Self::RoleAssignGameIds(_) => vec![Roles],
            Self::RoleDelete { .. } | Self::RolesDelete { .. } => {
                vec![Roles, LaunchWorkspaces, Macros]
            }
            Self::WorkspaceCreate(_)
            | Self::WorkspaceUpdate { .. }
            | Self::WorkspaceReorder { .. }
            | Self::WorkspaceDelete { .. }
            | Self::WorkspacesDelete { .. }
            | Self::WorkspaceClearRole { .. }
            | Self::WorkspaceSetRoleBrowserZoom { .. } => vec![LaunchWorkspaces],
            Self::GameWindowCreate(_)
            | Self::GameWindowSaveRuntime(_)
            | Self::GameWindowUpdate { .. }
            | Self::GameWindowsDisplayRemap { .. }
            | Self::GameWindowReorder { .. }
            | Self::GameWindowDelete { .. }
            | Self::GameWindowDeleteIfUnchanged { .. }
            | Self::GameWindowsRuntimeSync { .. } => vec![GameWindows],
            Self::MacroCreate(_)
            | Self::MacroUpdate { .. }
            | Self::MacroDelete { .. }
            | Self::MacrosDelete { .. }
            | Self::MacrosClearRole { .. } => vec![Macros],
        }
    }
}

pub struct StateDatabaseWorker {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl StateDatabaseWorker {
    pub fn start(path: PathBuf) -> CoreResult<Self> {
        let (sender, receiver) = bounded::<Request>(128);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-state-db".to_owned())
            .spawn(move || run_worker(path, receiver, ready_sender))
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        match ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(result) => result?,
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreError::StateDatabase(format!(
                    "state worker startup timed out after {} seconds",
                    WORKER_START_TIMEOUT.as_secs()
                )));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CoreError::StateDatabase(
                    "state worker stopped during startup".to_owned(),
                ));
            }
        }
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn snapshot(&self) -> CoreResult<Value> {
        request(&self.sender, Request::Snapshot)
    }

    pub fn read_collection(&self, collection: String) -> CoreResult<Value> {
        request(&self.sender, |response| {
            Request::ReadCollection(collection, response)
        })
    }

    pub fn read_record(&self, collection: String, id: String) -> CoreResult<Option<Value>> {
        request(&self.sender, |response| Request::ReadRecord {
            collection,
            id,
            response,
        })
    }

    pub fn read_scalar(&self, key: String) -> CoreResult<Option<Value>> {
        request(&self.sender, |response| Request::ReadScalar(key, response))
    }

    pub fn replace_snapshot(&self, snapshot: Value) -> CoreResult<(u64, bool)> {
        request(&self.sender, |response| {
            Request::ReplaceSnapshot(snapshot, response)
        })
    }

    pub fn replace_scalar(&self, key: String, value: Value) -> CoreResult<u64> {
        request(&self.sender, |response| {
            Request::ReplaceScalar(key, value, response)
        })
    }

    pub(crate) fn mutate(&self, mutation: StateMutation) -> CoreResult<Value> {
        request(&self.sender, |response| {
            Request::DomainMutation(Box::new(mutation), response)
        })
    }

    pub(crate) fn operation_journals(&self) -> CoreResult<Vec<OperationJournalRecord>> {
        request(&self.sender, Request::OperationJournals)
    }

    pub(crate) fn put_operation_journal(&self, record: OperationJournalRecord) -> CoreResult<()> {
        request(&self.sender, |response| {
            Request::OperationJournalPut(record, response)
        })
    }

    pub(crate) fn delete_operation_journal(&self, id: String) -> CoreResult<()> {
        request(&self.sender, |response| {
            Request::OperationJournalDelete(id, response)
        })
    }

    pub fn metadata(&self) -> CoreResult<Value> {
        request(&self.sender, Request::Metadata)
    }

    pub fn macro_configuration(&self) -> CoreResult<(Vec<MacroDefinition>, MacroRuntimeSettings)> {
        request(&self.sender, Request::MacroConfiguration)
    }

    pub fn overlay_configuration(
        &self,
    ) -> CoreResult<(Vec<MacroDefinition>, MacroBadgePositionRecord)> {
        request(&self.sender, Request::OverlayConfiguration)
    }

    pub fn recover_portable_import(&self, user_data_dir: PathBuf) -> CoreResult<bool> {
        request(&self.sender, |response| {
            Request::RecoverPortableImport(user_data_dir, response)
        })
    }

    pub fn shutdown(&mut self) {
        let (sender, receiver) = bounded(1);
        if self
            .sender
            .send_timeout(Request::Shutdown(sender), WORKER_SHUTDOWN_TIMEOUT)
            .is_ok()
        {
            let _ = receiver.recv_timeout(WORKER_SHUTDOWN_TIMEOUT);
        }
        join_worker_if_finished(&mut self.join);
    }
}

impl Drop for StateDatabaseWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn request<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
) -> CoreResult<T> {
    request_with_timeout(sender, create, WORKER_REQUEST_TIMEOUT)
}

fn request_with_timeout<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
    timeout: Duration,
) -> CoreResult<T> {
    let (response_sender, response_receiver) = bounded(1);
    match sender.send_timeout(create(response_sender), timeout) {
        Ok(()) => {}
        Err(SendTimeoutError::Timeout(_)) => {
            return Err(CoreError::StateDatabase(format!(
                "state worker queue timed out after {} milliseconds",
                timeout.as_millis()
            )));
        }
        Err(SendTimeoutError::Disconnected(_)) => return Err(CoreError::ShuttingDown),
    }
    match response_receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(CoreError::StateDatabase(format!(
            "state worker response timed out after {} milliseconds; the operation may still complete",
            timeout.as_millis()
        ))),
        Err(RecvTimeoutError::Disconnected) => Err(CoreError::ShuttingDown),
    }
}

fn run_worker(path: PathBuf, receiver: Receiver<Request>, ready: Sender<CoreResult<()>>) {
    let connection = Connection::open(path)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
        .and_then(|connection| {
            create_schema(&connection, true)?;
            Ok(connection)
        });
    let mut connection = match connection {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    while let Ok(message) = receiver.recv() {
        match message {
            Request::Snapshot(response) => {
                let _ = response.send(read_snapshot(&connection));
            }
            Request::ReadCollection(collection, response) => {
                let _ = response.send(read_collection(&connection, &collection));
            }
            Request::ReadRecord {
                collection,
                id,
                response,
            } => {
                let _ = response.send(read_record(&connection, &collection, &id));
            }
            Request::ReadScalar(key, response) => {
                let _ = response.send(read_scalar(&connection, &key));
            }
            Request::ReplaceSnapshot(snapshot, response) => {
                let _ = response.send(replace_snapshot_if_changed(&mut connection, &snapshot));
            }
            Request::ReplaceScalar(key, value, response) => {
                let _ = response.send(replace_scalar(&mut connection, &key, value));
            }
            Request::DomainMutation(mutation, response) => {
                let _ = response.send(apply_domain_mutation(&mut connection, *mutation));
            }
            Request::Metadata(response) => {
                let _ = response.send(read_metadata(&connection));
            }
            Request::MacroConfiguration(response) => {
                let _ = response.send(read_macro_configuration(&connection));
            }
            Request::OverlayConfiguration(response) => {
                let _ = response.send(read_overlay_configuration(&connection));
            }
            Request::RecoverPortableImport(user_data_dir, response) => {
                let result = recover_sqlite_portable_import(&mut connection, &user_data_dir);
                let _ = response.send(result);
            }
            Request::OperationJournals(response) => {
                let _ = response.send(read_operation_journals(&connection));
            }
            Request::OperationJournalPut(record, response) => {
                let _ = response.send(put_operation_journal(&connection, &record));
            }
            Request::OperationJournalDelete(id, response) => {
                let _ = response.send(delete_operation_journal(&connection, &id));
            }
            Request::Shutdown(response) => {
                let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                let _ = response.send(());
                break;
            }
        }
    }
}
