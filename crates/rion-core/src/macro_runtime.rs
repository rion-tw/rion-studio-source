use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
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
const MAX_ACTIVE_INVOCATIONS: usize = 64;
const MAX_PENDING_ACTIONS: usize = 512;
const SIBLING_FAILURE_MESSAGE: &str = "Cancelled because another assigned role failed.";
const UNASSIGNED_WORKFLOW_MESSAGE: &str =
    "Assign a role to this macro and every called macro before running it.";

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;
type RoleSync = Arc<dyn Fn(Vec<String>) -> CoreResult<()> + Send + Sync>;

#[derive(Clone)]
pub struct MacroRuntime {
    shared: Arc<Shared>,
}

struct Shared {
    action_role_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    events: EventSink,
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::SyncSender<BrowserActionResult>>>,
    role_sync: RoleSync,
    shutting_down: AtomicBool,
}

#[derive(Default)]
struct Inner {
    held_keys: HashMap<String, HeldKey>,
    invocations: HashMap<String, Arc<InvocationControl>>,
    leases: HashMap<String, HeldLease>,
    early_releases: HashMap<String, String>,
    mutation_leases: HashMap<String, HashSet<String>>,
    mutating_macro_ids: HashSet<String>,
    preparing_role_ids: HashMap<String, Vec<String>>,
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
    start_ready: (Mutex<bool>, Condvar),
    stop_after_first_iteration: AtomicBool,
    terminating: AtomicBool,
    wake: (Mutex<()>, Condvar),
}

struct InvocationBarrier {
    ready: Condvar,
    state: Mutex<InvocationBarrierState>,
}

#[derive(Default)]
struct InvocationBarrierState {
    arrived_role_ids: HashSet<String>,
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
}

#[derive(Clone)]
struct HeldKey {
    code: String,
    modifiers: Vec<String>,
    owner_id: String,
    role_id: String,
}

impl MacroRuntime {
    #[cfg(test)]
    pub fn new(events: EventSink) -> Self {
        Self::new_with_role_sync(events, Arc::new(|_| Ok(())))
    }

    pub fn new_with_role_sync(events: EventSink, role_sync: RoleSync) -> Self {
        Self {
            shared: Arc::new(Shared {
                action_role_locks: Mutex::new(HashMap::new()),
                events,
                inner: Mutex::new(Inner::default()),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                role_sync,
                shutting_down: AtomicBool::new(false),
            }),
        }
    }

    pub fn start(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
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
            wait_finished(&control);
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
            wait_finished(&control);
        } else {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
            wait_finished(&control);
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
        cancel_and_wait_all(&controls);
        self.remove_statuses(|status| status.macro_id == macro_id)?;
        Ok(())
    }

    pub fn stop_macro_from_role(&self, macro_id: &str, _source_role_id: &str) -> CoreResult<()> {
        self.stop_macro(macro_id)
    }

    pub fn stop_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_role_matching(role_id, None)
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
        cancel_and_wait_all(&controls);
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
            cancel_and_wait_all(&controls);
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
        cancel_and_wait_all(&controls);
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.held_keys.clear();
            inner.invocations.clear();
            inner.leases.clear();
            inner.early_releases.clear();
            inner.mutation_leases.clear();
            inner.mutating_macro_ids.clear();
            inner.preparing_role_ids.clear();
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
            return Err(CoreError::InvalidInput(
                "enable the macro before running it".to_owned(),
            ));
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
            return Err(CoreError::InvalidInput(
                "launch at least one assigned role before running a macro".to_owned(),
            ));
        }
        let invocation_number = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let invocation_id = format!("macro-invocation-{invocation_number}");
        let control = new_invocation_control(invocation_id.clone(), request.macro_id.clone());
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
            inner
                .preparing_role_ids
                .insert(invocation_id.clone(), roles.clone());
        }
        let prospective_role_ids = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            active_macro_role_ids(&inner, Vec::new())
        };
        if let Err(error) = (self.shared.role_sync)(prospective_role_ids) {
            discard_unstarted_invocation(&self.shared, &control);
            return Err(error);
        }
        let focus_actions = roles
            .iter()
            .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
            .collect();
        if let Err(error) =
            perform_actions_with_control(&self.shared, &control, focus_actions, false)
        {
            discard_unstarted_invocation(&self.shared, &control);
            let _ = sync_active_macro_roles(&self.shared);
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
                let _ = sync_active_macro_roles(&self.shared);
                return Err(CoreError::InvalidInput("macro run cancelled".to_owned()));
            }
            inner.preparing_role_ids.remove(&invocation_id);
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
        };
        let control_for_run = Arc::clone(&control);
        thread::Builder::new()
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
                let _ = sync_active_macro_roles(&self.shared);
                CoreError::Internal(error.to_string())
            })?;
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
            let invocation_ids = inner
                .statuses
                .iter()
                .filter(|(_, status)| {
                    status.role_id == role_id
                        && macro_id.is_none_or(|macro_id| status.macro_id == macro_id)
                })
                .filter_map(|(key, _)| key.split('|').next().map(str::to_owned))
                .collect::<HashSet<_>>();
            invocation_ids
                .iter()
                .filter_map(|id| inner.invocations.get(id).cloned())
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls);
        Ok(())
    }

    fn emit_statuses(&self) {
        emit_statuses(&self.shared);
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
        return Err(format!("called macro is disabled: {}", definition.name));
    }
    let assigned_roles = if root {
        roles.to_vec()
    } else {
        assigned_active_roles(definition, &context.active_role_ids)
    };
    if assigned_roles.is_empty() {
        return Err(format!(
            "called macro has no running assigned role: {}",
            definition.name
        ));
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
            let modifiers = modifiers.as_deref().unwrap_or_default();
            let holds = roles
                .iter()
                .map(|role_id| {
                    let owner_id = format!(
                        "{}:{}:{}:{}",
                        context.control.id, role_id, definition.id, id
                    );
                    (
                        role_id.as_str(),
                        BrowserAction::Key {
                            phase: "hold".to_owned(),
                            key: code.clone(),
                            code: Some(code.clone()),
                            modifiers: modifiers.to_vec(),
                            owner_id,
                        },
                    )
                })
                .collect::<Vec<_>>();
            if let Err(error) = perform_actions(shared, context, holds, false) {
                let _ = perform_actions(
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
                                    owner_id: format!(
                                        "{}:{}:{}:{}",
                                        context.control.id, role_id, definition.id, id
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                );
                return Err(error);
            }
            for role_id in roles {
                let owner_id = format!(
                    "{}:{}:{}:{}",
                    context.control.id, role_id, definition.id, id
                );
                if action.as_deref() == Some("hold_until_stop") {
                    let held = HeldKey {
                        code: code.clone(),
                        modifiers: modifiers.to_vec(),
                        owner_id: owner_id.clone(),
                        role_id: role_id.clone(),
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
                                },
                            )],
                            true,
                        )?;
                    }
                } else {
                    let _ = owner_id;
                }
            }
            if action.as_deref() != Some("hold_until_stop") {
                if applies_timing {
                    wait_cancelable_for_role(context, role_id, context.settings.key_hold_ms)?;
                }
                perform_actions(
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
                                    owner_id: format!(
                                        "{}:{}:{}:{}",
                                        context.control.id, role_id, definition.id, id
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                )?;
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
    loop {
        if let Some(outcome) = &state.outcome {
            return outcome.clone();
        }
        if context.control.cancelled.load(Ordering::Acquire) {
            return Err("macro run cancelled".to_owned());
        }
        let (next, _) = barrier
            .ready
            .wait_timeout(state, Duration::from_millis(25))
            .map_err(|_| "macro barrier lock poisoned".to_owned())?;
        state = next;
    }
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
    .ok_or_else(|| format!("called macro is already running: {macro_id}"))?;
    loop {
        if context.control.cancelled.load(Ordering::Acquire) {
            cancel_control(&child);
            wait_finished(&child);
            remove_owned_child(&context.control, &child.id);
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
        Err(_error) if child.cancelled.load(Ordering::Acquire) => {
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
    let _ = thread::Builder::new()
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
            if let Ok(mut children) = context.control.children.0.lock() {
                children.pending_starts = children.pending_starts.saturating_sub(1);
                context.control.children.1.notify_all();
            }
            let Ok(Some(child)) = started else {
                return;
            };
            if context.control.cancelled.load(Ordering::Acquire)
                || (context.control.terminating.load(Ordering::Acquire)
                    && !context.control.finished_naturally.load(Ordering::Acquire))
            {
                cancel_control(&child);
            }
            wait_finished(&child);
            remove_owned_child(&context.control, &child.id);
        });
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
        return Err(format!("called macro is disabled: {}", definition.name));
    }
    let roles = assigned_active_roles(definition, &parent_context.active_role_ids);
    if roles.is_empty() {
        return Err(format!(
            "called macro has no running assigned role: {}",
            definition.name
        ));
    }
    let invocation_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let invocation_id = format!("macro-invocation-{invocation_number}");
    let child = new_invocation_control(invocation_id.clone(), macro_id.to_owned());
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
                    "called macro is already running: {}",
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
        inner
            .preparing_role_ids
            .insert(invocation_id.clone(), roles.clone());
    }
    register_owned_child(owner, &child);
    let start_result = (|| {
        sync_active_macro_roles(shared).map_err(|error| error.to_string())?;
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
            inner.preparing_role_ids.remove(&invocation_id);
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
        emit_statuses(shared);
        let shared_for_run = Arc::clone(shared);
        let child_for_run = Arc::clone(&child);
        let mut child_ancestry = ancestry;
        let child_macro_id = macro_id.to_owned();
        let child_context = ExecutionContext {
            active_role_ids: Arc::clone(&parent_context.active_role_ids),
            control: Arc::clone(&child),
            macros: Arc::clone(&parent_context.macros),
            settings: parent_context.settings.clone(),
        };
        thread::Builder::new()
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
        Ok(())
    })();
    if let Err(error) = start_result {
        remove_owned_child(owner, &child.id);
        discard_unstarted_invocation(shared, &child);
        let _ = sync_active_macro_roles(shared);
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
    let mut role_ids = actions
        .iter()
        .map(|(role_id, _)| (*role_id).to_owned())
        .collect::<Vec<_>>();
    role_ids.sort();
    role_ids.dedup();
    let role_locks = {
        let mut locks = shared
            .action_role_locks
            .lock()
            .map_err(|_| "macro role action registry lock poisoned".to_owned())?;
        role_ids
            .iter()
            .map(|role_id| {
                Arc::clone(
                    locks
                        .entry(role_id.clone())
                        .or_insert_with(|| Arc::new(Mutex::new(()))),
                )
            })
            .collect::<Vec<_>>()
    };
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
                    deadline_ms: epoch_millis().saturating_add(ACTION_TIMEOUT.as_millis() as u64),
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
                Err(RecvTimeoutError::Timeout) if started.elapsed() < ACTION_TIMEOUT => {}
                Err(RecvTimeoutError::Timeout) => {
                    record_action_failure(
                        control,
                        role_id,
                        "macro browser action timed out".to_owned(),
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
            },
            true,
        );
    }
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
    if duration_ms == 0 {
        thread::yield_now();
        return check_role_cancelled(context, role_id);
    }
    let guard = context
        .control
        .wake
        .0
        .lock()
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    let _ = context
        .control
        .wake
        .1
        .wait_timeout(guard, Duration::from_millis(u64::from(duration_ms)))
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    check_role_cancelled(context, role_id)
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
                .wait_timeout(guard, Duration::from_secs(1))
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
        inner.preparing_role_ids.remove(&control.id);
        inner
            .held_keys
            .retain(|owner_id, _| !owner_id.starts_with(&format!("{}:", control.id)));
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    let _ = sync_active_macro_roles(shared);
    emit_statuses(shared);
    if let Ok(mut outcome) = control.outcome.lock() {
        *outcome = Some(result);
    }
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn new_invocation_control(id: String, macro_id: String) -> Arc<InvocationControl> {
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
        start_ready: (Mutex::new(false), Condvar::new()),
        stop_after_first_iteration: AtomicBool::new(false),
        terminating: AtomicBool::new(false),
        wake: (Mutex::new(()), Condvar::new()),
    })
}

fn discard_unstarted_invocation(shared: &Arc<Shared>, control: &Arc<InvocationControl>) {
    if let Ok(mut inner) = shared.inner.lock() {
        inner.invocations.remove(&control.id);
        inner.preparing_role_ids.remove(&control.id);
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
    cancel_and_wait_all(&child_controls);
}

fn active_macro_role_ids(
    inner: &Inner,
    additional: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let mut role_ids = inner
        .statuses
        .values()
        .filter(|status| matches!(status.state.as_str(), "running" | "stopping"))
        .map(|status| status.role_id.clone())
        .chain(
            inner
                .preparing_role_ids
                .values()
                .flat_map(|role_ids| role_ids.iter().cloned()),
        )
        .chain(additional)
        .collect::<Vec<_>>();
    role_ids.sort();
    role_ids.dedup();
    role_ids
}

fn sync_active_macro_roles(shared: &Arc<Shared>) -> CoreResult<()> {
    let role_ids = {
        let inner = shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
        active_macro_role_ids(&inner, Vec::new())
    };
    (shared.role_sync)(role_ids)
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
    emit_statuses(shared);
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
    emit_statuses(shared);
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
    emit_statuses(shared);
}

fn remove_macro_statuses(shared: &Arc<Shared>, invocation_id: &str, macro_id: &str) {
    if let Ok(mut inner) = shared.inner.lock() {
        let prefix = format!("{invocation_id}|");
        inner
            .statuses
            .retain(|key, status| !(key.starts_with(&prefix) && status.macro_id == macro_id));
    }
    emit_statuses(shared);
}

fn emit_statuses(shared: &Arc<Shared>) {
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
    (shared.events)(vec![CoreEvent::MacroStatuses { statuses }]);
}

fn cancel_control(control: &InvocationControl) {
    control.cancelled.store(true, Ordering::Release);
    control.wake.1.notify_all();
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

fn cancel_and_wait_all(controls: &[Arc<InvocationControl>]) {
    for control in controls {
        cancel_control(control);
    }
    for control in controls {
        wait_finished(control);
    }
}

fn wait_finished(control: &InvocationControl) {
    let Ok(finished) = control.finished.0.lock() else {
        return;
    };
    let _ = control
        .finished
        .1
        .wait_timeout_while(finished, Duration::from_secs(12), |finished| !*finished);
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
        runtime.dispatch_results(success_results(percent)).unwrap();
        wait_for_last_click(&runtime, "r1", 1, "percent-click");

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
        wait_for_last_click(&runtime, "r1", 2, "pixel-click");
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn one_second_digit_one_loop_completes_three_iterations_without_failing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
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
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, start);
        let mut phases = focus.iter().map(|_| "focus".to_owned()).collect::<Vec<_>>();
        let mut iteration_started = Vec::new();
        let mut completed_iterations = 0;
        while completed_iterations < 3 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        match &action.action {
                            BrowserAction::Focus => phases.push("focus".to_owned()),
                            BrowserAction::Key { code, phase, .. } => {
                                assert_eq!(code.as_deref(), Some("Digit1"));
                                if phase == "hold" {
                                    iteration_started.push(std::time::Instant::now());
                                } else if phase == "release" {
                                    completed_iterations += 1;
                                }
                                phases.push(phase.clone());
                            }
                            _ => phases.push("other".to_owned()),
                        }
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }

        runtime.stop_macro("m1").unwrap();
        assert_eq!(
            phases,
            [
                "focus", "hold", "release", "hold", "release", "hold", "release"
            ]
        );
        for interval in iteration_started.windows(2) {
            let elapsed = interval[1].duration_since(interval[0]);
            assert!(elapsed >= Duration::from_millis(850), "{elapsed:?}");
            assert!(elapsed < Duration::from_millis(1_500), "{elapsed:?}");
        }
        assert!(runtime.statuses().unwrap().is_empty());
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
    fn rejects_transitively_unassigned_children_before_resource_or_focus_preflight() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let synced = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let synced_output = Arc::clone(&synced);
        let runtime = MacroRuntime::new_with_role_sync(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(move |role_ids| {
                synced_output.lock().unwrap().push(role_ids);
                Ok(())
            }),
        );
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
        assert!(matches!(
            error,
            CoreError::InvalidInput(message) if message == UNASSIGNED_WORKFLOW_MESSAGE
        ));
        assert!(synced.lock().unwrap().is_empty());
        assert!(receiver.try_recv().is_err());
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
        assert_eq!(error.code(), "MACRO_MUTATION_BUSY");

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
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "s1".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, request);
        let mut actions = focus
            .iter()
            .map(|action| (action.role_id.clone(), "focus".to_owned()))
            .collect::<Vec<_>>();
        while actions.len() < 6 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions {
                    actions: action_requests,
                } = event
                {
                    actions.extend(action_requests.iter().map(|action| {
                        (
                            action.role_id.clone(),
                            match &action.action {
                                BrowserAction::Focus => "focus".to_owned(),
                                BrowserAction::Key { phase, .. } => phase.clone(),
                                _ => "other".to_owned(),
                            },
                        )
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
        for role_id in ["r1", "r2"] {
            assert_eq!(
                actions
                    .iter()
                    .filter(|(role, _)| role == role_id)
                    .map(|(_, phase)| phase.as_str())
                    .collect::<Vec<_>>(),
                ["focus", "hold", "release"]
            );
        }
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
        assert!(!stop.is_finished());

        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        thread::sleep(Duration::from_millis(50));
        assert!(!stop.is_finished());
        runtime.dispatch_results(success_results(releases)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
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
        assert_eq!(released_roles, ["r1", "r2"]);
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
            ms: 0,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
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
        assert_eq!(
            statuses
                .iter()
                .map(|status| status.role_id.as_str())
                .collect::<Vec<_>>(),
            ["r1", "r2"]
        );
        assert_eq!(focus.len(), 2);
        assert_eq!(
            focus
                .iter()
                .map(|action| action.role_id.as_str())
                .collect::<Vec<_>>(),
            ["r1", "r2"]
        );
    }

    #[test]
    fn cancellation_releases_owned_held_keys_before_finishing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let (_, focus) = start_and_ack_focus(
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
            runtime.dispatch_results(success_results(release)).unwrap();
        }
        stop.join().unwrap();
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
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);

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
        assert_eq!(child_focus.len(), 1);
        assert_eq!(child_focus[0].role_id, "r3");
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
        assert_eq!(parent_roles, ["r1", "r2"]);
        runtime
            .dispatch_results(success_results(parent_holds))
            .unwrap();
        let parent_releases = next_browser_action_count(&receiver, 2);
        runtime
            .dispatch_results(success_results(parent_releases))
            .unwrap();
    }

    #[test]
    fn triggered_child_keeps_its_configured_loop_after_parent_completion() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "trigger-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("trigger".to_owned()),
        }]);
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
        assert_eq!(release.len(), 1);
        assert!(matches!(
            release[0].action,
            BrowserAction::Key {
                ref phase,
                ..
            } if phase == "release"
        ));
        runtime.dispatch_results(success_results(release)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
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
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        };
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
    fn resource_preflight_and_focus_finish_before_running_status_is_published() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let synced = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let synced_output = Arc::clone(&synced);
        let runtime = MacroRuntime::new_with_role_sync(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(move |role_ids| {
                synced_output.lock().unwrap().push(role_ids);
                Ok(())
            }),
        );
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request(Vec::new())).unwrap());
        let focus = next_browser_actions(&receiver);
        assert_eq!(synced.lock().unwrap().as_slice(), &[vec!["r1".to_owned()]]);
        assert!(runtime.statuses().unwrap().is_empty());
        runtime.dispatch_results(success_results(focus)).unwrap();
        let statuses = start.join().unwrap();
        assert_eq!(statuses.len(), 1);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while synced
            .lock()
            .unwrap()
            .last()
            .is_none_or(|role_ids| !role_ids.is_empty())
        {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
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
        assert_eq!(press.join().unwrap().len(), 2);

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
        thread::yield_now();
        assert!(!release.is_finished());
        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        assert_eq!(releases.len(), 2);
        runtime.dispatch_results(success_results(releases)).unwrap();
        release.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
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
        assert!(runtime.statuses().unwrap().is_empty());
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
        while let Ok(events) = receiver.try_recv() {
            assert!(
                events
                    .iter()
                    .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                "the early release allowed a second iteration"
            );
        }
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

    fn wait_for_last_click(runtime: &MacroRuntime, role_id: &str, sequence: u32, step_id: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if runtime.statuses().unwrap().iter().any(|status| {
                status.role_id == role_id
                    && status
                        .last_click
                        .as_ref()
                        .is_some_and(|click| click.sequence == sequence && click.step_id == step_id)
            }) {
                return;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }
}
