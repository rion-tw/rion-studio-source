use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender, after, bounded, select};

use crate::{
    error::{CoreError, CoreResult},
    external_automation::ExternalAutomationRuntime,
    model::{CoreEvent, MacroDefinition, MacroOverlayRequestRecord},
};

const REFRESH_MIN_INTERVAL: Duration = Duration::from_millis(250);

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;

pub fn parse_request(raw: &str) -> CoreResult<MacroOverlayRequestRecord> {
    let request = serde_json::from_str::<MacroOverlayRequestRecord>(raw).map_err(|_| {
        domain(
            "MACRO_OVERLAY_REQUEST_INVALID",
            "Macro overlay request is invalid.",
        )
    })?;
    validate_request(&request)?;
    Ok(request)
}

pub fn available_macros(macros: &[MacroDefinition], role_id: &str) -> Vec<MacroDefinition> {
    macros
        .iter()
        .filter(|definition| {
            definition
                .role_ids
                .iter()
                .any(|candidate| candidate == role_id)
                && !has_unassigned_dependency(macros, &definition.id)
        })
        .cloned()
        .collect()
}

pub fn ensure_macro_available(
    macros: &[MacroDefinition],
    role_id: &str,
    macro_id: &str,
) -> CoreResult<()> {
    if available_macros(macros, role_id)
        .iter()
        .any(|definition| definition.id == macro_id)
    {
        Ok(())
    } else {
        Err(domain(
            "MACRO_ROLE_INVALID",
            "This macro is not assigned to the current role.",
        ))
    }
}

fn validate_request(request: &MacroOverlayRequestRecord) -> CoreResult<()> {
    match request {
        MacroOverlayRequestRecord::Start { macro_id }
        | MacroOverlayRequestRecord::Toggle { macro_id }
        | MacroOverlayRequestRecord::Stop { macro_id } => validate_identifier(macro_id, "macroId"),
        MacroOverlayRequestRecord::Press { macro_id, press_id } => {
            validate_identifier(macro_id, "macroId")?;
            validate_identifier(press_id, "pressId")
        }
        MacroOverlayRequestRecord::Release {
            macro_id,
            press_id,
            release_mode,
        } => {
            validate_identifier(macro_id, "macroId")?;
            validate_identifier(press_id, "pressId")?;
            if release_mode
                .as_deref()
                .is_some_and(|mode| !matches!(mode, "complete_first_iteration" | "immediate"))
            {
                return Err(domain(
                    "MACRO_OVERLAY_REQUEST_INVALID",
                    "Macro overlay release mode is invalid.",
                ));
            }
            Ok(())
        }
        MacroOverlayRequestRecord::CopyCoordinate { coordinate } => {
            if coordinate.viewport_width_px == 0
                || coordinate.viewport_height_px == 0
                || coordinate.x_px >= coordinate.viewport_width_px
                || coordinate.y_px >= coordinate.viewport_height_px
                || !valid_percent(coordinate.x_percent)
                || !valid_percent(coordinate.y_percent)
            {
                return Err(domain(
                    "MACRO_OVERLAY_REQUEST_INVALID",
                    "Macro overlay coordinate is invalid.",
                ));
            }
            Ok(())
        }
        MacroOverlayRequestRecord::GameInputContext { .. }
        | MacroOverlayRequestRecord::List
        | MacroOverlayRequestRecord::Open => Ok(()),
    }
}

fn validate_identifier(value: &str, field: &str) -> CoreResult<()> {
    if value.trim().is_empty() || value.len() > 256 {
        Err(domain(
            "MACRO_OVERLAY_REQUEST_INVALID",
            &format!("Macro overlay {field} is invalid."),
        ))
    } else {
        Ok(())
    }
}

fn valid_percent(value: f64) -> bool {
    value.is_finite() && (0.0..=100.0).contains(&value)
}

fn has_unassigned_dependency(macros: &[MacroDefinition], source_macro_id: &str) -> bool {
    let by_id = macros
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<HashMap<_, _>>();
    let mut pending = vec![source_macro_id];
    let mut visited = HashSet::new();
    while let Some(macro_id) = pending.pop() {
        if !visited.insert(macro_id) {
            continue;
        }
        let Some(definition) = by_id.get(macro_id) else {
            continue;
        };
        if definition.role_ids.is_empty() {
            return true;
        }
        for step in &definition.steps {
            if let crate::model::MacroStepDefinition::Macro { macro_id, .. } = step {
                pending.push(macro_id);
            }
        }
    }
    false
}

pub struct OverlayRefreshRuntime {
    control: Sender<()>,
    invalidation: Sender<Vec<String>>,
    join: Mutex<Option<JoinHandle<()>>>,
    stopped: AtomicBool,
}

impl OverlayRefreshRuntime {
    pub fn start(
        core_events: Receiver<Vec<CoreEvent>>,
        events: EventSink,
        external: Arc<ExternalAutomationRuntime>,
    ) -> CoreResult<Self> {
        let (control, control_receiver) = bounded(1);
        let (invalidation, invalidation_receiver) = bounded(32);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-overlay-refresh".to_owned())
            .spawn(move || {
                let io_runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .thread_name("rion-overlay-cdp")
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_sender.send(Err(error.to_string()));
                        return;
                    }
                };
                let io_handle = io_runtime.handle().clone();
                if ready_sender.send(Ok(())).is_err() {
                    return;
                }
                run_refresh_worker(
                    core_events,
                    control_receiver,
                    invalidation_receiver,
                    events,
                    external,
                    io_handle,
                );
                io_runtime.shutdown_timeout(Duration::from_secs(3));
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        match ready_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = join.join();
                return Err(CoreError::Internal(error));
            }
            Err(_) => {
                let _ = join.join();
                return Err(CoreError::Internal(
                    "overlay refresh worker stopped during startup".to_owned(),
                ));
            }
        }
        Ok(Self {
            control,
            invalidation,
            join: Mutex::new(Some(join)),
            stopped: AtomicBool::new(false),
        })
    }

    pub fn invalidate(&self, role_ids: Vec<String>) {
        let _ = self.invalidation.try_send(role_ids);
    }

    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.control.try_send(());
        if let Ok(mut join) = self.join.lock()
            && let Some(join) = join.take()
        {
            let _ = join.join();
        }
    }
}

impl Drop for OverlayRefreshRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Default)]
struct OverlayProjection {
    browser: HashMap<String, String>,
    macros: HashMap<String, String>,
    resources: HashMap<String, String>,
    unresponsive: HashSet<String>,
}

#[derive(Default)]
struct PendingRefresh {
    all: bool,
    role_ids: HashSet<String>,
}

impl PendingRefresh {
    fn is_empty(&self) -> bool {
        !self.all && self.role_ids.is_empty()
    }

    fn merge(&mut self, change: ProjectionChange) {
        self.all |= change.all;
        self.role_ids.extend(change.role_ids);
    }

    fn take(&mut self) -> (bool, Vec<String>) {
        let all = self.all;
        let mut role_ids = self.role_ids.drain().collect::<Vec<_>>();
        role_ids.sort();
        self.all = false;
        (all, role_ids)
    }
}

#[derive(Default)]
struct ProjectionChange {
    all: bool,
    role_ids: HashSet<String>,
}

impl OverlayProjection {
    fn observe(&mut self, events: &[CoreEvent]) -> ProjectionChange {
        let mut change = ProjectionChange::default();
        for event in events {
            match event {
                CoreEvent::StateChanged { .. } => change.all = true,
                CoreEvent::MacroStatuses { statuses, .. } => {
                    change.role_ids.extend(update_grouped_signatures(
                        &mut self.macros,
                        statuses,
                        |status| &status.role_id,
                    ));
                }
                CoreEvent::BrowserStatuses { statuses } => {
                    self.unresponsive = statuses
                        .iter()
                        .filter(|status| status.page_health.as_deref() == Some("unresponsive"))
                        .map(|status| status.role_id.clone())
                        .collect();
                    change.role_ids.extend(update_grouped_signatures(
                        &mut self.browser,
                        statuses,
                        |status| &status.role_id,
                    ));
                }
                CoreEvent::ResourceStatuses { statuses } => {
                    change.role_ids.extend(update_grouped_signatures(
                        &mut self.resources,
                        statuses,
                        |status| &status.role_id,
                    ));
                }
                _ => {}
            }
        }
        change
    }
}

fn update_grouped_signatures<T: serde::Serialize>(
    previous: &mut HashMap<String, String>,
    values: &[T],
    role_id: impl for<'a> Fn(&'a T) -> &'a str,
) -> HashSet<String> {
    let mut grouped = HashMap::<String, Vec<&T>>::new();
    for value in values {
        grouped
            .entry(role_id(value).to_owned())
            .or_default()
            .push(value);
    }
    let next = grouped
        .into_iter()
        .map(|(role_id, mut values)| {
            values.sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
            (
                role_id,
                serde_json::to_string(&values).unwrap_or_else(|_| "[]".to_owned()),
            )
        })
        .collect::<HashMap<_, _>>();
    let changed = previous
        .keys()
        .chain(next.keys())
        .filter(|role_id| previous.get(*role_id) != next.get(*role_id))
        .cloned()
        .collect::<HashSet<_>>();
    *previous = next;
    changed
}

fn run_refresh_worker(
    core_events: Receiver<Vec<CoreEvent>>,
    control: Receiver<()>,
    invalidation: Receiver<Vec<String>>,
    events: EventSink,
    external: Arc<ExternalAutomationRuntime>,
    io: tokio::runtime::Handle,
) {
    let mut projection = OverlayProjection::default();
    let mut pending = PendingRefresh::default();
    let mut last_started = Instant::now()
        .checked_sub(REFRESH_MIN_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        if pending.is_empty() {
            select! {
                recv(control) -> _ => break,
                recv(invalidation) -> incoming => {
                    let Ok(role_ids) = incoming else { break };
                    pending.merge(explicit_invalidation(role_ids));
                },
                recv(core_events) -> incoming => {
                    let Ok(incoming) = incoming else { break };
                    pending.merge(projection.observe(&incoming));
                }
            }
        } else {
            let remaining = REFRESH_MIN_INTERVAL.saturating_sub(last_started.elapsed());
            if remaining.is_zero() {
                flush_refresh(&mut pending, &projection, &events, &external, &io);
                last_started = Instant::now();
                continue;
            }
            select! {
                recv(control) -> _ => break,
                recv(invalidation) -> incoming => {
                    let Ok(role_ids) = incoming else { break };
                    pending.merge(explicit_invalidation(role_ids));
                },
                recv(core_events) -> incoming => {
                    let Ok(incoming) = incoming else { break };
                    pending.merge(projection.observe(&incoming));
                },
                recv(after(remaining)) -> _ => {
                    flush_refresh(
                        &mut pending,
                        &projection,
                        &events,
                        &external,
                        &io,
                    );
                    last_started = Instant::now();
                }
            }
        }
    }
}

fn explicit_invalidation(role_ids: Vec<String>) -> ProjectionChange {
    if role_ids.is_empty() {
        return ProjectionChange {
            all: true,
            role_ids: HashSet::new(),
        };
    }
    ProjectionChange {
        all: false,
        role_ids: role_ids.into_iter().collect(),
    }
}

fn flush_refresh(
    pending: &mut PendingRefresh,
    projection: &OverlayProjection,
    events: &EventSink,
    external: &Arc<ExternalAutomationRuntime>,
    io: &tokio::runtime::Handle,
) {
    let (all, role_ids) = pending.take();
    let event_role_ids = if all { Vec::new() } else { role_ids.clone() };
    events(vec![CoreEvent::OverlayChanged {
        role_ids: event_role_ids,
    }]);

    let external_role_ids = if all {
        external.role_ids().unwrap_or_default()
    } else {
        role_ids
    };
    let external_role_ids = external_role_ids
        .into_iter()
        .filter(|role_id| !projection.unresponsive.contains(role_id))
        .collect::<Vec<_>>();
    if external_role_ids.is_empty() {
        return;
    }
    let external = Arc::clone(external);
    io.spawn(async move {
        for role_id in external_role_ids {
            let _ = external.refresh_overlay(&role_id).await;
        }
    });
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::model::{
        BrowserRoleStatusRecord, MacroLastClick, MacroRepeat, MacroRunStatus, MacroStepDefinition,
        ResourceRuntimeStatusRecord,
    };

    fn definition(id: &str, role_ids: &[&str], steps: Vec<MacroStepDefinition>) -> MacroDefinition {
        MacroDefinition {
            id: id.to_owned(),
            enabled: true,
            activation_mode: None,
            name: id.to_owned(),
            role_ids: role_ids
                .iter()
                .map(|role_id| (*role_id).to_owned())
                .collect(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps,
        }
    }

    #[test]
    fn validates_requests_and_filters_unassigned_dependency_graphs() {
        assert!(parse_request(r#"{"type":"list"}"#).is_ok());
        assert!(
            parse_request(
                r#"{"type":"release","macroId":"m","pressId":"p","releaseMode":"later"}"#
            )
            .is_err()
        );
        assert!(parse_request(r#"{"type":"copy-coordinate","xPercent":1,"xPx":10,"viewportHeightPx":10,"viewportWidthPx":10,"yPercent":1,"yPx":1}"#).is_err());
        crate::v1_case!("overlay-a7ce35e7128c", {
            assert!(
                parse_request(
                    r#"{"type":"copy-coordinate","xPercent":12,"xPx":123,"yPercent":45,"yPx":-1}"#
                )
                .is_err()
            );
        });
        crate::v1_case!("overlay-3a84b61de0af", {
            assert!(parse_request(
                r#"{"type":"copy-coordinate","viewportWidthPx":500,"viewportHeightPx":500,"xPercent":101,"xPx":123,"yPercent":45,"yPx":456}"#
            )
            .is_err());
        });
        crate::v1_case!("overlay-b04ef43fac61", {
            assert!(parse_request(
                r#"{"type":"copy-coordinate","viewportWidthPx":500,"viewportHeightPx":500,"xPercent":12,"xPx":123.5,"yPercent":45,"yPx":456}"#
            )
            .is_err());
        });
        crate::v1_case!("overlay-f8625e34b90e", {
            assert!(parse_request(
                r#"{"type":"copy-coordinate","viewportWidthPx":100,"viewportHeightPx":100,"xPercent":12,"xPx":100,"yPercent":45,"yPx":45}"#
            )
            .is_err());
        });
        crate::v1_case!("overlay-9d0896d3a85e", {
            assert!(parse_request(
                r#"{"type":"copy-coordinate","viewportWidthPx":0,"viewportHeightPx":100,"xPercent":12,"xPx":0,"yPercent":45,"yPx":45}"#
            )
            .is_err());
        });

        let macros = vec![
            definition(
                "root",
                &["role-1"],
                vec![MacroStepDefinition::Macro {
                    id: "step-1".to_owned(),
                    macro_id: "dependency".to_owned(),
                    call_mode: None,
                }],
            ),
            definition("dependency", &[], Vec::new()),
        ];
        crate::v1_case!("overlay-078d30234927", {
            assert!(available_macros(&macros, "role-1").is_empty());
        });
        crate::v1_case!("overlay-54baaea7a3bb", {
            assert_eq!(
                ensure_macro_available(&macros, "role-1", "root")
                    .unwrap_err()
                    .code(),
                "MACRO_ROLE_INVALID"
            );
        });
    }

    #[test]
    fn projects_only_roles_with_changed_macro_or_resource_presentation() {
        let mut projection = OverlayProjection::default();
        let status = MacroRunStatus {
            role_id: "role-1".to_owned(),
            macro_id: "macro-1".to_owned(),
            state: "running".to_owned(),
            iteration: Some(0),
            last_click: None,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            error: None,
        };
        let first = projection.observe(&[CoreEvent::MacroStatuses {
            reliable: true,
            statuses: vec![status.clone()],
        }]);
        crate::v1_case!("overlay-51deeca46423", {
            assert_eq!(first.role_ids, HashSet::from(["role-1".to_owned()]));
        });
        assert!(
            projection
                .observe(&[CoreEvent::MacroStatuses {
                    reliable: true,
                    statuses: vec![status.clone()],
                }])
                .role_ids
                .is_empty()
        );
        let mut clicked = status;
        clicked.last_click = Some(MacroLastClick {
            sequence: 1,
            step_id: "click-1".to_owned(),
        });
        crate::v1_case!("overlay-7f93c2e432e3", {
            assert_eq!(
                projection
                    .observe(&[CoreEvent::MacroStatuses {
                        reliable: false,
                        statuses: vec![clicked],
                    }])
                    .role_ids,
                HashSet::from(["role-1".to_owned()])
            );
        });
        assert_eq!(
            projection
                .observe(&[CoreEvent::ResourceStatuses {
                    statuses: vec![ResourceRuntimeStatusRecord {
                        role_id: "role-2".to_owned(),
                        cpu_throttle_rate: 2,
                        resource_state: "throttled".to_owned(),
                        resource_pressure_level: Some("normal".to_owned()),
                        resource_reason: Some("runtime_tab_background".to_owned()),
                    }],
                }])
                .role_ids,
            HashSet::from(["role-2".to_owned()])
        );
    }

    #[test]
    fn coalesces_and_rate_limits_external_refresh_bursts() {
        let (core_sender, core_receiver) = bounded(32);
        let (output_sender, output_receiver) = std::sync::mpsc::channel();
        let starts = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let starts_output = Arc::clone(&starts);
        let events: EventSink = Arc::new(move |events| {
            if events
                .iter()
                .any(|event| matches!(event, CoreEvent::OverlayChanged { .. }))
            {
                starts_output.lock().unwrap().push(Instant::now());
                let _ = output_sender.send(());
            }
        });
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshes_output = Arc::clone(&refreshes);
        let external = Arc::new(ExternalAutomationRuntime::new("darwin".to_owned()));
        external
            .register(
                "role-1".to_owned(),
                Arc::new(crate::ExternalChromeCdpSession::test_session_with_observer(
                    Duration::from_millis(100),
                    move || {
                        refreshes_output.fetch_add(1, Ordering::AcqRel);
                    },
                )),
            )
            .unwrap();
        let runtime = OverlayRefreshRuntime::start(core_receiver, events, external).unwrap();

        runtime.invalidate(vec!["role-1".to_owned()]);
        output_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        for _ in 0..20 {
            runtime.invalidate(vec!["role-1".to_owned()]);
        }
        output_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while refreshes.load(Ordering::Acquire) < 2 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        thread::sleep(Duration::from_millis(300));
        crate::v1_case!("overlay-4cc5837ceff2", {
            assert_eq!(refreshes.load(Ordering::Acquire), 2);
        });
        crate::v1_case!("overlay-d253bf812639", {
            let starts = starts.lock().unwrap();
            assert_eq!(REFRESH_MIN_INTERVAL, Duration::from_millis(250));
            assert!(starts[1].duration_since(starts[0]) >= Duration::from_millis(240));
        });
        drop(core_sender);
        runtime.shutdown();
    }

    #[test]
    fn skips_unresponsive_or_disconnected_external_refresh_targets() {
        let (core_sender, core_receiver) = bounded(32);
        let (output_sender, output_receiver) = std::sync::mpsc::channel();
        let events: EventSink = Arc::new(move |events| {
            if events
                .iter()
                .any(|event| matches!(event, CoreEvent::OverlayChanged { .. }))
            {
                let _ = output_sender.send(());
            }
        });
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshes_output = Arc::clone(&refreshes);
        let external = Arc::new(ExternalAutomationRuntime::new("darwin".to_owned()));
        external
            .register(
                "role-1".to_owned(),
                Arc::new(crate::ExternalChromeCdpSession::test_session_with_observer(
                    Duration::from_millis(25),
                    move || {
                        refreshes_output.fetch_add(1, Ordering::AcqRel);
                    },
                )),
            )
            .unwrap();
        let runtime =
            OverlayRefreshRuntime::start(core_receiver, events, Arc::clone(&external)).unwrap();

        core_sender
            .send(vec![CoreEvent::BrowserStatuses {
                statuses: vec![browser_status("role-1", Some("unresponsive"))],
            }])
            .unwrap();
        output_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        thread::sleep(Duration::from_millis(75));
        crate::v1_case!("overlay-b4848b618886", {
            assert_eq!(refreshes.load(Ordering::Acquire), 0);
        });

        core_sender
            .send(vec![CoreEvent::BrowserStatuses {
                statuses: vec![browser_status("role-1", Some("healthy"))],
            }])
            .unwrap();
        output_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while refreshes.load(Ordering::Acquire) < 1 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        runtime.invalidate(vec!["role-1".to_owned()]);
        external.unregister("role-1").unwrap();
        output_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        thread::sleep(Duration::from_millis(75));
        crate::v1_case!("overlay-832f83a77ef2", {
            assert_eq!(refreshes.load(Ordering::Acquire), 1);
        });
        runtime.shutdown();
    }

    fn browser_status(role_id: &str, page_health: Option<&str>) -> BrowserRoleStatusRecord {
        BrowserRoleStatusRecord {
            role_id: role_id.to_owned(),
            state: "running".to_owned(),
            launched_at: Some("2026-01-01T00:00:00Z".to_owned()),
            notice: None,
            runtime_mode: "external".to_owned(),
            automation_state: Some("ready".to_owned()),
            page_health: page_health.map(str::to_owned),
            resource_state: None,
            cpu_throttle_rate: None,
            resource_pressure_level: None,
            resource_reason: None,
        }
    }
}
