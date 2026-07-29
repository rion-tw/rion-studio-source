use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserRuntimeCommand, BrowserRuntimeResult, BrowserRuntimeRoleRecord,
        BrowserRuntimeSnapshot, BrowserRuntimeTabRecord, BrowserRuntimeWindowRecord,
        BrowserRuntimeWorkspaceRecord,
    },
};

#[derive(Clone, Default)]
pub struct BrowserRuntime {
    windows: HashMap<String, BrowserRuntimeWindowRecord>,
    roles: HashMap<String, BrowserRuntimeRoleRecord>,
    tabs: HashMap<String, BrowserRuntimeTabRecord>,
    workspaces: HashMap<String, BrowserRuntimeWorkspaceRecord>,
}

impl BrowserRuntime {
    pub fn invoke(&mut self, command: BrowserRuntimeCommand) -> CoreResult<BrowserRuntimeResult> {
        let previous = self.clone();
        match self.invoke_inner(command) {
            Ok(result) => Ok(result),
            Err(error) => {
                *self = previous;
                Err(error)
            }
        }
    }

    fn invoke_inner(&mut self, command: BrowserRuntimeCommand) -> CoreResult<BrowserRuntimeResult> {
        let mut created_tab_id = None;
        match command {
            BrowserRuntimeCommand::Snapshot => {}
            BrowserRuntimeCommand::BeginWorkspace {
                workspace_id,
                name,
                window_id,
                role_ids,
            } => {
                if self.workspaces.contains_key(&workspace_id) {
                    return Err(domain(
                        "WORKSPACE_ALREADY_RUNNING",
                        "Launch workspace is already running.",
                    ));
                }
                self.ensure_roles_available(&role_ids, None)?;
                self.workspaces.insert(
                    workspace_id.clone(),
                    BrowserRuntimeWorkspaceRecord {
                        workspace_id,
                        name,
                        runtime: "pending".to_owned(),
                        window_id,
                        tab_id: None,
                        role_ids,
                        state: "launching".to_owned(),
                    },
                );
            }
            BrowserRuntimeCommand::RegisterWindow { window_id } => {
                self.windows
                    .entry(window_id.clone())
                    .or_insert(BrowserRuntimeWindowRecord {
                        window_id,
                        active_tab_id: None,
                        tab_ids: Vec::new(),
                    });
            }
            BrowserRuntimeCommand::RemoveWindow { window_id } => {
                if self
                    .windows
                    .get(&window_id)
                    .is_some_and(|window| !window.tab_ids.is_empty())
                {
                    return Err(domain(
                        "RUNTIME_WINDOW_NOT_EMPTY",
                        "Stop all tabs before deleting a game window.",
                    ));
                }
                self.windows.remove(&window_id);
            }
            BrowserRuntimeCommand::CreateTab {
                tab_id,
                source_id,
                name,
                window_id,
                tab_type,
                workspace_id,
                role_ids,
            } => {
                self.register_window(&window_id);
                if let Some(workspace_id) = &workspace_id {
                    if self
                        .workspaces
                        .get(workspace_id)
                        .is_some_and(|workspace| workspace.tab_id.is_some())
                    {
                        return Err(domain(
                            "WORKSPACE_ALREADY_RUNNING",
                            "Launch workspace is already running.",
                        ));
                    }
                    self.ensure_workspace_roles_match(workspace_id, &role_ids)?;
                }
                self.ensure_roles_available(&role_ids, workspace_id.as_deref())?;
                let id = tab_id.unwrap_or_else(|| Uuid::new_v4().to_string());
                if Uuid::parse_str(&id).is_err() || self.tabs.contains_key(&id) {
                    return Err(domain(
                        "RUNTIME_TAB_ID_INVALID",
                        "Runtime tab id is invalid or already in use.",
                    ));
                }
                let tab = BrowserRuntimeTabRecord {
                    id: id.clone(),
                    source_id,
                    name,
                    window_id: window_id.clone(),
                    tab_type,
                    workspace_id: workspace_id.clone(),
                    role_ids: role_ids.clone(),
                    hidden: true,
                };
                self.tabs.insert(id.clone(), tab);
                self.windows
                    .get_mut(&window_id)
                    .expect("window was registered")
                    .tab_ids
                    .push(id.clone());
                if let Some(workspace_id) = workspace_id {
                    let workspace =
                        self.workspaces
                            .entry(workspace_id.clone())
                            .or_insert_with(|| BrowserRuntimeWorkspaceRecord {
                                workspace_id,
                                name: self.tabs[&id].name.clone(),
                                runtime: "embedded".to_owned(),
                                window_id: Some(window_id.clone()),
                                tab_id: None,
                                role_ids: role_ids.clone(),
                                state: "launching".to_owned(),
                            });
                    workspace.name = self.tabs[&id].name.clone();
                    workspace.runtime = "embedded".to_owned();
                    workspace.window_id = Some(window_id);
                    workspace.tab_id = Some(id.clone());
                    workspace.role_ids = role_ids;
                }
                created_tab_id = Some(id);
            }
            BrowserRuntimeCommand::RemoveTab { tab_id } => self.remove_tab(&tab_id),
            BrowserRuntimeCommand::ActivateTab { tab_id } => self.activate_tab(&tab_id)?,
            BrowserRuntimeCommand::ShowWindow { window_id } => self.show_window(&window_id)?,
            BrowserRuntimeCommand::ActivateAdjacentTab {
                window_id,
                direction,
            } => self.activate_adjacent_tab(&window_id, &direction)?,
            BrowserRuntimeCommand::HideTab { tab_id } => self.hide_tab(&tab_id)?,
            BrowserRuntimeCommand::ReorderTab {
                tab_id,
                before_tab_id,
            } => self.reorder_tab(&tab_id, before_tab_id.as_deref())?,
            BrowserRuntimeCommand::MoveTab { tab_id, window_id } => {
                self.move_tab(&tab_id, &window_id)?;
            }
            BrowserRuntimeCommand::MoveWindowTabs {
                source_window_id,
                target_window_id,
            } => self.move_window_tabs(&source_window_id, &target_window_id)?,
            BrowserRuntimeCommand::RoleTransition {
                role_id,
                runtime,
                workspace_id,
                tab_id,
                state,
                launched_at,
            } => {
                self.transition_role(role_id, runtime, workspace_id, tab_id, &state, launched_at)?
            }
            BrowserRuntimeCommand::RemoveRole { role_id } => {
                self.roles.remove(&role_id);
                self.tabs
                    .values_mut()
                    .for_each(|tab| tab.role_ids.retain(|candidate| candidate != &role_id));
                self.workspaces.values_mut().for_each(|workspace| {
                    workspace.role_ids.retain(|candidate| candidate != &role_id);
                });
                self.refresh_workspace_states();
            }
            BrowserRuntimeCommand::SetWorkspaceState {
                workspace_id,
                state,
            } => self.set_workspace_state(&workspace_id, &state)?,
            BrowserRuntimeCommand::RemoveWorkspace { workspace_id } => {
                self.workspaces.remove(&workspace_id);
            }
        }
        self.validate()?;
        Ok(BrowserRuntimeResult {
            created_tab_id,
            snapshot: self.snapshot(),
        })
    }

    fn register_window(&mut self, window_id: &str) {
        self.windows
            .entry(window_id.to_owned())
            .or_insert(BrowserRuntimeWindowRecord {
                window_id: window_id.to_owned(),
                active_tab_id: None,
                tab_ids: Vec::new(),
            });
    }

    fn ensure_roles_available(
        &self,
        role_ids: &[String],
        except_workspace_id: Option<&str>,
    ) -> CoreResult<()> {
        let running = role_ids
            .iter()
            .filter(|role_id| {
                self.roles.contains_key(*role_id)
                    || self
                        .workspaces
                        .values()
                        .filter(|workspace| {
                            Some(workspace.workspace_id.as_str()) != except_workspace_id
                        })
                        .any(|workspace| workspace.role_ids.contains(*role_id))
            })
            .cloned()
            .collect::<Vec<_>>();
        if running.is_empty() {
            Ok(())
        } else {
            Err(domain(
                "ROLE_ALREADY_RUNNING",
                &format!("Roles are already running: {}.", running.join(", ")),
            ))
        }
    }

    fn ensure_workspace_roles_match(
        &self,
        workspace_id: &str,
        role_ids: &[String],
    ) -> CoreResult<()> {
        if self
            .workspaces
            .get(workspace_id)
            .is_some_and(|workspace| workspace.role_ids != role_ids)
        {
            return Err(domain(
                "WORKSPACE_ROLES_CHANGED",
                "Launch workspace roles changed while launch was pending.",
            ));
        }
        Ok(())
    }

    fn remove_tab(&mut self, tab_id: &str) {
        let Some(tab) = self.tabs.remove(tab_id) else {
            return;
        };
        if let Some(window) = self.windows.get_mut(&tab.window_id) {
            window.tab_ids.retain(|id| id != tab_id);
            if window.active_tab_id.as_deref() == Some(tab_id) {
                window.active_tab_id = window
                    .tab_ids
                    .iter()
                    .find(|id| self.tabs.get(*id).is_some_and(|tab| !tab.hidden))
                    .cloned();
            }
        }
        if let Some(workspace_id) = tab.workspace_id {
            self.workspaces.remove(&workspace_id);
        }
    }

    fn activate_tab(&mut self, tab_id: &str) -> CoreResult<()> {
        let tab = self
            .tabs
            .get_mut(tab_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        tab.hidden = false;
        self.windows
            .get_mut(&tab.window_id)
            .ok_or_else(|| domain("RUNTIME_WINDOW_NOT_FOUND", "Runtime window was not found."))?
            .active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn show_window(&mut self, window_id: &str) -> CoreResult<()> {
        let window = self
            .windows
            .get(window_id)
            .ok_or_else(|| domain("RUNTIME_WINDOW_NOT_FOUND", "Runtime window was not found."))?;
        let selected = window
            .active_tab_id
            .as_ref()
            .filter(|tab_id| self.tabs.get(*tab_id).is_some_and(|tab| !tab.hidden))
            .cloned()
            .or_else(|| window.tab_ids.first().cloned());
        if let Some(tab_id) = selected {
            self.activate_tab(&tab_id)?;
        }
        Ok(())
    }

    fn activate_adjacent_tab(&mut self, window_id: &str, direction: &str) -> CoreResult<()> {
        if !matches!(direction, "next" | "previous") {
            return Err(domain(
                "RUNTIME_TAB_DIRECTION_INVALID",
                "Runtime tab direction is invalid.",
            ));
        }
        let window = self
            .windows
            .get(window_id)
            .ok_or_else(|| domain("RUNTIME_WINDOW_NOT_FOUND", "Runtime window was not found."))?;
        let visible = window
            .tab_ids
            .iter()
            .filter(|tab_id| self.tabs.get(*tab_id).is_some_and(|tab| !tab.hidden))
            .cloned()
            .collect::<Vec<_>>();
        if visible.len() < 2 {
            return Ok(());
        }
        let current = window
            .active_tab_id
            .as_ref()
            .and_then(|active| visible.iter().position(|tab_id| tab_id == active));
        let next = match (current, direction) {
            (Some(index), "next") => (index + 1) % visible.len(),
            (Some(index), _) => (index + visible.len() - 1) % visible.len(),
            (None, _) => 0,
        };
        self.activate_tab(&visible[next])
    }

    fn hide_tab(&mut self, tab_id: &str) -> CoreResult<()> {
        let window_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.window_id.clone())
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        self.tabs.get_mut(tab_id).expect("tab exists").hidden = true;
        let window = self.windows.get_mut(&window_id).expect("window exists");
        if window.active_tab_id.as_deref() == Some(tab_id) {
            window.active_tab_id = window
                .tab_ids
                .iter()
                .find(|id| self.tabs.get(*id).is_some_and(|tab| !tab.hidden))
                .cloned();
        }
        Ok(())
    }

    fn reorder_tab(&mut self, tab_id: &str, before_tab_id: Option<&str>) -> CoreResult<()> {
        let window_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.window_id.clone())
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        let window = self.windows.get_mut(&window_id).expect("window exists");
        let mut ids = window
            .tab_ids
            .iter()
            .filter(|id| id.as_str() != tab_id)
            .cloned()
            .collect::<Vec<_>>();
        let index = before_tab_id
            .and_then(|before| ids.iter().position(|id| id == before))
            .unwrap_or(ids.len());
        ids.insert(index, tab_id.to_owned());
        window.tab_ids = ids;
        Ok(())
    }

    fn move_tab(&mut self, tab_id: &str, window_id: &str) -> CoreResult<()> {
        let source_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.window_id.clone())
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        if source_id == window_id {
            return Ok(());
        }
        self.register_window(window_id);
        if let Some(source) = self.windows.get_mut(&source_id) {
            source.tab_ids.retain(|id| id != tab_id);
            if source.active_tab_id.as_deref() == Some(tab_id) {
                source.active_tab_id = source
                    .tab_ids
                    .iter()
                    .find(|id| self.tabs.get(*id).is_some_and(|tab| !tab.hidden))
                    .cloned();
            }
        }
        self.tabs.get_mut(tab_id).expect("tab exists").hidden = false;
        let target = self.windows.get_mut(window_id).expect("window exists");
        target.tab_ids.push(tab_id.to_owned());
        target.active_tab_id = Some(tab_id.to_owned());
        self.tabs.get_mut(tab_id).expect("tab exists").window_id = window_id.to_owned();
        if let Some(workspace_id) = self.tabs[tab_id].workspace_id.as_ref()
            && let Some(workspace) = self.workspaces.get_mut(workspace_id)
        {
            workspace.window_id = Some(window_id.to_owned());
        }
        Ok(())
    }

    fn move_window_tabs(&mut self, source: &str, target: &str) -> CoreResult<()> {
        if source == target || !self.windows.contains_key(source) {
            return Ok(());
        }
        self.register_window(target);
        let source_record = self.windows.get_mut(source).expect("source exists");
        let source_tab_ids = std::mem::take(&mut source_record.tab_ids);
        let source_active_tab_id = source_record.active_tab_id.take();
        let target_record = self.windows.get_mut(target).expect("target exists");
        let target_had_active = target_record.active_tab_id.is_some();
        for tab_id in &source_tab_ids {
            self.tabs.get_mut(tab_id).expect("tab exists").window_id = target.to_owned();
            if let Some(workspace_id) = self.tabs[tab_id].workspace_id.as_ref()
                && let Some(workspace) = self.workspaces.get_mut(workspace_id)
            {
                workspace.window_id = Some(target.to_owned());
            }
        }
        target_record.tab_ids.extend(source_tab_ids);
        if !target_had_active {
            target_record.active_tab_id = source_active_tab_id;
        }
        Ok(())
    }

    fn transition_role(
        &mut self,
        role_id: String,
        runtime: String,
        workspace_id: Option<String>,
        tab_id: Option<String>,
        state: &str,
        launched_at: Option<String>,
    ) -> CoreResult<()> {
        if runtime != "embedded" {
            return Err(domain(
                "RUNTIME_MODE_INVALID",
                "Browser runtime mode is invalid.",
            ));
        }
        if !matches!(state, "launching" | "running" | "stopping") {
            return Err(domain(
                "RUNTIME_STATE_INVALID",
                "Browser runtime state is invalid.",
            ));
        }
        let previous = self.roles.get(&role_id).map(|role| role.state.as_str());
        let valid = matches!(
            (previous, state),
            (None, "launching")
                | (Some("launching"), "launching" | "running" | "stopping")
                | (Some("running"), "running" | "stopping")
                | (Some("stopping"), "stopping")
        );
        if !valid {
            return Err(domain(
                "RUNTIME_TRANSITION_INVALID",
                "Browser role transition is invalid.",
            ));
        }
        let launched_at = launched_at.or_else(|| {
            self.roles
                .get(&role_id)
                .and_then(|role| role.launched_at.clone())
        });
        self.roles.insert(
            role_id.clone(),
            BrowserRuntimeRoleRecord {
                role_id,
                runtime,
                workspace_id,
                tab_id,
                state: state.to_owned(),
                launched_at,
            },
        );
        self.refresh_workspace_states();
        Ok(())
    }

    fn set_workspace_state(&mut self, workspace_id: &str, state: &str) -> CoreResult<()> {
        if !matches!(state, "launching" | "running" | "stopping") {
            return Err(domain(
                "RUNTIME_STATE_INVALID",
                "Browser runtime state is invalid.",
            ));
        }
        let workspace = self.workspaces.get_mut(workspace_id).ok_or_else(|| {
            domain(
                "WORKSPACE_RUNTIME_NOT_FOUND",
                "Launch workspace runtime was not found.",
            )
        })?;
        workspace.state = state.to_owned();
        Ok(())
    }

    fn refresh_workspace_states(&mut self) {
        for workspace in self.workspaces.values_mut() {
            let states = workspace
                .role_ids
                .iter()
                .filter_map(|role_id| self.roles.get(role_id).map(|role| role.state.as_str()))
                .collect::<Vec<_>>();
            workspace.state = if states.contains(&"stopping") {
                "stopping"
            } else if states.len() < workspace.role_ids.len() || states.contains(&"launching") {
                "launching"
            } else {
                "running"
            }
            .to_owned();
        }
    }

    fn validate(&self) -> CoreResult<()> {
        let mut tab_ids = HashSet::new();
        for window in self.windows.values() {
            for tab_id in &window.tab_ids {
                if !tab_ids.insert(tab_id) || !self.tabs.contains_key(tab_id) {
                    return Err(CoreError::Internal(
                        "browser runtime tab ownership is inconsistent".to_owned(),
                    ));
                }
            }
            if window.active_tab_id.as_ref().is_some_and(|id| {
                !window.tab_ids.contains(id) || self.tabs.get(id).is_none_or(|tab| tab.hidden)
            }) {
                return Err(CoreError::Internal(
                    "browser runtime active tab is inconsistent".to_owned(),
                ));
            }
        }
        if tab_ids.len() != self.tabs.len() {
            return Err(CoreError::Internal(
                "browser runtime contains an unowned tab".to_owned(),
            ));
        }
        let mut seen = HashSet::new();
        if self
            .workspaces
            .values()
            .flat_map(|workspace| workspace.role_ids.iter())
            .any(|role_id| !seen.insert(role_id))
        {
            return Err(CoreError::Internal(
                "browser runtime role is assigned to multiple workspaces".to_owned(),
            ));
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> BrowserRuntimeSnapshot {
        let mut windows = self.windows.values().cloned().collect::<Vec<_>>();
        windows.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        let mut roles = self.roles.values().cloned().collect::<Vec<_>>();
        roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        let tabs = windows
            .iter()
            .flat_map(|window| &window.tab_ids)
            .filter_map(|tab_id| self.tabs.get(tab_id).cloned())
            .collect::<Vec<_>>();
        let mut workspaces = self.workspaces.values().cloned().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        BrowserRuntimeSnapshot {
            windows,
            roles,
            tabs,
            workspaces,
        }
    }
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(value: serde_json::Value) -> BrowserRuntimeCommand {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn owns_tab_order_visibility_display_moves_and_role_transitions() {
        let mut runtime = BrowserRuntime::default();
        let created = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"w1","name":"Party","windowId":"window-1",
                "tabType":"workspace","workspaceId":"w1","roleIds":["r1","r2"]
            })))
            .unwrap();
        let tab_id = created.created_tab_id.unwrap();
        for role_id in ["r1", "r2"] {
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                    "workspaceId":"w1","tabId":tab_id,"state":"launching"
                })))
                .unwrap();
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                    "workspaceId":"w1","tabId":tab_id,"state":"running"
                })))
                .unwrap();
        }
        runtime
            .invoke(command(json!({"type":"activateTab","tabId":tab_id})))
            .unwrap();
        let moved = runtime
            .invoke(command(
                json!({"type":"moveTab","tabId":tab_id,"windowId":"window-2"}),
            ))
            .unwrap();
        assert_eq!(moved.snapshot.windows[0].window_id, "window-1");
        assert_eq!(moved.snapshot.workspaces[0].state, "running");
        assert_eq!(
            moved.snapshot.workspaces[0].window_id.as_deref(),
            Some("window-2")
        );
    }

    #[test]
    fn rejects_duplicate_workspace_roles_and_invalid_transitions() {
        let mut runtime = BrowserRuntime::default();
        runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"w1","name":"One","windowId":"window-1",
                "tabType":"workspace","workspaceId":"w1","roleIds":["r1"]
            })))
            .unwrap();
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"createTab","sourceId":"w2","name":"Two","windowId":"window-2",
                    "tabType":"workspace","workspaceId":"w2","roleIds":["r1"]
                })))
                .unwrap_err()
                .code(),
            "ROLE_ALREADY_RUNNING"
        );
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":"r1","runtime":"embedded","state":"running"
                })))
                .unwrap_err()
                .code(),
            "RUNTIME_TRANSITION_INVALID"
        );
    }

    #[test]
    fn owns_window_show_and_adjacent_tab_selection() {
        let mut runtime = BrowserRuntime::default();
        let first = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r1","name":"One","windowId":"window-1",
                "tabType":"role","roleIds":["r1"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let second = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r2","name":"Two","windowId":"window-1",
                "tabType":"role","roleIds":["r2"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let shown = runtime
            .invoke(command(json!({"type":"showWindow","windowId":"window-1"})))
            .unwrap();
        assert_eq!(shown.snapshot.windows[0].active_tab_id, Some(first.clone()));
        assert!(
            !shown
                .snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == first)
                .unwrap()
                .hidden
        );
        runtime
            .invoke(command(json!({"type":"activateTab","tabId":second})))
            .unwrap();
        let adjacent = runtime
            .invoke(command(json!({
                "type":"activateAdjacentTab","windowId":"window-1","direction":"previous"
            })))
            .unwrap();
        assert_eq!(adjacent.snapshot.windows[0].active_tab_id, Some(first));
    }

    #[test]
    fn snapshots_tabs_in_window_order_and_appends_new_tabs_last() {
        let mut runtime = BrowserRuntime::default();
        let first = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        let second = "00000000-0000-4000-8000-000000000000";
        let third = "88888888-8888-4888-8888-888888888888";

        for (tab_id, role_id, name) in [(first, "r1", "First"), (second, "r2", "Second")] {
            runtime
                .invoke(command(json!({
                    "type":"createTab","tabId":tab_id,"sourceId":role_id,"name":name,
                    "windowId":"window-1","tabType":"role","roleIds":[role_id]
                })))
                .unwrap();
        }

        assert_eq!(
            runtime
                .snapshot()
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            [first, second]
        );

        runtime
            .invoke(command(json!({
                "type":"reorderTab","tabId":second,"beforeTabId":first
            })))
            .unwrap();
        let created = runtime
            .invoke(command(json!({
                "type":"createTab","tabId":third,"sourceId":"r3","name":"Third",
                "windowId":"window-1","tabType":"role","roleIds":["r3"]
            })))
            .unwrap();

        assert_eq!(created.snapshot.windows[0].tab_ids, [second, first, third]);
        assert_eq!(
            created
                .snapshot
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            [second, first, third]
        );
    }

    #[test]
    fn moving_tabs_reveals_the_target_and_keeps_source_active_tab_visible() {
        for platform in ["darwin", "win32"] {
            let mut runtime = BrowserRuntime::default();
            let create = |runtime: &mut BrowserRuntime, tab_id: &str, role_id: &str| {
                runtime
                    .invoke(command(json!({
                        "type":"createTab","tabId":tab_id,"sourceId":role_id,
                        "name":role_id,"windowId":"source","tabType":"role",
                        "roleIds":[role_id]
                    })))
                    .unwrap();
            };
            let hidden_skip = "11111111-1111-4111-8111-111111111111";
            let hidden_moved = "22222222-2222-4222-8222-222222222222";
            let visible_fallback = "33333333-3333-4333-8333-333333333333";
            let active_moved = "44444444-4444-4444-8444-444444444444";
            for (tab_id, role_id) in [
                (hidden_skip, "role-hidden"),
                (hidden_moved, "role-hidden-moved"),
                (visible_fallback, "role-visible"),
                (active_moved, "role-active"),
            ] {
                create(&mut runtime, tab_id, role_id);
            }

            let hidden_result = runtime
                .invoke(command(json!({
                    "type":"moveTab","tabId":hidden_moved,"windowId":"target"
                })))
                .unwrap();
            assert!(
                !hidden_result
                    .snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.id == hidden_moved)
                    .unwrap()
                    .hidden,
                "{platform}"
            );

            runtime
                .invoke(command(
                    json!({"type":"activateTab","tabId":visible_fallback}),
                ))
                .unwrap();
            runtime
                .invoke(command(json!({"type":"activateTab","tabId":active_moved})))
                .unwrap();
            let moved = runtime
                .invoke(command(json!({
                    "type":"moveTab","tabId":active_moved,"windowId":"target"
                })))
                .unwrap();
            let source = moved
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "source")
                .unwrap();
            let target = moved
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "target")
                .unwrap();
            assert_eq!(
                source.active_tab_id.as_deref(),
                Some(visible_fallback),
                "{platform}"
            );
            assert_eq!(
                target.active_tab_id.as_deref(),
                Some(active_moved),
                "{platform}"
            );
        }
    }
}
