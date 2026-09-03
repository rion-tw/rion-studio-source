use std::collections::{HashMap, VecDeque};

use crate::{
    error::{CoreError, CoreResult},
    model::{
        ChromiumPopupAdmissionRecord, ChromiumPopupCloseReason, ChromiumPopupLifecycleActionRecord,
        ChromiumPopupLifecycleEventRecord, ChromiumPopupLifecyclePhase,
        ChromiumPopupLifecycleReceiptRecord, ChromiumPopupNativeHostReceiptRecord,
        ChromiumPopupOpenRequestRecord, EmbeddedLaunchTargetRecord, StatePixelBoundsRecord,
        SystemRuntimeOperationCompletionScope, SystemRuntimeOperationStatus,
    },
};

const MAX_ACTIVE_POPUPS: usize = 64;
const MAX_RETAINED_REQUESTS: usize = 128;
const MAX_RETAINED_EVENTS: usize = 256;

#[derive(Debug, Clone)]
struct PopupRecord {
    admission: ChromiumPopupAdmissionRecord,
    phase: ChromiumPopupLifecyclePhase,
    revision: u64,
    close_operation_id: Option<String>,
    close_outcome: Option<CloseOutcome>,
    native_host: Option<ChromiumPopupNativeHostReceiptRecord>,
    open_terminal: bool,
}

#[derive(Debug, Clone)]
struct CloseOutcome {
    phase: ChromiumPopupLifecyclePhase,
    status: SystemRuntimeOperationStatus,
    failure_code: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct ReceiptDisposition {
    operation_terminal: bool,
    close_native: bool,
}

impl ReceiptDisposition {
    const PENDING: Self = Self {
        operation_terminal: false,
        close_native: false,
    };
    const PENDING_CLOSE_NATIVE: Self = Self {
        operation_terminal: false,
        close_native: true,
    };
    const TERMINAL: Self = Self {
        operation_terminal: true,
        close_native: false,
    };
}

#[derive(Debug, Clone)]
struct RequestEntry {
    request: ChromiumPopupOpenRequestRecord,
    admission: ChromiumPopupAdmissionRecord,
}

#[derive(Debug, Clone)]
struct EventEntry {
    event: ChromiumPopupLifecycleEventRecord,
    receipt: ChromiumPopupLifecycleReceiptRecord,
}

#[derive(Debug, Default)]
pub(crate) struct ChromiumPopupLifecycleRuntime {
    popups: HashMap<String, PopupRecord>,
    request_order: VecDeque<String>,
    requests: HashMap<String, RequestEntry>,
    event_order: VecDeque<String>,
    events: HashMap<String, EventEntry>,
}

impl ChromiumPopupLifecycleRuntime {
    pub(crate) fn admit(
        &mut self,
        request: ChromiumPopupOpenRequestRecord,
    ) -> CoreResult<ChromiumPopupAdmissionRecord> {
        validate_uuid(&request.request_id, "popup request")?;
        if let Some(previous) = self.requests.get(&request.request_id) {
            if previous.request != request {
                return Err(domain(
                    "CHROMIUM_POPUP_REQUEST_REPLAY_MISMATCH",
                    "A popup request identity was replayed with different content.",
                ));
            }
            return Ok(previous.admission.clone());
        }
        validate_open_request(&request)?;
        if self
            .popups
            .values()
            .filter(|record| !phase_is_terminal(record.phase))
            .count()
            >= MAX_ACTIVE_POPUPS
        {
            return Err(domain(
                "CHROMIUM_POPUP_CAPACITY",
                "The bounded Chromium popup registry is full.",
            ));
        }
        let popup_id = uuid::Uuid::new_v4().to_string();
        let open_operation_id = uuid::Uuid::new_v4().to_string();
        let target = popup_target(&request.parent_target, &popup_id)?;
        let parsed = url::Url::parse(&request.target_url).map_err(|_| {
            domain(
                "CHROMIUM_POPUP_TARGET_INVALID",
                "A canonical final HTTP(S) popup target is required.",
            )
        })?;
        let title = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .unwrap_or("Popup")
            .to_owned();
        let admission = ChromiumPopupAdmissionRecord {
            request_id: request.request_id.clone(),
            popup_id: popup_id.clone(),
            open_operation_id,
            lifecycle_revision: 1,
            parent: request.parent.clone(),
            target,
            title,
            creation_url: "about:blank".to_owned(),
            target_url: request.target_url.clone(),
            disposition: request.disposition,
            opener_policy: request.opener_policy,
            referrer_url: request.referrer_url.clone(),
            referrer_policy: request.referrer_policy.clone(),
        };
        self.popups.insert(
            popup_id,
            PopupRecord {
                admission: admission.clone(),
                phase: ChromiumPopupLifecyclePhase::Admitted,
                revision: 1,
                close_operation_id: None,
                close_outcome: None,
                native_host: None,
                open_terminal: false,
            },
        );
        self.requests.insert(
            request.request_id.clone(),
            RequestEntry {
                request,
                admission: admission.clone(),
            },
        );
        self.request_order.push_back(admission.request_id.clone());
        trim_ledger(
            &mut self.request_order,
            &mut self.requests,
            MAX_RETAINED_REQUESTS,
        );
        Ok(admission)
    }

    pub(crate) fn apply_event(
        &mut self,
        event: ChromiumPopupLifecycleEventRecord,
        platform: rion_platform::Platform,
    ) -> CoreResult<ChromiumPopupLifecycleReceiptRecord> {
        validate_uuid(&event.event_id, "popup event")?;
        if let Some(previous) = self.events.get(&event.event_id) {
            if previous.event != event {
                return Err(domain(
                    "CHROMIUM_POPUP_EVENT_REPLAY_MISMATCH",
                    "A popup event identity was replayed with different content.",
                ));
            }
            return Ok(previous.receipt.clone());
        }
        let record = self.popups.get_mut(&event.popup_id).ok_or_else(|| {
            domain(
                "CHROMIUM_POPUP_NOT_FOUND",
                "The popup lifecycle event has no Rust-owned popup identity.",
            )
        })?;
        if record.admission.parent != event.parent {
            return Err(domain(
                "CHROMIUM_POPUP_PARENT_FENCE_MISMATCH",
                "The popup lifecycle event crossed its admitted parent fence.",
            ));
        }
        let receipt = if event.expected_revision != record.revision {
            superseded_receipt(record, &event)
        } else {
            transition(record, &event, platform)?
        };
        self.events.insert(
            event.event_id.clone(),
            EventEntry {
                event,
                receipt: receipt.clone(),
            },
        );
        self.event_order.push_back(receipt.event_id.clone());
        trim_ledger(&mut self.event_order, &mut self.events, MAX_RETAINED_EVENTS);
        Ok(receipt)
    }
}

fn transition(
    record: &mut PopupRecord,
    event: &ChromiumPopupLifecycleEventRecord,
    platform: rion_platform::Platform,
) -> CoreResult<ChromiumPopupLifecycleReceiptRecord> {
    match &event.action {
        ChromiumPopupLifecycleActionRecord::NativeReady { host } => {
            if record.phase != ChromiumPopupLifecyclePhase::Admitted {
                return Ok(superseded_receipt(record, event));
            }
            validate_native_host(record, host, platform)?;
            record.native_host = Some(host.clone());
            record.phase = ChromiumPopupLifecyclePhase::NativeReady;
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                record.admission.open_operation_id.clone(),
                SystemRuntimeOperationStatus::Applied,
                SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
                ReceiptDisposition::PENDING,
                None,
            ))
        }
        ChromiumPopupLifecycleActionRecord::PageReady { final_url } => {
            if record.phase != ChromiumPopupLifecyclePhase::NativeReady {
                return Ok(superseded_receipt(record, event));
            }
            canonical_remote_url(final_url, "final")?;
            record.phase = ChromiumPopupLifecyclePhase::Ready;
            record.open_terminal = true;
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                record.admission.open_operation_id.clone(),
                SystemRuntimeOperationStatus::Applied,
                SystemRuntimeOperationCompletionScope::PageFinished,
                ReceiptDisposition::TERMINAL,
                None,
            ))
        }
        ChromiumPopupLifecycleActionRecord::CloseRequested { reason } => {
            if !matches!(
                record.phase,
                ChromiumPopupLifecyclePhase::Admitted
                    | ChromiumPopupLifecyclePhase::NativeReady
                    | ChromiumPopupLifecyclePhase::Ready
            ) {
                return Ok(superseded_receipt(record, event));
            }
            let outcome = close_outcome(*reason, record.open_terminal);
            let operation_id = if record.open_terminal {
                uuid::Uuid::new_v4().to_string()
            } else {
                record.admission.open_operation_id.clone()
            };
            record.close_operation_id = Some(operation_id.clone());
            record.close_outcome = Some(outcome.clone());
            if record.native_host.is_none() {
                record.phase = outcome.phase;
                record.open_terminal = true;
                record.revision += 1;
                return Ok(receipt(
                    record,
                    event,
                    operation_id,
                    outcome.status,
                    SystemRuntimeOperationCompletionScope::StateCommit,
                    ReceiptDisposition::TERMINAL,
                    outcome.failure_code,
                ));
            }
            record.phase = ChromiumPopupLifecyclePhase::Closing;
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                operation_id,
                SystemRuntimeOperationStatus::Applied,
                SystemRuntimeOperationCompletionScope::StateCommit,
                ReceiptDisposition::PENDING_CLOSE_NATIVE,
                None,
            ))
        }
        ChromiumPopupLifecycleActionRecord::NativeClosed => {
            if record.phase != ChromiumPopupLifecyclePhase::Closing {
                if phase_is_terminal(record.phase) {
                    return Ok(superseded_receipt(record, event));
                }
                record.phase = ChromiumPopupLifecyclePhase::Indeterminate;
                record.open_terminal = true;
                record.revision += 1;
                return Ok(receipt(
                    record,
                    event,
                    record.admission.open_operation_id.clone(),
                    SystemRuntimeOperationStatus::Indeterminate,
                    SystemRuntimeOperationCompletionScope::NativeDestroyed,
                    ReceiptDisposition::TERMINAL,
                    Some("CHROMIUM_POPUP_UNREQUESTED_NATIVE_CLOSE".to_owned()),
                ));
            }
            let outcome = record.close_outcome.clone().unwrap_or(CloseOutcome {
                phase: ChromiumPopupLifecyclePhase::Closed,
                status: SystemRuntimeOperationStatus::Applied,
                failure_code: None,
            });
            let operation_id = record
                .close_operation_id
                .clone()
                .unwrap_or_else(|| record.admission.open_operation_id.clone());
            record.phase = outcome.phase;
            if operation_id == record.admission.open_operation_id {
                record.open_terminal = true;
            }
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                operation_id,
                outcome.status,
                SystemRuntimeOperationCompletionScope::NativeDestroyed,
                ReceiptDisposition::TERMINAL,
                outcome.failure_code,
            ))
        }
        ChromiumPopupLifecycleActionRecord::Cancelled { failure_code } => {
            validate_failure_code(failure_code)?;
            if record.phase != ChromiumPopupLifecyclePhase::Admitted {
                return Ok(superseded_receipt(record, event));
            }
            record.phase = ChromiumPopupLifecyclePhase::Cancelled;
            record.open_terminal = true;
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                record.admission.open_operation_id.clone(),
                SystemRuntimeOperationStatus::Cancelled,
                SystemRuntimeOperationCompletionScope::StateCommit,
                ReceiptDisposition::TERMINAL,
                Some(failure_code.clone()),
            ))
        }
        ChromiumPopupLifecycleActionRecord::Failed {
            failure_code,
            native_state_unknown,
        } => {
            validate_failure_code(failure_code)?;
            if phase_is_terminal(record.phase) {
                return Ok(superseded_receipt(record, event));
            }
            if *native_state_unknown {
                record.phase = ChromiumPopupLifecyclePhase::Indeterminate;
                record.open_terminal = true;
                record.revision += 1;
                return Ok(receipt(
                    record,
                    event,
                    record.admission.open_operation_id.clone(),
                    SystemRuntimeOperationStatus::Indeterminate,
                    SystemRuntimeOperationCompletionScope::LifecycleTransition,
                    ReceiptDisposition {
                        operation_terminal: true,
                        close_native: record.native_host.is_some(),
                    },
                    Some(failure_code.clone()),
                ));
            }
            if record.native_host.is_some() {
                let operation_id = if record.open_terminal {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    record.admission.open_operation_id.clone()
                };
                record.close_operation_id = Some(operation_id.clone());
                record.close_outcome = Some(CloseOutcome {
                    phase: ChromiumPopupLifecyclePhase::Failed,
                    status: SystemRuntimeOperationStatus::Failed,
                    failure_code: Some(failure_code.clone()),
                });
                record.phase = ChromiumPopupLifecyclePhase::Closing;
                record.revision += 1;
                return Ok(receipt(
                    record,
                    event,
                    operation_id,
                    SystemRuntimeOperationStatus::Failed,
                    SystemRuntimeOperationCompletionScope::StateCommit,
                    ReceiptDisposition::PENDING_CLOSE_NATIVE,
                    Some(failure_code.clone()),
                ));
            }
            record.phase = ChromiumPopupLifecyclePhase::Failed;
            record.open_terminal = true;
            record.revision += 1;
            Ok(receipt(
                record,
                event,
                record.admission.open_operation_id.clone(),
                SystemRuntimeOperationStatus::Failed,
                SystemRuntimeOperationCompletionScope::StateCommit,
                ReceiptDisposition::TERMINAL,
                Some(failure_code.clone()),
            ))
        }
    }
}

fn receipt(
    record: &PopupRecord,
    event: &ChromiumPopupLifecycleEventRecord,
    operation_id: String,
    status: SystemRuntimeOperationStatus,
    completion_scope: SystemRuntimeOperationCompletionScope,
    disposition: ReceiptDisposition,
    failure_code: Option<String>,
) -> ChromiumPopupLifecycleReceiptRecord {
    ChromiumPopupLifecycleReceiptRecord {
        event_id: event.event_id.clone(),
        popup_id: event.popup_id.clone(),
        operation_id,
        lifecycle_revision: record.revision,
        phase: record.phase,
        status,
        completion_scope,
        operation_terminal: disposition.operation_terminal,
        lifecycle_terminal: phase_is_terminal(record.phase),
        close_native: disposition.close_native,
        failure_code,
    }
}

fn superseded_receipt(
    record: &PopupRecord,
    event: &ChromiumPopupLifecycleEventRecord,
) -> ChromiumPopupLifecycleReceiptRecord {
    receipt(
        record,
        event,
        record
            .close_operation_id
            .clone()
            .unwrap_or_else(|| record.admission.open_operation_id.clone()),
        SystemRuntimeOperationStatus::Superseded,
        SystemRuntimeOperationCompletionScope::StateCommit,
        ReceiptDisposition::TERMINAL,
        Some("CHROMIUM_POPUP_EVENT_SUPERSEDED".to_owned()),
    )
}

fn close_outcome(reason: ChromiumPopupCloseReason, open_terminal: bool) -> CloseOutcome {
    match reason {
        ChromiumPopupCloseReason::User if open_terminal => CloseOutcome {
            phase: ChromiumPopupLifecyclePhase::Closed,
            status: SystemRuntimeOperationStatus::Applied,
            failure_code: None,
        },
        ChromiumPopupCloseReason::User => CloseOutcome {
            phase: ChromiumPopupLifecyclePhase::Cancelled,
            status: SystemRuntimeOperationStatus::Cancelled,
            failure_code: Some("CHROMIUM_POPUP_CLOSED_BEFORE_READY".to_owned()),
        },
        ChromiumPopupCloseReason::ParentRetired | ChromiumPopupCloseReason::ApplicationShutdown => {
            CloseOutcome {
                phase: ChromiumPopupLifecyclePhase::Cancelled,
                status: SystemRuntimeOperationStatus::Cancelled,
                failure_code: Some("CHROMIUM_POPUP_OWNER_RETIRED".to_owned()),
            }
        }
        ChromiumPopupCloseReason::NavigationRejected => CloseOutcome {
            phase: ChromiumPopupLifecyclePhase::Failed,
            status: SystemRuntimeOperationStatus::Failed,
            failure_code: Some("CHROMIUM_POPUP_NAVIGATION_REJECTED".to_owned()),
        },
        ChromiumPopupCloseReason::LoadFailed => CloseOutcome {
            phase: ChromiumPopupLifecyclePhase::Failed,
            status: SystemRuntimeOperationStatus::Failed,
            failure_code: Some("CHROMIUM_POPUP_LOAD_FAILED".to_owned()),
        },
    }
}

fn validate_native_host(
    record: &PopupRecord,
    host: &ChromiumPopupNativeHostReceiptRecord,
    platform: rion_platform::Platform,
) -> CoreResult<()> {
    let expected_platform = match platform {
        rion_platform::Platform::Macos => "macos",
        rion_platform::Platform::Windows => "windows",
    };
    if host.platform != expected_platform
        || host.native_host_id < 1
        || host.logical_window_id != record.admission.target.window_id
        || host.window_generation != 1
        || host.topology_revision != 1
    {
        return Err(domain(
            "CHROMIUM_POPUP_NATIVE_HOST_FENCE_MISMATCH",
            "The popup native-host receipt does not match its Rust-owned admission.",
        ));
    }
    match platform {
        rion_platform::Platform::Macos => {
            let identity = host.appkit_identity.as_ref().ok_or_else(|| {
                domain(
                    "CHROMIUM_POPUP_APPKIT_RECEIPT_REQUIRED",
                    "The macOS popup requires an exact AppKit host identity receipt.",
                )
            })?;
            if identity.logical_window_id != record.admission.target.window_id
                || identity.launch_generation != record.admission.open_operation_id
                || identity.native_generation < 1
            {
                return Err(domain(
                    "CHROMIUM_POPUP_APPKIT_RECEIPT_MISMATCH",
                    "The AppKit popup identity does not match its Rust-owned launch fence.",
                ));
            }
        }
        rion_platform::Platform::Windows if host.appkit_identity.is_some() => {
            return Err(domain(
                "CHROMIUM_POPUP_WINDOWS_HOST_INVALID",
                "A Windows popup cannot claim an AppKit host identity.",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn validate_open_request(request: &ChromiumPopupOpenRequestRecord) -> CoreResult<()> {
    validate_identifier(&request.parent.owner_id, "popup owner")?;
    validate_identifier(&request.parent.parent_window_id, "popup parent window")?;
    validate_identifier(&request.parent.parent_tab_id, "popup parent tab")?;
    validate_identifier(
        &request.parent.parent_attempt_generation,
        "popup parent attempt",
    )?;
    if request.parent.owner_native_generation < 1
        || request.parent.parent_window_generation < 1
        || request.parent.parent_topology_revision < 1
        || request.parent.parent_native_host_id < 1
        || request.has_post_body
    {
        return Err(domain(
            "CHROMIUM_POPUP_PARENT_FENCE_INVALID",
            "The popup request is missing an exact parent fence or contains unsupported POST data.",
        ));
    }
    if request
        .frame_name
        .as_deref()
        .is_some_and(|name| name != "_blank")
    {
        return Err(domain(
            "CHROMIUM_POPUP_NAMED_TARGET_UNSUPPORTED",
            "Only an unnamed or _blank isolated popup target is supported.",
        ));
    }
    for feature in request.raw_features.split(',').map(str::trim) {
        if !feature.is_empty() && feature != "noopener" && feature != "noreferrer" {
            return Err(domain(
                "CHROMIUM_POPUP_FEATURE_UNSUPPORTED",
                "The popup requested an unsupported native window feature.",
            ));
        }
    }
    canonical_remote_url(&request.target_url, "target")?;
    if let Some(referrer) = request.referrer_url.as_deref() {
        canonical_remote_url(referrer, "referrer")?;
    }
    if request.referrer_policy.as_deref().is_some_and(|policy| {
        !matches!(
            policy,
            "default"
                | "unsafe-url"
                | "no-referrer-when-downgrade"
                | "no-referrer"
                | "origin"
                | "strict-origin-when-cross-origin"
                | "same-origin"
                | "strict-origin"
                | "origin-when-cross-origin"
        )
    }) {
        return Err(domain(
            "CHROMIUM_POPUP_REFERRER_POLICY_INVALID",
            "The popup referrer policy is not supported by the controlled loader.",
        ));
    }
    Ok(())
}

fn canonical_remote_url(value: &str, field: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 8_192
        || value != value.trim()
        || value.contains(char::is_whitespace)
        || value.contains('\\')
    {
        return Err(domain(
            "CHROMIUM_POPUP_URL_INVALID",
            &format!("A canonical HTTP(S) popup {field} URL is required."),
        ));
    }
    let parsed = url::Url::parse(value).map_err(|_| {
        domain(
            "CHROMIUM_POPUP_URL_INVALID",
            &format!("A canonical HTTP(S) popup {field} URL is required."),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.as_str() != value
    {
        return Err(domain(
            "CHROMIUM_POPUP_URL_INVALID",
            &format!("A canonical HTTP(S) popup {field} URL is required."),
        ));
    }
    Ok(())
}

fn popup_target(
    parent: &EmbeddedLaunchTargetRecord,
    popup_id: &str,
) -> CoreResult<EmbeddedLaunchTargetRecord> {
    validate_bounds(&parent.work_area)?;
    validate_bounds(&parent.bounds)?;
    if parent.scale_factor <= 0.0 || parent.scale_factor > 8.0 || !parent.scale_factor.is_finite() {
        return Err(domain(
            "CHROMIUM_POPUP_PARENT_TARGET_INVALID",
            "The popup parent target has invalid display scale evidence.",
        ));
    }
    let width = parent.bounds.width.min(parent.work_area.width).max(640);
    let height = parent.bounds.height.min(parent.work_area.height).max(480);
    if width > parent.work_area.width || height > parent.work_area.height {
        return Err(domain(
            "CHROMIUM_POPUP_WORK_AREA_TOO_SMALL",
            "The target display cannot contain a controlled popup host.",
        ));
    }
    let max_x = parent.work_area.x + parent.work_area.width - width;
    let max_y = parent.work_area.y + parent.work_area.height - height;
    let x = (parent.bounds.x + 24).clamp(parent.work_area.x, max_x);
    let y = (parent.bounds.y + 24).clamp(parent.work_area.y, max_y);
    Ok(EmbeddedLaunchTargetRecord {
        window_id: format!("popup-{popup_id}"),
        persisted_name: Some("Popup".to_owned()),
        display_id: parent.display_id,
        scale_factor: parent.scale_factor,
        work_area: parent.work_area.clone(),
        bounds: StatePixelBoundsRecord {
            x,
            y,
            width,
            height,
        },
        presentation: "normal".to_owned(),
    })
}

fn validate_bounds(bounds: &StatePixelBoundsRecord) -> CoreResult<()> {
    if bounds.width < 1
        || bounds.height < 1
        || bounds.x.checked_add(bounds.width).is_none()
        || bounds.y.checked_add(bounds.height).is_none()
    {
        return Err(domain(
            "CHROMIUM_POPUP_PARENT_TARGET_INVALID",
            "The popup parent target has invalid display bounds.",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 256
        || value != value.trim()
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(|character| character.is_control())
    {
        return Err(domain(
            "CHROMIUM_POPUP_ID_INVALID",
            &format!("A canonical {field} identity is required."),
        ));
    }
    Ok(())
}

fn validate_uuid(value: &str, field: &str) -> CoreResult<()> {
    let is_canonical = uuid::Uuid::parse_str(value)
        .map(|parsed| parsed.to_string() == value)
        .unwrap_or(false);
    if !is_canonical {
        return Err(domain(
            "CHROMIUM_POPUP_ID_INVALID",
            &format!("A canonical {field} UUID is required."),
        ));
    }
    Ok(())
}

fn validate_failure_code(value: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(domain(
            "CHROMIUM_POPUP_FAILURE_CODE_INVALID",
            "A bounded canonical popup failure code is required.",
        ));
    }
    Ok(())
}

fn phase_is_terminal(phase: ChromiumPopupLifecyclePhase) -> bool {
    matches!(
        phase,
        ChromiumPopupLifecyclePhase::Closed
            | ChromiumPopupLifecyclePhase::Cancelled
            | ChromiumPopupLifecyclePhase::Failed
            | ChromiumPopupLifecyclePhase::Indeterminate
    )
}

fn trim_ledger<Value>(
    order: &mut VecDeque<String>,
    entries: &mut HashMap<String, Value>,
    capacity: usize,
) {
    while order.len() > capacity {
        if let Some(retired) = order.pop_front() {
            entries.remove(&retired);
        }
    }
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}
