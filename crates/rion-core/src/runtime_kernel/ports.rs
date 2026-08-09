use crate::model::{DisplayTargetRecord, GameWindowPlacementRecord, GameWindowRoleSlotRecord};

use super::{
    LaunchAttemptId, OperationId, RuntimeSnapshot, RuntimeSurfaceGeneration,
    RuntimeSurfaceLifecycle, RuntimeWindowGeneration,
};

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeNativeTabProjection {
    pub audio_muted: bool,
    pub closable: bool,
    pub hidden: bool,
    pub icon_data_url: Option<String>,
    pub persistable: bool,
    pub role_ids: Vec<String>,
    pub role_slots: Vec<GameWindowRoleSlotRecord>,
    pub selected: bool,
    pub source_id: String,
    pub tab_id: String,
    pub tab_type: String,
    pub title: String,
    pub workspace_template: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeNativeSurfaceFence {
    pub attempt_id: LaunchAttemptId,
    pub lifecycle: RuntimeSurfaceLifecycle,
    pub operation_id: OperationId,
    pub surface_generation: RuntimeSurfaceGeneration,
    pub tab_id: String,
    pub window_generation: RuntimeWindowGeneration,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeNativeProjection {
    pub persisted_name: Option<String>,
    pub placement: Option<GameWindowPlacementRecord>,
    pub revision: u64,
    pub surfaces: Vec<RuntimeNativeSurfaceFence>,
    pub tabs: Vec<RuntimeNativeTabProjection>,
    pub target_display: Option<DisplayTargetRecord>,
    pub window_generation: u64,
    pub window_id: String,
    pub window_revision: u64,
    pub window_zoom_factor: Option<f64>,
}

impl RuntimeSnapshot {
    pub fn native_projection(&self, window_id: &str) -> Option<RuntimeNativeProjection> {
        let window = self.windows.get(window_id)?;
        let tabs = window
            .tabs
            .iter()
            .map(|tab| RuntimeNativeTabProjection {
                audio_muted: tab.audio_muted,
                closable: tab.closable,
                hidden: window.hidden_tab_ids.contains(&tab.id),
                icon_data_url: tab.icon_data_url.clone(),
                persistable: tab.persistable,
                role_ids: tab.role_ids.clone(),
                role_slots: tab.role_slots.clone(),
                selected: window.selected_tab_id.as_deref() == Some(tab.id.as_str()),
                source_id: tab.source_id.clone(),
                tab_id: tab.id.clone(),
                tab_type: tab.tab_type.clone(),
                title: tab.title.clone(),
                workspace_template: tab.workspace_template.clone(),
            })
            .collect::<Vec<_>>();
        let tab_ids = tabs
            .iter()
            .map(|tab| tab.tab_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut surfaces = self
            .logical_surfaces
            .values()
            .filter(|surface| tab_ids.contains(surface.tab_id.as_str()))
            .map(|surface| RuntimeNativeSurfaceFence {
                attempt_id: surface.attempt_id.clone(),
                lifecycle: surface.lifecycle,
                operation_id: surface.operation_id.clone(),
                surface_generation: surface.surface_generation,
                tab_id: surface.tab_id.as_str().to_owned(),
                window_generation: surface.window_generation,
            })
            .collect::<Vec<_>>();
        surfaces.sort_by(|left, right| left.tab_id.cmp(&right.tab_id));
        Some(RuntimeNativeProjection {
            persisted_name: window.persisted_name.clone(),
            placement: window.placement.clone(),
            revision: self.revision,
            surfaces,
            tabs,
            target_display: window.target_display.clone(),
            window_generation: window.window_generation,
            window_id: window_id.to_owned(),
            window_revision: window.revision,
            window_zoom_factor: window.window_zoom_factor,
        })
    }
}

pub trait WindowPort {
    type Error;

    fn apply_window(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error>;
}

pub trait TabChromePort {
    type Error;

    fn apply_tab_chrome(&mut self, projection: &RuntimeNativeProjection)
    -> Result<(), Self::Error>;
}

pub trait SurfacePort {
    type Error;

    fn apply_surfaces(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error>;
}

pub trait FocusPort {
    type Error;

    fn apply_focus(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error>;
}

pub fn apply_runtime_native_projection<P, E>(
    port: &mut P,
    projection: &RuntimeNativeProjection,
) -> Result<(), E>
where
    P: WindowPort<Error = E>
        + TabChromePort<Error = E>
        + SurfacePort<Error = E>
        + FocusPort<Error = E>,
{
    port.apply_window(projection)?;
    port.apply_tab_chrome(projection)?;
    port.apply_surfaces(projection)?;
    port.apply_focus(projection)
}
