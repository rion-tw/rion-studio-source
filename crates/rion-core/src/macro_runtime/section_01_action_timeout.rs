use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, TryRecvError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::Utc;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserAction, BrowserActionRequest, BrowserActionResult, CoreEvent, MacroDefinition,
        MacroInputDiagnosticsRecord, MacroInputRoleDiagnosticRecord, MacroLastClick,
        MacroPressRequest, MacroReleaseRequest, MacroRepeat, MacroRunStatus, MacroRuntimeSettings,
        MacroStartRequest, MacroStepDefinition,
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
const INPUT_FENCED_ROLE_MESSAGE: &str =
    "A role assigned to this macro is navigating and cannot accept automatic input yet.";
const INPUT_RECOVERING_ROLE_MESSAGE: &str =
    "A role assigned to this macro is recovering automatic input.";
const INPUT_RESTART_REQUIRED_ROLE_MESSAGE: &str =
    "A role assigned to this macro must be restarted before it can accept automatic input.";

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
    pending: Mutex<HashMap<String, PendingMacroAction>>,
    last_presentation_status_emit: Mutex<Option<Instant>>,
    macro_run_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    shutting_down: AtomicBool,
    input_sequence_role_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    role_transfer_changed: Condvar,
    waiter: Waiter,
}

struct PendingMacroAction {
    result: mpsc::SyncSender<BrowserActionResult>,
    role_id: String,
    signal: Weak<InvocationControl>,
}

#[derive(Default)]
struct Inner {
    held_keys: HashMap<String, HeldKey>,
    invocations: HashMap<String, Arc<InvocationControl>>,
    leases: HashMap<String, HeldLease>,
    early_releases: HashMap<String, String>,
    mutation_leases: HashMap<String, HashSet<String>>,
    mutating_macro_ids: HashSet<String>,
    input_epochs: HashMap<String, u64>,
    input_recoveries: HashMap<String, MacroInputRecovery>,
    input_recovery_by_role: HashMap<String, String>,
    quiesced_role_ids: HashSet<String>,
    recovering_role_ids: HashSet<String>,
    restart_required_role_ids: HashSet<String>,
    stopping_role_ids: HashSet<String>,
    transferring_role_ids: HashSet<String>,
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
    owner_signal: Mutex<Option<Weak<InvocationControl>>>,
    restart_intent: Mutex<Option<MacroRestartIntent>>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MacroRestartIntent {
    pub(crate) macro_id: String,
    pub(crate) sequence: u64,
    pub(crate) source_role_id: Option<String>,
}

#[derive(Clone)]
struct MacroInputRecovery {
    input_epoch: u64,
    intents: Vec<MacroRestartIntent>,
    role_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacroInputRecoveryTicket {
    pub input_epoch: u64,
    pub pending_macro_restart_count: u32,
    pub recovery_id: String,
    pub role_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacroInputRecoveryCompletion {
    pub deferred_count: u32,
    pub restarted_count: u32,
    pub skipped_count: u32,
}
