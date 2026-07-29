use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::Utc;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserAction, BrowserActionRequest, BrowserActionResult, CoreEvent, MacroDefinition,
        MacroLastClick, MacroPressRequest, MacroReleaseRequest, MacroRepeat, MacroRunStatus,
        MacroRuntimeSettings, MacroStartRequest, MacroStepDefinition,
    },
};

const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const INVOCATION_STOP_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ACTIVE_INVOCATIONS: usize = 64;
const MAX_PENDING_ACTIONS: usize = 512;
const PRESENTATION_STATUS_MIN_INTERVAL: Duration = Duration::from_millis(250);
const SIBLING_FAILURE_MESSAGE: &str = "Cancelled because another assigned role failed.";
const UNASSIGNED_WORKFLOW_MESSAGE: &str =
    "Assign a role to this macro and every called macro before running it.";
const DISABLED_MACRO_MESSAGE: &str = "Enable this macro before running it.";
const UNAVAILABLE_ROLE_MESSAGE: &str = "Launch at least one assigned role before running a macro.";
const STOPPING_ROLE_MESSAGE: &str =
    "A role assigned to this macro is stopping and cannot accept new input.";

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;
type Waiter = Arc<dyn Fn(&Arc<InvocationControl>, &str, u32) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct MacroRuntime {
    shared: Arc<Shared>,
}

struct Shared {
    action_timeout: Duration,
    action_role_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    events: EventSink,
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::SyncSender<BrowserActionResult>>>,
    last_presentation_status_emit: Mutex<Option<Instant>>,
    shutting_down: AtomicBool,
    input_sequence_role_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    toggle_serial: Mutex<()>,
    waiter: Waiter,
}

#[derive(Default)]
struct Inner {
    held_keys: HashMap<String, HeldKey>,
    invocations: HashMap<String, Arc<InvocationControl>>,
    leases: HashMap<String, HeldLease>,
    early_releases: HashMap<String, String>,
    mutation_leases: HashMap<String, HashSet<String>>,
    mutating_macro_ids: HashSet<String>,
    stopping_role_ids: HashSet<String>,
    statuses: HashMap<String, MacroRunStatus>,
}

struct HeldLease {
    invocation_id: String,
    press_id: String,
}

struct InvocationControl {
    barriers: Mutex<HashMap<String, Arc<InvocationBarrier>>>,
    cancelled: AtomicBool,
    cancellation_error: Mutex<Option<String>>,
    cancelled_role_ids: Mutex<HashSet<String>>,
    children: (Mutex<ChildInvocations>, Condvar),
    failed_role_id: Mutex<Option<String>>,
    first_iteration_completed: AtomicBool,
    first_iteration_roles: (Mutex<HashSet<String>>, Condvar),
    finished: (Mutex<bool>, Condvar),
    finished_naturally: AtomicBool,
    id: String,
    macro_ids: Mutex<HashSet<String>>,
    outcome: Mutex<Option<Result<(), String>>>,
    role_ids: HashSet<String>,
    start_ready: (Mutex<bool>, Condvar),
    stop_after_first_iteration: AtomicBool,
    terminating: AtomicBool,
    wake: (Mutex<()>, Condvar),
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

struct InvocationBarrier {
    ready: Condvar,
    state: Mutex<InvocationBarrierState>,
}

#[derive(Default)]
struct InvocationBarrierState {
    arrived_role_ids: HashSet<String>,
    departed_role_ids: HashSet<String>,
    outcome: Option<Result<(), String>>,
    started: bool,
}

#[derive(Default)]
struct ChildInvocations {
    ids: HashSet<String>,
    pending_starts: usize,
}

#[derive(Clone)]
struct ExecutionContext {
    active_role_ids: Arc<HashSet<String>>,
    control: Arc<InvocationControl>,
    macros: Arc<HashMap<String, MacroDefinition>>,
    settings: MacroRuntimeSettings,
    waiter: Waiter,
}

#[derive(Clone)]
struct HeldKey {
    code: String,
    modifiers: Vec<String>,
    owner_id: String,
    role_id: String,
}

impl MacroRuntime {
    pub fn new(events: EventSink) -> Self {
        Self::new_with_waiter(events, Arc::new(default_wait))
    }

    fn new_with_waiter(events: EventSink, waiter: Waiter) -> Self {
        Self::new_with_waiter_and_timeout(events, waiter, ACTION_TIMEOUT)
    }

    fn new_with_waiter_and_timeout(
        events: EventSink,
        waiter: Waiter,
        action_timeout: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                action_timeout,
                action_role_locks: Mutex::new(HashMap::new()),
                events,
                inner: Mutex::new(Inner::default()),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                last_presentation_status_emit: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                input_sequence_role_locks: Mutex::new(HashMap::new()),
                toggle_serial: Mutex::new(()),
                waiter,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn seed_running_status(&self, macro_id: &str, role_id: &str) -> CoreResult<()> {
        let now = Utc::now().to_rfc3339();
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .insert(
                format!("test-invocation|{role_id}|{macro_id}"),
                MacroRunStatus {
                    role_id: role_id.to_owned(),
                    macro_id: macro_id.to_owned(),
                    state: "running".to_owned(),
                    iteration: Some(1),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now,
                    error: None,
                },
            );
        Ok(())
    }

    pub fn start(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
        self.start_internal(request, false)
            .map(|(statuses, _)| statuses)
    }

    pub fn toggle(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
        let _toggle = self
            .shared
            .toggle_serial
            .lock()
            .map_err(|_| CoreError::Internal("macro toggle lock poisoned".to_owned()))?;
        let macro_id = request.macro_id.clone();
        let running = !self
            .controls_matching(|control| {
                control
                    .macro_ids
                    .lock()
                    .is_ok_and(|ids| ids.contains(&macro_id))
            })?
            .is_empty();
        if running {
            self.stop_macro(&macro_id)?;
            return Ok(Vec::new());
        }
        self.start_internal(request, false)
            .map(|(statuses, _)| statuses)
    }

    pub fn press(&self, request: MacroPressRequest) -> CoreResult<Vec<MacroRunStatus>> {
        validate_press_id(&request.press_id)?;
        let source_role_id = request.start.source_role_id.as_deref().ok_or_else(|| {
            CoreError::InvalidInput("macro press requires sourceRoleId".to_owned())
        })?;
        let lease_key = lease_key(source_role_id, &request.start.macro_id);
        let release_key =
            early_release_key(source_role_id, &request.start.macro_id, &request.press_id);
        let mut early_release = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .early_releases
            .remove(&release_key);
        if early_release.as_deref() == Some("immediate") {
            return Ok(Vec::new());
        }
        {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if let Some(existing) = inner.leases.get(&lease_key) {
                if existing.press_id == request.press_id {
                    return Ok(inner
                        .statuses
                        .values()
                        .filter(|status| status.macro_id == request.start.macro_id)
                        .cloned()
                        .collect());
                }
                return Err(CoreError::InvalidInput(
                    "macro shortcut is already held for this role".to_owned(),
                ));
            }
        }
        let macro_definition = request
            .start
            .macros
            .iter()
            .find(|definition| definition.id == request.start.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        if macro_definition
            .activation_mode
            .as_deref()
            .unwrap_or("toggle")
            != "while_held"
        {
            return Err(CoreError::InvalidInput(
                "macro does not use while-held activation".to_owned(),
            ));
        }
        let press_id = request.press_id;
        let (statuses, control) = self.start_internal(request.start, true)?;
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            early_release = inner.early_releases.remove(&release_key).or(early_release);
        }
        if early_release.as_deref() == Some("immediate") {
            cancel_control(&control);
            wait_finished(&control)?;
            return Ok(Vec::new());
        }
        if early_release.as_deref() == Some("complete_first_iteration") {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
        }
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .leases
            .insert(
                lease_key,
                HeldLease {
                    invocation_id: control.id.clone(),
                    press_id,
                },
            );
        mark_invocation_ready(&control);
        Ok(statuses)
    }

    pub fn release(&self, request: MacroReleaseRequest) -> CoreResult<()> {
        validate_press_id(&request.press_id)?;
        if !matches!(
            request.mode.as_str(),
            "complete_first_iteration" | "immediate"
        ) {
            return Err(CoreError::InvalidInput(
                "macro release mode is invalid".to_owned(),
            ));
        }
        let key = lease_key(&request.source_role_id, &request.macro_id);
        let control = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let Some(lease) = inner.leases.get(&key) else {
                inner.early_releases.insert(
                    early_release_key(
                        &request.source_role_id,
                        &request.macro_id,
                        &request.press_id,
                    ),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            };
            if lease.press_id != request.press_id {
                inner.early_releases.insert(
                    early_release_key(
                        &request.source_role_id,
                        &request.macro_id,
                        &request.press_id,
                    ),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            }
            let invocation_id = lease.invocation_id.clone();
            inner.leases.remove(&key);
            inner.invocations.get(&invocation_id).cloned()
        };
        let Some(control) = control else {
            return Ok(());
        };
        if request.mode == "immediate" || control.first_iteration_completed.load(Ordering::Acquire)
        {
            cancel_control(&control);
            wait_finished(&control)?;
        } else {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
            wait_finished(&control)?;
        }
        Ok(())
    }

    pub fn stop_macro(&self, macro_id: &str) -> CoreResult<()> {
        let controls = self.controls_matching(|control| {
            control
                .macro_ids
                .lock()
                .is_ok_and(|ids| ids.contains(macro_id))
        })?;
        cancel_and_wait_all(&controls)?;
        self.remove_statuses(|status| status.macro_id == macro_id)?;
        Ok(())
    }

    pub fn stop_macro_from_role(&self, macro_id: &str, _source_role_id: &str) -> CoreResult<()> {
        self.stop_macro(macro_id)
    }

    pub fn stop_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_role_matching(role_id, None)
    }

    /// Fences new work for a role and requests cancellation without waiting for
    /// every invocation worker to finish its bounded native cleanup.
    ///
    /// Browser teardown must be able to proceed while a worker is unwinding: the
    /// cancellation flag is the safety boundary, whereas joining the worker is
    /// resource cleanup and can take up to `INVOCATION_STOP_TIMEOUT`.
    pub fn request_stop_role(&self, role_id: &str) -> CoreResult<()> {
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner.stopping_role_ids.insert(role_id.to_owned());
            inner
                .invocations
                .values()
                .filter(|control| control.role_ids.contains(role_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        controls.iter().for_each(|control| cancel_control(control));
        Ok(())
    }

    pub fn allow_role_after_launch(&self, role_id: &str) {
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.stopping_role_ids.remove(role_id);
        }
    }

    pub fn release_role(&self, role_id: &str) -> CoreResult<()> {
        let releases = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner
                .leases
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{role_id}|")))
                .map(|(key, lease)| (key.clone(), lease.invocation_id.clone()))
                .collect::<Vec<_>>()
        };
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            releases
                .into_iter()
                .filter_map(|(key, invocation_id)| {
                    inner.leases.remove(&key);
                    inner.invocations.get(&invocation_id).cloned()
                })
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls)?;
        Ok(())
    }

    pub fn statuses(&self) -> CoreResult<Vec<MacroRunStatus>> {
        let mut statuses = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .values()
            .cloned()
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.role_id.cmp(&right.role_id))
                .then_with(|| left.macro_id.cmp(&right.macro_id))
        });
        Ok(statuses)
    }

    pub fn acquire_mutation(
        &self,
        macro_ids: Vec<String>,
        stop_active: bool,
    ) -> CoreResult<String> {
        let macro_ids = macro_ids
            .into_iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>();
        if macro_ids.is_empty() {
            return Err(CoreError::InvalidInput(
                "macro mutation requires at least one macro id".to_owned(),
            ));
        }
        let lease_id = format!(
            "macro-mutation-{}",
            self.shared.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if !inner.mutating_macro_ids.is_disjoint(&macro_ids) {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "Another macro mutation is already in progress.".to_owned(),
                });
            }
            let active = inner.statuses.values().any(|status| {
                macro_ids.contains(&status.macro_id)
                    && matches!(status.state.as_str(), "running" | "stopping")
            });
            if active && !stop_active {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "Stop affected macros before importing.".to_owned(),
                });
            }
            let controls = inner
                .invocations
                .values()
                .filter(|control| {
                    control
                        .macro_ids
                        .lock()
                        .is_ok_and(|ids| !ids.is_disjoint(&macro_ids))
                })
                .cloned()
                .collect::<Vec<_>>();
            inner.mutating_macro_ids.extend(macro_ids.iter().cloned());
            inner
                .mutation_leases
                .insert(lease_id.clone(), macro_ids.clone());
            controls
        };
        if stop_active {
            if let Err(error) = cancel_and_wait_all(&controls) {
                if let Ok(mut inner) = self.shared.inner.lock() {
                    inner.mutation_leases.remove(&lease_id);
                    for id in &macro_ids {
                        inner.mutating_macro_ids.remove(id);
                    }
                }
                return Err(error);
            }
            self.remove_statuses(|status| macro_ids.contains(&status.macro_id))?;
        }
        Ok(lease_id)
    }

    pub fn release_mutation(&self, lease_id: &str) -> CoreResult<()> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        let ids = inner.mutation_leases.remove(lease_id).ok_or_else(|| {
            CoreError::InvalidInput("macro mutation lease was not found".to_owned())
        })?;
        for id in ids {
            inner.mutating_macro_ids.remove(&id);
        }
        Ok(())
    }

    pub fn dispatch_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        for result in results {
            validate_result(&result)?;
            if let Some(sender) = self
                .shared
                .pending
                .lock()
                .map_err(|_| CoreError::Internal("macro result lock poisoned".to_owned()))?
                .remove(&result.request_id)
            {
                let _ = sender.send(result);
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if self.shared.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let controls = self
            .shared
            .inner
            .lock()
            .map(|inner| inner.invocations.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let _ = cancel_and_wait_all(&controls);
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.held_keys.clear();
            inner.invocations.clear();
            inner.leases.clear();
            inner.early_releases.clear();
            inner.mutation_leases.clear();
            inner.mutating_macro_ids.clear();
            inner.stopping_role_ids.clear();
            inner.statuses.clear();
        }
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.clear();
        }
    }

    fn start_internal(
        &self,
        request: MacroStartRequest,
        defer_execution: bool,
    ) -> CoreResult<(Vec<MacroRunStatus>, Arc<InvocationControl>)> {
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        validate_start_request(&request)?;
        let macros = request
            .macros
            .into_iter()
            .map(|definition| (definition.id.clone(), definition))
            .collect::<HashMap<_, _>>();
        let root = macros
            .get(&request.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        let invocation_macro_ids = collect_invocation_macro_ids(&request.macro_id, &macros);
        if !root.enabled {
            return Err(CoreError::InvalidInput(DISABLED_MACRO_MESSAGE.to_owned()));
        }
        if invocation_macro_ids.iter().any(|macro_id| {
            macros
                .get(macro_id)
                .is_some_and(|definition| definition.role_ids.is_empty())
        }) {
            return Err(CoreError::InvalidInput(
                UNASSIGNED_WORKFLOW_MESSAGE.to_owned(),
            ));
        }
        if let Some(source_role_id) = &request.source_role_id
            && !root.role_ids.contains(source_role_id)
        {
            return Err(CoreError::InvalidInput(
                "macro is not assigned to the requested role".to_owned(),
            ));
        }
        let active_role_ids = request.active_role_ids.into_iter().collect::<HashSet<_>>();
        let roles = assigned_active_roles(root, &active_role_ids);
        if roles.is_empty() {
            return Err(CoreError::InvalidInput(UNAVAILABLE_ROLE_MESSAGE.to_owned()));
        }
        let invocation_number = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let invocation_id = format!("macro-invocation-{invocation_number}");
        let control = new_invocation_control(
            invocation_id.clone(),
            request.macro_id.clone(),
            roles.iter().cloned().collect(),
        );
        let started_at = Utc::now().to_rfc3339();
        let statuses = roles
            .iter()
            .map(|role_id| MacroRunStatus {
                role_id: role_id.clone(),
                macro_id: request.macro_id.clone(),
                state: "running".to_owned(),
                iteration: Some(0),
                last_click: None,
                started_at: started_at.clone(),
                updated_at: started_at.clone(),
                error: None,
            })
            .collect::<Vec<_>>();
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if !inner.mutating_macro_ids.is_disjoint(&invocation_macro_ids) {
                return Err(CoreError::Domain {
                    code: "MACRO_MUTATION_BUSY",
                    message: "The macro is being changed and cannot be started.".to_owned(),
                });
            }
            if roles
                .iter()
                .any(|role_id| inner.stopping_role_ids.contains(role_id))
            {
                return Err(CoreError::Domain {
                    code: "MACRO_ROLE_STOPPING",
                    message: STOPPING_ROLE_MESSAGE.to_owned(),
                });
            }
            if inner.invocations.len() >= MAX_ACTIVE_INVOCATIONS {
                return Err(CoreError::InvalidInput(
                    "too many macro invocations are active".to_owned(),
                ));
            }
            if inner.invocations.values().any(|existing| {
                existing
                    .macro_ids
                    .lock()
                    .is_ok_and(|ids| ids.contains(&request.macro_id))
            }) {
                return Err(CoreError::InvalidInput(
                    "macro is already running for this role".to_owned(),
                ));
            }
            inner.statuses.retain(|_, status| {
                status.macro_id != request.macro_id || !roles.contains(&status.role_id)
            });
            inner
                .invocations
                .insert(invocation_id.clone(), Arc::clone(&control));
        }
        let focus_actions = roles
            .iter()
            .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
            .collect();
        if let Err(error) =
            perform_actions_with_control(&self.shared, &control, focus_actions, false)
        {
            discard_unstarted_invocation(&self.shared, &control);
            return Err(CoreError::Domain {
                code: "MACRO_INPUT_FAILED",
                message: error,
            });
        }
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if control.cancelled.load(Ordering::Acquire) {
                drop(inner);
                discard_unstarted_invocation(&self.shared, &control);
                return Err(CoreError::InvalidInput("macro run cancelled".to_owned()));
            }
            for status in &statuses {
                inner.statuses.insert(
                    status_key(&invocation_id, &status.role_id, &status.macro_id),
                    status.clone(),
                );
            }
        }
        self.emit_statuses();
        let shared = Arc::clone(&self.shared);
        let macro_id = request.macro_id;
        let context = ExecutionContext {
            active_role_ids: Arc::new(active_role_ids),
            control: Arc::clone(&control),
            macros: Arc::new(macros),
            settings: request.settings,
            waiter: Arc::clone(&self.shared.waiter),
        };
        let control_for_run = Arc::clone(&control);
        let worker = thread::Builder::new()
            .name(format!("rion-macro-{invocation_number}"))
            .spawn(move || {
                let result = wait_for_invocation_ready(&control_for_run).and_then(|_| {
                    execute_macro(
                        &shared,
                        &context,
                        &macro_id,
                        &roles,
                        &mut Vec::new(),
                        true,
                        false,
                    )
                });
                finish_invocation(&shared, &context.control, result);
            })
            .map_err(|error| {
                discard_unstarted_invocation(&self.shared, &control);
                CoreError::Internal(error.to_string())
            })?;
        *control
            .worker
            .lock()
            .map_err(|_| CoreError::Internal("macro worker lock poisoned".to_owned()))? =
            Some(worker);
        if !defer_execution {
            mark_invocation_ready(&control);
        }
        Ok((statuses, control))
    }

    fn controls_matching(
        &self,
        predicate: impl Fn(&InvocationControl) -> bool,
    ) -> CoreResult<Vec<Arc<InvocationControl>>> {
        Ok(self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .invocations
            .values()
            .filter(|control| predicate(control))
            .cloned()
            .collect())
    }

    fn remove_statuses(&self, predicate: impl Fn(&MacroRunStatus) -> bool) -> CoreResult<()> {
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .retain(|_, status| !predicate(status));
        self.emit_statuses();
        Ok(())
    }

    fn stop_role_matching(&self, role_id: &str, macro_id: Option<&str>) -> CoreResult<()> {
        let controls = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner
                .invocations
                .values()
                .filter(|control| {
                    control.role_ids.contains(role_id)
                        && macro_id.is_none_or(|macro_id| {
                            control
                                .macro_ids
                                .lock()
                                .is_ok_and(|ids| ids.contains(macro_id))
                        })
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls)
    }

    fn emit_statuses(&self) {
        emit_statuses(&self.shared, true);
    }
}

fn execute_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    ancestry: &mut Vec<String>,
    root: bool,
    single_iteration: bool,
) -> Result<(), String> {
    let role_id = roles
        .first()
        .ok_or_else(|| "macro step has no execution role".to_owned())?;
    check_role_cancelled(context, role_id)?;
    if ancestry.iter().any(|id| id == macro_id) {
        return Err("macro dependency cycle detected while running".to_owned());
    }
    let definition = context
        .macros
        .get(macro_id)
        .ok_or_else(|| format!("called macro was not found: {macro_id}"))?;
    if !definition.enabled {
        return Err(DISABLED_MACRO_MESSAGE.to_owned());
    }
    let assigned_roles = if root {
        roles.to_vec()
    } else {
        assigned_active_roles(definition, &context.active_role_ids)
    };
    if assigned_roles.is_empty() {
        return Err(UNAVAILABLE_ROLE_MESSAGE.to_owned());
    }
    let roles = active_execution_roles(context, &assigned_roles);
    if roles.is_empty() {
        return Ok(());
    }
    ancestry.push(macro_id.to_owned());
    if let Ok(mut ids) = context.control.macro_ids.lock() {
        ids.insert(macro_id.to_owned());
    }
    if !root {
        add_running_statuses(shared, context, macro_id, &roles);
    }
    let applies_timing = definition.trigger.is_some();
    let execution = (|| {
        if !root {
            perform_actions(
                shared,
                context,
                roles
                    .iter()
                    .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
                    .collect(),
                false,
            )?;
        }
        let ancestry = ancestry.clone();
        let results = thread::scope(|scope| {
            roles
                .iter()
                .map(|role_id| {
                    let role_id = role_id.clone();
                    let ancestry = ancestry.clone();
                    let roles = roles.clone();
                    scope.spawn(move || {
                        let result = execute_macro_role(
                            shared,
                            context,
                            definition,
                            &role_id,
                            &roles,
                            ancestry,
                            single_iteration,
                            applies_timing,
                        );
                        if result.is_err() && !context.control.cancelled.load(Ordering::Acquire) {
                            if let Ok(mut failed_role_id) = context.control.failed_role_id.lock()
                                && failed_role_id.is_none()
                            {
                                *failed_role_id = Some(role_id);
                            }
                            cancel_control(&context.control);
                        }
                        result
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err("macro role worker panicked".to_owned()))
                })
                .collect::<Vec<_>>()
        });
        let mut first_error = None;
        for result in results {
            if let Err(error) = result {
                let is_cancellation = error == "macro run cancelled";
                if first_error.is_none()
                    || first_error
                        .as_deref()
                        .is_some_and(|current| current == "macro run cancelled" && !is_cancellation)
                {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    })();
    ancestry.pop();
    if !root && execution.is_ok() {
        remove_macro_statuses(shared, &context.control.id, macro_id);
    }
    execution
}

#[allow(clippy::too_many_arguments)]
fn execute_macro_role(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    definition: &MacroDefinition,
    role_id: &str,
    invocation_role_ids: &[String],
    ancestry: Vec<String>,
    single_iteration: bool,
    applies_timing: bool,
) -> Result<(), String> {
    let mut held_keys = Vec::new();
    let role_ids = [role_id.to_owned()];
    let execution = (|| {
        if applies_timing {
            wait_cancelable_for_role(context, role_id, context.settings.startup_delay_ms)?;
        }
        let mut iteration = 0_u32;
        loop {
            check_role_cancelled(context, role_id)?;
            for step in &definition.steps {
                check_role_cancelled(context, role_id)?;
                execute_step(
                    shared,
                    context,
                    definition,
                    &role_ids,
                    invocation_role_ids,
                    step,
                    iteration,
                    &ancestry,
                    &mut held_keys,
                    applies_timing,
                )?;
            }
            iteration = iteration.saturating_add(1);
            update_iteration(shared, context, &definition.id, &role_ids, iteration);
            if iteration == 1 {
                wait_for_first_iteration(context, role_id, invocation_role_ids.len())?;
            }
            if context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
                || single_iteration
                || matches!(definition.repeat, MacroRepeat::Once)
            {
                break;
            }
            let MacroRepeat::Loop { interval_ms } = definition.repeat else {
                break;
            };
            wait_cancelable_for_role(context, role_id, interval_ms)?;
        }
        if matches!(definition.repeat, MacroRepeat::Once)
            && !held_keys.is_empty()
            && !single_iteration
            && !context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
        {
            wait_until_role_cancelled(context, role_id)?;
        }
        Ok(())
    })();
    release_held_keys(shared, context, &mut held_keys);
    execution
}

#[allow(clippy::too_many_arguments)]
fn execute_step(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    definition: &MacroDefinition,
    roles: &[String],
    invocation_role_ids: &[String],
    step: &MacroStepDefinition,
    iteration: u32,
    ancestry: &[String],
    held_keys: &mut Vec<HeldKey>,
    applies_timing: bool,
) -> Result<(), String> {
    let role_id = roles
        .first()
        .ok_or_else(|| "macro step has no execution role".to_owned())?;
    check_role_cancelled(context, role_id)?;
    match step {
        MacroStepDefinition::Key {
            id,
            code,
            modifiers,
            action,
            ..
        } => {
            let input_sequence = input_sequence_role_lock(shared, role_id)?;
            let _input_sequence_guard = input_sequence
                .lock()
                .map_err(|_| "macro input sequence lock poisoned".to_owned())?;
            let modifiers = modifiers.as_deref().unwrap_or_default();
            let hold_until_stop = action.as_deref() == Some("hold_until_stop");
            let owner_id_for = |role_id: &str| {
                format!(
                    "{}:{}:{}:{}",
                    context.control.id, role_id, definition.id, id
                )
            };
            let roles_to_hold = roles
                .iter()
                .filter(|role_id| {
                    !hold_until_stop
                        || !held_keys
                            .iter()
                            .any(|held| held.owner_id == owner_id_for(role_id))
                })
                .collect::<Vec<_>>();
            let holds = roles_to_hold
                .iter()
                .map(|role_id| {
                    (
                        role_id.as_str(),
                        BrowserAction::Key {
                            phase: "hold".to_owned(),
                            key: code.clone(),
                            code: Some(code.clone()),
                            modifiers: modifiers.to_vec(),
                            owner_id: owner_id_for(role_id),
                            suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                context, role_id, code, modifiers,
                            ),
                        },
                    )
                })
                .collect::<Vec<_>>();
            if let Err(error) = perform_actions(shared, context, holds, false) {
                let _ = perform_actions(
                    shared,
                    context,
                    roles_to_hold
                        .iter()
                        .map(|role_id| {
                            (
                                role_id.as_str(),
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id: owner_id_for(role_id),
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                );
                return Err(error);
            }
            for role_id in &roles_to_hold {
                let owner_id = owner_id_for(role_id);
                if hold_until_stop {
                    let held = HeldKey {
                        code: code.clone(),
                        modifiers: modifiers.to_vec(),
                        owner_id: owner_id.clone(),
                        role_id: (*role_id).clone(),
                    };
                    if register_held_key(shared, context, held.clone())? {
                        held_keys.push(held);
                    } else {
                        perform_actions(
                            shared,
                            context,
                            vec![(
                                role_id,
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id,
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )],
                            true,
                        )?;
                    }
                }
            }
            if !hold_until_stop {
                let timing_result = if applies_timing {
                    wait_cancelable_for_role(context, role_id, context.settings.key_hold_ms)
                } else {
                    Ok(())
                };
                let release_result = perform_actions(
                    shared,
                    context,
                    roles
                        .iter()
                        .map(|role_id| {
                            (
                                role_id.as_str(),
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id: owner_id_for(role_id),
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                );
                timing_result?;
                release_result?;
            }
            if applies_timing {
                wait_cancelable_for_role(context, role_id, context.settings.post_input_delay_ms)
            } else {
                Ok(())
            }
        }
        MacroStepDefinition::Click {
            id,
            anchor,
            position,
        } => {
            let input_sequence = input_sequence_role_lock(shared, role_id)?;
            let _input_sequence_guard = input_sequence
                .lock()
                .map_err(|_| "macro input sequence lock poisoned".to_owned())?;
            let (unit, x, y) = match position {
                crate::model::MacroClickDefinition::Percent {
                    x_percent,
                    y_percent,
                    ..
                } => ("percent", *x_percent, *y_percent),
                crate::model::MacroClickDefinition::Pixels { x_px, y_px, .. } => {
                    ("px", *x_px, *y_px)
                }
            };
            perform_actions(
                shared,
                context,
                roles
                    .iter()
                    .map(|role_id| {
                        (
                            role_id.as_str(),
                            BrowserAction::Click {
                                anchor: anchor.clone(),
                                unit: unit.to_owned(),
                                x,
                                y,
                                button: "left".to_owned(),
                            },
                        )
                    })
                    .collect(),
                false,
            )?;
            for role_id in roles {
                mark_click(shared, context, &definition.id, role_id, id);
            }
            if applies_timing {
                wait_cancelable_for_role(context, role_id, context.settings.post_input_delay_ms)
            } else {
                Ok(())
            }
        }
        MacroStepDefinition::Delay { ms, .. } => wait_cancelable_for_role(context, role_id, *ms),
        MacroStepDefinition::Macro {
            macro_id,
            call_mode,
            ..
        } if call_mode.as_deref() == Some("trigger") => {
            spawn_triggered_macro(shared, context, macro_id.clone(), ancestry.to_owned());
            Ok(())
        }
        MacroStepDefinition::Macro { id, macro_id, .. } => run_synchronous_child_at_barrier(
            shared,
            context,
            macro_id,
            ancestry.to_owned(),
            &format!("{}:{iteration}:{id}", definition.id),
            role_id,
            invocation_role_ids,
        ),
    }
}

fn run_synchronous_child_at_barrier(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
    barrier_key: &str,
    role_id: &str,
    invocation_role_ids: &[String],
) -> Result<(), String> {
    let barrier = {
        let mut barriers = context
            .control
            .barriers
            .lock()
            .map_err(|_| "macro barrier registry lock poisoned".to_owned())?;
        Arc::clone(barriers.entry(barrier_key.to_owned()).or_insert_with(|| {
            Arc::new(InvocationBarrier {
                ready: Condvar::new(),
                state: Mutex::new(InvocationBarrierState::default()),
            })
        }))
    };
    let should_start = {
        let mut state = barrier
            .state
            .lock()
            .map_err(|_| "macro barrier lock poisoned".to_owned())?;
        state.arrived_role_ids.insert(role_id.to_owned());
        let should_start =
            !state.started && state.arrived_role_ids.len() == invocation_role_ids.len();
        if should_start {
            state.started = true;
        }
        should_start
    };
    if should_start {
        let outcome = run_synchronous_child(shared, context, macro_id, ancestry);
        if let Ok(mut state) = barrier.state.lock() {
            state.outcome = Some(outcome.clone());
            barrier.ready.notify_all();
        }
    }
    let mut state = barrier
        .state
        .lock()
        .map_err(|_| "macro barrier lock poisoned".to_owned())?;
    let outcome = loop {
        if let Some(outcome) = &state.outcome {
            break outcome.clone();
        }
        if context.control.cancelled.load(Ordering::Acquire) {
            break Err("macro run cancelled".to_owned());
        }
        let (next, _) = barrier
            .ready
            .wait_timeout(state, Duration::from_millis(25))
            .map_err(|_| "macro barrier lock poisoned".to_owned())?;
        state = next;
    };
    state.departed_role_ids.insert(role_id.to_owned());
    let should_remove = state.departed_role_ids.len() >= invocation_role_ids.len();
    drop(state);
    if should_remove
        && let Ok(mut barriers) = context.control.barriers.lock()
        && barriers
            .get(barrier_key)
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &barrier))
    {
        barriers.remove(barrier_key);
    }
    outcome
}

fn run_synchronous_child(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
) -> Result<(), String> {
    let child = start_child_invocation(
        shared,
        context,
        macro_id,
        ancestry,
        true,
        &context.control,
        false,
    )?
    .ok_or_else(|| {
        let name = context
            .macros
            .get(macro_id)
            .map(|definition| definition.name.as_str())
            .unwrap_or(macro_id);
        format!("Called macro \"{name}\" is already running.")
    })?;
    loop {
        if context.control.cancelled.load(Ordering::Acquire) {
            cancel_control(&child);
            let wait_result = wait_finished(&child);
            remove_owned_child(&context.control, &child.id);
            wait_result.map_err(|error| error.to_string())?;
            return Err("macro run cancelled".to_owned());
        }
        let finished = child
            .finished
            .0
            .lock()
            .map_err(|_| "child macro completion lock poisoned".to_owned())?;
        if *finished {
            break;
        }
        let (finished, _) = child
            .finished
            .1
            .wait_timeout(finished, Duration::from_millis(25))
            .map_err(|_| "child macro completion lock poisoned".to_owned())?;
        if *finished {
            break;
        }
    }
    remove_owned_child(&context.control, &child.id);
    match child
        .outcome
        .lock()
        .map_err(|_| "child macro outcome lock poisoned".to_owned())?
        .clone()
        .unwrap_or_else(|| Err("child macro outcome is unavailable".to_owned()))
    {
        Ok(()) => Ok(()),
        Err(_error)
            if child.cancelled.load(Ordering::Acquire)
                && child
                    .failed_role_id
                    .lock()
                    .is_ok_and(|failed_role_id| failed_role_id.is_none()) =>
        {
            let message = "Cancelled because a called macro was stopped.".to_owned();
            if let Ok(mut cancellation_error) = context.control.cancellation_error.lock() {
                *cancellation_error = Some(message.clone());
            }
            Err(message)
        }
        Err(error) => Err(error),
    }
}

fn spawn_triggered_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: String,
    ancestry: Vec<String>,
) {
    if let Ok(mut children) = context.control.children.0.lock() {
        children.pending_starts = children.pending_starts.saturating_add(1);
    } else {
        return;
    }
    let shared = Arc::clone(shared);
    let context = context.clone();
    let pending_control = Arc::clone(&context.control);
    let spawn = thread::Builder::new()
        .name("rion-macro-trigger".to_owned())
        .spawn(move || {
            let started = start_child_invocation(
                &shared,
                &context,
                &macro_id,
                ancestry,
                false,
                &context.control,
                true,
            );
            finish_pending_child_start(&context.control);
            let Ok(Some(child)) = started else {
                return;
            };
            if context.control.cancelled.load(Ordering::Acquire)
                || (context.control.terminating.load(Ordering::Acquire)
                    && !context.control.finished_naturally.load(Ordering::Acquire))
            {
                cancel_control(&child);
            }
            let _ = wait_finished(&child);
            remove_owned_child(&context.control, &child.id);
        });
    finish_pending_child_start_after_spawn(&pending_control, &spawn);
}

fn finish_pending_child_start(control: &InvocationControl) {
    if let Ok(mut children) = control.children.0.lock() {
        children.pending_starts = children.pending_starts.saturating_sub(1);
        control.children.1.notify_all();
    }
}

fn finish_pending_child_start_after_spawn<T, E>(control: &InvocationControl, spawn: &Result<T, E>) {
    if spawn.is_err() {
        finish_pending_child_start(control);
    }
}

fn start_child_invocation(
    shared: &Arc<Shared>,
    parent_context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
    single_iteration: bool,
    owner: &Arc<InvocationControl>,
    ignore_duplicate: bool,
) -> Result<Option<Arc<InvocationControl>>, String> {
    if ancestry.iter().any(|id| id == macro_id) {
        return Err("macro dependency cycle detected while running".to_owned());
    }
    let definition = parent_context
        .macros
        .get(macro_id)
        .ok_or_else(|| format!("called macro was not found: {macro_id}"))?;
    if !definition.enabled {
        return Err(DISABLED_MACRO_MESSAGE.to_owned());
    }
    let roles = assigned_active_roles(definition, &parent_context.active_role_ids);
    if roles.is_empty() {
        return Err(UNAVAILABLE_ROLE_MESSAGE.to_owned());
    }
    let invocation_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let invocation_id = format!("macro-invocation-{invocation_number}");
    let child = new_invocation_control(
        invocation_id.clone(),
        macro_id.to_owned(),
        roles.iter().cloned().collect(),
    );
    {
        let mut inner = shared
            .inner
            .lock()
            .map_err(|_| "macro runtime lock poisoned".to_owned())?;
        let duplicate = inner.invocations.values().any(|control| {
            control
                .macro_ids
                .lock()
                .is_ok_and(|ids| ids.contains(macro_id))
        });
        if duplicate {
            return if ignore_duplicate {
                Ok(None)
            } else {
                Err(format!(
                    "Called macro \"{}\" is already running.",
                    definition.name
                ))
            };
        }
        if inner.mutating_macro_ids.contains(macro_id) {
            return Err("called macro is being changed".to_owned());
        }
        if inner.invocations.len() >= MAX_ACTIVE_INVOCATIONS {
            return Err("too many macro invocations are active".to_owned());
        }
        inner
            .invocations
            .insert(invocation_id.clone(), Arc::clone(&child));
    }
    register_owned_child(owner, &child);
    let start_result = (|| {
        perform_actions_with_control(
            shared,
            &child,
            roles
                .iter()
                .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
                .collect(),
            false,
        )?;
        let started_at = Utc::now().to_rfc3339();
        {
            let mut inner = shared
                .inner
                .lock()
                .map_err(|_| "macro runtime lock poisoned".to_owned())?;
            for role_id in &roles {
                inner.statuses.insert(
                    status_key(&invocation_id, role_id, macro_id),
                    MacroRunStatus {
                        role_id: role_id.clone(),
                        macro_id: macro_id.to_owned(),
                        state: "running".to_owned(),
                        iteration: Some(0),
                        last_click: None,
                        started_at: started_at.clone(),
                        updated_at: started_at.clone(),
                        error: None,
                    },
                );
            }
        }
        emit_statuses(shared, true);
        let shared_for_run = Arc::clone(shared);
        let child_for_run = Arc::clone(&child);
        let mut child_ancestry = ancestry;
        let child_macro_id = macro_id.to_owned();
        let child_context = ExecutionContext {
            active_role_ids: Arc::clone(&parent_context.active_role_ids),
            control: Arc::clone(&child),
            macros: Arc::clone(&parent_context.macros),
            settings: parent_context.settings.clone(),
            waiter: Arc::clone(&parent_context.waiter),
        };
        let worker = thread::Builder::new()
            .name(format!("rion-macro-child-{invocation_number}"))
            .spawn(move || {
                let result = execute_macro(
                    &shared_for_run,
                    &child_context,
                    &child_macro_id,
                    &roles,
                    &mut child_ancestry,
                    true,
                    single_iteration,
                );
                finish_invocation(&shared_for_run, &child_for_run, result);
            })
            .map_err(|error| error.to_string())?;
        *child
            .worker
            .lock()
            .map_err(|_| "macro worker lock poisoned".to_owned())? = Some(worker);
        Ok(())
    })();
    if let Err(error) = start_result {
        remove_owned_child(owner, &child.id);
        discard_unstarted_invocation(shared, &child);
        return Err(error);
    }
    Ok(Some(child))
}

fn register_owned_child(owner: &Arc<InvocationControl>, child: &Arc<InvocationControl>) {
    if owner.finished_naturally.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut children) = owner.children.0.lock() {
        children.ids.insert(child.id.clone());
        owner.children.1.notify_all();
    }
}

fn remove_owned_child(owner: &Arc<InvocationControl>, child_id: &str) {
    if let Ok(mut children) = owner.children.0.lock() {
        children.ids.remove(child_id);
        owner.children.1.notify_all();
    }
}

fn input_sequence_role_lock(shared: &Arc<Shared>, role_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = shared
        .input_sequence_role_locks
        .lock()
        .map_err(|_| "macro input sequence registry lock poisoned".to_owned())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(role_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(role_id.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn action_role_locks(
    shared: &Arc<Shared>,
    role_ids: &[String],
) -> Result<Vec<Arc<Mutex<()>>>, String> {
    let mut locks = shared
        .action_role_locks
        .lock()
        .map_err(|_| "macro role action registry lock poisoned".to_owned())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    Ok(role_ids
        .iter()
        .map(|role_id| {
            if let Some(lock) = locks.get(role_id).and_then(Weak::upgrade) {
                return lock;
            }
            let lock = Arc::new(Mutex::new(()));
            locks.insert(role_id.clone(), Arc::downgrade(&lock));
            lock
        })
        .collect())
}

fn perform_action(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    role_id: &str,
    action: BrowserAction,
    allow_cancelled: bool,
) -> Result<(), String> {
    perform_actions(shared, context, vec![(role_id, action)], allow_cancelled)
}

fn perform_actions(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    mut actions: Vec<(&str, BrowserAction)>,
    allow_cancelled: bool,
) -> Result<(), String> {
    if !allow_cancelled {
        actions.retain(|(role_id, _)| !is_role_cancelled(&context.control, role_id));
    }
    perform_actions_with_control(shared, &context.control, actions, allow_cancelled)
}

fn perform_actions_with_control(
    shared: &Arc<Shared>,
    control: &Arc<InvocationControl>,
    actions: Vec<(&str, BrowserAction)>,
    allow_cancelled: bool,
) -> Result<(), String> {
    if !allow_cancelled && control.cancelled.load(Ordering::Acquire) {
        return Err("macro run cancelled".to_owned());
    }
    if actions.is_empty() {
        return Ok(());
    }
    let cancel_pending_wait = actions
        .iter()
        .all(|(_, action)| matches!(action, BrowserAction::Focus));
    let mut role_ids = actions
        .iter()
        .map(|(role_id, _)| (*role_id).to_owned())
        .collect::<Vec<_>>();
    role_ids.sort();
    role_ids.dedup();
    let role_locks = action_role_locks(shared, &role_ids)?;
    let _role_guards = role_locks
        .iter()
        .map(|lock| {
            lock.lock()
                .map_err(|_| "macro role action lock poisoned".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut pending_actions = Vec::with_capacity(actions.len());
    let requests = {
        let mut pending = shared
            .pending
            .lock()
            .map_err(|_| "macro action result lock poisoned".to_owned())?;
        if pending.len().saturating_add(actions.len()) > MAX_PENDING_ACTIONS {
            return Err("macro browser action queue is full".to_owned());
        }
        actions
            .into_iter()
            .map(|(role_id, action)| {
                let request_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
                let request_id = format!("browser-action-{request_number}");
                let (sender, receiver) = mpsc::sync_channel(1);
                pending.insert(request_id.clone(), sender);
                pending_actions.push((request_id.clone(), role_id.to_owned(), receiver));
                BrowserActionRequest {
                    request_id,
                    role_id: role_id.to_owned(),
                    origin: "macro".to_owned(),
                    scheduled_at_ms: epoch_millis(),
                    deadline_ms: epoch_millis()
                        .saturating_add(shared.action_timeout.as_millis() as u64),
                    action,
                }
            })
            .collect::<Vec<_>>()
    };
    (shared.events)(vec![CoreEvent::BrowserActions { actions: requests }]);
    let started = std::time::Instant::now();
    let mut outcome = Ok(());
    for (_, role_id, receiver) in &pending_actions {
        loop {
            if cancel_pending_wait && !allow_cancelled && control.cancelled.load(Ordering::Acquire)
            {
                outcome = Err("macro run cancelled".to_owned());
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(result) if result.ok => break,
                Ok(result) => {
                    record_action_failure(
                        control,
                        role_id,
                        result
                            .error_message
                            .unwrap_or_else(|| "browser action failed".to_owned()),
                        &mut outcome,
                    );
                    break;
                }
                Err(RecvTimeoutError::Timeout) if started.elapsed() < shared.action_timeout => {}
                Err(RecvTimeoutError::Timeout) => {
                    record_action_failure(
                        control,
                        role_id,
                        format!(
                            "Macro input timed out after {} ms.",
                            ACTION_TIMEOUT.as_millis()
                        ),
                        &mut outcome,
                    );
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    record_action_failure(
                        control,
                        role_id,
                        "macro browser action result channel closed".to_owned(),
                        &mut outcome,
                    );
                    break;
                }
            }
        }
    }
    if let Ok(mut pending) = shared.pending.lock() {
        for (request_id, _, _) in &pending_actions {
            pending.remove(request_id);
        }
    }
    if outcome.is_ok() && !allow_cancelled && control.cancelled.load(Ordering::Acquire) {
        return Err("macro run cancelled".to_owned());
    }
    outcome
}

fn record_action_failure(
    control: &InvocationControl,
    role_id: &str,
    message: String,
    outcome: &mut Result<(), String>,
) {
    if outcome.is_ok() && !control.cancelled.load(Ordering::Acquire) {
        if let Ok(mut failed_role_id) = control.failed_role_id.lock()
            && failed_role_id.is_none()
        {
            *failed_role_id = Some(role_id.to_owned());
        }
        *outcome = Err(message);
    }
}

fn release_held_keys(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    held_keys: &mut Vec<HeldKey>,
) {
    while let Some(held) = held_keys.pop() {
        let registered = shared
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.held_keys.remove(&held.owner_id))
            .is_some();
        if !registered {
            continue;
        }
        let Ok(input_sequence) = input_sequence_role_lock(shared, &held.role_id) else {
            continue;
        };
        let Ok(_input_sequence_guard) = input_sequence.lock() else {
            continue;
        };
        let suppress_overlay_shortcut =
            should_suppress_overlay_shortcut(context, &held.role_id, &held.code, &held.modifiers);
        let _ = perform_action(
            shared,
            context,
            &held.role_id,
            BrowserAction::Key {
                phase: "release".to_owned(),
                key: held.code.clone(),
                code: Some(held.code),
                modifiers: held.modifiers,
                owner_id: held.owner_id,
                suppress_overlay_shortcut,
            },
            true,
        );
    }
}

fn should_suppress_overlay_shortcut(
    context: &ExecutionContext,
    role_id: &str,
    code: &str,
    modifiers: &[String],
) -> bool {
    should_suppress_overlay_shortcut_for_macros(&context.macros, role_id, code, modifiers)
}

fn should_suppress_overlay_shortcut_for_macros(
    macros: &HashMap<String, MacroDefinition>,
    role_id: &str,
    code: &str,
    modifiers: &[String],
) -> bool {
    let ctrl = modifiers.iter().any(|modifier| modifier == "ctrl");
    let alt = modifiers.iter().any(|modifier| modifier == "alt");
    let shift = modifiers.iter().any(|modifier| modifier == "shift");
    let meta = modifiers.iter().any(|modifier| modifier == "meta");
    let primary = modifiers.iter().any(|modifier| modifier == "primary");
    macros.values().any(|definition| {
        if !definition.enabled || !definition.role_ids.iter().any(|id| id == role_id) {
            return false;
        }
        let Some(trigger) = &definition.trigger else {
            return false;
        };
        if trigger.code != code || trigger.alt != alt || trigger.shift != shift {
            return false;
        }
        if primary {
            (trigger.ctrl == ctrl && trigger.meta) || (trigger.ctrl && trigger.meta == meta)
        } else {
            trigger.ctrl == ctrl && trigger.meta == meta
        }
    })
}

fn register_held_key(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    held: HeldKey,
) -> Result<bool, String> {
    let mut inner = shared
        .inner
        .lock()
        .map_err(|_| "macro runtime lock poisoned".to_owned())?;
    if is_role_cancelled(&context.control, &held.role_id) {
        return Ok(false);
    }
    inner.held_keys.insert(held.owner_id.clone(), held);
    Ok(true)
}

fn active_execution_roles(context: &ExecutionContext, roles: &[String]) -> Vec<String> {
    roles
        .iter()
        .filter(|role_id| !is_role_cancelled(&context.control, role_id))
        .cloned()
        .collect()
}

fn is_role_cancelled(control: &InvocationControl, role_id: &str) -> bool {
    control
        .cancelled_role_ids
        .lock()
        .is_ok_and(|role_ids| role_ids.contains(role_id))
}

fn wait_for_first_iteration(
    context: &ExecutionContext,
    role_id: &str,
    expected_roles: usize,
) -> Result<(), String> {
    let mut completed_roles = context
        .control
        .first_iteration_roles
        .0
        .lock()
        .map_err(|_| "macro first-iteration barrier lock poisoned".to_owned())?;
    completed_roles.insert(role_id.to_owned());
    if completed_roles.len() == expected_roles {
        context
            .control
            .first_iteration_completed
            .store(true, Ordering::Release);
        context.control.first_iteration_roles.1.notify_all();
    }
    while !context
        .control
        .first_iteration_completed
        .load(Ordering::Acquire)
        && !context.control.cancelled.load(Ordering::Acquire)
    {
        completed_roles = context
            .control
            .first_iteration_roles
            .1
            .wait(completed_roles)
            .map_err(|_| "macro first-iteration barrier lock poisoned".to_owned())?;
    }
    check_role_cancelled(context, role_id)
}

fn wait_cancelable_for_role(
    context: &ExecutionContext,
    role_id: &str,
    duration_ms: u32,
) -> Result<(), String> {
    check_role_cancelled(context, role_id)?;
    (context.waiter)(&context.control, role_id, duration_ms)?;
    check_role_cancelled(context, role_id)
}

fn default_wait(
    control: &Arc<InvocationControl>,
    role_id: &str,
    duration_ms: u32,
) -> Result<(), String> {
    if duration_ms == 0 {
        thread::yield_now();
        return Ok(());
    }
    let guard = control
        .wake
        .0
        .lock()
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    let _ = control
        .wake
        .1
        .wait_timeout_while(guard, Duration::from_millis(u64::from(duration_ms)), |_| {
            !control.cancelled.load(Ordering::Acquire) && !is_role_cancelled(control, role_id)
        })
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    Ok(())
}

fn wait_until_role_cancelled(context: &ExecutionContext, role_id: &str) -> Result<(), String> {
    while check_role_cancelled(context, role_id).is_ok() {
        let guard = context
            .control
            .wake
            .0
            .lock()
            .map_err(|_| "macro wait lock poisoned".to_owned())?;
        drop(
            context
                .control
                .wake
                .1
                .wait_timeout_while(guard, Duration::from_secs(1), |_| {
                    !context.control.cancelled.load(Ordering::Acquire)
                        && !is_role_cancelled(&context.control, role_id)
                })
                .map_err(|_| "macro wait lock poisoned".to_owned())?,
        );
    }
    Err("macro run cancelled".to_owned())
}

fn check_role_cancelled(context: &ExecutionContext, role_id: &str) -> Result<(), String> {
    if context.control.cancelled.load(Ordering::Acquire)
        || is_role_cancelled(&context.control, role_id)
    {
        Err("macro run cancelled".to_owned())
    } else {
        Ok(())
    }
}

fn finish_invocation(
    shared: &Arc<Shared>,
    control: &Arc<InvocationControl>,
    result: Result<(), String>,
) {
    if result.is_ok() {
        control.finished_naturally.store(true, Ordering::Release);
        detach_owned_children(control);
    } else {
        control.terminating.store(true, Ordering::Release);
        cancel_owned_children(shared, control);
    }
    if let Ok(mut inner) = shared.inner.lock() {
        let cancelled = control.cancelled.load(Ordering::Acquire);
        let cancellation_error = control
            .cancellation_error
            .lock()
            .ok()
            .and_then(|error| error.clone());
        let prefix = format!("{}|", control.id);
        if let Some(error) = cancellation_error
            && result.is_err()
        {
            let now = Utc::now().to_rfc3339();
            for (key, status) in &mut inner.statuses {
                if key.starts_with(&prefix) {
                    status.state = "cancelled".to_owned();
                    status.updated_at = now.clone();
                    status.error = Some(error.clone());
                }
            }
        } else if let Err(ref error) = result
            && (!cancelled
                || control
                    .failed_role_id
                    .lock()
                    .is_ok_and(|role_id| role_id.is_some()))
        {
            let now = Utc::now().to_rfc3339();
            let failed_role_id = control
                .failed_role_id
                .lock()
                .ok()
                .and_then(|role_id| role_id.clone());
            for (key, status) in &mut inner.statuses {
                if key.starts_with(&prefix) {
                    let is_failed_role = failed_role_id
                        .as_ref()
                        .is_none_or(|role_id| role_id == &status.role_id);
                    status.state = if is_failed_role {
                        "failed".to_owned()
                    } else {
                        "cancelled".to_owned()
                    };
                    status.updated_at = now.clone();
                    status.error = Some(if is_failed_role {
                        error.clone()
                    } else {
                        SIBLING_FAILURE_MESSAGE.to_owned()
                    });
                }
            }
        } else if cancelled || result.is_ok() {
            inner.statuses.retain(|key, _| !key.starts_with(&prefix));
        }
        inner.invocations.remove(&control.id);
        inner
            .held_keys
            .retain(|owner_id, _| !owner_id.starts_with(&format!("{}:", control.id)));
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    emit_statuses(shared, true);
    if let Ok(mut outcome) = control.outcome.lock() {
        *outcome = Some(result);
    }
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn new_invocation_control(
    id: String,
    macro_id: String,
    role_ids: HashSet<String>,
) -> Arc<InvocationControl> {
    Arc::new(InvocationControl {
        barriers: Mutex::new(HashMap::new()),
        cancelled: AtomicBool::new(false),
        cancellation_error: Mutex::new(None),
        cancelled_role_ids: Mutex::new(HashSet::new()),
        children: (Mutex::new(ChildInvocations::default()), Condvar::new()),
        failed_role_id: Mutex::new(None),
        first_iteration_completed: AtomicBool::new(false),
        first_iteration_roles: (Mutex::new(HashSet::new()), Condvar::new()),
        finished: (Mutex::new(false), Condvar::new()),
        finished_naturally: AtomicBool::new(false),
        id,
        macro_ids: Mutex::new(HashSet::from([macro_id])),
        outcome: Mutex::new(None),
        role_ids,
        start_ready: (Mutex::new(false), Condvar::new()),
        stop_after_first_iteration: AtomicBool::new(false),
        terminating: AtomicBool::new(false),
        wake: (Mutex::new(()), Condvar::new()),
        worker: Mutex::new(None),
    })
}

fn discard_unstarted_invocation(shared: &Arc<Shared>, control: &Arc<InvocationControl>) {
    if let Ok(mut inner) = shared.inner.lock() {
        inner.invocations.remove(&control.id);
        let prefix = format!("{}|", control.id);
        inner.statuses.retain(|key, _| !key.starts_with(&prefix));
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    if let Ok(mut outcome) = control.outcome.lock() {
        *outcome = Some(Err("macro invocation did not start".to_owned()));
    }
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn detach_owned_children(control: &Arc<InvocationControl>) {
    if let Ok(mut children) = control.children.0.lock() {
        children.ids.clear();
        control.children.1.notify_all();
    }
}

fn cancel_owned_children(shared: &Arc<Shared>, control: &Arc<InvocationControl>) {
    let child_controls = {
        let mut children = match control.children.0.lock() {
            Ok(children) => children,
            Err(_) => return,
        };
        while children.pending_starts > 0 {
            children = match control.children.1.wait(children) {
                Ok(children) => children,
                Err(_) => return,
            };
        }
        let ids = std::mem::take(&mut children.ids);
        let inner = match shared.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        ids.into_iter()
            .filter_map(|id| inner.invocations.get(&id).cloned())
            .collect::<Vec<_>>()
    };
    let _ = cancel_and_wait_all(&child_controls);
}

fn add_running_statuses(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            inner.statuses.insert(
                status_key(&context.control.id, role_id, macro_id),
                MacroRunStatus {
                    role_id: role_id.clone(),
                    macro_id: macro_id.to_owned(),
                    state: "running".to_owned(),
                    iteration: Some(0),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now.clone(),
                    error: None,
                },
            );
        }
    }
    emit_statuses(shared, true);
}

fn update_iteration(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    iteration: u32,
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            if let Some(status) =
                inner
                    .statuses
                    .get_mut(&status_key(&context.control.id, role_id, macro_id))
            {
                status.iteration = Some(iteration);
                status.updated_at = now.clone();
            }
        }
    }
    emit_presentation_statuses(shared);
}

fn mark_click(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    role_id: &str,
    step_id: &str,
) {
    if let Ok(mut inner) = shared.inner.lock()
        && let Some(status) =
            inner
                .statuses
                .get_mut(&status_key(&context.control.id, role_id, macro_id))
    {
        status.last_click = Some(MacroLastClick {
            sequence: status
                .last_click
                .as_ref()
                .map_or(1, |click| click.sequence.saturating_add(1)),
            step_id: step_id.to_owned(),
        });
        status.updated_at = Utc::now().to_rfc3339();
    }
    emit_presentation_statuses(shared);
}

fn remove_macro_statuses(shared: &Arc<Shared>, invocation_id: &str, macro_id: &str) {
    if let Ok(mut inner) = shared.inner.lock() {
        let prefix = format!("{invocation_id}|");
        inner
            .statuses
            .retain(|key, status| !(key.starts_with(&prefix) && status.macro_id == macro_id));
    }
    emit_statuses(shared, true);
}

fn emit_statuses(shared: &Arc<Shared>, reliable: bool) {
    let mut statuses = shared
        .inner
        .lock()
        .map(|inner| inner.statuses.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    statuses.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.role_id.cmp(&right.role_id))
    });
    (shared.events)(vec![CoreEvent::MacroStatuses { reliable, statuses }]);
}

fn emit_presentation_statuses(shared: &Arc<Shared>) {
    let now = Instant::now();
    let should_emit = shared
        .last_presentation_status_emit
        .lock()
        .map(|mut last| {
            if last.is_some_and(|last| now.duration_since(last) < PRESENTATION_STATUS_MIN_INTERVAL)
            {
                return false;
            }
            *last = Some(now);
            true
        })
        .unwrap_or(false);
    if should_emit {
        emit_statuses(shared, false);
    }
}

fn cancel_control(control: &InvocationControl) {
    let _wake = control.wake.0.lock().ok();
    control.cancelled.store(true, Ordering::Release);
    control.wake.1.notify_all();
    drop(_wake);
    control.start_ready.1.notify_all();
    control.first_iteration_roles.1.notify_all();
    if let Ok(barriers) = control.barriers.lock() {
        for barrier in barriers.values() {
            barrier.ready.notify_all();
        }
    }
}

fn mark_invocation_ready(control: &InvocationControl) {
    if let Ok(mut ready) = control.start_ready.0.lock() {
        *ready = true;
        control.start_ready.1.notify_all();
    }
}

fn wait_for_invocation_ready(control: &InvocationControl) -> Result<(), String> {
    let mut ready = control
        .start_ready
        .0
        .lock()
        .map_err(|_| "macro start gate lock poisoned".to_owned())?;
    while !*ready && !control.cancelled.load(Ordering::Acquire) {
        ready = control
            .start_ready
            .1
            .wait(ready)
            .map_err(|_| "macro start gate lock poisoned".to_owned())?;
    }
    if control.cancelled.load(Ordering::Acquire) {
        Err("macro run cancelled".to_owned())
    } else {
        Ok(())
    }
}

fn cancel_and_wait_all(controls: &[Arc<InvocationControl>]) -> CoreResult<()> {
    for control in controls {
        cancel_control(control);
    }
    let mut first_error = None;
    for control in controls {
        if let Err(error) = wait_finished(control)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn wait_finished(control: &InvocationControl) -> CoreResult<()> {
    wait_finished_with_timeout(control, INVOCATION_STOP_TIMEOUT)
}

fn wait_finished_with_timeout(control: &InvocationControl, timeout: Duration) -> CoreResult<()> {
    let finished = control
        .finished
        .0
        .lock()
        .map_err(|_| CoreError::Internal("macro completion lock poisoned".to_owned()))?;
    let (finished, _) = control
        .finished
        .1
        .wait_timeout_while(finished, timeout, |finished| !*finished)
        .map_err(|_| CoreError::Internal("macro completion lock poisoned".to_owned()))?;
    if !*finished {
        return Err(CoreError::Domain {
            code: "MACRO_STOP_TIMEOUT",
            message: format!(
                "Macro invocation {} did not stop within {} seconds.",
                control.id,
                timeout.as_secs_f64()
            ),
        });
    }
    drop(finished);
    let worker = control
        .worker
        .lock()
        .map_err(|_| CoreError::Internal("macro worker lock poisoned".to_owned()))?
        .take();
    if let Some(worker) = worker
        && worker.thread().id() != thread::current().id()
    {
        worker
            .join()
            .map_err(|_| CoreError::Internal("macro worker panicked".to_owned()))?;
    }
    Ok(())
}

fn assigned_active_roles(
    definition: &MacroDefinition,
    active_role_ids: &HashSet<String>,
) -> Vec<String> {
    definition
        .role_ids
        .iter()
        .filter(|role_id| active_role_ids.contains(*role_id))
        .cloned()
        .collect()
}

fn collect_invocation_macro_ids(
    root_id: &str,
    macros: &HashMap<String, MacroDefinition>,
) -> HashSet<String> {
    let mut collected = HashSet::new();
    let mut pending = vec![root_id.to_owned()];
    while let Some(macro_id) = pending.pop() {
        if !collected.insert(macro_id.clone()) {
            continue;
        }
        let Some(definition) = macros.get(&macro_id) else {
            continue;
        };
        pending.extend(definition.steps.iter().filter_map(|step| match step {
            MacroStepDefinition::Macro { macro_id, .. } => Some(macro_id.clone()),
            _ => None,
        }));
    }
    collected
}

fn validate_start_request(request: &MacroStartRequest) -> CoreResult<()> {
    if request.macro_id.trim().is_empty() || request.macros.is_empty() {
        return Err(CoreError::InvalidInput(
            "macro start request is invalid".to_owned(),
        ));
    }
    if request.macros.len() > 2_000 || request.active_role_ids.len() > 128 {
        return Err(CoreError::InvalidInput(
            "macro start request exceeds runtime limits".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for definition in &request.macros {
        if definition.id.trim().is_empty()
            || definition.name.trim().is_empty()
            || !ids.insert(definition.id.clone())
            || definition.steps.len() > 100
            || definition.role_ids.iter().any(|id| id.trim().is_empty())
        {
            return Err(CoreError::InvalidInput(
                "macro definition is invalid".to_owned(),
            ));
        }
    }
    validate_macro_dependencies(&request.macros)
}

fn validate_macro_dependencies(macros: &[MacroDefinition]) -> CoreResult<()> {
    let by_id = macros
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<HashMap<_, _>>();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a MacroDefinition>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> CoreResult<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(CoreError::InvalidInput(
                "macro dependency cycle detected".to_owned(),
            ));
        }
        let definition = by_id
            .get(id)
            .ok_or_else(|| CoreError::InvalidInput("macro dependency is missing".to_owned()))?;
        for dependency in definition.steps.iter().filter_map(|step| match step {
            MacroStepDefinition::Macro { macro_id, .. } => Some(macro_id.as_str()),
            _ => None,
        }) {
            if !by_id.contains_key(dependency) {
                return Err(CoreError::InvalidInput(
                    "macro dependency is missing".to_owned(),
                ));
            }
            visit(dependency, by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in by_id.keys().copied() {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_press_id(press_id: &str) -> CoreResult<()> {
    if press_id.trim().is_empty() || press_id.len() > 160 {
        Err(CoreError::InvalidInput(
            "macro shortcut press id is invalid".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn validate_result(result: &BrowserActionResult) -> CoreResult<()> {
    if result.request_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "browser action result requires requestId".to_owned(),
        ));
    }
    if result.ok && (result.error_code.is_some() || result.error_message.is_some()) {
        return Err(CoreError::InvalidInput(
            "successful browser action result cannot contain an error".to_owned(),
        ));
    }
    if !result.ok
        && (result.error_code.as_deref().is_none_or(str::is_empty)
            || result.error_message.as_deref().is_none_or(str::is_empty))
    {
        return Err(CoreError::InvalidInput(
            "failed browser action result requires an error code and message".to_owned(),
        ));
    }
    Ok(())
}

fn status_key(invocation_id: &str, role_id: &str, macro_id: &str) -> String {
    format!("{invocation_id}|{role_id}|{macro_id}")
}

fn lease_key(role_id: &str, macro_id: &str) -> String {
    format!("{role_id}|{macro_id}")
}

fn early_release_key(role_id: &str, macro_id: &str, press_id: &str) -> String {
    format!("{role_id}|{macro_id}|{press_id}")
}

fn trim_early_releases(releases: &mut HashMap<String, String>) {
    while releases.len() > 256 {
        let Some(key) = releases.keys().next().cloned() else {
            break;
        };
        releases.remove(&key);
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::model::{MacroRepeat, MacroStepDefinition};

    struct ManualWait {
        duration_ms: u32,
        release: mpsc::SyncSender<()>,
        role_id: String,
    }

    #[test]
    fn unfinished_invocation_reports_stop_timeout() {
        let control = new_invocation_control(
            "hung-invocation".to_owned(),
            "m1".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );

        let error = wait_finished_with_timeout(&control, Duration::ZERO).unwrap_err();

        assert_eq!(error.code(), "MACRO_STOP_TIMEOUT");
        assert!(error.to_string().contains("hung-invocation"));
    }

    #[test]
    fn role_stop_request_sets_a_cancellation_fence_without_waiting_for_worker_cleanup() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        let control = new_invocation_control(
            "hung-invocation".to_owned(),
            "m1".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );
        runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .invocations
            .insert(control.id.clone(), Arc::clone(&control));

        let started = Instant::now();
        runtime.request_stop_role("r1").unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(control.cancelled.load(Ordering::Acquire));
        assert!(!*control.finished.0.lock().unwrap());
        let error = runtime.start(request(Vec::new())).unwrap_err();
        assert_eq!(error.code(), "MACRO_ROLE_STOPPING");

        runtime.allow_role_after_launch("r1");
        assert!(
            !runtime
                .shared
                .inner
                .lock()
                .unwrap()
                .stopping_role_ids
                .contains("r1")
        );
    }

    fn runtime_with_manual_wait(events: EventSink) -> (MacroRuntime, mpsc::Receiver<ManualWait>) {
        let (waits, receiver) = mpsc::channel();
        let waiter: Waiter = Arc::new(move |control, role_id, duration_ms| {
            let (release, released) = mpsc::sync_channel(0);
            waits
                .send(ManualWait {
                    duration_ms,
                    release,
                    role_id: role_id.to_owned(),
                })
                .map_err(|_| "manual wait receiver closed".to_owned())?;
            loop {
                match released.recv_timeout(Duration::from_millis(10)) {
                    Ok(()) => return Ok(()),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if control.cancelled.load(Ordering::Acquire)
                            || is_role_cancelled(control, role_id)
                        {
                            return Err("macro run cancelled".to_owned());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("manual wait release closed".to_owned());
                    }
                }
            }
        });
        (MacroRuntime::new_with_waiter(events, waiter), receiver)
    }

    fn next_wait(receiver: &mpsc::Receiver<ManualWait>) -> ManualWait {
        receiver.recv_timeout(Duration::from_secs(2)).unwrap()
    }

    fn request(steps: Vec<MacroStepDefinition>) -> MacroStartRequest {
        MacroStartRequest {
            macros: vec![MacroDefinition {
                id: "m1".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Macro".to_owned(),
                role_ids: vec!["r1".to_owned()],
                trigger: None,
                repeat: MacroRepeat::Once,
                steps,
            }],
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 1,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "m1".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned()],
        }
    }

    #[test]
    fn suppresses_only_keys_that_can_match_an_enabled_role_shortcut() {
        let definitions = [
            MacroDefinition {
                id: "matching".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Matching".to_owned(),
                role_ids: vec!["r1".to_owned()],
                trigger: Some(crate::model::MacroTrigger {
                    code: "KeyE".to_owned(),
                    ctrl: false,
                    alt: false,
                    shift: false,
                    meta: false,
                }),
                repeat: MacroRepeat::Once,
                steps: Vec::new(),
            },
            MacroDefinition {
                id: "other-role".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Other".to_owned(),
                role_ids: vec!["r2".to_owned()],
                trigger: Some(crate::model::MacroTrigger {
                    code: "KeyY".to_owned(),
                    ctrl: false,
                    alt: false,
                    shift: false,
                    meta: false,
                }),
                repeat: MacroRepeat::Once,
                steps: Vec::new(),
            },
        ]
        .into_iter()
        .map(|definition| (definition.id.clone(), definition))
        .collect::<HashMap<_, _>>();

        assert!(should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "KeyE",
            &[]
        ));
        assert!(!should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "KeyY",
            &[]
        ));
        assert!(!should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "Digit1",
            &[]
        ));
    }

    fn triggered_delay_request() -> MacroStartRequest {
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "parent-wait".to_owned(),
                ms: 60_000,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "child-wait".to_owned(),
                ms: 60_000,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        start
    }

    #[test]
    fn emits_ordered_actions_and_consumes_results() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let (_, focus) = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "s1".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }]),
        );
        let mut phases = focus
            .iter()
            .map(|_| "focus".to_owned())
            .collect::<Vec<String>>();
        while phases.len() < 3 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                        runtime
                            .dispatch_results(vec![BrowserActionResult {
                                request_id: action.request_id,
                                ok: true,
                                value_json: None,
                                error_code: None,
                                error_message: None,
                            }])
                            .unwrap();
                    }
                }
            }
        }
        assert_eq!(phases, ["focus", "hold", "release"]);
    }

    #[test]
    fn forwards_click_anchors_and_increments_each_role_click_sequence() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Click {
                id: "percent-click".to_owned(),
                anchor: Some("bottom-right".to_owned()),
                position: crate::model::MacroClickDefinition::Percent {
                    unit: Some("percent".to_owned()),
                    x_percent: -10.0,
                    y_percent: -20.0,
                },
            },
            MacroStepDefinition::Click {
                id: "pixel-click".to_owned(),
                anchor: Some("center".to_owned()),
                position: crate::model::MacroClickDefinition::Pixels {
                    unit: "px".to_owned(),
                    x_px: 12.0,
                    y_px: -8.0,
                },
            },
        ]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let percent = next_browser_actions(&receiver);
        crate::v1_case!("macro-c39036338d41", {
            assert!(matches!(
                percent[0].action,
                BrowserAction::Click {
                    ref anchor,
                    ref unit,
                    x,
                    y,
                    ..
                } if anchor.as_deref() == Some("bottom-right")
                    && unit == "percent"
                    && x == -10.0
                    && y == -20.0
            ));
        });
        runtime.dispatch_results(success_results(percent)).unwrap();
        let first_click = wait_for_last_click(&runtime, "r1", 1, "percent-click");
        crate::v1_case!("macro-runtime-09beabfa3d19", {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
        });

        let pixels = next_browser_actions(&receiver);
        assert!(matches!(
            pixels[0].action,
            BrowserAction::Click {
                ref anchor,
                ref unit,
                x,
                y,
                ..
            } if anchor.as_deref() == Some("center")
                && unit == "px"
                && x == 12.0
                && y == -8.0
        ));
        runtime.dispatch_results(success_results(pixels)).unwrap();
        let second_click = wait_for_last_click(&runtime, "r1", 2, "pixel-click");
        crate::v1_case!("macro-baf3548b5c3b", {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
            assert_eq!(
                (second_click.sequence, second_click.step_id.as_str()),
                (2, "pixel-click")
            );
        });
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn one_second_digit_one_loop_completes_three_iterations_without_failing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "digit-1".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: Some("1".to_owned()),
        }]);
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let (started, focus) = start_and_ack_focus(&runtime, &receiver, start);
        crate::v1_case!("macro-23762f0194b5", {
            assert_eq!(
                started
                    .iter()
                    .map(|status| status.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1"]
            );
        });
        let mut phases = focus.iter().map(|_| "focus".to_owned()).collect::<Vec<_>>();
        let startup = next_wait(&waits);
        assert_eq!(startup.duration_ms, 0);
        startup.release.send(()).unwrap();

        let mut loop_waits = Vec::new();
        let mut pending_loop_wait = None;
        for _ in 0..3 {
            for expected_phase in ["hold", "release"] {
                let actions = next_browser_actions(&receiver);
                assert!(actions.iter().all(|action| matches!(
                    action.action,
                    BrowserAction::Key {
                        ref code,
                        ref phase,
                        ..
                    } if code.as_deref() == Some("Digit1") && phase == expected_phase
                )));
                phases.push(expected_phase.to_owned());
                runtime.dispatch_results(success_results(actions)).unwrap();
                if expected_phase == "hold" {
                    let key_hold = next_wait(&waits);
                    assert_eq!(key_hold.duration_ms, 1);
                    key_hold.release.send(()).unwrap();
                } else {
                    let post_input = next_wait(&waits);
                    assert_eq!(post_input.duration_ms, 0);
                    post_input.release.send(()).unwrap();
                }
            }
            let loop_wait = next_wait(&waits);
            loop_waits.push(loop_wait.duration_ms);
            if loop_waits.len() < 3 {
                loop_wait.release.send(()).unwrap();
            } else {
                pending_loop_wait = Some(loop_wait);
            }
        }

        runtime.stop_macro("m1").unwrap();
        drop(pending_loop_wait);
        crate::v1_case!("macro-87360f7f466d", {
            assert_eq!(loop_waits, [1_000, 1_000, 1_000]);
            assert_eq!(
                phases,
                [
                    "focus", "hold", "release", "hold", "release", "hold", "release"
                ]
            );
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn v1_applies_startup_timing_once_and_captures_settings_per_start() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 100,
            key_hold_ms: 30,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        let first_waits = drive_timed_tap(&runtime, &receiver, &waits, first);

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        second.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        second.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 80,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        let second_waits = drive_timed_tap(&runtime, &receiver, &waits, second);

        crate::v1_case!("macro-89c4b8841d73", {
            assert_eq!(first_waits, [100, 30, 30]);
        });
        crate::v1_case!("macro-02f53b92e12c", {
            assert_eq!(second_waits, [0, 80, 30]);
            assert_eq!(first_waits[1], 30);
        });
    }

    #[test]
    fn v1_omits_implicit_timing_but_keeps_explicit_delays_without_a_shortcut() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Key {
                id: "before".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
            MacroStepDefinition::Delay {
                id: "delay".to_owned(),
                ms: 100,
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 50 };
        start.settings = MacroRuntimeSettings {
            startup_delay_ms: 500,
            key_hold_ms: 400,
            post_input_delay_ms: 300,
            default_loop_delay_ms: 200,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        for expected in [("KeyA", "hold"), ("KeyA", "release")] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected.0) && phase == expected.1
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
        }
        let explicit = next_wait(&waits);
        assert_eq!(explicit.role_id, "r1");
        assert_eq!(explicit.duration_ms, 100);
        explicit.release.send(()).unwrap();
        for expected in [("KeyB", "hold"), ("KeyB", "release")] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected.0) && phase == expected.1
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
        }
        let loop_wait = next_wait(&waits);
        crate::v1_case!("macro-3446dd16a6af", {
            assert_eq!(loop_wait.duration_ms, 50);
            assert!(waits.try_recv().is_err());
        });
        crate::v1_case!("macro-3c7a66fa8062", {
            assert_eq!((explicit.duration_ms, loop_wait.duration_ms), (100, 50));
        });
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn v1_called_macro_timing_depends_on_each_definition_shortcut() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Key {
                id: "parent-key".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
        ]);
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.settings = MacroRuntimeSettings {
            startup_delay_ms: 100,
            key_hold_ms: 30,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![
                MacroStepDefinition::Key {
                    id: "child-key".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                },
                MacroStepDefinition::Macro {
                    id: "call-grandchild".to_owned(),
                    macro_id: "grandchild".to_owned(),
                    call_mode: Some("wait".to_owned()),
                },
            ],
        });
        start.macros.push(MacroDefinition {
            id: "grandchild".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Grandchild".to_owned(),
            role_ids: vec!["r3".to_owned()],
            trigger: Some(crate::model::MacroTrigger {
                code: "KeyG".to_owned(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            }),
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "grandchild-key".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut timed_waits = Vec::new();
        let parent_startup = next_wait(&waits);
        timed_waits.push(parent_startup.duration_ms);
        parent_startup.release.send(()).unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyA") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let wait = next_wait(&waits);
            timed_waits.push(wait.duration_ms);
            wait.release.send(()).unwrap();
        }

        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyB") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            assert!(waits.try_recv().is_err(), "untimed child introduced a wait");
        }

        let grandchild_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(grandchild_focus))
            .unwrap();
        let grandchild_startup = next_wait(&waits);
        timed_waits.push(grandchild_startup.duration_ms);
        grandchild_startup.release.send(()).unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyC") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let wait = next_wait(&waits);
            timed_waits.push(wait.duration_ms);
            wait.release.send(()).unwrap();
        }
        crate::v1_case!("macro-b0cc1d61fb76", {
            assert_eq!(timed_waits, [100, 30, 30, 100, 30, 30]);
        });
    }

    #[test]
    fn rejects_dependency_cycles_before_starting() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        let mut request = request(vec![MacroStepDefinition::Macro {
            id: "s1".to_owned(),
            macro_id: "m1".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        request.macros[0].steps = request.macros[0].steps.clone();
        assert!(runtime.start(request).is_err());
    }

    #[test]
    fn rejects_transitively_unassigned_children_before_focus_preflight() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "call-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: Vec::new(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: Vec::new(),
        });
        let error = runtime.start(start).unwrap_err();
        crate::v1_case!("macro-9e169962dea5", {
            assert!(matches!(
                error,
                CoreError::InvalidInput(message) if message == UNASSIGNED_WORKFLOW_MESSAGE
            ));
            assert!(receiver.try_recv().is_err());
        });
    }

    #[test]
    fn v1_rejects_disabled_unassigned_and_unavailable_starts() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));

        let mut unavailable = request(Vec::new());
        unavailable.active_role_ids.clear();
        crate::v1_case!("macro-2e985330d84a", {
            let error = runtime.start(unavailable).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == UNAVAILABLE_ROLE_MESSAGE
            ));
            assert!(runtime.statuses().unwrap().is_empty());
        });

        let mut unassigned = request(Vec::new());
        unassigned.macros[0].role_ids.clear();
        crate::v1_case!("macro-f7e4fa9e23ea", {
            let error = runtime.start(unassigned).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message) if message == UNASSIGNED_WORKFLOW_MESSAGE
            ));
            assert!(receiver.try_recv().is_err());
        });

        let mut disabled = request(Vec::new());
        disabled.macros[0].enabled = false;
        crate::v1_case!("macro-0b5213817444", {
            let error = runtime.start(disabled).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == DISABLED_MACRO_MESSAGE
            ));
            assert!(runtime.statuses().unwrap().is_empty());
            assert!(receiver.try_recv().is_err());
        });
    }

    #[test]
    fn v1_waits_for_all_focus_results_before_running_or_dispatching_input() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start));
        let focus = next_browser_action_count(&receiver, 2);
        let r1 = focus
            .iter()
            .find(|action| action.role_id == "r1")
            .cloned()
            .unwrap();
        runtime.dispatch_results(success_results(vec![r1])).unwrap();

        crate::v1_case!("macro-78c7a107997d", {
            thread::sleep(Duration::from_millis(25));
            assert!(!starting.is_finished());
            assert!(runtime.statuses().unwrap().is_empty());
            assert!(receiver.try_recv().is_err());
        });

        runtime
            .dispatch_results(success_results(
                focus
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        assert_eq!(starting.join().unwrap().unwrap().len(), 2);
        let holds = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(releases)).unwrap();
    }

    #[test]
    fn v1_rejects_duplicate_runs_and_stops_only_the_requested_macro() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let steps = vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }];
        let mut first = request(steps.clone());
        first.macros.push(MacroDefinition {
            id: "m2".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Second".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: steps.clone(),
        });
        first.active_role_ids.push("r2".to_owned());
        let (_, _) = start_and_ack_focus(&runtime, &receiver, first.clone());

        crate::v1_case!("macro-677fecf721f6", {
            let error = runtime.start(first.clone()).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == "macro is already running for this role"
            ));
        });

        let mut second = first;
        second.macro_id = "m2".to_owned();
        let (_, _) = start_and_ack_focus(&runtime, &receiver, second);
        crate::v1_case!("macro-96f1664fe14f", {
            runtime.stop_macro("m1").unwrap();
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .map(|status| (status.macro_id.as_str(), status.role_id.as_str()))
                    .collect::<Vec<_>>(),
                [("m2", "r2")]
            );
        });
        runtime.stop_macro("m2").unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn rust_mutation_leases_block_starts_until_the_transaction_finishes() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let lease = runtime
            .acquire_mutation(vec!["m1".to_owned()], false)
            .unwrap();

        let error = runtime.start(request(Vec::new())).unwrap_err();
        crate::v1_case!("macro-34e3112bbe5b", {
            assert_eq!(error.code(), "MACRO_MUTATION_BUSY");
        });

        runtime.release_mutation(&lease).unwrap();
        let (statuses, _) = start_and_ack_focus(&runtime, &receiver, request(Vec::new()));
        assert_eq!(statuses.len(), 1);
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn batches_cross_role_actions_and_preserves_each_role_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![
            MacroStepDefinition::Key {
                id: "s1".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: Some(vec!["primary".to_owned(), "shift".to_owned()]),
                action: Some("tap".to_owned()),
                label: None,
            },
            MacroStepDefinition::Click {
                id: "s2".to_owned(),
                anchor: Some("center".to_owned()),
                position: crate::model::MacroClickDefinition::Percent {
                    unit: Some("percent".to_owned()),
                    x_percent: 50.0,
                    y_percent: 50.0,
                },
            },
        ]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, request);
        let mut actions = focus
            .iter()
            .map(|action| (action.role_id.clone(), "focus".to_owned()))
            .collect::<Vec<_>>();
        let mut key_operation_modifiers = Vec::new();
        while actions.len() < 8 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions {
                    actions: action_requests,
                } = event
                {
                    actions.extend(action_requests.iter().map(|action| {
                        let phase = match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key {
                                phase, modifiers, ..
                            } => {
                                key_operation_modifiers.push(modifiers.clone());
                                phase.clone()
                            }
                            BrowserAction::Click { .. } => "click".to_owned(),
                        };
                        (action.role_id.clone(), phase)
                    }));
                    runtime
                        .dispatch_results(
                            action_requests
                                .into_iter()
                                .map(|action| BrowserActionResult {
                                    request_id: action.request_id,
                                    ok: true,
                                    value_json: None,
                                    error_code: None,
                                    error_message: None,
                                })
                                .collect(),
                        )
                        .unwrap();
                }
            }
        }
        crate::v1_case!("macro-23c30b4fba31", {
            for role_id in ["r1", "r2"] {
                assert_eq!(
                    actions
                        .iter()
                        .filter(|(role, _)| role == role_id)
                        .map(|(_, phase)| phase.as_str())
                        .collect::<Vec<_>>(),
                    ["focus", "hold", "release", "click"]
                );
            }
        });
        crate::v1_case!("macro-7ef873c48bd8", {
            assert_eq!(
                key_operation_modifiers,
                [
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                ]
            );
        });
    }

    #[test]
    fn ordinary_steps_advance_per_role_before_the_first_iteration_barrier() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        runtime
            .dispatch_results(success_results(
                holds
                    .iter()
                    .filter(|action| action.role_id == "r2")
                    .cloned()
                    .collect(),
            ))
            .unwrap();
        let r2_release = next_browser_actions(&receiver);
        assert_eq!(r2_release.len(), 1);
        assert_eq!(r2_release[0].role_id, "r2");
        assert!(matches!(
            r2_release[0].action,
            BrowserAction::Key {
                ref phase,
                ..
            } if phase == "release"
        ));
        runtime
            .dispatch_results(success_results(r2_release))
            .unwrap();

        runtime
            .dispatch_results(success_results(
                holds
                    .into_iter()
                    .filter(|action| action.role_id == "r1")
                    .collect(),
            ))
            .unwrap();
        let r1_release = next_browser_actions(&receiver);
        assert_eq!(r1_release.len(), 1);
        assert_eq!(r1_release[0].role_id, "r1");
        runtime
            .dispatch_results(success_results(r1_release))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn stop_waits_for_in_flight_actions_and_their_compensating_releases() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        thread::sleep(Duration::from_millis(50));
        crate::v1_case!("macro-8a8d01d649bb", {
            assert!(!stop.is_finished());
        });

        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        thread::sleep(Duration::from_millis(50));
        assert!(!stop.is_finished());
        runtime.dispatch_results(success_results(releases)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn v1_fails_an_unacknowledged_input_with_the_original_timeout_error() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new_with_waiter_and_timeout(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(default_wait),
            Duration::from_millis(1),
        );
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "hung".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }]),
        );
        let hung_hold = next_browser_actions(&receiver);
        assert!(matches!(
            hung_hold[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "hold"
        ));

        let compensating_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(compensating_release))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let failed = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.state == "failed")
            {
                break status;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        };
        crate::v1_case!("macro-2f12cec90976", {
            assert_eq!(
                failed.error.as_deref(),
                Some("Macro input timed out after 10000 ms.")
            );
            runtime
                .dispatch_results(success_results(hung_hold))
                .unwrap();
        });
    }

    #[test]
    fn keeps_only_one_unacknowledged_action_per_role_across_invocations() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let steps = vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 0,
        }];
        let first_request = request(steps.clone());
        let first_runtime = runtime.clone();
        let first_start = thread::spawn(move || first_runtime.start(first_request).unwrap());
        let first = next_browser_actions(&receiver);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].role_id, "r1");

        let mut second_request = request(steps);
        second_request.macro_id = "m2".to_owned();
        second_request.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second_request).unwrap());

        crate::v1_case!("macro-900c71b89cc0", {
            let wait_started = std::time::Instant::now();
            while wait_started.elapsed() < Duration::from_millis(100) {
                let remaining = Duration::from_millis(100).saturating_sub(wait_started.elapsed());
                let Ok(batch) = receiver.recv_timeout(remaining) else {
                    break;
                };
                assert!(
                    batch
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "a second same-role action escaped before the first result was acknowledged"
                );
            }
        });
        runtime.dispatch_results(success_results(first)).unwrap();
        first_start.join().unwrap();
        let second = next_browser_actions(&receiver);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].role_id, "r1");
        runtime.dispatch_results(success_results(second)).unwrap();
        second_start.join().unwrap();
        runtime.shutdown();
    }

    #[test]
    fn v1_serializes_complete_key_and_click_sequences_across_same_role_invocations() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "first-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 0,
            post_input_delay_ms: 100,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let startup = next_wait(&waits);
        assert_eq!(startup.duration_ms, 0);
        startup.release.send(()).unwrap();
        let key_hold = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(key_hold)).unwrap();
        let hold_wait = next_wait(&waits);
        assert_eq!(hold_wait.duration_ms, 0);
        hold_wait.release.send(()).unwrap();
        let key_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(key_release))
            .unwrap();
        let post_input = next_wait(&waits);
        assert_eq!(post_input.duration_ms, 100);

        let mut second = request(vec![MacroStepDefinition::Click {
            id: "second-click".to_owned(),
            anchor: None,
            position: crate::model::MacroClickDefinition::Percent {
                unit: Some("percent".to_owned()),
                x_percent: 20.0,
                y_percent: 30.0,
            },
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second).unwrap());
        let second_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_focus))
            .unwrap();
        second_start.join().unwrap();
        crate::v1_case!("effect-lifecycle-9fd32f9d9a46", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        });
        crate::v1_case!("effect-lifecycle-3ea8a4d777a6", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        });

        post_input.release.send(()).unwrap();
        let click = next_browser_actions(&receiver);
        assert!(matches!(click[0].action, BrowserAction::Click { .. }));
        runtime.dispatch_results(success_results(click)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn v1_serializes_concurrent_key_sequences_for_the_same_role() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "first-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 100,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let startup = next_wait(&waits);
        startup.release.send(()).unwrap();
        let first_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(first_hold))
            .unwrap();
        let key_hold = next_wait(&waits);
        assert_eq!(key_hold.duration_ms, 100);

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "second-key".to_owned(),
            code: "F3".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second).unwrap());
        let second_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_focus))
            .unwrap();
        second_start.join().unwrap();
        crate::v1_case!("effect-lifecycle-58de3b545b87", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        });

        key_hold.release.send(()).unwrap();
        let first_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(first_release))
            .unwrap();
        let first_post = next_wait(&waits);
        first_post.release.send(()).unwrap();
        let second_hold = next_browser_actions(&receiver);
        assert!(matches!(
            second_hold[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("F3") && phase == "hold"
        ));
        runtime
            .dispatch_results(success_results(second_hold))
            .unwrap();
        let second_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_release))
            .unwrap();
    }

    #[test]
    fn v1_keeps_held_key_cleanup_inside_the_same_role_input_sequence() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "held".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
            }]),
        );
        let held = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(held)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while runtime.statuses().unwrap()[0].iteration.unwrap_or_default() == 0 {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "queued-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        second.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        second.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 100,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, second);
        let startup = next_wait(&waits);
        startup.release.send(()).unwrap();
        let queued_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(queued_hold))
            .unwrap();
        let key_hold = next_wait(&waits);

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        crate::v1_case!("effect-lifecycle-71c3f4375db4", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        });
        crate::v1_case!("macro-runtime-046554940f1f", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        });
        crate::v1_case!("macro-runtime-5f44c60fd7a4", {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        });
        key_hold.release.send(()).unwrap();
        let queued_release = next_browser_actions(&receiver);
        assert!(matches!(
            queued_release[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("F2") && phase == "release"
        ));
        runtime
            .dispatch_results(success_results(queued_release))
            .unwrap();
        let post_input = next_wait(&waits);
        post_input.release.send(()).unwrap();
        let held_release = next_browser_actions(&receiver);
        assert!(matches!(
            held_release[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("KeyW") && phase == "release"
        ));
        runtime
            .dispatch_results(success_results(held_release))
            .unwrap();
        stop.join().unwrap();
    }

    #[test]
    fn stopping_from_one_assigned_role_cancels_the_sibling_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, request);
        let mut action_batches = vec![focus];
        let holds = next_browser_action_count(&receiver, 2);
        action_batches.push(holds.clone());
        runtime.dispatch_results(success_results(holds)).unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || {
            stopping_runtime.stop_macro_from_role("m1", "r1").unwrap();
        });
        let mut released_roles = Vec::new();
        while released_roles.len() < 2 {
            let release = next_browser_actions(&receiver);
            released_roles.extend(release.iter().map(|action| action.role_id.clone()));
            runtime.dispatch_results(success_results(release)).unwrap();
        }
        stop.join().unwrap();
        released_roles.sort();
        assert_eq!(released_roles, ["r1", "r2"]);
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn closing_any_execution_role_stops_the_whole_sibling_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, request);
        let holds = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(holds)).unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_role("r2").unwrap());
        let releases = next_browser_action_count(&receiver, 2);
        let mut released_roles = releases
            .iter()
            .map(|action| action.role_id.as_str())
            .collect::<Vec<_>>();
        released_roles.sort_unstable();
        crate::v1_case!("macro-70847388785a", {
            assert_eq!(released_roles, ["r1", "r2"]);
        });
        runtime.dispatch_results(success_results(releases)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn source_role_starts_all_available_assigned_roles() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);
        request.macros[0]
            .role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        request.active_role_ids.push("r2".to_owned());
        request.source_role_id = Some("r2".to_owned());
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request).unwrap());
        let focus = next_browser_actions(&receiver);
        assert!(runtime.statuses().unwrap().is_empty());
        runtime
            .dispatch_results(success_results(focus.clone()))
            .unwrap();
        let statuses = start.join().unwrap();
        crate::v1_case!("macro-7f1350a27644", {
            assert_eq!(
                statuses
                    .iter()
                    .map(|status| status.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1", "r2"]
            );
            assert!(statuses.iter().all(|status| status.role_id != "r3"));
        });
        crate::v1_case!("macro-55aadc285c62", {
            assert_eq!(focus.len(), 2);
            assert_eq!(
                focus
                    .iter()
                    .map(|action| action.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1", "r2"]
            );
        });
        crate::v1_case!("macro-5c368d9c8ecd", {
            runtime.stop_macro("m1").unwrap();
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn cancellation_releases_owned_held_keys_before_finishing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1 };
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, start);
        let mut phases = focus.iter().map(|_| "focus".to_owned()).collect::<Vec<_>>();
        while phases.len() < 2 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        crate::v1_case!("macro-39621b53863b", {
            assert_eq!(runtime.statuses().unwrap().len(), 1);
            assert_eq!(phases, ["focus", "hold"]);
        });
        crate::v1_case!("macro-b40211c87ff3", {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let statuses = runtime.statuses().unwrap();
                // A looped hold remains owned after its first iteration. Advancing
                // further must not dispatch another hold for the same owner.
                if statuses[0].iteration.unwrap_or_default() >= 3 {
                    assert_eq!(statuses[0].state, "running");
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
        });
        crate::v1_case!("macro-67ee29e0f60e", {
            let error = runtime
                .acquire_mutation(vec!["m2".to_owned(), "m1".to_owned()], false)
                .unwrap_err();
            assert_eq!(error.code(), "MACRO_MUTATION_BUSY");
        });
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        while phases.last().map(String::as_str) != Some("release") {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        if let BrowserAction::Key { phase, .. } = &action.action {
                            phases.push(phase.clone());
                        }
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        stop.join().unwrap();
        assert_eq!(phases, ["focus", "hold", "release"]);
        assert!(runtime.statuses().unwrap().is_empty());
        crate::v1_case!("macro-runtime-8dff14f03246", {
            assert_eq!(phases.last().map(String::as_str), Some("release"));
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn cancellation_releases_a_hold_that_is_acknowledged_after_stop_begins() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "late-hold".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
            }]),
        );
        let hold = next_browser_actions(&receiver);
        let owner_id = match &hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected pending hold, got {action:?}"),
        };
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        assert_no_browser_actions(&receiver, Duration::from_millis(25));
        assert!(!stop.is_finished());

        runtime.dispatch_results(success_results(hold)).unwrap();
        let release = next_browser_actions(&receiver);
        crate::v1_case!("macro-runtime-10c50f77180d", {
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref phase,
                    owner_id: ref release_owner,
                    ..
                } if phase == "release" && release_owner == &owner_id
            ));
            assert!(!stop.is_finished());
        });
        runtime.dispatch_results(success_results(release)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn held_key_owners_release_in_reverse_step_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![
                MacroStepDefinition::Key {
                    id: "first".to_owned(),
                    code: "KeyA".to_owned(),
                    modifiers: Some(vec!["primary".to_owned()]),
                    action: Some("hold_until_stop".to_owned()),
                    label: None,
                },
                MacroStepDefinition::Key {
                    id: "second".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: Some(vec!["primary".to_owned()]),
                    action: Some("hold_until_stop".to_owned()),
                    label: None,
                },
            ]),
        );
        for expected_code in ["KeyA", "KeyB"] {
            let hold = next_browser_actions(&receiver);
            assert!(matches!(
                hold[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected_code) && phase == "hold"
            ));
            runtime.dispatch_results(success_results(hold)).unwrap();
        }

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        let mut released_codes = Vec::new();
        for expected_code in ["KeyB", "KeyA"] {
            let release = next_browser_actions(&receiver);
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected_code) && phase == "release"
            ));
            released_codes.push(expected_code);
            runtime.dispatch_results(success_results(release)).unwrap();
        }
        stop.join().unwrap();
        crate::v1_case!("macro-03c6ea334e84", {
            assert_eq!(released_codes, ["KeyB", "KeyA"]);
        });
    }

    #[test]
    fn v1_uses_distinct_owners_for_two_macros_holding_the_same_role_key() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "m1-hold".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }]);
        let mut second_macro = first.macros[0].clone();
        second_macro.id = "m2".to_owned();
        second_macro.name = "Second".to_owned();
        second_macro.steps = vec![MacroStepDefinition::Key {
            id: "m2-hold".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }];
        first.macros.push(second_macro);
        let second = MacroStartRequest {
            macro_id: "m2".to_owned(),
            ..first.clone()
        };

        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let first_hold = next_browser_actions(&receiver);
        let first_owner = match &first_hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected first held key, got {action:?}"),
        };
        runtime
            .dispatch_results(success_results(first_hold))
            .unwrap();

        let _ = start_and_ack_focus(&runtime, &receiver, second);
        let second_hold = next_browser_actions(&receiver);
        let second_owner = match &second_hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected second held key, got {action:?}"),
        };
        runtime
            .dispatch_results(success_results(second_hold))
            .unwrap();

        crate::v1_case!("macro-dda7b6b3249d", {
            assert_ne!(first_owner, second_owner);
            assert!(first_owner.contains(":r1:m1:m1-hold"));
            assert!(second_owner.contains(":r1:m2:m2-hold"));
        });

        let stopping_first = runtime.clone();
        let first_stop = thread::spawn(move || stopping_first.stop_macro("m1").unwrap());
        let first_release = next_browser_actions(&receiver);
        assert!(matches!(
            first_release[0].action,
            BrowserAction::Key {
                ref owner_id,
                ref phase,
                ..
            } if phase == "release" && owner_id == &first_owner
        ));
        runtime
            .dispatch_results(success_results(first_release))
            .unwrap();
        first_stop.join().unwrap();
        assert_eq!(runtime.statuses().unwrap()[0].macro_id, "m2");

        let stopping_second = runtime.clone();
        let second_stop = thread::spawn(move || stopping_second.stop_macro("m2").unwrap());
        let second_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_release))
            .unwrap();
        second_stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn synchronous_looping_child_runs_once_before_the_parent_continues() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Loop { interval_ms: 0 },
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let control = runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .invocations
            .values()
            .find(|control| control.macro_ids.lock().is_ok_and(|ids| ids.contains("m1")))
            .cloned()
            .unwrap();

        let mut actions = Vec::new();
        while actions.len() < 5 {
            let batch = next_browser_actions(&receiver);
            actions.extend(batch.iter().map(|request| {
                (
                    request.role_id.clone(),
                    match &request.action {
                        BrowserAction::Focus => "focus".to_owned(),
                        BrowserAction::Key { code, phase, .. } => {
                            format!("{}:{phase}", code.as_deref().unwrap_or_default())
                        }
                        _ => "other".to_owned(),
                    },
                )
            }));
            runtime.dispatch_results(success_results(batch)).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !control.barriers.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert!(control.barriers.lock().unwrap().is_empty());
        crate::v1_case!("macro-a51f31bc94a0", {
            assert_eq!(
                actions,
                [
                    ("r2".to_owned(), "focus".to_owned()),
                    ("r2".to_owned(), "KeyB:hold".to_owned()),
                    ("r2".to_owned(), "KeyB:release".to_owned()),
                    ("r1".to_owned(), "KeyC:hold".to_owned()),
                    ("r1".to_owned(), "KeyC:release".to_owned()),
                ]
            );
        });
        crate::v1_case!("macro-04f2c3221ed9", {
            assert_eq!(
                actions
                    .iter()
                    .filter(|(_, phase)| phase.starts_with("KeyB:"))
                    .count(),
                2
            );
        });
        crate::v1_case!("macro-ce3652f5d1c7", {
            let child_release = actions
                .iter()
                .position(|(_, phase)| phase == "KeyB:release")
                .unwrap();
            let parent_after = actions
                .iter()
                .position(|(_, phase)| phase == "KeyC:hold")
                .unwrap();
            assert!(child_release < parent_after);
        });
    }

    #[test]
    fn atomic_toggle_converges_without_a_phantom_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let toggle_request = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);
        let stop_request = toggle_request.clone();
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.toggle(toggle_request));
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        assert_eq!(starting.join().unwrap().unwrap().len(), 1);

        assert!(runtime.toggle(stop_request).unwrap().is_empty());
        assert!(runtime.statuses().unwrap().is_empty());
        assert!(runtime.shared.inner.lock().unwrap().invocations.is_empty());
    }

    #[test]
    fn presentation_updates_are_rate_limited_but_terminal_delivery_is_immediate() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime.seed_running_status("m1", "r1").unwrap();

        for _ in 0..1_000 {
            emit_presentation_statuses(&runtime.shared);
        }
        emit_statuses(&runtime.shared, true);

        let batches = receiver.try_iter().collect::<Vec<_>>();
        assert_eq!(batches.len(), 2);
        assert!(batches[0].iter().any(|event| matches!(
            event,
            CoreEvent::MacroStatuses {
                reliable: false,
                ..
            }
        )));
        assert!(
            batches[1]
                .iter()
                .any(|event| matches!(event, CoreEvent::MacroStatuses { reliable: true, .. }))
        );
    }

    #[test]
    fn role_lock_registries_stay_bounded_across_five_hundred_role_lifecycles() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        for index in 0..500 {
            let role_id = format!("role-{index}");
            drop(input_sequence_role_lock(&runtime.shared, &role_id).unwrap());
            drop(action_role_locks(&runtime.shared, &[role_id]).unwrap());
        }
        drop(input_sequence_role_lock(&runtime.shared, "role-final").unwrap());
        drop(action_role_locks(&runtime.shared, &["role-final".to_owned()]).unwrap());

        assert!(
            runtime
                .shared
                .input_sequence_role_locks
                .lock()
                .unwrap()
                .len()
                <= 1
        );
        assert!(runtime.shared.action_role_locks.lock().unwrap().len() <= 1);
    }

    #[test]
    fn one_thousand_start_stop_cycles_drain_authoritative_runtime_state() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let start = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);

        for _ in 0..1_000 {
            let _ = start_and_ack_focus(&runtime, &receiver, start.clone());
            runtime.stop_macro("m1").unwrap();
        }

        let inner = runtime.shared.inner.lock().unwrap();
        assert!(inner.invocations.is_empty());
        assert!(inner.statuses.is_empty());
        assert!(inner.held_keys.is_empty());
        assert!(inner.leases.is_empty());
        drop(inner);
        assert!(runtime.shared.pending.lock().unwrap().is_empty());
        assert!(runtime.shared.action_role_locks.lock().unwrap().len() <= 1);
    }

    #[test]
    fn v1_propagates_disabled_and_unavailable_synchronous_child_start_errors() {
        for (child_enabled, child_active, expected_error, case_id) in [
            (false, true, DISABLED_MACRO_MESSAGE, "macro-1b1528b03ec8"),
            (true, false, UNAVAILABLE_ROLE_MESSAGE, "macro-242ee2cae449"),
        ] {
            let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
            let runtime = MacroRuntime::new(Arc::new(move |batch| {
                let _ = events.send(batch);
            }));
            let mut start = request(vec![MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            }]);
            start.macros.push(MacroDefinition {
                id: "child".to_owned(),
                enabled: child_enabled,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![],
            });
            if child_active {
                start.active_role_ids.push("r2".to_owned());
            }
            let _ = start_and_ack_focus(&runtime, &receiver, start);
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let failed = loop {
                if let Some(status) = runtime
                    .statuses()
                    .unwrap()
                    .into_iter()
                    .find(|status| status.macro_id == "m1" && status.state == "failed")
                {
                    break status;
                }
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            };
            match case_id {
                "macro-1b1528b03ec8" => {
                    crate::v1_case!("macro-1b1528b03ec8", {
                        assert_eq!(failed.error.as_deref(), Some(expected_error));
                    });
                }
                "macro-242ee2cae449" => {
                    crate::v1_case!("macro-242ee2cae449", {
                        assert_eq!(failed.error.as_deref(), Some(expected_error));
                    });
                }
                _ => unreachable!(),
            }
            runtime.stop_macro("m1").unwrap();
        }
    }

    #[test]
    fn v1_fails_a_parent_when_its_synchronous_child_is_already_active() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = MacroDefinition {
            id: "parent".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Parent".to_owned(),
            role_ids: vec!["r1".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            }],
        };
        let child = MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "wait".to_owned(),
                ms: 60_000,
            }],
        };
        let definitions = vec![parent, child];
        let base = MacroStartRequest {
            macros: definitions.clone(),
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 0,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "child".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned(), "r2".to_owned()],
        };
        let _ = start_and_ack_focus(&runtime, &receiver, base.clone());
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            MacroStartRequest {
                macro_id: "parent".to_owned(),
                ..base
            },
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let parent_status = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.macro_id == "parent" && status.state == "failed")
            {
                break status;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        };
        crate::v1_case!("macro-dade3184393d", {
            assert_eq!(
                parent_status.error.as_deref(),
                Some("Called macro \"Child\" is already running.")
            );
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| { status.macro_id == "child" && status.state == "running" })
            );
        });
        runtime.stop_macro("child").unwrap();
        runtime.stop_macro("parent").unwrap();
    }

    #[test]
    fn multi_role_sync_barrier_creates_one_child_before_all_parents_continue() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r3".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let child_focus = next_browser_actions(&receiver);
        crate::v1_case!("macro-eb326b83fb4c", {
            assert_eq!(child_focus.len(), 1);
            assert_eq!(child_focus[0].role_id, "r3");
        });
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        for expected_phase in ["hold", "release"] {
            let child_action = next_browser_actions(&receiver);
            assert_eq!(child_action.len(), 1);
            assert_eq!(child_action[0].role_id, "r3");
            assert!(matches!(
                child_action[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == expected_phase
            ));
            runtime
                .dispatch_results(success_results(child_action))
                .unwrap();
        }

        let parent_holds = next_browser_action_count(&receiver, 2);
        let mut parent_roles = parent_holds
            .iter()
            .map(|action| action.role_id.as_str())
            .collect::<Vec<_>>();
        parent_roles.sort_unstable();
        crate::v1_case!("macro-38b2cd5ed223", {
            assert_eq!(parent_roles, ["r1", "r2"]);
        });
        runtime
            .dispatch_results(success_results(parent_holds))
            .unwrap();
        let parent_releases = next_browser_action_count(&receiver, 2);
        runtime
            .dispatch_results(success_results(parent_releases))
            .unwrap();
    }

    #[test]
    fn v1_supports_nested_synchronous_macro_calls_in_child_first_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let macro_c = MacroDefinition {
            id: "c".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "C".to_owned(),
            role_ids: vec!["r3".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "key-c".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        };
        let macro_b = MacroDefinition {
            id: "b".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "B".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![
                MacroStepDefinition::Macro {
                    id: "call-c".to_owned(),
                    macro_id: "c".to_owned(),
                    call_mode: Some("wait".to_owned()),
                },
                MacroStepDefinition::Key {
                    id: "key-b".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                },
            ],
        };
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-b".to_owned(),
                macro_id: "b".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "key-a".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros[0].id = "a".to_owned();
        start.macros[0].name = "A".to_owned();
        start.macro_id = "a".to_owned();
        start.macros.extend([macro_b, macro_c]);
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut held_codes = Vec::new();
        while held_codes.len() < 3 {
            let actions = next_browser_actions(&receiver);
            for action in &actions {
                if let BrowserAction::Key { code, phase, .. } = &action.action
                    && phase == "hold"
                {
                    held_codes.push(code.clone().unwrap());
                }
            }
            runtime.dispatch_results(success_results(actions)).unwrap();
        }
        crate::v1_case!("macro-f82be3dab72b", {
            assert_eq!(held_codes, ["KeyC", "KeyB", "KeyA"]);
        });
        let final_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(final_release))
            .unwrap();
    }

    #[test]
    fn v1_propagates_a_synchronous_child_action_failure_to_parent_and_child() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "call-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "fail".to_owned(),
                code: "KeyF".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let child_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: child_hold[0].request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("child target detached".to_owned()),
            }])
            .unwrap();
        let release = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(release)).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let statuses = loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.iter().any(|status| {
                status.macro_id == "m1"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child target detached")
            }) && statuses.iter().any(|status| {
                status.macro_id == "child"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child target detached")
            }) {
                break statuses;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child failure statuses did not settle: {statuses:?}"
            );
            thread::yield_now();
        };
        crate::v1_case!("macro-d2ba69fd3f80", {
            let mut failed = statuses
                .iter()
                .filter(|status| status.state == "failed")
                .map(|status| (status.macro_id.as_str(), status.error.as_deref()))
                .collect::<Vec<_>>();
            failed.sort_unstable();
            assert_eq!(
                failed,
                [
                    ("child", Some("child target detached")),
                    ("m1", Some("child target detached")),
                ]
            );
        });
        runtime.stop_macro("m1").unwrap();
        runtime.stop_macro("child").unwrap();
    }

    #[test]
    fn v1_parent_stop_keeps_an_unrelated_invocation_running() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = MacroDefinition {
            id: "parent".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Parent".to_owned(),
            role_ids: vec!["r1".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            }],
        };
        let child = MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "child-wait".to_owned(),
                ms: 60_000,
            }],
        };
        let unrelated = MacroDefinition {
            id: "unrelated".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Unrelated".to_owned(),
            role_ids: vec!["r3".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "unrelated-wait".to_owned(),
                ms: 60_000,
            }],
        };
        let base = MacroStartRequest {
            macros: vec![parent, child, unrelated],
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 0,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "unrelated".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned(), "r2".to_owned(), "r3".to_owned()],
        };
        let _ = start_and_ack_focus(&runtime, &receiver, base.clone());
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            MacroStartRequest {
                macro_id: "parent".to_owned(),
                ..base
            },
        );
        let child_focus = next_browser_actions(&receiver);
        assert_eq!(child_focus[0].role_id, "r2");
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        runtime.stop_macro("parent").unwrap();
        crate::v1_case!("macro-001e95906647", {
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .map(|status| (status.macro_id.as_str(), status.state.as_str()))
                    .collect::<Vec<_>>(),
                [("unrelated", "running")]
            );
        });
        runtime.stop_macro("unrelated").unwrap();
    }

    #[test]
    fn v1_calls_a_run_once_child_on_every_parent_loop_iteration() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "call-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1 };
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let mut child_holds = 0;
        for iteration in 0..2 {
            for expected in ["focus", "hold", "release"] {
                let action = next_browser_actions(&receiver);
                assert!(match (&action[0].action, expected) {
                    (BrowserAction::Focus, "focus") => true,
                    (BrowserAction::Key { phase, .. }, phase_expected) => {
                        phase == phase_expected
                    }
                    _ => false,
                });
                if expected == "hold" {
                    child_holds += 1;
                }
                runtime.dispatch_results(success_results(action)).unwrap();
            }
            let loop_wait = next_wait(&waits);
            assert_eq!(loop_wait.duration_ms, 1);
            if iteration == 0 {
                loop_wait.release.send(()).unwrap();
            } else {
                crate::v1_case!("macro-0fa4ce544d0c", {
                    assert_eq!(child_holds, 2);
                });
                runtime.stop_macro("m1").unwrap();
                drop(loop_wait);
            }
        }
    }

    #[test]
    fn triggered_child_keeps_its_configured_loop_after_parent_completion() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "wait-before-duplicate".to_owned(),
                ms: 20,
            },
            MacroStepDefinition::Macro {
                id: "duplicate-trigger".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Loop { interval_ms: 1_000 },
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        for _ in 0..3 {
            let batch = next_browser_actions(&receiver);
            runtime.dispatch_results(success_results(batch)).unwrap();
        }
        crate::v1_case!("macro-8c8fc482c2e2", {
            let wait_started = std::time::Instant::now();
            loop {
                let statuses = runtime.statuses().unwrap();
                if statuses.iter().any(|status| status.macro_id == "child")
                    && statuses.iter().all(|status| status.macro_id != "m1")
                {
                    break;
                }
                assert!(wait_started.elapsed() < Duration::from_secs(2));
                thread::yield_now();
            }
        });
        crate::v1_case!("macro-ec61e5be8676", {
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| status.macro_id == "child" && status.state == "running")
            );
        });
        crate::v1_case!("macro-eec4f34f9c73", {
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .filter(|status| status.macro_id == "child")
                    .count(),
                1
            );
        });
        runtime.stop_macro("child").unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn stopping_parent_recursively_stops_triggered_held_child() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "wait".to_owned(),
                ms: 1_000,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "held".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let child_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_hold))
            .unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        let release = next_browser_actions(&receiver);
        crate::v1_case!("macro-2560b69ef571", {
            assert_eq!(release.len(), 1);
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == "release"
            ));
        });
        crate::v1_case!("macro-76ed0b007727", {
            assert_eq!(release[0].role_id, "r2");
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyW") && phase == "release"
            ));
        });
        runtime.dispatch_results(success_results(release)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn v1_stops_a_triggered_child_when_the_parent_role_closes() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(&runtime, &receiver, triggered_delay_request());
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child" && status.state == "running")
        {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime.stop_role("r1").unwrap();
        crate::v1_case!("macro-a0b20c487fd2", {
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn v1_parent_stop_waits_for_a_pending_triggered_child_focus_result() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(&runtime, &receiver, triggered_delay_request());
        let child_focus = next_browser_actions(&receiver);

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        thread::sleep(Duration::from_millis(25));
        crate::v1_case!("macro-ae0a2bf9063f", {
            assert!(!stop.is_finished());
        });
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn v1_keeps_the_parent_running_when_a_triggered_child_fails() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = triggered_delay_request();
        start.macros[1].steps = vec![MacroStepDefinition::Key {
            id: "fail".to_owned(),
            code: "KeyF".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }];
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let parent_wait = next_wait(&waits);
        assert_eq!(parent_wait.role_id, "r1");
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let child_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: child_hold[0].request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("CHILD_FAILED".to_owned()),
                error_message: Some("child failed".to_owned()),
            }])
            .unwrap();
        let release = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(release)).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.iter().any(|status| {
                status.macro_id == "child"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child failed")
            }) {
                crate::v1_case!("macro-adc24e3c31d8", {
                    assert!(
                        statuses
                            .iter()
                            .any(|status| { status.macro_id == "m1" && status.state == "running" })
                    );
                });
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime.stop_macro("m1").unwrap();
        drop(parent_wait);
        assert!(runtime.statuses().unwrap().iter().any(|status| {
            status.macro_id == "child"
                && status.state == "failed"
                && status.error.as_deref() == Some("child failed")
        }));
        runtime.stop_macro("child").unwrap();
    }

    #[test]
    fn v1_stops_an_active_triggered_child_when_the_parent_fails() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "parent-fail".to_owned(),
                code: "KeyF".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Held child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "held".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut parent_hold = None;
        let mut child_held = false;
        while parent_hold.is_none() || !child_held {
            let actions = next_browser_actions(&receiver);
            for action in actions {
                match (&action.role_id[..], &action.action) {
                    ("r1", BrowserAction::Key { phase, .. }) if phase == "hold" => {
                        parent_hold = Some(action);
                    }
                    ("r2", BrowserAction::Key { phase, .. }) if phase == "hold" => {
                        child_held = true;
                        runtime
                            .dispatch_results(success_results(vec![action]))
                            .unwrap();
                    }
                    ("r2", BrowserAction::Focus) => {
                        runtime
                            .dispatch_results(success_results(vec![action]))
                            .unwrap();
                    }
                    (_, action) => panic!("unexpected pre-failure action: {action:?}"),
                }
            }
        }
        let parent_hold = parent_hold.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child" && status.iteration.unwrap_or_default() > 0)
        {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: parent_hold.request_id,
                ok: false,
                value_json: None,
                error_code: Some("PARENT_FAILED".to_owned()),
                error_message: Some("parent failed".to_owned()),
            }])
            .unwrap();
        let parent_release = next_browser_actions(&receiver);
        assert_eq!(parent_release[0].role_id, "r1");
        runtime
            .dispatch_results(success_results(parent_release))
            .unwrap();
        let child_release = loop {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(events) => {
                    if let Some(actions) = events.into_iter().find_map(|event| match event {
                        CoreEvent::BrowserActions { actions } => Some(actions),
                        _ => None,
                    }) {
                        break actions;
                    }
                }
                Err(error) => panic!(
                    "missing child release after parent failure ({error:?}): {:?}",
                    runtime.statuses().unwrap()
                ),
            }
        };
        assert_eq!(child_release[0].role_id, "r2");
        runtime
            .dispatch_results(success_results(child_release))
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.len() == 1 && statuses[0].macro_id == "m1" && statuses[0].state == "failed"
            {
                crate::v1_case!("macro-abdc8a9f5ddf", {
                    assert_eq!(statuses[0].error.as_deref(), Some("parent failed"));
                    assert!(statuses.iter().all(|status| status.macro_id != "child"));
                });
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "triggered child did not stop with failed parent: {statuses:?}"
            );
            thread::yield_now();
        }
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn v1_continues_the_parent_when_a_triggered_child_cannot_start() {
        for (child_enabled, child_active, case_id) in [
            (false, true, "macro-4f6ff4a65685"),
            (true, false, "macro-16bfa0b6fc25"),
        ] {
            let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
            let runtime = MacroRuntime::new(Arc::new(move |batch| {
                let _ = events.send(batch);
            }));
            let mut start = request(vec![
                MacroStepDefinition::Macro {
                    id: "trigger-child".to_owned(),
                    macro_id: "child".to_owned(),
                    call_mode: Some("trigger".to_owned()),
                },
                MacroStepDefinition::Key {
                    id: "after".to_owned(),
                    code: "KeyC".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                },
            ]);
            start.macros.push(MacroDefinition {
                id: "child".to_owned(),
                enabled: child_enabled,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![],
            });
            if child_active {
                start.active_role_ids.push("r2".to_owned());
            }
            let _ = start_and_ack_focus(&runtime, &receiver, start);
            let parent_hold = next_browser_actions(&receiver);
            assert!(matches!(
                parent_hold[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyC") && phase == "hold"
            ));
            runtime
                .dispatch_results(success_results(parent_hold))
                .unwrap();
            let parent_release = next_browser_actions(&receiver);
            runtime
                .dispatch_results(success_results(parent_release))
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while runtime
                .statuses()
                .unwrap()
                .iter()
                .any(|status| status.macro_id == "m1")
            {
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
            match case_id {
                "macro-4f6ff4a65685" => {
                    crate::v1_case!("macro-4f6ff4a65685", {
                        assert!(runtime.statuses().unwrap().is_empty());
                    });
                }
                "macro-16bfa0b6fc25" => {
                    crate::v1_case!("macro-16bfa0b6fc25", {
                        assert!(runtime.statuses().unwrap().is_empty());
                    });
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn manually_stopped_synchronous_child_cancels_parent_before_next_step() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "wait".to_owned(),
                ms: 1_000,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let wait_started = std::time::Instant::now();
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child")
        {
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        }
        runtime.stop_macro("child").unwrap();
        let wait_started = std::time::Instant::now();
        let parent = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.macro_id == "m1")
                && status.state == "cancelled"
            {
                break status;
            }
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        };
        crate::v1_case!("macro-1d428d305b23", {
            assert_eq!(
                parent.error.as_deref(),
                Some("Cancelled because a called macro was stopped.")
            );
            while let Ok(events) = receiver.try_recv() {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "parent dispatched its next step"
                );
            }
        });
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn partial_role_failure_preserves_the_failed_role_and_cancels_siblings() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        let failed = holds.iter().find(|action| action.role_id == "r1").unwrap();
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: failed.request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("target detached".to_owned()),
            }])
            .unwrap();
        runtime
            .dispatch_results(success_results(
                holds
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        assert!(releases.iter().all(|action| matches!(
            action.action,
            BrowserAction::Key {
                ref phase,
                ..
            } if phase == "release"
        )));
        runtime.dispatch_results(success_results(releases)).unwrap();
        let wait_started = std::time::Instant::now();
        let statuses = loop {
            let statuses = runtime.statuses().unwrap();
            if statuses
                .iter()
                .all(|status| matches!(status.state.as_str(), "failed" | "cancelled"))
            {
                break statuses;
            }
            assert!(
                wait_started.elapsed() < Duration::from_secs(2),
                "statuses did not settle: {statuses:?}"
            );
            thread::yield_now();
        };
        crate::v1_case!("macro-86fe57b6249c", {
            assert_eq!(
                statuses
                    .iter()
                    .map(|status| (
                        status.role_id.as_str(),
                        status.state.as_str(),
                        status.error.as_deref(),
                    ))
                    .collect::<Vec<_>>(),
                [
                    ("r1", "failed", Some("target detached")),
                    ("r2", "cancelled", Some(SIBLING_FAILURE_MESSAGE)),
                ]
            );
        });
    }

    #[test]
    fn failed_focus_batch_waits_for_every_role_acknowledgement() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(Vec::new());
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start));
        let focus = next_browser_actions(&receiver);
        let failed = focus.iter().find(|action| action.role_id == "r1").unwrap();
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: failed.request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("target detached".to_owned()),
            }])
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        assert!(!starting.is_finished());
        runtime
            .dispatch_results(success_results(
                focus
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        let error = starting.join().unwrap().unwrap_err();
        assert_eq!(error.code(), "MACRO_INPUT_FAILED");
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn focus_preflight_finishes_before_running_status_is_published() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request(Vec::new())).unwrap());
        let focus = next_browser_actions(&receiver);
        let status_was_hidden_during_preflight = runtime.statuses().unwrap().is_empty();
        let focused_role_ids = focus
            .iter()
            .filter(|request| matches!(request.action, BrowserAction::Focus))
            .map(|request| request.role_id.clone())
            .collect::<Vec<_>>();
        runtime.dispatch_results(success_results(focus)).unwrap();
        let statuses = start.join().unwrap();
        assert_eq!(statuses.len(), 1);
        crate::v1_case!("macro-61139813b60e", {
            assert_eq!(focused_role_ids, ["r1".to_owned()]);
            assert!(status_was_hidden_during_preflight);
        });
    }

    #[test]
    fn stop_role_cancels_an_invocation_during_focus_preflight() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start_request = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start_request.source_role_id = Some("r1".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start_request));
        let late_focus = next_browser_actions(&receiver);

        let stopped_at = Instant::now();
        runtime.stop_role("r1").unwrap();
        assert!(stopped_at.elapsed() < Duration::from_secs(1));
        let error = starting.join().unwrap().unwrap_err();
        assert_eq!(error.code(), "MACRO_INPUT_FAILED");
        assert!(runtime.statuses().unwrap().is_empty());

        runtime
            .dispatch_results(success_results(late_focus))
            .unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < deadline {
            if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "a late focus acknowledgement started macro input after stop_role"
                );
            }
        }
    }

    #[test]
    fn triggered_child_spawn_failure_releases_the_pending_start_guard() {
        let control = new_invocation_control(
            "parent".to_owned(),
            "macro-parent".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );
        control.children.0.lock().unwrap().pending_starts = 1;

        finish_pending_child_start_after_spawn(&control, &Err::<(), _>("spawn denied"));

        assert_eq!(control.children.0.lock().unwrap().pending_starts, 0);
    }

    #[test]
    fn v1_rechecks_focus_once_for_each_separate_macro_start() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut focus_count = 0;
        for _ in 0..2 {
            let (_, focus) = start_and_ack_focus(
                &runtime,
                &receiver,
                request(vec![MacroStepDefinition::Key {
                    id: "key".to_owned(),
                    code: "KeyA".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                }]),
            );
            focus_count += focus
                .iter()
                .filter(|action| matches!(action.action, BrowserAction::Focus))
                .count();
            for expected_phase in ["hold", "release"] {
                let action = next_browser_actions(&receiver);
                assert!(matches!(
                    action[0].action,
                    BrowserAction::Key {
                        ref phase,
                        ..
                    } if phase == expected_phase
                ));
                runtime.dispatch_results(success_results(action)).unwrap();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !runtime.statuses().unwrap().is_empty() {
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
        }
        crate::v1_case!("macro-832559ff652f", {
            assert_eq!(focus_count, 2);
        });
    }

    #[test]
    fn quick_multi_role_release_waits_for_every_first_iteration_action() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime
                .press(MacroPressRequest {
                    start,
                    press_id: "press-1".to_owned(),
                })
                .unwrap()
        });
        let focus = next_browser_actions(&receiver);
        assert_eq!(focus.len(), 2);
        runtime.dispatch_results(success_results(focus)).unwrap();
        crate::v1_case!("macro-cfe1e21720c6", {
            assert_eq!(press.join().unwrap().len(), 2);
        });

        let holds = next_browser_action_count(&receiver, 2);
        assert_eq!(holds.len(), 2);
        let releasing_runtime = runtime.clone();
        let release = thread::spawn(move || {
            releasing_runtime
                .release(MacroReleaseRequest {
                    macro_id: "m1".to_owned(),
                    source_role_id: "r1".to_owned(),
                    press_id: "press-1".to_owned(),
                    mode: "complete_first_iteration".to_owned(),
                })
                .unwrap();
        });
        let release_deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let control = runtime
                .shared
                .inner
                .lock()
                .unwrap()
                .invocations
                .values()
                .next()
                .cloned()
                .unwrap();
            if control.stop_after_first_iteration.load(Ordering::Acquire) {
                break;
            }
            assert!(
                std::time::Instant::now() < release_deadline,
                "release request did not reach the first-iteration barrier"
            );
            thread::yield_now();
        }
        assert!(!release.is_finished());
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        crate::v1_case!("macro-0ac489bf140b", {
            assert_eq!(releases.len(), 2);
        });
        crate::v1_case!("macro-badb57de73cf", {
            assert_eq!(
                releases
                    .iter()
                    .filter(|action| matches!(
                        action.action,
                        BrowserAction::Key {
                            ref phase,
                            ..
                        } if phase == "release"
                    ))
                    .count(),
                2
            );
        });
        runtime.dispatch_results(success_results(releases)).unwrap();
        release.join().unwrap();
        stop.join().unwrap();
        crate::v1_case!("macro-77cf800f4fc9", {
            assert!(runtime.statuses().unwrap().is_empty());
        });
        crate::v1_case!("macro-f49ff2bd81d6", {
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn v1_immediate_release_interrupts_first_or_later_while_held_iterations() {
        for (completed_iterations, press_id, case_id) in [
            (0, "first-iteration", "macro-8b4e22c0e423"),
            (1, "later-iteration", "macro-cefbad4638d2"),
        ] {
            let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
            let runtime = MacroRuntime::new(Arc::new(move |batch| {
                let _ = events.send(batch);
            }));
            let mut start = request(vec![MacroStepDefinition::Key {
                id: "key".to_owned(),
                code: "Digit1".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }]);
            start.macros[0].activation_mode = Some("while_held".to_owned());
            start.macros[0].trigger = Some(crate::model::MacroTrigger {
                code: "KeyQ".to_owned(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            });
            start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
            start.source_role_id = Some("r1".to_owned());
            let pressing_runtime = runtime.clone();
            let press_id_for_start = press_id.to_owned();
            let press = thread::spawn(move || {
                pressing_runtime
                    .press(MacroPressRequest {
                        start,
                        press_id: press_id_for_start,
                    })
                    .unwrap()
            });
            let focus = next_browser_actions(&receiver);
            runtime.dispatch_results(success_results(focus)).unwrap();
            press.join().unwrap();

            for _ in 0..completed_iterations {
                let hold = next_browser_actions(&receiver);
                runtime.dispatch_results(success_results(hold)).unwrap();
                let release = next_browser_actions(&receiver);
                runtime.dispatch_results(success_results(release)).unwrap();
            }
            let in_flight_hold = next_browser_actions(&receiver);
            let releasing_runtime = runtime.clone();
            let press_id_for_release = press_id.to_owned();
            let release = thread::spawn(move || {
                releasing_runtime
                    .release(MacroReleaseRequest {
                        macro_id: "m1".to_owned(),
                        source_role_id: "r1".to_owned(),
                        press_id: press_id_for_release,
                        mode: "immediate".to_owned(),
                    })
                    .unwrap();
            });
            thread::sleep(Duration::from_millis(25));
            assert!(!release.is_finished());
            runtime
                .dispatch_results(success_results(in_flight_hold))
                .unwrap();
            let compensating_release = next_browser_actions(&receiver);
            runtime
                .dispatch_results(success_results(compensating_release))
                .unwrap();
            release.join().unwrap();
            match case_id {
                "macro-8b4e22c0e423" => {
                    crate::v1_case!("macro-8b4e22c0e423", {
                        assert!(runtime.statuses().unwrap().is_empty());
                    });
                }
                "macro-cefbad4638d2" => {
                    crate::v1_case!("macro-cefbad4638d2", {
                        assert!(runtime.statuses().unwrap().is_empty());
                        while let Ok(events) = receiver.try_recv() {
                            assert!(events.iter().all(|event| {
                                !matches!(event, CoreEvent::BrowserActions { .. })
                            }));
                        }
                    });
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn v1_zero_delay_loop_yields_without_blocking_the_runtime_caller() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Delay {
            id: "zero".to_owned(),
            ms: 0,
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let caller_progressed = Arc::new(AtomicBool::new(false));
        let caller_progressed_output = Arc::clone(&caller_progressed);
        let caller = thread::spawn(move || {
            thread::yield_now();
            caller_progressed_output.store(true, Ordering::Release);
        });
        caller.join().unwrap();
        crate::v1_case!("macro-3c32b7b3055b", {
            assert!(caller_progressed.load(Ordering::Acquire));
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| status.state == "running")
            );
        });
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn held_invocation_ignores_mismatched_source_and_press_ids() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "press-correct".to_owned(),
            })
        });
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        press.join().unwrap().unwrap();
        let hold = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(hold)).unwrap();

        crate::v1_case!("macro-e72e89468ae9", {
            for (source_role_id, press_id) in [("r1", "press-other"), ("r2", "press-correct")] {
                runtime
                    .release(MacroReleaseRequest {
                        macro_id: "m1".to_owned(),
                        source_role_id: source_role_id.to_owned(),
                        press_id: press_id.to_owned(),
                        mode: "immediate".to_owned(),
                    })
                    .unwrap();
                assert_eq!(runtime.statuses().unwrap().len(), 1);
                let deadline = std::time::Instant::now() + Duration::from_millis(25);
                while std::time::Instant::now() < deadline {
                    if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                        assert!(
                            events
                                .iter()
                                .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                            "a mismatched release stopped the held invocation"
                        );
                    }
                }
            }
        });

        let releasing_runtime = runtime.clone();
        let release = thread::spawn(move || {
            releasing_runtime
                .release(MacroReleaseRequest {
                    macro_id: "m1".to_owned(),
                    source_role_id: "r1".to_owned(),
                    press_id: "press-correct".to_owned(),
                    mode: "immediate".to_owned(),
                })
                .unwrap();
        });
        let key_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(key_release))
            .unwrap();
        release.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn immediate_release_during_focus_preflight_never_dispatches_the_first_key() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "press-before-focus".to_owned(),
            })
        });

        let focus = next_browser_actions(&receiver);
        runtime
            .release(MacroReleaseRequest {
                macro_id: "m1".to_owned(),
                source_role_id: "r1".to_owned(),
                press_id: "press-before-focus".to_owned(),
                mode: "immediate".to_owned(),
            })
            .unwrap();
        runtime.dispatch_results(success_results(focus)).unwrap();

        crate::v1_case!("macro-ec0ed215114c", {
            assert!(press.join().unwrap().unwrap().is_empty());
            let deadline = std::time::Instant::now() + Duration::from_millis(100);
            while std::time::Instant::now() < deadline {
                if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                    assert!(
                        events
                            .iter()
                            .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                        "an input action escaped after the immediate release"
                    );
                }
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn complete_first_release_arriving_before_press_runs_exactly_one_iteration() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime
            .release(MacroReleaseRequest {
                macro_id: "m1".to_owned(),
                source_role_id: "r1".to_owned(),
                press_id: "release-first".to_owned(),
                mode: "complete_first_iteration".to_owned(),
            })
            .unwrap();
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "release-first".to_owned(),
            })
        });
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        assert_eq!(press.join().unwrap().unwrap().len(), 1);
        let mut phases = Vec::new();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == expected_phase
            ));
            phases.push(expected_phase);
            runtime.dispatch_results(success_results(action)).unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        crate::v1_case!("macro-e00157ddebea", {
            assert_eq!(phases, ["hold", "release"]);
            while let Ok(events) = receiver.try_recv() {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "the early release allowed a second iteration"
                );
            }
        });
    }

    fn drive_timed_tap(
        runtime: &MacroRuntime,
        events: &mpsc::Receiver<Vec<CoreEvent>>,
        waits: &mpsc::Receiver<ManualWait>,
        request: MacroStartRequest,
    ) -> Vec<u32> {
        let _ = start_and_ack_focus(runtime, events, request);
        let mut durations = Vec::new();

        let startup = next_wait(waits);
        durations.push(startup.duration_ms);
        startup.release.send(()).unwrap();

        let hold = next_browser_actions(events);
        assert!(matches!(
            hold[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "hold"
        ));
        runtime.dispatch_results(success_results(hold)).unwrap();

        let key_hold = next_wait(waits);
        durations.push(key_hold.duration_ms);
        key_hold.release.send(()).unwrap();

        let release = next_browser_actions(events);
        assert!(matches!(
            release[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "release"
        ));
        runtime.dispatch_results(success_results(release)).unwrap();

        let post_input = next_wait(waits);
        durations.push(post_input.duration_ms);
        post_input.release.send(()).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        durations
    }

    fn success_results(actions: Vec<BrowserActionRequest>) -> Vec<BrowserActionResult> {
        actions
            .into_iter()
            .map(|action| BrowserActionResult {
                request_id: action.request_id,
                ok: true,
                value_json: None,
                error_code: None,
                error_message: None,
            })
            .collect()
    }

    fn start_and_ack_focus(
        runtime: &MacroRuntime,
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
        request: MacroStartRequest,
    ) -> (Vec<MacroRunStatus>, Vec<BrowserActionRequest>) {
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request).unwrap());
        let focus = next_browser_actions(receiver);
        runtime
            .dispatch_results(success_results(focus.clone()))
            .unwrap();
        (start.join().unwrap(), focus)
    }

    fn next_browser_actions(
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
    ) -> Vec<BrowserActionRequest> {
        loop {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    return actions;
                }
            }
        }
    }

    fn next_browser_action_count(
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
        count: usize,
    ) -> Vec<BrowserActionRequest> {
        let mut actions = Vec::new();
        while actions.len() < count {
            actions.extend(next_browser_actions(receiver));
        }
        assert_eq!(actions.len(), count);
        actions
    }

    fn assert_no_browser_actions(receiver: &mpsc::Receiver<Vec<CoreEvent>>, duration: Duration) {
        let started = std::time::Instant::now();
        while started.elapsed() < duration {
            let remaining = duration.saturating_sub(started.elapsed());
            let Ok(events) = receiver.recv_timeout(remaining) else {
                break;
            };
            assert!(
                events
                    .iter()
                    .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                "an input action escaped its per-role sequence"
            );
        }
    }

    fn wait_for_last_click(
        runtime: &MacroRuntime,
        role_id: &str,
        sequence: u32,
        step_id: &str,
    ) -> MacroLastClick {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(click) = runtime
                .statuses()
                .unwrap()
                .iter()
                .find(|status| status.role_id == role_id)
                .and_then(|status| status.last_click.as_ref())
                .filter(|click| click.sequence == sequence && click.step_id == step_id)
                .cloned()
            {
                return click;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }
}
