use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserRuntimeCommand, BrowserRuntimeResult, BrowserRuntimeRoleOwnerRecord,
        BrowserRuntimeRoleRecord, BrowserRuntimeSnapshot, BrowserRuntimeTabRecord,
        BrowserRuntimeWorkspaceRecord, RuntimeRoleSlotRecord,
    },
};

#[derive(Clone, Default)]
pub struct RoleOwnershipRuntime {
    next_owner_generation: u64,
    roles: HashMap<String, BrowserRuntimeRoleRecord>,
    tabs: HashMap<String, BrowserRuntimeTabRecord>,
}

impl RoleOwnershipRuntime {
    pub fn invoke(&mut self, command: BrowserRuntimeCommand) -> CoreResult<BrowserRuntimeResult> {
        self.invoke_inner(command)
    }

    fn invoke_inner(&mut self, command: BrowserRuntimeCommand) -> CoreResult<BrowserRuntimeResult> {
        let mut created_tab_id = None;
        let mut tab_created = false;
        match command {
            BrowserRuntimeCommand::Snapshot => {}
            BrowserRuntimeCommand::CreateTab {
                tab_id,
                source_id,
                name,
                tab_type,
                workspace_id,
                role_slots,
            } => {
                if !matches!(tab_type.as_str(), "role" | "workspace") {
                    return Err(domain(
                        "RUNTIME_TAB_TYPE_INVALID",
                        "Runtime tab type is invalid.",
                    ));
                }
                validate_role_slot_inputs(&tab_type, &role_slots)?;
                if let Some(existing) = self.tabs.values().find(|tab| {
                    tab.source_id == source_id
                        && tab.tab_type == tab_type
                        && tab.workspace_id == workspace_id
                }) {
                    created_tab_id = Some(existing.id.clone());
                } else {
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
                        window_id: String::new(),
                        tab_type,
                        workspace_id,
                        slots: role_slots
                            .into_iter()
                            .map(|slot| RuntimeRoleSlotRecord {
                                slot_id: slot.slot_id,
                                role_id: slot.role_id,
                                rect: slot.rect,
                                browser_zoom_percent: slot.browser_zoom_percent,
                                state: "available".to_owned(),
                                owner: None,
                            })
                            .collect(),
                        hidden: true,
                    };
                    self.tabs.insert(id.clone(), tab);
                    self.refresh_slot_states();
                    created_tab_id = Some(id);
                    tab_created = true;
                }
            }
            BrowserRuntimeCommand::RemoveTab { tab_id } => self.remove_tab(&tab_id),
            BrowserRuntimeCommand::CloseTabs { tab_ids } => self.close_tabs(&tab_ids),
            BrowserRuntimeCommand::RoleTransition {
                role_id,
                runtime,
                tab_id,
                slot_id,
                state,
                launched_at,
            } => {
                self.transition_role(role_id, runtime, tab_id, slot_id, &state, launched_at)?
            }
            BrowserRuntimeCommand::ReleaseRole {
                role_id,
                expected_tab_id,
            } => {
                if let Some(expected_tab_id) = expected_tab_id
                    && self
                        .roles
                        .get(&role_id)
                        .is_some_and(|role| role.owner.tab_id != expected_tab_id)
                {
                    return Err(domain(
                        "RUNTIME_ROLE_OWNER_STALE",
                        "The role moved to another slot before it could be released.",
                    ));
                }
                self.roles.remove(&role_id);
                self.refresh_slot_states();
            }
            BrowserRuntimeCommand::ClaimRoleSlot {
                role_id,
                tab_id,
                slot_id,
                expected_owner_generation,
            } => self.claim_role_slot(
                &role_id,
                &tab_id,
                &slot_id,
                expected_owner_generation,
            )?,
        }
        self.validate()?;
        Ok(BrowserRuntimeResult {
            created_tab_id,
            tab_created,
            snapshot: self.snapshot(),
        })
    }

    fn remove_tab(&mut self, tab_id: &str) {
        let Some(_tab) = self.tabs.remove(tab_id) else {
            return;
        };
        self.roles
            .retain(|_, role| role.owner.tab_id.as_str() != tab_id);
        self.refresh_slot_states();
    }

    fn close_tabs(&mut self, tab_ids: &[String]) {
        let tab_ids = tab_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        self.tabs
            .retain(|tab_id, _| !tab_ids.contains(tab_id.as_str()));
        self.roles
            .retain(|_, role| !tab_ids.contains(role.owner.tab_id.as_str()));
        self.refresh_slot_states();
    }

    fn transition_role(
        &mut self,
        role_id: String,
        runtime: String,
        tab_id: String,
        slot_id: Option<String>,
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
        let tab = self
            .tabs
            .get(&tab_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        let slot = slot_id
            .as_deref()
            .and_then(|slot_id| tab.slots.iter().find(|slot| slot.slot_id == slot_id))
            .or_else(|| tab.slots.iter().find(|slot| slot.role_id == role_id))
            .ok_or_else(|| {
                domain(
                    "RUNTIME_ROLE_SLOT_NOT_FOUND",
                    "The runtime tab does not contain a slot for this role.",
                )
            })?;
        if slot.role_id != role_id {
            return Err(domain(
                "RUNTIME_ROLE_SLOT_MISMATCH",
                "The runtime slot belongs to another role.",
            ));
        }
        let slot_id = slot.slot_id.clone();
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
        if let Some(existing) = self.roles.get(&role_id)
            && (existing.owner.tab_id != tab_id || existing.owner.slot_id != slot_id)
        {
            return Err(domain(
                "RUNTIME_ROLE_ALREADY_OWNED",
                "The role is owned by another runtime slot.",
            ));
        }
        let launched_at = launched_at.or_else(|| {
            self.roles
                .get(&role_id)
                .and_then(|role| role.launched_at.clone())
        });
        let owner = self
            .roles
            .get(&role_id)
            .map(|role| role.owner.clone())
            .unwrap_or_else(|| self.next_owner(tab_id, slot_id));
        self.roles.insert(
            role_id.clone(),
            BrowserRuntimeRoleRecord {
                role_id,
                runtime,
                owner,
                state: state.to_owned(),
                launched_at,
            },
        );
        self.refresh_slot_states();
        Ok(())
    }

    fn claim_role_slot(
        &mut self,
        role_id: &str,
        tab_id: &str,
        slot_id: &str,
        expected_owner_generation: Option<u64>,
    ) -> CoreResult<()> {
        let tab = self
            .tabs
            .get(tab_id)
            .ok_or_else(|| domain("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
        if !tab
            .slots
            .iter()
            .any(|slot| slot.slot_id == slot_id && slot.role_id == role_id)
        {
            return Err(domain(
                "RUNTIME_ROLE_SLOT_NOT_FOUND",
                "The requested runtime role slot was not found.",
            ));
        }
        match (self.roles.get(role_id), expected_owner_generation) {
            (None, None) => {}
            (Some(role), Some(expected)) if role.owner.generation == expected => {
                if role.owner.tab_id == tab_id && role.owner.slot_id == slot_id {
                    return Err(domain(
                        "RUNTIME_ROLE_SLOT_ALREADY_OWNED",
                        "The target slot already owns this role.",
                    ));
                }
            }
            _ => {
                return Err(domain(
                    "RUNTIME_ROLE_OWNER_STALE",
                    "The role owner changed before the takeover could commit.",
                ));
            }
        }
        let launched_at = self
            .roles
            .get(role_id)
            .and_then(|role| role.launched_at.clone());
        let owner = self.next_owner(tab_id.to_owned(), slot_id.to_owned());
        self.roles.insert(
            role_id.to_owned(),
            BrowserRuntimeRoleRecord {
                role_id: role_id.to_owned(),
                runtime: "embedded".to_owned(),
                owner,
                state: "launching".to_owned(),
                launched_at,
            },
        );
        self.refresh_slot_states();
        Ok(())
    }

    fn next_owner(&mut self, tab_id: String, slot_id: String) -> BrowserRuntimeRoleOwnerRecord {
        self.next_owner_generation = self.next_owner_generation.saturating_add(1).max(1);
        BrowserRuntimeRoleOwnerRecord {
            tab_id,
            slot_id,
            generation: self.next_owner_generation,
        }
    }

    fn refresh_slot_states(&mut self) {
        for tab in self.tabs.values_mut() {
            for slot in &mut tab.slots {
                match self.roles.get(&slot.role_id) {
                    Some(role)
                        if role.owner.tab_id == tab.id && role.owner.slot_id == slot.slot_id =>
                    {
                        slot.state = role.state.clone();
                        slot.owner = Some(role.owner.clone());
                    }
                    Some(role) => {
                        slot.state = "blocked".to_owned();
                        slot.owner = Some(role.owner.clone());
                    }
                    None => {
                        slot.state = "available".to_owned();
                        slot.owner = None;
                    }
                }
            }
        }
    }

    fn validate(&self) -> CoreResult<()> {
        for role in self.roles.values() {
            let Some(tab) = self.tabs.get(&role.owner.tab_id) else {
                return Err(CoreError::Internal(
                    "browser runtime role owner references a missing tab".to_owned(),
                ));
            };
            if !tab.slots.iter().any(|slot| {
                slot.slot_id == role.owner.slot_id && slot.role_id == role.role_id
            })
            {
                return Err(CoreError::Internal(
                    "browser runtime role owner references an inconsistent slot".to_owned(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> BrowserRuntimeSnapshot {
        let mut roles = self.roles.values().cloned().collect::<Vec<_>>();
        roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        let mut tabs = self.tabs.values().cloned().collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.id.cmp(&right.id));
        let mut workspaces = tabs
            .iter()
            .filter(|tab| tab.tab_type == "workspace")
            .map(|tab| BrowserRuntimeWorkspaceRecord {
                workspace_id: tab.source_id.clone(),
                name: tab.name.clone(),
                runtime: "embedded".to_owned(),
                window_id: String::new(),
                tab_id: tab.id.clone(),
                role_ids: tab.slots.iter().map(|slot| slot.role_id.clone()).collect(),
                state: workspace_state(&tab.slots).to_owned(),
            })
            .collect::<Vec<_>>();
        workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        BrowserRuntimeSnapshot {
            windows: Vec::new(),
            roles,
            tabs,
            workspaces,
        }
    }
}
