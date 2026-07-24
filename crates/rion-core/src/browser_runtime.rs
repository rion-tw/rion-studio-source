use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserRuntimeCommand, BrowserRuntimeDisplayRecord, BrowserRuntimeResult,
        BrowserRuntimeRoleRecord, BrowserRuntimeSnapshot, BrowserRuntimeTabRecord,
        BrowserRuntimeWorkspaceRecord,
    },
};

#[derive(Clone, Default)]
pub struct BrowserRuntime {
    displays: HashMap<i64, BrowserRuntimeDisplayRecord>,
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
                display_id,
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
                        display_id,
                        exclusive_display: false,
                        tab_id: None,
                        role_ids,
                        state: "launching".to_owned(),
                    },
                );
            }
            BrowserRuntimeCommand::RegisterDisplay { display_id } => {
                self.displays
                    .entry(display_id)
                    .or_insert(BrowserRuntimeDisplayRecord {
                        display_id,
                        active_tab_id: None,
                        tab_ids: Vec::new(),
                    });
            }
            BrowserRuntimeCommand::CreateTab {
                source_id,
                name,
                display_id,
                tab_type,
                workspace_id,
                role_ids,
            } => {
                self.register_display(display_id);
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
                let id = Uuid::new_v4().to_string();
                let tab = BrowserRuntimeTabRecord {
                    id: id.clone(),
                    source_id,
                    name,
                    display_id,
                    tab_type,
                    workspace_id: workspace_id.clone(),
                    role_ids: role_ids.clone(),
                    hidden: true,
                };
                self.tabs.insert(id.clone(), tab);
                self.displays
                    .get_mut(&display_id)
                    .expect("display was registered")
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
                                display_id: Some(display_id),
                                exclusive_display: false,
                                tab_id: None,
                                role_ids: role_ids.clone(),
                                state: "launching".to_owned(),
                            });
                    workspace.name = self.tabs[&id].name.clone();
                    workspace.runtime = "embedded".to_owned();
                    workspace.display_id = Some(display_id);
                    workspace.exclusive_display = false;
                    workspace.tab_id = Some(id.clone());
                    workspace.role_ids = role_ids;
                }
                created_tab_id = Some(id);
            }
            BrowserRuntimeCommand::CreateExternalWorkspace {
                workspace_id,
                name,
                display_id,
                exclusive_display,
                role_ids,
            } => {
                if self
                    .workspaces
                    .get(&workspace_id)
                    .is_some_and(|workspace| workspace.runtime != "pending")
                {
                    return Err(domain(
                        "WORKSPACE_ALREADY_RUNNING",
                        "Launch workspace is already running.",
                    ));
                }
                self.ensure_workspace_roles_match(&workspace_id, &role_ids)?;
                self.ensure_roles_available(&role_ids, Some(&workspace_id))?;
                if exclusive_display
                    && display_id.is_some_and(|candidate| {
                        self.workspaces.values().any(|workspace| {
                            workspace.workspace_id != workspace_id
                                && workspace.exclusive_display
                                && workspace.display_id == Some(candidate)
                        })
                    })
                {
                    return Err(domain(
                        "WORKSPACE_DISPLAY_OCCUPIED",
                        "Launch workspace target display is already occupied.",
                    ));
                }
                let workspace = self
                    .workspaces
                    .entry(workspace_id.clone())
                    .or_insert_with(|| BrowserRuntimeWorkspaceRecord {
                        workspace_id,
                        name: name.clone(),
                        runtime: "external".to_owned(),
                        display_id,
                        exclusive_display,
                        tab_id: None,
                        role_ids: role_ids.clone(),
                        state: "launching".to_owned(),
                    });
                workspace.name = name;
                workspace.runtime = "external".to_owned();
                workspace.display_id = display_id;
                workspace.exclusive_display = exclusive_display;
                workspace.role_ids = role_ids;
            }
            BrowserRuntimeCommand::RemoveTab { tab_id } => self.remove_tab(&tab_id),
            BrowserRuntimeCommand::ActivateTab { tab_id } => self.activate_tab(&tab_id)?,
            BrowserRuntimeCommand::ShowDisplay { display_id } => self.show_display(display_id)?,
            BrowserRuntimeCommand::ActivateAdjacentTab {
                display_id,
                direction,
            } => self.activate_adjacent_tab(display_id, &direction)?,
            BrowserRuntimeCommand::HideTab { tab_id } => self.hide_tab(&tab_id)?,
            BrowserRuntimeCommand::ReorderTab {
                tab_id,
                before_tab_id,
            } => self.reorder_tab(&tab_id, before_tab_id.as_deref())?,
            BrowserRuntimeCommand::MoveTab { tab_id, display_id } => {
                self.move_tab(&tab_id, display_id)?;
            }
            BrowserRuntimeCommand::MoveDisplayTabs {
                source_display_id,
                target_display_id,
            } => self.move_display_tabs(source_display_id, target_display_id)?,
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

    fn register_display(&mut self, display_id: i64) {
        self.displays
            .entry(display_id)
            .or_insert(BrowserRuntimeDisplayRecord {
                display_id,
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
        if let Some(display) = self.displays.get_mut(&tab.display_id) {
            display.tab_ids.retain(|id| id != tab_id);
            if display.active_tab_id.as_deref() == Some(tab_id) {
                display.active_tab_id = display
                    .tab_ids
                    .iter()
                    .find(|id| self.tabs.get(*id).is_some_and(|tab| !tab.hidden))
                    .cloned();
            }
            if display.tab_ids.is_empty() {
                self.displays.remove(&tab.display_id);
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
        self.displays
            .get_mut(&tab.display_id)
            .ok_or_else(|| {
                domain(
                    "RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display was not found.",
                )
            })?
            .active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn show_display(&mut self, display_id: i64) -> CoreResult<()> {
        let display = self.displays.get(&display_id).ok_or_else(|| {
            domain(
                "RUNTIME_DISPLAY_NOT_FOUND",
                "Runtime display was not found.",
            )
        })?;
        let selected = display
            .active_tab_id
            .as_ref()
            .filter(|tab_id| self.tabs.get(*tab_id).is_some_and(|tab| !tab.hidden))
            .cloned()
            .or_else(|| display.tab_ids.first().cloned());
        if let Some(tab_id) = selected {
            self.activate_tab(&tab_id)?;
        }
        Ok(())
    }

    fn activate_adjacent_tab(&mut self, display_id: i64, direction: &str) -> CoreResult<()> {
        if !matches!(direction, "next" | "previous") {
            return Err(domain(
                "RUNTIME_TAB_DIRECTION_INVALID",
                "Runtime tab direction is invalid.",
            ));
        }
        let display = self.displays.get(&display_id).ok_or_else(|| {
            domain(
                "RUNTIME_DISPLAY_NOT_FOUND",
                "Runtime display was not found.",
            )
        })?;
        let visible = display
            .tab_ids
            .iter()
            .filter(|tab_id| self.tabs.get(*tab_id).is_some_and(|tab| !tab.hidden))
            .cloned()
            .collect::<Vec<_>>();
        if visible.len() < 2 {
            return Ok(());
        }
        let current = display
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
        let display_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.display_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        self.tabs.get_mut(tab_id).expect("tab exists").hidden = true;
        let display = self.displays.get_mut(&display_id).expect("display exists");
        if display.active_tab_id.as_deref() == Some(tab_id) {
            display.active_tab_id = display
                .tab_ids
                .iter()
                .find(|id| self.tabs.get(*id).is_some_and(|tab| !tab.hidden))
                .cloned();
        }
        Ok(())
    }

    fn reorder_tab(&mut self, tab_id: &str, before_tab_id: Option<&str>) -> CoreResult<()> {
        let display_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.display_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        let display = self.displays.get_mut(&display_id).expect("display exists");
        let mut ids = display
            .tab_ids
            .iter()
            .filter(|id| id.as_str() != tab_id)
            .cloned()
            .collect::<Vec<_>>();
        let index = before_tab_id
            .and_then(|before| ids.iter().position(|id| id == before))
            .unwrap_or(ids.len());
        ids.insert(index, tab_id.to_owned());
        display.tab_ids = ids;
        Ok(())
    }

    fn move_tab(&mut self, tab_id: &str, display_id: i64) -> CoreResult<()> {
        let source_id = self
            .tabs
            .get(tab_id)
            .map(|tab| tab.display_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        if source_id == display_id {
            return Ok(());
        }
        self.register_display(display_id);
        let source_empty = if let Some(source) = self.displays.get_mut(&source_id) {
            source.tab_ids.retain(|id| id != tab_id);
            if source.active_tab_id.as_deref() == Some(tab_id) {
                source.active_tab_id = source.tab_ids.first().cloned();
            }
            source.tab_ids.is_empty()
        } else {
            false
        };
        if source_empty {
            self.displays.remove(&source_id);
        }
        let target = self.displays.get_mut(&display_id).expect("display exists");
        target.tab_ids.push(tab_id.to_owned());
        target.active_tab_id = Some(tab_id.to_owned());
        self.tabs.get_mut(tab_id).expect("tab exists").display_id = display_id;
        if let Some(workspace_id) = self.tabs[tab_id].workspace_id.as_ref()
            && let Some(workspace) = self.workspaces.get_mut(workspace_id)
        {
            workspace.display_id = Some(display_id);
        }
        Ok(())
    }

    fn move_display_tabs(&mut self, source: i64, target: i64) -> CoreResult<()> {
        if source == target || !self.displays.contains_key(&source) {
            return Ok(());
        }
        self.register_display(target);
        let source_record = self.displays.remove(&source).expect("source exists");
        let target_record = self.displays.get_mut(&target).expect("target exists");
        let target_had_active = target_record.active_tab_id.is_some();
        for tab_id in &source_record.tab_ids {
            self.tabs.get_mut(tab_id).expect("tab exists").display_id = target;
            if let Some(workspace_id) = self.tabs[tab_id].workspace_id.as_ref()
                && let Some(workspace) = self.workspaces.get_mut(workspace_id)
            {
                workspace.display_id = Some(target);
            }
        }
        target_record.tab_ids.extend(source_record.tab_ids);
        if !target_had_active {
            target_record.active_tab_id = source_record.active_tab_id;
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
        if !matches!(runtime.as_str(), "embedded" | "external") {
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
        for display in self.displays.values() {
            for tab_id in &display.tab_ids {
                if !tab_ids.insert(tab_id) || !self.tabs.contains_key(tab_id) {
                    return Err(CoreError::Internal(
                        "browser runtime tab ownership is inconsistent".to_owned(),
                    ));
                }
            }
            if display
                .active_tab_id
                .as_ref()
                .is_some_and(|id| !display.tab_ids.contains(id))
            {
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
        let mut displays = self.displays.values().cloned().collect::<Vec<_>>();
        displays.sort_by_key(|display| display.display_id);
        let mut roles = self.roles.values().cloned().collect::<Vec<_>>();
        roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        let mut tabs = self.tabs.values().cloned().collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.id.cmp(&right.id));
        let mut workspaces = self.workspaces.values().cloned().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        BrowserRuntimeSnapshot {
            displays,
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
                "type":"createTab","sourceId":"w1","name":"Party","displayId":1,
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
                json!({"type":"moveTab","tabId":tab_id,"displayId":2}),
            ))
            .unwrap();
        assert_eq!(moved.snapshot.displays[0].display_id, 2);
        assert_eq!(moved.snapshot.workspaces[0].state, "running");
        assert_eq!(moved.snapshot.workspaces[0].display_id, Some(2));
    }

    #[test]
    fn rejects_duplicate_workspace_roles_and_invalid_transitions() {
        let mut runtime = BrowserRuntime::default();
        runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"w1","name":"One","displayId":1,
                "tabType":"workspace","workspaceId":"w1","roleIds":["r1"]
            })))
            .unwrap();
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"createTab","sourceId":"w2","name":"Two","displayId":2,
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
    fn promotes_pending_workspace_and_owns_exclusive_display_reservations() {
        let mut runtime = BrowserRuntime::default();
        runtime
            .invoke(command(json!({
                "type":"beginWorkspace","workspaceId":"w1","name":"One",
                "displayId":2,"roleIds":["r1"]
            })))
            .unwrap();
        let external = runtime
            .invoke(command(json!({
                "type":"createExternalWorkspace","workspaceId":"w1","name":"One",
                "displayId":2,"exclusiveDisplay":true,"roleIds":["r1"]
            })))
            .unwrap();
        crate::v1_case!("browser-workspace-834d6924d42c", {
            let workspace = external
                .snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == "w1")
                .unwrap();
            assert_eq!(workspace.runtime, "external");
            assert_eq!(workspace.display_id, Some(2));
            assert!(workspace.exclusive_display);
        });

        runtime
            .invoke(command(json!({
                "type":"beginWorkspace","workspaceId":"w2","name":"Two",
                "displayId":2,"roleIds":["r2"]
            })))
            .unwrap();
        let occupied_error = runtime
            .invoke(command(json!({
                "type":"createExternalWorkspace","workspaceId":"w2","name":"Two",
                "displayId":2,"exclusiveDisplay":true,"roleIds":["r2"]
            })))
            .unwrap_err();
        assert_eq!(occupied_error.code(), "WORKSPACE_DISPLAY_OCCUPIED");
        assert_eq!(runtime.snapshot().workspaces[1].runtime, "pending");

        runtime
            .invoke(command(
                json!({"type":"removeWorkspace","workspaceId":"w1"}),
            ))
            .unwrap();
        let released = runtime
            .invoke(command(json!({
                "type":"createExternalWorkspace","workspaceId":"w2","name":"Two",
                "displayId":2,"exclusiveDisplay":true,"roleIds":["r2"]
            })))
            .unwrap();
        crate::v1_case!("browser-workspace-fb693eb251e3", {
            assert_eq!(
                released
                    .snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.workspace_id == "w2")
                    .unwrap()
                    .runtime,
                "external"
            );
        });
    }

    #[test]
    fn owns_display_show_and_adjacent_tab_selection() {
        let mut runtime = BrowserRuntime::default();
        let first = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r1","name":"One","displayId":1,
                "tabType":"role","roleIds":["r1"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let second = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r2","name":"Two","displayId":1,
                "tabType":"role","roleIds":["r2"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let shown = runtime
            .invoke(command(json!({"type":"showDisplay","displayId":1})))
            .unwrap();
        assert_eq!(
            shown.snapshot.displays[0].active_tab_id,
            Some(first.clone())
        );
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
                "type":"activateAdjacentTab","displayId":1,"direction":"previous"
            })))
            .unwrap();
        assert_eq!(adjacent.snapshot.displays[0].active_tab_id, Some(first));
    }
}
