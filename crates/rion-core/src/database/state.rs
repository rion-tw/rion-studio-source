use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crossbeam_channel::{Receiver, Sender, bounded};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::database::{
    legacy,
    portable_recovery::{self, StorageKind},
};
use crate::domain::{
    assign_role_game_ids, clear_macro_role, clear_workspace_role, create_game, create_macro,
    create_role, create_workspace, default_game_browser_settings, default_macro_settings,
    default_runtime_window_preferences, delete_game, delete_macro, delete_macros, delete_workspace,
    normalize_game_browser_settings, normalize_macro_settings, reorder_roles, reorder_workspaces,
    reset_builtin_game, set_role_browser_session_source, update_game, update_macro, update_role,
    update_workspace,
};
use crate::error::{CoreError, CoreResult};
use crate::macro_graph::validate_macro_graph;
use crate::model::{
    GameBrowserSettingsRecord, GameCreateInputRecord, GameUpdateInputRecord, LogLevel,
    MacroBadgePositionRecord, MacroCreateInputRecord, MacroDefinition, MacroRuntimeSettings,
    MacroSettingsRecord, MacroUpdateInputRecord, RoleCreateInputRecord, RoleGameAssignmentRecord,
    RoleUpdateInputRecord, RuntimeWindowPreferencesRecord, StateCollection,
    StateCompatibilityObservationsRecord, StateCompatibilityReportRecord, StateGameRecord,
    StateLaunchWorkspaceRecord, StateMacroRecord, StateRoleRecord, WorkspaceCreateInputRecord,
    WorkspaceDisplayInfoRecord, WorkspaceUpdateInputRecord,
};

pub(crate) const SCHEMA_VERSION: u32 = 5;

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
    ApplyProfileRoles(Vec<crate::model::StateRoleRecord>, Sender<CoreResult<u64>>),
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
    RoleSetBrowserSessionSource {
        id: String,
        source: String,
    },
    RoleBrowserDataReset {
        id: String,
        operation_id: String,
    },
    RoleAssignGameIds(Vec<RoleGameAssignmentRecord>),
    ProfileRolesPatch {
        upserts: Vec<StateRoleRecord>,
        delete_ids: Vec<String>,
    },
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
    WorkspaceReconcileDisplays(Vec<WorkspaceDisplayInfoRecord>),
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
    CompatibilityReportSave(Box<StateCompatibilityReportRecord>),
    CompatibilityReportRecordObservation {
        game_id: String,
        observation: StateCompatibilityObservationsRecord,
    },
    CompatibilityReportDelete {
        game_id: String,
    },
}

impl StateMutation {
    pub(crate) fn changed_collections(&self) -> Vec<StateCollection> {
        use StateCollection::{CompatibilityReports, Games, LaunchWorkspaces, Macros, Roles};

        match self {
            Self::GameCreate(_) | Self::GameUpdate { .. } | Self::GameResetBuiltin { .. } => {
                vec![Games]
            }
            Self::GameDelete { .. } | Self::GamesDelete { .. } => {
                vec![Games, CompatibilityReports]
            }
            Self::RoleCreate(_)
            | Self::RoleUpdate { .. }
            | Self::RoleReorder { .. }
            | Self::RoleSetBrowserSessionSource { .. }
            | Self::RoleBrowserDataReset { .. }
            | Self::RoleAssignGameIds(_)
            | Self::ProfileRolesPatch { .. } => vec![Roles],
            Self::RoleDelete { .. } | Self::RolesDelete { .. } => {
                vec![Roles, LaunchWorkspaces, Macros]
            }
            Self::WorkspaceCreate(_)
            | Self::WorkspaceUpdate { .. }
            | Self::WorkspaceReorder { .. }
            | Self::WorkspaceDelete { .. }
            | Self::WorkspacesDelete { .. }
            | Self::WorkspaceClearRole { .. }
            | Self::WorkspaceSetRoleBrowserZoom { .. }
            | Self::WorkspaceReconcileDisplays(_) => vec![LaunchWorkspaces],
            Self::MacroCreate(_)
            | Self::MacroUpdate { .. }
            | Self::MacroDelete { .. }
            | Self::MacrosDelete { .. }
            | Self::MacrosClearRole { .. } => vec![Macros],
            Self::CompatibilityReportSave(_)
            | Self::CompatibilityReportRecordObservation { .. }
            | Self::CompatibilityReportDelete { .. } => vec![CompatibilityReports],
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
        ready_receiver.recv().map_err(|_| {
            CoreError::StateDatabase("state worker stopped during startup".to_owned())
        })??;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn snapshot(&self) -> CoreResult<Value> {
        request(&self.sender, Request::Snapshot)
    }

    pub fn read_collection(&self, collection: String) -> CoreResult<Value> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReadCollection(collection, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn read_record(&self, collection: String, id: String) -> CoreResult<Option<Value>> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReadRecord {
                collection,
                id,
                response: response_sender,
            })
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn read_scalar(&self, key: String) -> CoreResult<Option<Value>> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReadScalar(key, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn replace_snapshot(&self, snapshot: Value) -> CoreResult<(u64, bool)> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReplaceSnapshot(snapshot, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn apply_profile_roles(
        &self,
        roles: Vec<crate::model::StateRoleRecord>,
    ) -> CoreResult<u64> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ApplyProfileRoles(roles, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn replace_scalar(&self, key: String, value: Value) -> CoreResult<u64> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReplaceScalar(key, value, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub(crate) fn mutate(&self, mutation: StateMutation) -> CoreResult<Value> {
        let (response, receiver) = bounded(1);
        self.sender
            .send(Request::DomainMutation(Box::new(mutation), response))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
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
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::RecoverPortableImport(
                user_data_dir,
                response_sender,
            ))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
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

impl Drop for StateDatabaseWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn request<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
) -> CoreResult<T> {
    let (response_sender, response_receiver) = bounded(1);
    sender
        .send(create(response_sender))
        .map_err(|_| CoreError::ShuttingDown)?;
    response_receiver
        .recv()
        .map_err(|_| CoreError::ShuttingDown)?
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
            Request::ApplyProfileRoles(roles, response) => {
                let _ = response.send(apply_profile_roles(&mut connection, roles));
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

fn apply_domain_mutation(
    connection: &mut Connection,
    mutation: StateMutation,
) -> CoreResult<Value> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let result = match mutation {
        StateMutation::GameCreate(input) => {
            let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let game = create_game(&mut games, input)?;
            upsert_entity(&transaction, "games", &json_value(&game)?, games.len() - 1)?;
            serde_json::to_value(game)
        }
        StateMutation::GameUpdate { id, input } => {
            let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let game = update_game(&mut games, &id, input)?;
            let ordinal = games.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "games", &json_value(&game)?, ordinal)?;
            serde_json::to_value(game)
        }
        StateMutation::GameResetBuiltin { id } => {
            let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let game = reset_builtin_game(&mut games, &id)?;
            let ordinal = games.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "games", &json_value(&game)?, ordinal)?;
            serde_json::to_value(game)
        }
        StateMutation::GameDelete { id } => {
            let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            delete_game(&mut games, &roles, &id)?;
            transaction
                .execute("DELETE FROM games WHERE id=?1", params![id])
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            Ok(json!({ "deleted": true }))
        }
        StateMutation::GamesDelete { ids } => {
            let requested = normalize_bulk_ids(ids)?;
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let mut deleted_ids = Vec::new();
            let mut skipped = Vec::new();
            for id in requested {
                let Some(game) = games.iter().find(|game| game.id == id) else {
                    skipped.push(bulk_skip(id, "not_found", Vec::new()));
                    continue;
                };
                if game.source == "builtin" {
                    skipped.push(bulk_skip(id, "protected", Vec::new()));
                    continue;
                }
                let related_names = roles
                    .iter()
                    .filter(|role| role.game_id == id)
                    .map(|role| role.name.clone())
                    .collect::<Vec<_>>();
                if !related_names.is_empty() {
                    skipped.push(bulk_skip(id, "in_use", related_names));
                    continue;
                }
                transaction
                    .execute("DELETE FROM games WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                deleted_ids.push(id);
            }
            Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
        }
        StateMutation::RoleCreate(input) => {
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role = create_role(&games, &mut roles, input)?;
            upsert_entity(&transaction, "roles", &json_value(&role)?, roles.len() - 1)?;
            serde_json::to_value(role)
        }
        StateMutation::RoleUpdate { id, input } => {
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role = update_role(&games, &mut roles, &id, input)?;
            let ordinal = roles.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
            serde_json::to_value(role)
        }
        StateMutation::RoleReorder { ordered_ids } => {
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            reorder_roles(&mut roles, &ordered_ids)?;
            update_ordinals(&transaction, "roles", &ordered_ids)?;
            serde_json::to_value(&roles)
        }
        StateMutation::RoleDelete { id, operation_id } => {
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let original_len = roles.len();
            roles.retain(|role| role.id != id);
            if roles.len() == original_len {
                return Err(CoreError::Domain {
                    code: "ROLE_NOT_FOUND",
                    message: "Role not found.".to_owned(),
                });
            }
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            for workspace in &mut workspaces {
                for slot in &mut workspace.slots {
                    if slot.role_id.as_deref() == Some(&id) {
                        slot.role_id = None;
                    }
                }
            }
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            for macro_record in &mut macros {
                macro_record.role_ids.retain(|role_id| role_id != &id);
            }
            transaction
                .execute("DELETE FROM roles WHERE id=?1", params![id])
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            sync_workspaces(&transaction, &workspaces)?;
            sync_macros(&transaction, &macros)?;
            if let Some(operation_id) = operation_id {
                set_operation_journal_phase(&transaction, &operation_id, "committed")?;
            }
            Ok(json!({ "deleted": true }))
        }
        StateMutation::RolesDelete { ids, operation_ids } => {
            let requested = normalize_bulk_ids(ids)?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let existing_ids = roles
                .iter()
                .map(|role| role.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let deleted_ids = requested
                .iter()
                .filter(|id| existing_ids.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let skipped = requested
                .iter()
                .filter(|id| !existing_ids.contains(id.as_str()))
                .map(|id| bulk_skip(id.clone(), "not_found", Vec::new()))
                .collect::<Vec<_>>();
            let deleted = deleted_ids.iter().collect::<std::collections::HashSet<_>>();
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            for workspace in &mut workspaces {
                for slot in &mut workspace.slots {
                    if slot
                        .role_id
                        .as_ref()
                        .is_some_and(|role_id| deleted.contains(role_id))
                    {
                        slot.role_id = None;
                    }
                }
            }
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            for macro_record in &mut macros {
                macro_record
                    .role_ids
                    .retain(|role_id| !deleted.contains(role_id));
            }
            for id in &deleted_ids {
                transaction
                    .execute("DELETE FROM roles WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                if let Some(operation_id) = operation_ids.get(id) {
                    set_operation_journal_phase(&transaction, operation_id, "committed")?;
                }
            }
            sync_workspaces(&transaction, &workspaces)?;
            sync_macros(&transaction, &macros)?;
            Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
        }
        StateMutation::RoleSetBrowserSessionSource { id, source } => {
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role = set_role_browser_session_source(&mut roles, &id, &source)?;
            let ordinal = roles.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
            serde_json::to_value(role)
        }
        StateMutation::RoleBrowserDataReset { id, operation_id } => {
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role = set_role_browser_session_source(&mut roles, &id, "embedded")?;
            let ordinal = roles.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
            set_operation_journal_phase(&transaction, &operation_id, "committed")?;
            serde_json::to_value(role)
        }
        StateMutation::RoleAssignGameIds(assignments) => {
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            assign_role_game_ids(&games, &mut roles, &assignments)?;
            for (ordinal, role) in roles.iter().enumerate() {
                upsert_entity(&transaction, "roles", &json_value(role)?, ordinal)?;
            }
            serde_json::to_value(&roles)
        }
        StateMutation::ProfileRolesPatch {
            upserts,
            delete_ids,
        } => {
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let delete_ids = delete_ids
                .into_iter()
                .collect::<std::collections::HashSet<_>>();
            roles.retain(|role| !delete_ids.contains(&role.id));
            for role in upserts {
                if let Some(index) = roles.iter().position(|candidate| candidate.id == role.id) {
                    roles[index] = role;
                } else {
                    roles.push(role);
                }
            }
            validate_profile_roles(&games, &roles)?;
            for id in &delete_ids {
                transaction
                    .execute("DELETE FROM roles WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            for (ordinal, role) in roles.iter().enumerate() {
                upsert_entity(&transaction, "roles", &json_value(role)?, ordinal)?;
            }
            if !delete_ids.is_empty() {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                for role_id in delete_ids {
                    clear_workspace_role(&mut workspaces, &role_id);
                    clear_macro_role(&mut macros, &role_id);
                }
                sync_workspaces(&transaction, &workspaces)?;
                sync_macros(&transaction, &macros)?;
            }
            serde_json::to_value(&roles)
        }
        StateMutation::WorkspaceCreate(input) => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let workspace = create_workspace(&mut workspaces, input)?;
            validate_workspace_role_references(&workspace, &roles)?;
            upsert_workspace(&transaction, &json_value(&workspace)?, workspaces.len() - 1)?;
            serde_json::to_value(workspace)
        }
        StateMutation::WorkspaceUpdate { id, input } => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let workspace = update_workspace(&mut workspaces, &id, input)?;
            validate_workspace_role_references(&workspace, &roles)?;
            let ordinal = workspaces.iter().position(|item| item.id == id).unwrap();
            upsert_workspace(&transaction, &json_value(&workspace)?, ordinal)?;
            serde_json::to_value(workspace)
        }
        StateMutation::WorkspaceReorder { ordered_ids } => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            reorder_workspaces(&mut workspaces, &ordered_ids)?;
            update_ordinals(&transaction, "workspaces", &ordered_ids)?;
            serde_json::to_value(&workspaces)
        }
        StateMutation::WorkspaceDelete { id } => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            delete_workspace(&mut workspaces, &id)?;
            transaction
                .execute("DELETE FROM workspaces WHERE id=?1", params![id])
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            Ok(json!({ "deleted": true }))
        }
        StateMutation::WorkspacesDelete { ids } => {
            let requested = normalize_bulk_ids(ids)?;
            let workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            let existing_ids = workspaces
                .iter()
                .map(|workspace| workspace.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let deleted_ids = requested
                .iter()
                .filter(|id| existing_ids.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let skipped = requested
                .iter()
                .filter(|id| !existing_ids.contains(id.as_str()))
                .map(|id| bulk_skip(id.clone(), "not_found", Vec::new()))
                .collect::<Vec<_>>();
            for id in &deleted_ids {
                transaction
                    .execute("DELETE FROM workspaces WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
        }
        StateMutation::WorkspaceClearRole { role_id } => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            clear_workspace_role(&mut workspaces, &role_id);
            sync_workspaces(&transaction, &workspaces)?;
            Ok(json!({ "cleared": true }))
        }
        StateMutation::WorkspaceSetRoleBrowserZoom {
            workspace_id,
            role_id,
            browser_zoom_percent,
        } => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            let workspace = crate::domain::set_workspace_role_browser_zoom(
                &mut workspaces,
                &workspace_id,
                &role_id,
                browser_zoom_percent,
            )?;
            if let Some(workspace) = &workspace {
                let ordinal = workspaces
                    .iter()
                    .position(|item| item.id == workspace_id)
                    .unwrap();
                upsert_workspace(&transaction, &json_value(workspace)?, ordinal)?;
            }
            serde_json::to_value(workspace)
        }
        StateMutation::WorkspaceReconcileDisplays(displays) => {
            let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                &transaction,
                "launchWorkspaces",
            )?;
            crate::domain::reconcile_workspace_displays(&mut workspaces, &displays)?;
            sync_workspaces(&transaction, &workspaces)?;
            serde_json::to_value(&workspaces)
        }
        StateMutation::MacroCreate(input) => {
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let macro_record = create_macro(&mut macros, input)?;
            validate_macro_role_references(&macro_record, &roles)?;
            upsert_macro(&transaction, &json_value(&macro_record)?, macros.len() - 1)?;
            serde_json::to_value(macro_record)
        }
        StateMutation::MacroUpdate { id, input } => {
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let macro_record = update_macro(&mut macros, &id, input)?;
            validate_macro_role_references(&macro_record, &roles)?;
            let ordinal = macros.iter().position(|item| item.id == id).unwrap();
            upsert_macro(&transaction, &json_value(&macro_record)?, ordinal)?;
            serde_json::to_value(macro_record)
        }
        StateMutation::MacroDelete { id } => {
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            delete_macro(&mut macros, &id)?;
            transaction
                .execute("DELETE FROM macros WHERE id=?1", params![id])
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            Ok(json!({ "deleted": true }))
        }
        StateMutation::MacrosDelete { ids } => {
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            let (deleted_ids, skipped) = delete_macros(&mut macros, &ids);
            for id in &deleted_ids {
                transaction
                    .execute("DELETE FROM macros WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            Ok(json!({
                "deletedIds": deleted_ids,
                "skipped": skipped.into_iter().map(|(id, reason, related_names)| json!({
                    "id": id,
                    "reason": reason,
                    "relatedNames": related_names
                })).collect::<Vec<_>>()
            }))
        }
        StateMutation::MacrosClearRole { role_id } => {
            let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
            clear_macro_role(&mut macros, &role_id);
            sync_macros(&transaction, &macros)?;
            Ok(json!({ "cleared": true }))
        }
        StateMutation::CompatibilityReportSave(report) => {
            let mut report = *report;
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            if !games.iter().any(|game| game.id == report.game_id) {
                return Err(CoreError::Domain {
                    code: "GAME_NOT_FOUND",
                    message: "Game not found.".to_owned(),
                });
            }
            let mut reports = read_typed_collection::<StateCompatibilityReportRecord>(
                &transaction,
                "compatibilityReports",
            )?;
            if let Some(index) = reports
                .iter()
                .position(|current| current.game_id == report.game_id)
            {
                report.observations = merge_compatibility_observations(
                    &reports[index].observations,
                    report.observations,
                );
                reports[index] = report.clone();
            } else {
                reports.push(report.clone());
            }
            let ordinal = reports
                .iter()
                .position(|item| item.game_id == report.game_id)
                .unwrap();
            upsert_compatibility(&transaction, &json_value(&report)?, ordinal)?;
            serde_json::to_value(report)
        }
        StateMutation::CompatibilityReportRecordObservation {
            game_id,
            observation,
        } => {
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            if !games.iter().any(|game| game.id == game_id) {
                return Err(CoreError::Domain {
                    code: "GAME_NOT_FOUND",
                    message: "Game not found.".to_owned(),
                });
            }
            let mut reports = read_typed_collection::<StateCompatibilityReportRecord>(
                &transaction,
                "compatibilityReports",
            )?;
            let index = reports
                .iter()
                .position(|current| current.game_id == game_id);
            let mut report = index
                .map(|index| reports[index].clone())
                .unwrap_or_else(|| StateCompatibilityReportRecord {
                    game_id: game_id.clone(),
                    checked_at: None,
                    configuration_fingerprint: None,
                    is_stale: false,
                    load: None,
                    graphics: None,
                    system_chrome: None,
                    recommendation: None,
                    observations: StateCompatibilityObservationsRecord {
                        last_embedded_success_at: None,
                        last_external_success_at: None,
                        last_fallback_at: None,
                        last_launch_failure_at: None,
                        last_launch_failure_code: None,
                    },
                });
            report.observations =
                merge_compatibility_observations(&report.observations, observation);
            if let Some(index) = index {
                reports[index] = report.clone();
            } else {
                reports.push(report.clone());
            }
            let ordinal = reports
                .iter()
                .position(|item| item.game_id == game_id)
                .unwrap();
            upsert_compatibility(&transaction, &json_value(&report)?, ordinal)?;
            serde_json::to_value(report)
        }
        StateMutation::CompatibilityReportDelete { game_id } => {
            transaction
                .execute(
                    "DELETE FROM compatibility_reports WHERE game_id=?1",
                    params![game_id],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            Ok(json!({ "deleted": true }))
        }
    }
    .map_err(|error| CoreError::Internal(error.to_string()))?;
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(json!({ "revision": revision, "value": result }))
}

fn normalize_bulk_ids(ids: Vec<String>) -> CoreResult<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() {
            return Err(CoreError::InvalidInput(
                "Bulk delete input is invalid.".to_owned(),
            ));
        }
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    Ok(normalized)
}

fn bulk_skip(id: String, reason: &str, related_names: Vec<String>) -> Value {
    json!({
        "id": id,
        "reason": reason,
        "relatedNames": related_names
    })
}

fn read_operation_journals(connection: &Connection) -> CoreResult<Vec<OperationJournalRecord>> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind, phase, payload_json
             FROM operation_journal ORDER BY created_at, id",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    rows.map(|row| {
        let (id, kind, phase, payload) =
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        Ok(OperationJournalRecord {
            id,
            kind,
            phase,
            payload: serde_json::from_str(&payload)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        })
    })
    .collect()
}

fn put_operation_journal(
    connection: &Connection,
    record: &OperationJournalRecord,
) -> CoreResult<()> {
    let payload = serde_json::to_string(&record.payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO operation_journal(id, kind, phase, payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               phase=excluded.phase,
               payload_json=excluded.payload_json,
               updated_at=excluded.updated_at",
            params![
                record.id,
                record.kind,
                record.phase,
                payload,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn delete_operation_journal(connection: &Connection, id: &str) -> CoreResult<()> {
    connection
        .execute("DELETE FROM operation_journal WHERE id=?1", params![id])
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn set_operation_journal_phase(connection: &Connection, id: &str, phase: &str) -> CoreResult<()> {
    let changed = connection
        .execute(
            "UPDATE operation_journal SET phase=?2, updated_at=?3 WHERE id=?1",
            params![id, phase, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if changed == 0 {
        return Err(CoreError::StateDatabase(
            "operation journal was not found".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workspace_role_references(
    workspace: &crate::model::StateLaunchWorkspaceRecord,
    roles: &[crate::model::StateRoleRecord],
) -> CoreResult<()> {
    if workspace
        .slots
        .iter()
        .filter_map(|slot| slot.role_id.as_ref())
        .any(|id| !roles.iter().any(|role| &role.id == id))
    {
        Err(CoreError::Domain {
            code: "WORKSPACE_ROLE_INVALID",
            message: "Launch workspace role was not found.".to_owned(),
        })
    } else {
        Ok(())
    }
}

fn validate_macro_role_references(
    macro_record: &StateMacroRecord,
    roles: &[crate::model::StateRoleRecord],
) -> CoreResult<()> {
    if macro_record
        .role_ids
        .iter()
        .any(|id| !roles.iter().any(|role| &role.id == id))
    {
        Err(CoreError::Domain {
            code: "MACRO_ROLE_ID_INVALID",
            message: "Macro role assignment is invalid.".to_owned(),
        })
    } else {
        Ok(())
    }
}

fn merge_compatibility_observations(
    current: &StateCompatibilityObservationsRecord,
    update: StateCompatibilityObservationsRecord,
) -> StateCompatibilityObservationsRecord {
    StateCompatibilityObservationsRecord {
        last_embedded_success_at: update
            .last_embedded_success_at
            .or_else(|| current.last_embedded_success_at.clone()),
        last_external_success_at: update
            .last_external_success_at
            .or_else(|| current.last_external_success_at.clone()),
        last_fallback_at: update
            .last_fallback_at
            .or_else(|| current.last_fallback_at.clone()),
        last_launch_failure_at: update
            .last_launch_failure_at
            .or_else(|| current.last_launch_failure_at.clone()),
        last_launch_failure_code: update
            .last_launch_failure_code
            .or_else(|| current.last_launch_failure_code.clone()),
    }
}

fn read_macro_configuration(
    connection: &Connection,
) -> CoreResult<(Vec<MacroDefinition>, MacroRuntimeSettings)> {
    let macros = read_payloads(connection, "macros")?;
    let macros = serde_json::from_value::<Vec<StateMacroRecord>>(macros)
        .map_err(|error| CoreError::StateDatabase(format!("stored macros are invalid: {error}")))?
        .into_iter()
        .map(|record| MacroDefinition {
            id: record.id,
            enabled: record.enabled,
            activation_mode: record.activation_mode,
            name: record.name,
            role_ids: record.role_ids,
            trigger: record.trigger,
            repeat: record.repeat,
            steps: record.steps,
        })
        .collect();
    let settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='macroSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .map(|payload| {
            serde_json::from_str::<MacroSettingsRecord>(&payload).map_err(|error| {
                CoreError::StateDatabase(format!("stored macro settings are invalid: {error}"))
            })
        })
        .transpose()?
        .unwrap_or_else(default_macro_settings);
    Ok((
        macros,
        MacroRuntimeSettings {
            startup_delay_ms: settings.startup_delay_ms,
            key_hold_ms: settings.key_hold_ms,
            post_input_delay_ms: settings.post_input_delay_ms,
            default_loop_delay_ms: settings.default_loop_delay_ms,
        },
    ))
}

fn read_overlay_configuration(
    connection: &Connection,
) -> CoreResult<(Vec<MacroDefinition>, MacroBadgePositionRecord)> {
    let (macros, _) = read_macro_configuration(connection)?;
    let settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .map(|payload| {
            serde_json::from_str::<GameBrowserSettingsRecord>(&payload).map_err(|error| {
                CoreError::StateDatabase(format!(
                    "stored game browser settings are invalid: {error}"
                ))
            })
        })
        .transpose()?
        .unwrap_or_else(default_game_browser_settings);
    Ok((macros, settings.macro_badge_position))
}

fn recover_sqlite_portable_import(
    connection: &mut Connection,
    user_data_dir: &Path,
) -> CoreResult<bool> {
    let Some(plan) = portable_recovery::load(user_data_dir)? else {
        return Ok(false);
    };
    if plan.storage_kind != StorageKind::Sqlite {
        return Ok(false);
    }
    let mut snapshot = read_snapshot(connection)?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| CoreError::StateDatabase("state snapshot must be an object".to_owned()))?;
    object.extend(plan.snapshot_fields);
    replace_snapshot(connection, &snapshot)?;
    portable_recovery::finish(user_data_dir, &plan.remove_created_role_ids)?;
    Ok(true)
}

pub(super) fn create_schema(connection: &Connection, runtime: bool) -> CoreResult<()> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute_batch(if runtime {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            );",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let newest_version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<u32>>(0)
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .unwrap_or(0);
    if newest_version > SCHEMA_VERSION {
        return Err(CoreError::StateDatabase(format!(
            "database schema {newest_version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS games (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS game_images (
              game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
              field TEXT NOT NULL CHECK(field IN ('iconImageDataUrl', 'coverImageDataUrl')),
              mime TEXT NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY(game_id, field)
            );
            CREATE TABLE IF NOT EXISTS roles (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS role_images (
              role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
              field TEXT NOT NULL CHECK(field = 'coverImageDataUrl'),
              mime TEXT NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY(role_id, field)
            );
            CREATE INDEX IF NOT EXISTS roles_game_id_idx ON roles(game_id, ordinal);
            CREATE TABLE IF NOT EXISTS workspaces (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspace_slots (
              workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY(workspace_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS workspace_slots_role_idx ON workspace_slots(role_id);
            CREATE TABLE IF NOT EXISTS macros (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS macro_roles (
              macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
              PRIMARY KEY(macro_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS macro_roles_role_idx ON macro_roles(role_id);
            CREATE TABLE IF NOT EXISTS macro_steps (
              macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY(macro_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS legal_acceptance (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS compatibility_reports (
              game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if newest_version < 1 {
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
                params![chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    if newest_version < 2 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE state_revision (
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   revision INTEGER NOT NULL CHECK(revision >= 0)
                 );
                 INSERT INTO state_revision(singleton, revision)
                 VALUES (1, COALESCE(
                   (SELECT CAST(value AS INTEGER) FROM metadata WHERE key='revision'),
                   0
                 ));
                 INSERT INTO schema_migrations(version, applied_at)
                 VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
                 COMMIT;",
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    if newest_version < 3 {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        repair_required_settings(&transaction)?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?1)",
                params![chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    if newest_version < 4 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS operation_journal (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   phase TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS operation_journal_kind_phase_idx
                   ON operation_journal(kind, phase);
                 INSERT INTO schema_migrations(version, applied_at)
                 VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
                 COMMIT;",
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    if newest_version < 5 {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        strip_workspace_resource_policies(&transaction)?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?1)",
                params![chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    repair_optional_log_level(connection)?;
    Ok(())
}

fn repair_optional_log_level(connection: &Connection) -> CoreResult<()> {
    let payload = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='logLevel'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if payload
        .as_deref()
        .is_some_and(|payload| serde_json::from_str::<LogLevel>(payload).is_err())
    {
        connection
            .execute("DELETE FROM settings WHERE key='logLevel'", [])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn strip_workspace_resource_policies(connection: &Connection) -> CoreResult<()> {
    let mut statement = connection
        .prepare("SELECT id, payload_json FROM workspaces")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    drop(statement);

    for (id, payload) in rows {
        let mut value = parse_payload(&payload)?;
        let object = value.as_object_mut().ok_or_else(|| {
            CoreError::Migration(format!("stored workspace {id} must be an object"))
        })?;
        if object.remove("resourcePolicy").is_none() {
            continue;
        }
        connection
            .execute(
                "UPDATE workspaces SET payload_json=?1 WHERE id=?2",
                params![serialize_payload(&value)?, id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn repair_required_settings(connection: &Connection) -> CoreResult<()> {
    let browser_settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<GameBrowserSettingsRecord>(&payload).ok())
        .map(normalize_game_browser_settings)
        .unwrap_or_else(default_game_browser_settings);
    let macro_settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='macroSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<MacroSettingsRecord>(&payload).ok())
        .map(normalize_macro_settings)
        .unwrap_or_else(default_macro_settings);
    let window_preferences = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='runtimeWindowPreferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<RuntimeWindowPreferencesRecord>(&payload).ok())
        .unwrap_or_else(default_runtime_window_preferences);

    for (key, payload) in [
        (
            "gameBrowserSettings",
            serde_json::to_string(&browser_settings)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
        (
            "macroSettings",
            serde_json::to_string(&macro_settings)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
        (
            "runtimeWindowPreferences",
            serde_json::to_string(&window_preferences)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
    ] {
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                params![key, payload],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

pub(super) fn import_legacy_files(
    connection: &mut Connection,
    user_data_dir: &Path,
) -> CoreResult<()> {
    let snapshot = legacy::build_snapshot(user_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    replace_snapshot_transaction(&transaction, &snapshot)?;
    transaction
        .commit()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    Ok(())
}

pub(super) fn read_snapshot(connection: &Connection) -> CoreResult<Value> {
    let mut object = Map::new();
    object.insert("games".to_owned(), read_payloads(connection, "games")?);
    object.insert("roles".to_owned(), read_payloads(connection, "roles")?);
    object.insert(
        "launchWorkspaces".to_owned(),
        read_payloads(connection, "workspaces")?,
    );
    object.insert("macros".to_owned(), read_payloads(connection, "macros")?);
    object.insert(
        "compatibilityReports".to_owned(),
        read_payloads(connection, "compatibility_reports")?,
    );
    let mut statement = connection
        .prepare("SELECT key, payload_json FROM settings ORDER BY key")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (key, payload) = row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        object.insert(key, parse_payload(&payload)?);
    }
    if let Some(payload) = connection
        .query_row(
            "SELECT payload_json FROM legal_acceptance WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    {
        object.insert("legalAcceptance".to_owned(), parse_payload(&payload)?);
    }
    Ok(Value::Object(object))
}

fn read_scalar(connection: &Connection, key: &str) -> CoreResult<Option<Value>> {
    let payload = if key == "legalAcceptance" {
        connection
            .query_row(
                "SELECT payload_json FROM legal_acceptance WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
    } else if matches!(
        key,
        "gameBrowserSettings" | "macroSettings" | "runtimeWindowPreferences" | "logLevel"
    ) {
        connection
            .query_row(
                "SELECT payload_json FROM settings WHERE key=?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
    } else {
        return Err(CoreError::InvalidInput(format!(
            "scalar state key is invalid: {key}"
        )));
    }
    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    payload.map(|payload| parse_payload(&payload)).transpose()
}

fn collection_table(collection: &str) -> CoreResult<(&'static str, &'static str)> {
    match collection {
        "games" => Ok(("games", "id")),
        "roles" => Ok(("roles", "id")),
        "launchWorkspaces" => Ok(("workspaces", "id")),
        "macros" => Ok(("macros", "id")),
        "compatibilityReports" => Ok(("compatibility_reports", "game_id")),
        _ => Err(CoreError::InvalidInput(format!(
            "state collection is invalid: {collection}"
        ))),
    }
}

fn read_collection(connection: &Connection, collection: &str) -> CoreResult<Value> {
    let (table, _) = collection_table(collection)?;
    read_payloads(connection, table)
}

fn read_typed_collection<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    collection: &str,
) -> CoreResult<Vec<T>> {
    serde_json::from_value(read_collection(connection, collection)?).map_err(|error| {
        CoreError::StateDatabase(format!("stored {collection} are invalid: {error}"))
    })
}

fn read_record(connection: &Connection, collection: &str, id: &str) -> CoreResult<Option<Value>> {
    let (table, id_column) = collection_table(collection)?;
    let sql = format!("SELECT payload_json FROM {table} WHERE {id_column}=?1");
    let payload = connection
        .query_row(&sql, params![id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let mut value = parse_payload(&payload)?;
    if matches!(table, "games" | "roles") {
        restore_entity_images(connection, table, std::slice::from_mut(&mut value))?;
    }
    Ok(Some(value))
}

fn read_payloads(connection: &Connection, table: &str) -> CoreResult<Value> {
    let sql = format!("SELECT payload_json FROM {table} ORDER BY ordinal");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let mut values = rows
        .map(|row| {
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))
                .and_then(|payload| parse_payload(&payload))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    if matches!(table, "games" | "roles") {
        restore_entity_images(connection, table, &mut values)?;
    }
    Ok(Value::Array(values))
}

pub(super) fn replace_snapshot(connection: &mut Connection, snapshot: &Value) -> CoreResult<u64> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    replace_snapshot_transaction(&transaction, snapshot)?;
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(revision)
}

fn replace_snapshot_if_changed(
    connection: &mut Connection,
    snapshot: &Value,
) -> CoreResult<(u64, bool)> {
    if read_snapshot(connection)? == *snapshot {
        return Ok((read_revision(connection)?, false));
    }
    Ok((replace_snapshot(connection, snapshot)?, true))
}

fn replace_scalar(connection: &mut Connection, key: &str, value: Value) -> CoreResult<u64> {
    if !matches!(
        key,
        "gameBrowserSettings"
            | "macroSettings"
            | "runtimeWindowPreferences"
            | "legalAcceptance"
            | "logLevel"
    ) {
        return Err(CoreError::InvalidInput(format!(
            "scalar state key is invalid: {key}"
        )));
    }
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if key == "legalAcceptance" {
        transaction
            .execute(
                "INSERT INTO legal_acceptance(singleton, payload_json) VALUES (1, ?1)
                 ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json",
                params![serialize_payload(&value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    } else {
        transaction
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                params![key, serialize_payload(&value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(revision)
}

fn apply_profile_roles(
    connection: &mut Connection,
    roles: Vec<crate::model::StateRoleRecord>,
) -> CoreResult<u64> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
    let previous_roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
    validate_profile_roles(&games, &roles)?;
    let target_ids = roles
        .iter()
        .map(|role| role.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let removed_role_ids = previous_roles
        .iter()
        .filter(|role| !target_ids.contains(role.id.as_str()))
        .map(|role| role.id.clone())
        .collect::<Vec<_>>();
    for role in &previous_roles {
        if !target_ids.contains(role.id.as_str()) {
            transaction
                .execute("DELETE FROM roles WHERE id=?1", params![role.id])
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    for (ordinal, role) in roles.iter().enumerate() {
        upsert_entity(&transaction, "roles", &json_value(role)?, ordinal)?;
    }
    if !removed_role_ids.is_empty() {
        let mut workspaces =
            read_typed_collection::<StateLaunchWorkspaceRecord>(&transaction, "launchWorkspaces")?;
        let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
        for role_id in removed_role_ids {
            clear_workspace_role(&mut workspaces, &role_id);
            clear_macro_role(&mut macros, &role_id);
        }
        sync_workspaces(&transaction, &workspaces)?;
        sync_macros(&transaction, &macros)?;
    }
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(revision)
}

fn validate_profile_roles(games: &[StateGameRecord], roles: &[StateRoleRecord]) -> CoreResult<()> {
    let mut identities = std::collections::HashSet::new();
    for role in roles {
        if !games.iter().any(|game| game.id == role.game_id) {
            return Err(CoreError::Domain {
                code: "ROLE_GAME_INVALID",
                message: "Role game is invalid.".to_owned(),
            });
        }
        let identity = (role.game_id.clone(), role.name.trim().to_lowercase());
        if role.name.trim().is_empty() || !identities.insert(identity) {
            return Err(CoreError::Domain {
                code: "ROLE_NAME_DUPLICATE",
                message: "A role with this name already exists.".to_owned(),
            });
        }
        crate::domain::validate_collection_record(
            crate::model::StateCollection::Roles,
            &json_value(role)?,
        )?;
    }
    Ok(())
}

fn replace_snapshot_transaction(transaction: &Transaction<'_>, snapshot: &Value) -> CoreResult<()> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| CoreError::InvalidInput("state snapshot must be an object".to_owned()))?;
    validate_macro_graph(array_field(object, "macros")?)?;
    transaction
        .execute_batch(
            "
            DELETE FROM workspace_slots;
            DELETE FROM workspaces;
            DELETE FROM macro_steps;
            DELETE FROM macro_roles;
            DELETE FROM macros;
            DELETE FROM compatibility_reports;
            DELETE FROM role_images;
            DELETE FROM roles;
            DELETE FROM game_images;
            DELETE FROM games;
            DELETE FROM settings;
            DELETE FROM legal_acceptance;
            ",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    insert_entities(transaction, "games", array_field(object, "games")?)?;
    insert_entities(transaction, "roles", array_field(object, "roles")?)?;
    insert_workspaces(transaction, array_field(object, "launchWorkspaces")?)?;
    insert_macros(transaction, array_field(object, "macros")?)?;
    insert_compatibility(transaction, array_field(object, "compatibilityReports")?)?;
    for key in [
        "gameBrowserSettings",
        "macroSettings",
        "runtimeWindowPreferences",
        "logLevel",
    ] {
        if let Some(value) = object.get(key) {
            transaction
                .execute(
                    "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)",
                    params![key, serialize_payload(value)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    if let Some(value) = object.get("legalAcceptance") {
        transaction
            .execute(
                "INSERT INTO legal_acceptance(singleton, payload_json) VALUES (1, ?1)",
                params![serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    let hash = snapshot_hash(snapshot)?;
    let row_count = [
        "games",
        "roles",
        "launchWorkspaces",
        "macros",
        "compatibilityReports",
    ]
    .into_iter()
    .map(|key| array_field(object, key).map(<[Value]>::len))
    .try_fold(0_usize, |total, count| {
        count.map(|count| total.saturating_add(count))
    })?;
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('snapshot_sha256', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![hash],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('snapshot_row_count', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![row_count.to_string()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn insert_entities(transaction: &Transaction<'_>, table: &str, values: &[Value]) -> CoreResult<()> {
    let sql = match table {
        "games" => "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
        "roles" => {
            "INSERT INTO roles(id, ordinal, game_id, name, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)"
        }
        _ => return Err(CoreError::Internal("invalid entity table".to_owned())),
    };
    let mut statement = transaction
        .prepare(sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, table)?;
        let id = required_string(object, "id", table)?;
        let name = required_string(object, "name", table)?;
        let (payload, images) = split_entity_images(table, value)?;
        if table == "games" {
            statement.execute(params![
                id,
                ordinal as i64,
                name,
                serialize_payload(&payload)?
            ])
        } else {
            let game_id = object.get("gameId").and_then(Value::as_str).unwrap_or("");
            statement.execute(params![
                id,
                ordinal as i64,
                game_id,
                name,
                serialize_payload(&payload)?
            ])
        }
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        insert_entity_images(transaction, table, id, images)?;
    }
    Ok(())
}

struct EntityImage {
    field: String,
    mime: String,
    data: Vec<u8>,
}

fn split_entity_images(table: &str, value: &Value) -> CoreResult<(Value, Vec<EntityImage>)> {
    let mut payload = value.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| CoreError::InvalidInput(format!("{table} must be an object")))?;
    let fields: &[&str] = match table {
        "games" => &["iconImageDataUrl", "coverImageDataUrl"],
        "roles" => &["coverImageDataUrl"],
        _ => &[],
    };
    let mut images = Vec::new();
    for field in fields {
        let Some(value) = object.remove(*field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let data_url = value.as_str().ok_or_else(|| {
            CoreError::InvalidInput(format!("{table}.{field} must be an image data URL"))
        })?;
        let (mime, encoded) = data_url.split_once(";base64,").ok_or_else(|| {
            CoreError::InvalidInput(format!("{table}.{field} must be an image data URL"))
        })?;
        if !matches!(
            mime,
            "data:image/png"
                | "data:image/jpeg"
                | "data:image/jpg"
                | "data:image/webp"
                | "data:image/gif"
        ) {
            return Err(CoreError::InvalidInput(format!(
                "{table}.{field} uses an unsupported image MIME type"
            )));
        }
        let data = BASE64.decode(encoded).map_err(|error| {
            CoreError::InvalidInput(format!("{table}.{field} has invalid base64: {error}"))
        })?;
        images.push(EntityImage {
            field: (*field).to_owned(),
            mime: mime.trim_start_matches("data:").to_owned(),
            data,
        });
    }
    Ok((payload, images))
}

fn insert_entity_images(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    images: Vec<EntityImage>,
) -> CoreResult<()> {
    let (image_table, id_column) = match table {
        "games" => ("game_images", "game_id"),
        "roles" => ("role_images", "role_id"),
        _ => return Ok(()),
    };
    let sql = format!(
        "INSERT INTO {image_table}({id_column}, field, mime, data) VALUES (?1, ?2, ?3, ?4)"
    );
    let mut statement = transaction
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for image in images {
        statement
            .execute(params![id, image.field, image.mime, image.data])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn restore_entity_images(
    connection: &Connection,
    table: &str,
    values: &mut [Value],
) -> CoreResult<()> {
    let (image_table, id_column) = match table {
        "games" => ("game_images", "game_id"),
        "roles" => ("role_images", "role_id"),
        _ => return Ok(()),
    };
    let mut by_id = HashMap::<String, usize>::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_owned(), index);
        }
    }
    let sql = format!(
        "SELECT {id_column}, field, mime, data FROM {image_table} ORDER BY {id_column}, field"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (id, field, mime, data) =
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let Some(index) = by_id.get(&id).copied() else {
            continue;
        };
        let object = values[index].as_object_mut().ok_or_else(|| {
            CoreError::StateDatabase("entity payload must be an object".to_owned())
        })?;
        object.insert(
            field,
            Value::String(format!("data:{mime};base64,{}", BASE64.encode(data))),
        );
    }
    Ok(())
}

fn insert_workspaces(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "workspace")?;
        let id = required_string(object, "id", "workspace")?;
        let name = required_string(object, "name", "workspace")?;
        transaction
            .execute(
                "INSERT INTO workspaces(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, ordinal as i64, name, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let slots = object
            .get("slots")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidInput(format!("workspace {id} has invalid slots")))?;
        for (slot_ordinal, slot) in slots.iter().enumerate() {
            let role_id = slot.get("roleId").and_then(Value::as_str);
            transaction
                .execute(
                    "INSERT INTO workspace_slots(workspace_id, ordinal, role_id, payload_json)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, slot_ordinal as i64, role_id, serialize_payload(slot)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn insert_macros(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "macro")?;
        let id = required_string(object, "id", "macro")?;
        let name = required_string(object, "name", "macro")?;
        transaction
            .execute(
                "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, ordinal as i64, name, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let role_ids = object
            .get("roleIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (role_ordinal, role_id) in role_ids.iter().enumerate() {
            let role_id = role_id.as_str().ok_or_else(|| {
                CoreError::InvalidInput(format!("macro {id} contains an invalid role id"))
            })?;
            transaction
                .execute(
                    "INSERT INTO macro_roles(macro_id, ordinal, role_id) VALUES (?1, ?2, ?3)",
                    params![id, role_ordinal as i64, role_id],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
        let steps = object
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidInput(format!("macro {id} has invalid steps")))?;
        for (step_ordinal, step) in steps.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO macro_steps(macro_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                    params![id, step_ordinal as i64, serialize_payload(step)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn insert_compatibility(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "compatibility report")?;
        let game_id = required_string(object, "gameId", "compatibility report")?;
        transaction
            .execute(
                "INSERT INTO compatibility_reports(game_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                params![game_id, ordinal as i64, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn upsert_entity(
    transaction: &Transaction<'_>,
    table: &str,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, table)?;
    let id = required_string(object, "id", table)?;
    let name = required_string(object, "name", table)?;
    let (payload, images) = split_entity_images(table, value)?;
    match table {
        "games" => transaction.execute(
            "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(&payload)?],
        ),
        "roles" => transaction.execute(
            "INSERT INTO roles(id, ordinal, game_id, name, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, game_id=excluded.game_id,
               name=excluded.name, payload_json=excluded.payload_json",
            params![
                id,
                ordinal as i64,
                object.get("gameId").and_then(Value::as_str).unwrap_or(""),
                name,
                serialize_payload(&payload)?
            ],
        ),
        _ => return Err(CoreError::Internal("invalid entity table".to_owned())),
    }
    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let (image_table, id_column) = if table == "games" {
        ("game_images", "game_id")
    } else {
        ("role_images", "role_id")
    };
    transaction
        .execute(
            &format!("DELETE FROM {image_table} WHERE {id_column}=?1"),
            params![id],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    insert_entity_images(transaction, table, id, images)
}

fn upsert_workspace(
    transaction: &Transaction<'_>,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, "workspace")?;
    let id = required_string(object, "id", "workspace")?;
    let name = required_string(object, "name", "workspace")?;
    transaction
        .execute(
            "INSERT INTO workspaces(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute(
            "DELETE FROM workspace_slots WHERE workspace_id=?1",
            params![id],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (slot_ordinal, slot) in object
        .get("slots")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidInput(format!("workspace {id} has invalid slots")))?
        .iter()
        .enumerate()
    {
        transaction
            .execute(
                "INSERT INTO workspace_slots(workspace_id, ordinal, role_id, payload_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    id,
                    slot_ordinal as i64,
                    slot.get("roleId").and_then(Value::as_str),
                    serialize_payload(slot)?
                ],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn upsert_macro(transaction: &Transaction<'_>, value: &Value, ordinal: usize) -> CoreResult<()> {
    let object = entity_object(value, "macro")?;
    let id = required_string(object, "id", "macro")?;
    let name = required_string(object, "name", "macro")?;
    transaction
        .execute(
            "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute("DELETE FROM macro_roles WHERE macro_id=?1", params![id])
        .and_then(|_| transaction.execute("DELETE FROM macro_steps WHERE macro_id=?1", params![id]))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (role_ordinal, role_id) in object
        .get("roleIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let role_id = role_id.as_str().ok_or_else(|| {
            CoreError::InvalidInput(format!("macro {id} contains an invalid role id"))
        })?;
        transaction
            .execute(
                "INSERT INTO macro_roles(macro_id, ordinal, role_id) VALUES (?1, ?2, ?3)",
                params![id, role_ordinal as i64, role_id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    for (step_ordinal, step) in object
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidInput(format!("macro {id} has invalid steps")))?
        .iter()
        .enumerate()
    {
        transaction
            .execute(
                "INSERT INTO macro_steps(macro_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                params![id, step_ordinal as i64, serialize_payload(step)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn upsert_compatibility(
    transaction: &Transaction<'_>,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, "compatibility report")?;
    let game_id = required_string(object, "gameId", "compatibility report")?;
    transaction
        .execute(
            "INSERT INTO compatibility_reports(game_id, ordinal, payload_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(game_id) DO UPDATE SET ordinal=excluded.ordinal,
               payload_json=excluded.payload_json",
            params![game_id, ordinal as i64, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn sync_workspaces(
    transaction: &Transaction<'_>,
    workspaces: &[crate::model::StateLaunchWorkspaceRecord],
) -> CoreResult<()> {
    for (ordinal, workspace) in workspaces.iter().enumerate() {
        upsert_workspace(transaction, &json_value(workspace)?, ordinal)?;
    }
    Ok(())
}

fn sync_macros(transaction: &Transaction<'_>, macros: &[StateMacroRecord]) -> CoreResult<()> {
    for (ordinal, macro_record) in macros.iter().enumerate() {
        upsert_macro(transaction, &json_value(macro_record)?, ordinal)?;
    }
    Ok(())
}

fn update_ordinals(transaction: &Transaction<'_>, table: &str, ids: &[String]) -> CoreResult<()> {
    if !matches!(table, "roles" | "workspaces") {
        return Err(CoreError::Internal("invalid ordinal table".to_owned()));
    }
    let sql = format!("UPDATE {table} SET ordinal=?1 WHERE id=?2");
    for (ordinal, id) in ids.iter().enumerate() {
        transaction
            .execute(&sql, params![ordinal as i64, id])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn json_value(value: &impl serde::Serialize) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Internal(error.to_string()))
}

fn increment_revision(transaction: &Transaction<'_>) -> CoreResult<u64> {
    let current = transaction
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .unwrap_or(0)
        .max(0) as u64;
    let next = current.saturating_add(1);
    transaction
        .execute(
            "INSERT INTO state_revision(singleton, revision) VALUES (1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision",
            params![i64::try_from(next).unwrap_or(i64::MAX)],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(next)
}

fn read_revision(connection: &Connection) -> CoreResult<u64> {
    connection
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|revision| revision.max(0) as u64)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn read_metadata(connection: &Connection) -> CoreResult<Value> {
    let mut values = Map::new();
    let mut statement = connection
        .prepare("SELECT key, value FROM metadata ORDER BY key")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (key, value) = row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        values.insert(key, Value::String(value));
    }
    let revision = connection
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    values.insert("revision".to_owned(), Value::String(revision.to_string()));
    values.insert("schemaVersion".to_owned(), json!(SCHEMA_VERSION));
    Ok(Value::Object(values))
}

fn array_field<'a>(object: &'a Map<String, Value>, key: &str) -> CoreResult<&'a [Value]> {
    match object.get(key) {
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| CoreError::InvalidInput(format!("{key} must be an array"))),
        None => Ok(&[]),
    }
}

fn entity_object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::InvalidInput(format!("{label} must be an object")))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> CoreResult<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CoreError::InvalidInput(format!("{label} requires {key}")))
}

fn serialize_payload(value: &Value) -> CoreResult<String> {
    serde_json::to_string(value).map_err(|error| CoreError::InvalidInput(error.to_string()))
}

fn parse_payload(value: &str) -> CoreResult<Value> {
    serde_json::from_str(value).map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn snapshot_hash(snapshot: &Value) -> CoreResult<String> {
    let serialized = serialize_payload(snapshot)?;
    Ok(format!("{:x}", Sha256::digest(serialized.as_bytes())))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn seeds_recommended_graphics_defaults_and_preserves_explicit_settings_on_restart() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("rion-studio.sqlite3");
        let recommended = serde_json::to_value(default_game_browser_settings()).unwrap();

        let first_plan = crate::bootstrap_settings::read_plan(
            directory.path(),
            rion_platform::Platform::Macos,
            "",
            "",
        );
        assert_eq!(
            first_plan.applied_graphics_settings,
            crate::model::BrowserGraphicsSettingsRecord::recommended_default()
        );

        {
            let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
            assert_eq!(
                worker
                    .read_scalar("gameBrowserSettings".to_owned())
                    .unwrap(),
                Some(recommended.clone())
            );
        }

        let second_plan = crate::bootstrap_settings::read_plan(
            directory.path(),
            rion_platform::Platform::Macos,
            "",
            "",
        );
        assert_eq!(
            second_plan.applied_graphics_settings,
            crate::model::BrowserGraphicsSettingsRecord::recommended_default()
        );

        let mut settings_without_eco_qos = recommended.clone();
        settings_without_eco_qos["graphics"]
            .as_object_mut()
            .unwrap()
            .remove("windowsEcoQosEnabled");
        {
            let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
            worker
                .replace_scalar("gameBrowserSettings".to_owned(), settings_without_eco_qos)
                .unwrap();
        }
        let migrated_plan = crate::bootstrap_settings::read_plan(
            directory.path(),
            rion_platform::Platform::Windows,
            "",
            "",
        );
        assert!(
            migrated_plan
                .applied_graphics_settings
                .windows_eco_qos_enabled
        );

        let mut explicit = default_game_browser_settings();
        explicit.graphics =
            crate::model::BrowserGraphicsSettingsRecord::from_legacy_mode("automatic");
        explicit.graphics.windows_eco_qos_enabled = false;
        let expected_graphics = explicit.graphics.clone();
        let explicit = serde_json::to_value(explicit).unwrap();
        {
            let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
            worker
                .replace_scalar("gameBrowserSettings".to_owned(), explicit.clone())
                .unwrap();
        }
        {
            let worker = StateDatabaseWorker::start(database_path).unwrap();
            assert_eq!(
                worker
                    .read_scalar("gameBrowserSettings".to_owned())
                    .unwrap(),
                Some(explicit)
            );
        }

        let preserved_plan = crate::bootstrap_settings::read_plan(
            directory.path(),
            rion_platform::Platform::Windows,
            "",
            "",
        );
        assert_eq!(preserved_plan.applied_graphics_settings, expected_graphics);
    }

    #[test]
    fn snapshot_round_trips_in_one_transaction() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("state.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        let snapshot = json!({
          "games": [{"id":"g1","name":"Game"}],
          "roles": [{"id":"r1","gameId":"g1","name":"Role"}],
          "launchWorkspaces": [{"id":"w1","name":"Workspace","slots":[{"id":"s1","roleId":"r1"}]}],
          "macros": [{"id":"m1","name":"Macro","roleIds":["r1"],"steps":[]}],
          "compatibilityReports": [],
          "logLevel": "debug"
        });
        replace_snapshot(&mut connection, &snapshot).unwrap();
        assert_eq!(read_snapshot(&connection).unwrap(), snapshot);
    }

    #[test]
    fn identical_snapshot_replace_preserves_revision() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let snapshot = json!({
          "games": [{"id":"g1","name":"Game"}],
          "roles": [{"id":"r1","gameId":"g1","name":"Role"}],
          "launchWorkspaces": [],
          "macros": [],
          "compatibilityReports": []
        });
        let revision = replace_snapshot(&mut connection, &snapshot).unwrap();
        let stored = read_snapshot(&connection).unwrap();

        let (unchanged_revision, changed) =
            replace_snapshot_if_changed(&mut connection, &stored).unwrap();

        assert!(!changed);
        assert_eq!(unchanged_revision, revision);
        assert_eq!(read_revision(&connection).unwrap(), revision);
        assert_eq!(read_snapshot(&connection).unwrap(), stored);
    }

    #[test]
    fn failed_replace_preserves_previous_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({"games":[{"name":"Missing id"}]});
        crate::v1_case!("portable-profile-6ce7f4b873a7", {
            assert!(replace_snapshot(&mut connection, &invalid).is_err());
            assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
            let retry = json!({"games":[{"id":"g2","name":"Retry"}]});
            replace_snapshot(&mut connection, &retry).unwrap();
            assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g2");
        });
    }

    #[test]
    fn foreign_key_failure_rolls_back_the_whole_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({
            "games":[{"id":"g2","name":"Other"}],
            "roles":[{"id":"r1","gameId":"missing","name":"Role"}]
        });

        assert!(replace_snapshot(&mut connection, &invalid).is_err());
        assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
    }

    #[test]
    fn disk_full_during_snapshot_replace_rolls_back_the_transaction() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("state.sqlite3");
        let mut connection = Connection::open(&database_path).unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({"games":[{"id":"g1","name":"Original"}]});
        replace_snapshot(&mut connection, &original).unwrap();
        connection.execute_batch("VACUUM").unwrap();
        let page_count: i64 = connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        connection
            .pragma_update(None, "max_page_count", page_count)
            .unwrap();
        let oversized = json!({
            "games":[{"id":"g2","name":"x".repeat(2 * 1024 * 1024)}]
        });

        assert!(replace_snapshot(&mut connection, &oversized).is_err());
        assert_eq!(
            read_snapshot(&connection).unwrap()["games"],
            original["games"]
        );
    }

    #[test]
    fn replaces_snapshots_that_already_have_compatibility_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{"id":"g1","name":"Game"}],
            "compatibilityReports":[{"gameId":"g1","status":"compatible"}]
        });
        replace_snapshot(&mut connection, &original).unwrap();
        let replacement = json!({
            "games":[{"id":"g2","name":"Other"}],
            "compatibilityReports":[{"gameId":"g2","status":"unknown"}]
        });

        replace_snapshot(&mut connection, &replacement).unwrap();

        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], replacement["games"]);
        assert_eq!(
            stored["compatibilityReports"],
            replacement["compatibilityReports"]
        );
    }

    #[test]
    fn replaces_one_scalar_state_field_without_rewriting_domain_tables() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{
                "id":"g1","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles":[],"launchWorkspaces":[],"macros":[],"compatibilityReports":[],
            "gameBrowserSettings":{"launchMode":"embedded"}
        });
        replace_snapshot(&mut connection, &original).unwrap();

        connection
            .execute_batch(
                "CREATE TRIGGER reject_game_delete BEFORE DELETE ON games
                 BEGIN SELECT RAISE(ABORT, 'domain table rewrite'); END;",
            )
            .unwrap();

        replace_scalar(
            &mut connection,
            "gameBrowserSettings",
            json!({"launchMode":"external"}),
        )
        .unwrap();

        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], original["games"]);
        assert_eq!(
            stored["gameBrowserSettings"],
            json!({"launchMode":"external"})
        );
        assert!(replace_scalar(&mut connection, "games", json!([])).is_err());

        crate::v1_case!("state-migration-d7ddbd1f976f", {
            let settings: GameBrowserSettingsRecord = serde_json::from_value(json!({
                "fonts":{
                    "mode":"custom",
                    "families":{"fixed":"  Courier   New  ","bad":"Ignored"}
                },
                "graphics":{"mode":"automatic"},
                "launchMode":"auto",
                "macroBadgePosition":{
                    "horizontalAlign":"center","horizontalMarginPx":8,"topPx":128
                },
                "network":{
                    "cdnCompatibility":{"mode":"auto"},
                    "proxy":{"mode":"system","server":""}
                },
                "workspace":{"background":"material","gap":4}
            }))
            .unwrap();
            let settings = normalize_game_browser_settings(settings);
            replace_scalar(
                &mut connection,
                "gameBrowserSettings",
                serde_json::to_value(&settings).unwrap(),
            )
            .unwrap();
            let stored: GameBrowserSettingsRecord = serde_json::from_value(
                read_scalar(&connection, "gameBrowserSettings")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(stored.fonts.families["fixed"], "Courier New");
            assert!(!stored.fonts.families.contains_key("bad"));
            let mut changed_copy = stored.clone();
            changed_copy
                .fonts
                .families
                .insert("standard".to_owned(), "Changed".to_owned());
            let reloaded: GameBrowserSettingsRecord = serde_json::from_value(
                read_scalar(&connection, "gameBrowserSettings")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert!(!reloaded.fonts.families.contains_key("standard"));
        });

        crate::v1_case!("state-migration-b46be2776736", {
            let settings = normalize_macro_settings(MacroSettingsRecord {
                startup_delay_ms: 10_001,
                key_hold_ms: 1,
                post_input_delay_ms: 1,
                default_loop_delay_ms: 86_400_001,
            });
            replace_scalar(
                &mut connection,
                "macroSettings",
                serde_json::to_value(&settings).unwrap(),
            )
            .unwrap();
            let mut first: MacroSettingsRecord =
                serde_json::from_value(read_scalar(&connection, "macroSettings").unwrap().unwrap())
                    .unwrap();
            assert_eq!(first.key_hold_ms, 30);
            first.key_hold_ms = 999;
            assert_eq!(first.key_hold_ms, 999);
            let second: MacroSettingsRecord =
                serde_json::from_value(read_scalar(&connection, "macroSettings").unwrap().unwrap())
                    .unwrap();
            assert_eq!(second.key_hold_ms, 30);
        });

        crate::v1_case!("state-migration-961da508a5ff", {
            replace_scalar(
                &mut connection,
                "runtimeWindowPreferences",
                json!({"alwaysShowToolbarInFullScreen":true}),
            )
            .unwrap();
            let reloaded: RuntimeWindowPreferencesRecord = serde_json::from_value(
                read_scalar(&connection, "runtimeWindowPreferences")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert!(reloaded.always_show_toolbar_in_full_screen);
        });
    }

    #[test]
    fn game_and_role_crud_generate_identity_and_validate_relationships_in_rust() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games": [{
                    "id":"builtin-flyff-universe","source":"builtin","builtinKey":"flyff-universe",
                    "name":"Flyff Universe","defaultLaunchUrl":"https://universe.flyff.com/play",
                    "browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles": [], "launchWorkspaces": [], "macros": [], "compatibilityReports": []
            }),
        )
        .unwrap();

        let created_game = apply_domain_mutation(
            &mut connection,
            StateMutation::GameCreate(GameCreateInputRecord {
                name: "  Custom  ".to_owned(),
                default_launch_url: "https://example.test/play".to_owned(),
                icon_image_data_url: None,
                cover_image_data_url: None,
                browser_launch_mode: None,
            }),
        )
        .unwrap();
        let game_id = created_game["value"]["id"].as_str().unwrap().to_owned();
        crate::v1_case!("state-migration-edad5901a646", {
            assert_eq!(created_game["value"]["name"], "Custom");
            assert_eq!(created_game["value"]["browserLaunchMode"], "inherit");
            assert_eq!(
                read_record(&connection, "games", &game_id)
                    .unwrap()
                    .unwrap()["name"],
                "Custom"
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM games WHERE id=?1",
                        params![&game_id],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        });

        let created_role = apply_domain_mutation(
            &mut connection,
            StateMutation::RoleCreate(RoleCreateInputRecord {
                game_id: game_id.clone(),
                name: "  Main  ".to_owned(),
                launch_url: Some("https://example.test/game".to_owned()),
                notes: None,
                cover_image_data_url: None,
                cover_image_dominant_color: None,
            browser_zoom_percent: None,
            }),
        )
        .unwrap();
        assert_eq!(created_role["value"]["name"], "Main");
        assert_eq!(created_role["value"]["gameId"], game_id);
        assert!(created_role["value"]["id"].as_str().unwrap().len() > 20);

        let error = apply_domain_mutation(
            &mut connection,
            StateMutation::GameDelete {
                id: game_id.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "GAME_IN_USE");
        assert_eq!(
            read_snapshot(&connection).unwrap()["games"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn ordinary_crud_never_rewrites_unrelated_domain_tables() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[],"macros":[],"compatibilityReports":[]
            }),
        )
        .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_unrelated_role_delete BEFORE DELETE ON roles
                 BEGIN SELECT RAISE(ABORT, 'unrelated role rewrite'); END;",
            )
            .unwrap();

        apply_domain_mutation(
            &mut connection,
            StateMutation::GameUpdate {
                id: "g1".to_owned(),
                input: GameUpdateInputRecord {
                    name: Some("Renamed".to_owned()),
                    ..GameUpdateInputRecord::default()
                },
            },
        )
        .unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert_eq!(snapshot["games"][0]["name"], "Renamed");
        assert_eq!(snapshot["roles"][0]["id"], "r1");
    }

    #[test]
    fn workspace_and_macro_inputs_are_normalized_and_related_in_rust() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[],"macros":[],"compatibilityReports":[]
            }),
        )
        .unwrap();
        let workspace_input = serde_json::from_value(json!({
            "name":"  Party  ",
            "slots":[{"roleId":"r1"}]
        }))
        .unwrap();
        let workspace = apply_domain_mutation(
            &mut connection,
            StateMutation::WorkspaceCreate(workspace_input),
        )
        .unwrap();
        assert_eq!(workspace["value"]["name"], "Party");
        assert_eq!(workspace["value"]["template"], "two_columns");
        assert_eq!(workspace["value"]["slots"][0]["id"], "slot-1");

        let macro_input = serde_json::from_value(json!({
            "name":"  Buff  ",
            "roleIds":["r1", "r1"],
            "steps":[{"type":"key","code":" F1 ","modifiers":["shift", "shift"]}]
        }))
        .unwrap();
        let macro_record =
            apply_domain_mutation(&mut connection, StateMutation::MacroCreate(macro_input))
                .unwrap();
        assert_eq!(macro_record["value"]["name"], "Buff");
        assert_eq!(macro_record["value"]["roleIds"], json!(["r1"]));
        assert_eq!(macro_record["value"]["steps"][0]["code"], "F1");
        assert!(macro_record["value"]["steps"][0]["id"].is_string());

        let invalid = serde_json::from_value(json!({
            "name":"Invalid","roleIds":["missing"],
            "steps":[{"type":"delay","ms":1}]
        }))
        .unwrap();
        assert_eq!(
            apply_domain_mutation(&mut connection, StateMutation::MacroCreate(invalid))
                .unwrap_err()
                .code(),
            "MACRO_ROLE_ID_INVALID"
        );
    }

    #[test]
    fn upgrades_the_version_one_database_created_by_the_initial_rust_release() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy');
                 INSERT INTO metadata(key, value) VALUES ('revision', '41');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, u32>(0)
                })
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row("SELECT revision FROM state_revision", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            41
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM settings", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            3
        );
        let macro_settings: MacroSettingsRecord = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM settings WHERE key='macroSettings'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(macro_settings.key_hold_ms, 30);
    }

    #[test]
    fn version_three_repairs_missing_and_corrupt_required_settings() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE state_revision(
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   revision INTEGER NOT NULL CHECK(revision >= 0)
                 );
                 CREATE TABLE settings(key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'legacy');
                 INSERT INTO state_revision(singleton, revision) VALUES (1, 9);
                 INSERT INTO settings(key, payload_json)
                 VALUES ('gameBrowserSettings', '{\"broken\":true}');
                 INSERT INTO settings(key, payload_json)
                 VALUES ('runtimeWindowPreferences', '{\"alwaysShowToolbarInFullScreen\":true}');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        let browser: GameBrowserSettingsRecord = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let macros: MacroSettingsRecord = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM settings WHERE key='macroSettings'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let preferences: RuntimeWindowPreferencesRecord = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM settings WHERE key='runtimeWindowPreferences'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(browser.launch_mode, "auto");
        assert_eq!(macros.key_hold_ms, 30);
        assert!(preferences.always_show_toolbar_in_full_screen);
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, u32>(0)
                })
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn upgrades_schema_three_with_the_versioned_operation_journal() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'legacy');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, u32>(0)
                })
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type='table' AND name='operation_journal'",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn version_five_removes_persisted_workspace_resource_policies() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (3, 'legacy');
                 INSERT INTO schema_migrations(version, applied_at) VALUES (4, 'legacy');
                 CREATE TABLE workspaces(
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 INSERT INTO workspaces(id, ordinal, name, payload_json)
                 VALUES (
                   'workspace-1',
                   0,
                   'Legacy',
                   '{\"id\":\"workspace-1\",\"name\":\"Legacy\",\"resourcePolicy\":{\"mode\":\"unrestricted\"}}'
                 );",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        let payload: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM workspaces WHERE id='workspace-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(payload.get("resourcePolicy").is_none());
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, u32>(0)
                })
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn role_delete_commits_relationship_cleanup_and_journal_phase_together() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[{
                    "id":"w1","name":"Workspace","template":"single","browserLaunchMode":"inherit",
                    "browserZoomMode":"fixed","browserZoomPercent":90,"resourcePolicy":{"mode":"unrestricted"},
                    "slots":[{"id":"slot-1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "macros":[{
                    "id":"m1","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["r1"],
                    "repeat":{"type":"once"},"steps":[{"type":"delay","id":"s1","ms":1}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "compatibilityReports":[]
            }),
        )
        .unwrap();
        put_operation_journal(
            &connection,
            &OperationJournalRecord {
                id: "role-delete-test".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({"roleId":"r1"}),
            },
        )
        .unwrap();

        apply_domain_mutation(
            &mut connection,
            StateMutation::RoleDelete {
                id: "r1".to_owned(),
                operation_id: Some("role-delete-test".to_owned()),
            },
        )
        .unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert!(snapshot["roles"].as_array().unwrap().is_empty());
        assert!(snapshot["launchWorkspaces"][0]["slots"][0]["roleId"].is_null());
        assert!(
            snapshot["macros"][0]["roleIds"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT phase FROM operation_journal WHERE id='role-delete-test'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "committed"
        );
    }

    #[test]
    fn bulk_game_delete_classifies_once_and_cascades_compatibility_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[
                    {
                        "id":"g-in-use","source":"custom","name":"In Use",
                        "defaultLaunchUrl":"https://example.test/in-use","browserLaunchMode":"inherit",
                        "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                    },
                    {
                        "id":"g-delete","source":"custom","name":"Delete",
                        "defaultLaunchUrl":"https://example.test/delete","browserLaunchMode":"inherit",
                        "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                    },
                    {
                        "id":"builtin-flyff-universe","source":"builtin","builtinKey":"flyff-universe",
                        "name":"Flyff Universe","defaultLaunchUrl":"https://universe.flyff.com/play",
                        "browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z",
                        "updatedAt":"2026-01-01T00:00:00Z"
                    }
                ],
                "roles":[{
                    "id":"r1","gameId":"g-in-use","name":"Role","launchUrl":"https://example.test/in-use",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[], "macros":[], "compatibilityReports":[]
            }),
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO compatibility_reports(game_id, ordinal, payload_json)
                 VALUES ('g-delete', 0, '{}')",
                [],
            )
            .unwrap();

        let result = apply_domain_mutation(
            &mut connection,
            StateMutation::GamesDelete {
                ids: vec![
                    "g-in-use".to_owned(),
                    "g-delete".to_owned(),
                    "builtin-flyff-universe".to_owned(),
                    "missing".to_owned(),
                    "g-delete".to_owned(),
                ],
            },
        )
        .unwrap();

        assert_eq!(result["value"]["deletedIds"], json!(["g-delete"]));
        assert_eq!(
            result["value"]["skipped"],
            json!([
                {"id":"g-in-use","reason":"in_use","relatedNames":["Role"]},
                {"id":"builtin-flyff-universe","reason":"protected","relatedNames":[]},
                {"id":"missing","reason":"not_found","relatedNames":[]}
            ])
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM compatibility_reports WHERE game_id='g-delete'",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn rejects_a_database_created_by_a_newer_application_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (999, 'future');",
            )
            .unwrap();

        assert!(
            create_schema(&connection, false)
                .unwrap_err()
                .to_string()
                .contains("newer than supported")
        );
    }

    #[test]
    fn corrupt_optional_legacy_files_do_not_block_migration() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("games.json"), r#"{"games":[]}"#).unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            "not-json",
        )
        .unwrap();
        fs::write(directory.path().join("game-compatibility.json"), "not-json").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();

        import_legacy_files(&mut connection, directory.path()).unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert_eq!(snapshot["compatibilityReports"], json!([]));
        assert_eq!(snapshot["gameBrowserSettings"]["launchMode"], "auto");
    }

    #[test]
    fn stores_images_as_blobs_and_restores_data_urls_at_the_api_boundary() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let data_url = "data:image/png;base64,AQIDBA==";
        let snapshot = json!({
            "games": [{"id":"g1","name":"Game","iconImageDataUrl":data_url}],
            "roles": [{"id":"r1","gameId":"g1","name":"Role","coverImageDataUrl":data_url}]
        });

        replace_snapshot(&mut connection, &snapshot).unwrap();

        let game_payload: String = connection
            .query_row("SELECT payload_json FROM games", [], |row| row.get(0))
            .unwrap();
        let image_bytes: Vec<u8> = connection
            .query_row("SELECT data FROM game_images", [], |row| row.get(0))
            .unwrap();
        assert!(!game_payload.contains("base64"));
        assert_eq!(image_bytes, vec![1, 2, 3, 4]);
        let restored = read_snapshot(&connection).unwrap();
        assert_eq!(restored["games"], snapshot["games"]);
        assert_eq!(restored["roles"], snapshot["roles"]);
    }

    #[test]
    fn completes_a_committed_sqlite_portable_journal_before_state_is_exposed() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("state.sqlite3");
        let connection = Connection::open(&database_path).unwrap();
        create_schema(&connection, false).unwrap();
        drop(connection);
        fs::create_dir_all(directory.path().join("portable-import-transaction.stage")).unwrap();
        fs::write(
            directory.path().join("portable-import-transaction.json"),
            r#"{
              "storageKind":"sqlite","phase":"committed","createdRoleIds":[],
              "games":[],"roles":[],"workspaces":[],"macros":[],
              "targetGames":[{"id":"g2","name":"Imported"}],
              "targetRoles":[],"targetWorkspaces":[],"targetMacros":[]
            }"#,
        )
        .unwrap();
        let worker = StateDatabaseWorker::start(database_path).unwrap();

        crate::v1_case!("portable-profile-08b90063a73f", {
            assert!(
                worker
                    .recover_portable_import(directory.path().to_path_buf())
                    .unwrap()
            );
            assert_eq!(worker.snapshot().unwrap()["games"][0]["id"], "g2");
            assert!(
                !directory
                    .path()
                    .join("portable-import-transaction.json")
                    .exists()
            );
            assert!(
                !directory
                    .path()
                    .join("portable-import-transaction.stage")
                    .exists()
            );
        });
    }
}
