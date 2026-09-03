use std::collections::{HashMap, HashSet};

use napi_derive::napi;

use super::*;

const MAX_NATIVE_INPUT_SURFACES: usize = 128;
const MAX_NATIVE_INPUT_REQUESTS_PER_SURFACE: usize = 256;
const APPKIT_INPUT_ALLOWED_MODIFIER_FLAGS: u32 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);

#[napi(object)]
pub struct AppKitInputSurfaceCaptureReceipt {
    pub role_id: String,
    pub surface_generation: u32,
    pub capture_sequence: String,
    pub observed_node_count: u32,
}

#[napi(object)]
pub struct AppKitInputSurfaceOwnershipReceipt {
    pub role_id: String,
    pub surface_generation: u32,
    pub native_generation: u32,
    pub capture_sequence: String,
}

#[napi(object)]
pub struct AppKitNativeBackgroundKeyRequest {
    pub request_id: String,
    pub role_id: String,
    pub surface_generation: u32,
    pub input_epoch: String,
    pub deadline_ms: String,
    pub event_type: String,
    pub code: String,
    pub modifier_flags: u32,
    pub repeat: bool,
}

#[napi(object)]
pub struct AppKitNativeBackgroundKeySubmissionReceipt {
    pub status: String,
    pub request_id: String,
    pub role_id: String,
    pub surface_generation: u32,
    pub input_epoch: String,
    pub native_generation: u32,
    pub dispatch_sequence: String,
    pub submitted_at_ms: String,
    pub within_deadline: bool,
    pub event_type: String,
    pub code: String,
    pub dispatched_event_count: u32,
    pub virtual_key_code: u32,
    pub modifier_flags: u32,
    pub target_attached: bool,
    pub focus_neutral: bool,
    pub key_window_preserved: bool,
    pub key_window_first_responder_preserved: bool,
    pub target_first_responder_preserved: bool,
    pub target_x: f64,
    pub target_y: f64,
    pub target_width: f64,
    pub target_height: f64,
}

#[napi(object)]
pub struct AppKitNativeBackgroundMouseRequest {
    pub request_id: String,
    pub role_id: String,
    pub surface_generation: u32,
    pub input_epoch: String,
    pub deadline_ms: String,
    pub client_x: f64,
    pub client_y: f64,
    pub zoom_factor: f64,
    pub button: u32,
    pub modifier_flags: u32,
}

#[napi(object)]
pub struct AppKitNativeBackgroundMouseSubmissionReceipt {
    pub status: String,
    pub request_id: String,
    pub role_id: String,
    pub surface_generation: u32,
    pub input_epoch: String,
    pub native_generation: u32,
    pub dispatch_sequence: String,
    pub submitted_at_ms: String,
    pub within_deadline: bool,
    pub dispatched_event_count: u32,
    pub button: u32,
    pub modifier_flags: u32,
    pub client_x: f64,
    pub client_y: f64,
    pub zoom_factor: f64,
    pub app_kit_point_x: f64,
    pub app_kit_point_y: f64,
    pub window_point_x: f64,
    pub window_point_y: f64,
    pub target_flipped: bool,
    pub target_attached: bool,
    pub focus_neutral: bool,
    pub key_window_preserved: bool,
    pub key_window_first_responder_preserved: bool,
    pub target_first_responder_preserved: bool,
    pub target_x: f64,
    pub target_y: f64,
    pub target_width: f64,
    pub target_height: f64,
}

pub(super) struct PendingInputSurfaceCapture {
    role_id: String,
    surface_generation: u32,
    capture_sequence: u64,
    before_addresses: HashSet<usize>,
}

pub(super) struct NativeInputSurface {
    surface_generation: u32,
    web_contents_root_address: usize,
    input_epoch: u64,
    dispatch_sequence: u64,
    request_deadlines: HashMap<String, u64>,
}

struct ValidatedNativeBackgroundKeyRequest {
    request_id: String,
    role_id: String,
    surface_generation: u32,
    input_epoch: u64,
    deadline_ms: u64,
    event_type: String,
    code: String,
    modifier_flags: u32,
    repeat: bool,
}

struct ValidatedNativeBackgroundMouseRequest {
    request_id: String,
    role_id: String,
    surface_generation: u32,
    input_epoch: u64,
    deadline_ms: u64,
    client_x: f64,
    client_y: f64,
    zoom_factor: f64,
    button: u8,
    modifier_flags: u32,
}

#[napi]
impl NativeAppKitRuntimeHost {
    #[napi(js_name = "beginInputSurfaceCapture")]
    pub fn begin_input_surface_capture(
        &self,
        expected: AppKitRuntimeHostIdentity,
        role_id: String,
        surface_generation: u32,
    ) -> Result<AppKitInputSurfaceCaptureReceipt> {
        self.require_identity(&expected)?;
        validate_identifier(&role_id, "input role")?;
        if surface_generation == 0 {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit input-surface generation must be positive.",
            ));
        }
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        if state.pending_input_capture.is_some() {
            return Err(adapter_error(
                Status::GenericFailure,
                "An AppKit input-surface capture is already pending for this host.",
            ));
        }
        if state.input_surfaces.contains_key(&role_id) {
            return Err(adapter_error(
                Status::InvalidArg,
                "The role already owns an AppKit Chromium input surface.",
            ));
        }
        self.require_exact_native_window()?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        let before = read_native_view_tree(native_view)?;
        let before_addresses = native_view_addresses(&before)?;
        let capture_sequence = state
            .next_input_capture_sequence
            .checked_add(1)
            .ok_or_else(|| {
                adapter_error(
                    Status::GenericFailure,
                    "The AppKit input-surface capture sequence is exhausted.",
                )
            })?;
        state.next_input_capture_sequence = capture_sequence;
        state.pending_input_capture = Some(PendingInputSurfaceCapture {
            role_id: role_id.clone(),
            surface_generation,
            capture_sequence,
            before_addresses,
        });
        Ok(AppKitInputSurfaceCaptureReceipt {
            role_id,
            surface_generation,
            capture_sequence: capture_sequence.to_string(),
            observed_node_count: u32::try_from(before.len()).map_err(|_| {
                adapter_error(
                    Status::GenericFailure,
                    "The AppKit input-surface snapshot exceeded its bounded node count.",
                )
            })?,
        })
    }

    #[napi(js_name = "commitInputSurfaceCapture")]
    pub fn commit_input_surface_capture(
        &self,
        expected: AppKitRuntimeHostIdentity,
        role_id: String,
        surface_generation: u32,
        capture_sequence: String,
    ) -> Result<AppKitInputSurfaceOwnershipReceipt> {
        self.require_identity(&expected)?;
        validate_identifier(&role_id, "input role")?;
        let capture_sequence = parse_canonical_u64(&capture_sequence, true, "capture sequence")?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        let pending = state.pending_input_capture.as_ref().ok_or_else(|| {
            adapter_error(
                Status::InvalidArg,
                "No AppKit input-surface capture is pending.",
            )
        })?;
        if pending.role_id != role_id
            || pending.surface_generation != surface_generation
            || pending.capture_sequence != capture_sequence
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit input-surface capture identity is stale.",
            ));
        }
        self.require_exact_native_window()?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        let after = read_native_view_tree(native_view)?;
        let root_address = exact_added_web_contents_root(&after, &pending.before_addresses)?;
        if state.input_surfaces.len() >= MAX_NATIVE_INPUT_SURFACES {
            state.pending_input_capture = None;
            return Err(adapter_error(
                Status::GenericFailure,
                "The AppKit host reached its bounded native input-surface capacity.",
            ));
        }
        state.input_surfaces.insert(
            role_id.clone(),
            NativeInputSurface {
                surface_generation,
                web_contents_root_address: root_address,
                input_epoch: 0,
                dispatch_sequence: 0,
                request_deadlines: HashMap::new(),
            },
        );
        state.pending_input_capture = None;
        Ok(AppKitInputSurfaceOwnershipReceipt {
            role_id,
            surface_generation,
            native_generation: self.identity.native_generation,
            capture_sequence: capture_sequence.to_string(),
        })
    }

    #[napi(js_name = "cancelInputSurfaceCapture")]
    pub fn cancel_input_surface_capture(
        &self,
        expected: AppKitRuntimeHostIdentity,
        role_id: String,
        surface_generation: u32,
        capture_sequence: String,
    ) -> Result<bool> {
        self.require_identity(&expected)?;
        validate_identifier(&role_id, "input role")?;
        let capture_sequence = parse_canonical_u64(&capture_sequence, true, "capture sequence")?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        let Some(pending) = state.pending_input_capture.as_ref() else {
            return Ok(false);
        };
        if pending.role_id != role_id
            || pending.surface_generation != surface_generation
            || pending.capture_sequence != capture_sequence
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit input-surface capture identity is stale.",
            ));
        }
        state.pending_input_capture = None;
        Ok(true)
    }

    #[napi(js_name = "retireInputSurface")]
    pub fn retire_input_surface(
        &self,
        expected: AppKitRuntimeHostIdentity,
        role_id: String,
        surface_generation: u32,
    ) -> Result<bool> {
        self.require_identity(&expected)?;
        validate_identifier(&role_id, "input role")?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        let Some(surface) = state.input_surfaces.get(&role_id) else {
            return Ok(false);
        };
        if surface.surface_generation != surface_generation {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit input-surface generation is stale.",
            ));
        }
        state.input_surfaces.remove(&role_id);
        Ok(true)
    }

    #[napi(js_name = "submitNativeBackgroundKey")]
    pub fn submit_native_background_key(
        &self,
        expected: AppKitRuntimeHostIdentity,
        request: AppKitNativeBackgroundKeyRequest,
    ) -> Result<AppKitNativeBackgroundKeySubmissionReceipt> {
        self.require_identity(&expected)?;
        let request = validate_native_background_key_request(request)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let surface = state
            .input_surfaces
            .get_mut(&request.role_id)
            .ok_or_else(|| {
                adapter_error(
                    Status::InvalidArg,
                    "The role has no captured AppKit Chromium input surface.",
                )
            })?;
        if surface.surface_generation != request.surface_generation {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium input-surface generation is stale.",
            ));
        }
        if request.input_epoch < surface.input_epoch {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium input epoch is stale.",
            ));
        }
        let started_at_ms = unix_epoch_ms()?;
        admit_request_ledger(
            &mut surface.request_deadlines,
            &request.request_id,
            request.deadline_ms,
            started_at_ms,
        )?;
        let dispatch_sequence = surface.dispatch_sequence.checked_add(1).ok_or_else(|| {
            adapter_error(
                Status::GenericFailure,
                "The AppKit Chromium input dispatch sequence is exhausted.",
            )
        })?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        let code = CString::new(request.code.as_str()).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium key code contains an invalid null byte.",
            )
        })?;
        let native_receipt = submit_native_background_key(
            native_view,
            surface.web_contents_root_address,
            &code,
            request.event_type == "keyDown",
            request.modifier_flags,
            request.repeat,
        )?;
        let submitted_at_ms = unix_epoch_ms()?;
        surface.input_epoch = request.input_epoch;
        surface.dispatch_sequence = dispatch_sequence;
        Ok(AppKitNativeBackgroundKeySubmissionReceipt {
            status: "submitted".to_owned(),
            request_id: request.request_id,
            role_id: request.role_id,
            surface_generation: request.surface_generation,
            input_epoch: request.input_epoch.to_string(),
            native_generation: self.identity.native_generation,
            dispatch_sequence: dispatch_sequence.to_string(),
            submitted_at_ms: submitted_at_ms.to_string(),
            within_deadline: submitted_at_ms < request.deadline_ms,
            event_type: request.event_type,
            code: request.code,
            dispatched_event_count: u32::from(native_receipt.dispatched_event_count),
            virtual_key_code: u32::from(native_receipt.virtual_key_code),
            modifier_flags: u32::try_from(native_receipt.modifier_flags).map_err(|_| {
                adapter_error(
                    Status::GenericFailure,
                    "The AppKit Chromium modifier receipt exceeded its validated width.",
                )
            })?,
            target_attached: native_receipt.target_attached != 0,
            focus_neutral: native_receipt.focus_neutral != 0,
            key_window_preserved: native_receipt.key_window_preserved != 0,
            key_window_first_responder_preserved: native_receipt
                .key_window_first_responder_preserved
                != 0,
            target_first_responder_preserved: native_receipt.target_first_responder_preserved != 0,
            target_x: native_receipt.target_x,
            target_y: native_receipt.target_y,
            target_width: native_receipt.target_width,
            target_height: native_receipt.target_height,
        })
    }

    #[napi(js_name = "submitNativeBackgroundMouse")]
    pub fn submit_native_background_mouse(
        &self,
        expected: AppKitRuntimeHostIdentity,
        request: AppKitNativeBackgroundMouseRequest,
    ) -> Result<AppKitNativeBackgroundMouseSubmissionReceipt> {
        self.require_identity(&expected)?;
        let request = validate_native_background_mouse_request(request)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let surface = state
            .input_surfaces
            .get_mut(&request.role_id)
            .ok_or_else(|| {
                adapter_error(
                    Status::InvalidArg,
                    "The role has no captured AppKit Chromium input surface.",
                )
            })?;
        if surface.surface_generation != request.surface_generation {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium input-surface generation is stale.",
            ));
        }
        if request.input_epoch < surface.input_epoch {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium input epoch is stale.",
            ));
        }
        let started_at_ms = unix_epoch_ms()?;
        admit_request_ledger(
            &mut surface.request_deadlines,
            &request.request_id,
            request.deadline_ms,
            started_at_ms,
        )?;
        let dispatch_sequence = surface.dispatch_sequence.checked_add(1).ok_or_else(|| {
            adapter_error(
                Status::GenericFailure,
                "The AppKit Chromium input dispatch sequence is exhausted.",
            )
        })?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        let native_receipt = submit_native_background_mouse(
            native_view,
            surface.web_contents_root_address,
            request.client_x,
            request.client_y,
            request.zoom_factor,
            request.button,
            request.modifier_flags,
        )?;
        let submitted_at_ms = unix_epoch_ms()?;
        surface.input_epoch = request.input_epoch;
        surface.dispatch_sequence = dispatch_sequence;
        Ok(AppKitNativeBackgroundMouseSubmissionReceipt {
            status: "submitted".to_owned(),
            request_id: request.request_id,
            role_id: request.role_id,
            surface_generation: request.surface_generation,
            input_epoch: request.input_epoch.to_string(),
            native_generation: self.identity.native_generation,
            dispatch_sequence: dispatch_sequence.to_string(),
            submitted_at_ms: submitted_at_ms.to_string(),
            within_deadline: submitted_at_ms < request.deadline_ms,
            dispatched_event_count: u32::from(native_receipt.dispatched_event_count),
            button: u32::from(native_receipt.button),
            modifier_flags: u32::try_from(native_receipt.modifier_flags).map_err(|_| {
                adapter_error(
                    Status::GenericFailure,
                    "The AppKit Chromium modifier receipt exceeded its validated width.",
                )
            })?,
            client_x: native_receipt.client_x,
            client_y: native_receipt.client_y,
            zoom_factor: native_receipt.zoom_factor,
            app_kit_point_x: native_receipt.app_kit_point_x,
            app_kit_point_y: native_receipt.app_kit_point_y,
            window_point_x: native_receipt.window_point_x,
            window_point_y: native_receipt.window_point_y,
            target_flipped: native_receipt.target_flipped != 0,
            target_attached: native_receipt.target_attached != 0,
            focus_neutral: native_receipt.focus_neutral != 0,
            key_window_preserved: native_receipt.key_window_preserved != 0,
            key_window_first_responder_preserved: native_receipt
                .key_window_first_responder_preserved
                != 0,
            target_first_responder_preserved: native_receipt.target_first_responder_preserved != 0,
            target_x: native_receipt.target_x,
            target_y: native_receipt.target_y,
            target_width: native_receipt.target_width,
            target_height: native_receipt.target_height,
        })
    }
}

fn parse_canonical_u64(value: &str, positive: bool, field: &str) -> Result<u64> {
    let parsed = value.parse::<u64>().map_err(|_| {
        adapter_error(
            Status::InvalidArg,
            format!("The AppKit {field} must be a canonical integer."),
        )
    })?;
    if (positive && parsed == 0) || parsed.to_string() != value {
        return Err(adapter_error(
            Status::InvalidArg,
            format!("The AppKit {field} must be a canonical integer."),
        ));
    }
    Ok(parsed)
}

fn validate_native_background_key_request(
    request: AppKitNativeBackgroundKeyRequest,
) -> Result<ValidatedNativeBackgroundKeyRequest> {
    validate_identifier(&request.request_id, "input request")?;
    validate_identifier(&request.role_id, "input role")?;
    if request.surface_generation == 0
        || !matches!(request.event_type.as_str(), "keyDown" | "keyUp")
        || request.code.is_empty()
        || request.code.len() > 128
        || request.code.trim() != request.code
        || request
            .code
            .chars()
            .any(|character| character.is_control() || character == '\u{7f}')
        || request.modifier_flags & !APPKIT_INPUT_ALLOWED_MODIFIER_FLAGS != 0
        || (request.event_type == "keyUp" && request.repeat)
    {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit Chromium background-key request is invalid.",
        ));
    }
    Ok(ValidatedNativeBackgroundKeyRequest {
        request_id: request.request_id,
        role_id: request.role_id,
        surface_generation: request.surface_generation,
        input_epoch: parse_canonical_u64(&request.input_epoch, false, "input epoch")?,
        deadline_ms: parse_canonical_u64(&request.deadline_ms, true, "input deadline")?,
        event_type: request.event_type,
        code: request.code,
        modifier_flags: request.modifier_flags,
        repeat: request.repeat,
    })
}

fn validate_native_background_mouse_request(
    request: AppKitNativeBackgroundMouseRequest,
) -> Result<ValidatedNativeBackgroundMouseRequest> {
    validate_identifier(&request.request_id, "input request")?;
    validate_identifier(&request.role_id, "input role")?;
    if request.surface_generation == 0
        || !request.client_x.is_finite()
        || request.client_x < 0.0
        || request.client_x.fract() != 0.0
        || !request.client_y.is_finite()
        || request.client_y < 0.0
        || request.client_y.fract() != 0.0
        || !request.zoom_factor.is_finite()
        || !(0.25..=5.0).contains(&request.zoom_factor)
        || request.button > 2
        || request.modifier_flags & !APPKIT_INPUT_ALLOWED_MODIFIER_FLAGS != 0
    {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit Chromium background-mouse request is invalid.",
        ));
    }
    Ok(ValidatedNativeBackgroundMouseRequest {
        request_id: request.request_id,
        role_id: request.role_id,
        surface_generation: request.surface_generation,
        input_epoch: parse_canonical_u64(&request.input_epoch, false, "input epoch")?,
        deadline_ms: parse_canonical_u64(&request.deadline_ms, true, "input deadline")?,
        client_x: request.client_x,
        client_y: request.client_y,
        zoom_factor: request.zoom_factor,
        button: u8::try_from(request.button).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit Chromium mouse button is invalid.",
            )
        })?,
        modifier_flags: request.modifier_flags,
    })
}

fn unix_epoch_ms() -> Result<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};

    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                adapter_error(
                    Status::GenericFailure,
                    "The AppKit Chromium input clock is unavailable.",
                )
            })?
            .as_millis(),
    )
    .map_err(|_| {
        adapter_error(
            Status::GenericFailure,
            "The AppKit Chromium input clock exceeded its supported range.",
        )
    })
}

fn admit_request_ledger(
    request_deadlines: &mut HashMap<String, u64>,
    request_id: &str,
    deadline_ms: u64,
    now_ms: u64,
) -> Result<()> {
    request_deadlines.retain(|_, deadline| *deadline > now_ms);
    if deadline_ms <= now_ms {
        return Err(adapter_error(
            Status::GenericFailure,
            "The AppKit Chromium input deadline expired before native submission.",
        ));
    }
    if request_deadlines.contains_key(request_id) {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit Chromium input request was already submitted.",
        ));
    }
    if request_deadlines.len() >= MAX_NATIVE_INPUT_REQUESTS_PER_SURFACE {
        return Err(adapter_error(
            Status::GenericFailure,
            "The AppKit Chromium input request ledger is full of live deadlines.",
        ));
    }
    request_deadlines.insert(request_id.to_owned(), deadline_ms);
    Ok(())
}

fn native_view_addresses(nodes: &[AppKitNativeViewTreeNode]) -> Result<HashSet<usize>> {
    let mut addresses = HashSet::with_capacity(nodes.len());
    for node in nodes {
        let address = parse_native_address(&node.address)?;
        if !addresses.insert(address) {
            return Err(adapter_error(
                Status::GenericFailure,
                "The AppKit native-view snapshot contains duplicate identities.",
            ));
        }
    }
    Ok(addresses)
}

fn exact_added_web_contents_root(
    nodes: &[AppKitNativeViewTreeNode],
    before_addresses: &HashSet<usize>,
) -> Result<usize> {
    let mut candidates = Vec::new();
    for node in nodes {
        let address = parse_native_address(&node.address)?;
        if before_addresses.contains(&address)
            || node.class_name != "WebContentsViewCocoa"
            || !node.attached_to_window
            || !node.width.is_finite()
            || node.width < 0.0
            || !node.height.is_finite()
            || node.height < 0.0
        {
            continue;
        }
        let Some(parent) = node.parent_address.as_deref() else {
            continue;
        };
        if before_addresses.contains(&parse_native_address(parent)?) {
            candidates.push(address);
        }
    }
    if candidates.len() != 1 {
        return Err(adapter_error(
            Status::GenericFailure,
            "AppKit did not observe exactly one newly attached WebContentsViewCocoa root.",
        ));
    }
    Ok(candidates[0])
}

#[cfg(target_os = "macos")]
fn submit_native_background_key(
    native_view: NonNull<c_void>,
    web_contents_root_address: usize,
    code: &CStr,
    key_down: bool,
    modifier_flags: u32,
    repeat: bool,
) -> Result<rion_appkit::AppKitChromiumKeyDispatchResult> {
    // SAFETY: the WebContents root address never crosses the N-API boundary;
    // it was captured beneath this exact live Electron root and is re-resolved
    // synchronously by the AppKit bridge on every submission.
    unsafe {
        rion_appkit::submit_key_to_electron_chromium_view(
            native_view,
            web_contents_root_address,
            code,
            key_down,
            u64::from(modifier_flags),
            repeat,
        )
    }
    .map_err(|error| {
        adapter_error(
            Status::GenericFailure,
            format!("The AppKit Chromium background-key submission failed: {error:?}."),
        )
    })
}

#[cfg(target_os = "macos")]
fn submit_native_background_mouse(
    native_view: NonNull<c_void>,
    web_contents_root_address: usize,
    client_x: f64,
    client_y: f64,
    zoom_factor: f64,
    button: u8,
    modifier_flags: u32,
) -> Result<rion_appkit::AppKitChromiumMouseDispatchResult> {
    // SAFETY: the WebContents root is the same opaque, exact captured address
    // used by the key path and is re-resolved beneath the live host root.
    unsafe {
        rion_appkit::submit_mouse_to_electron_chromium_view(
            native_view,
            web_contents_root_address,
            client_x,
            client_y,
            zoom_factor,
            button,
            u64::from(modifier_flags),
        )
    }
    .map_err(|error| {
        adapter_error(
            Status::GenericFailure,
            format!("The AppKit Chromium background-mouse submission failed: {error:?}."),
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn submit_native_background_mouse(
    _native_view: NonNull<c_void>,
    _web_contents_root_address: usize,
    _client_x: f64,
    _client_y: f64,
    _zoom_factor: f64,
    _button: u8,
    _modifier_flags: u32,
) -> Result<rion_appkit::AppKitChromiumMouseDispatchResult> {
    Err(adapter_error(
        Status::GenericFailure,
        "The AppKit Chromium background-mouse submission is unavailable on this platform.",
    ))
}

#[cfg(not(target_os = "macos"))]
fn submit_native_background_key(
    _native_view: NonNull<c_void>,
    _web_contents_root_address: usize,
    _code: &CStr,
    _key_down: bool,
    _modifier_flags: u32,
    _repeat: bool,
) -> Result<rion_appkit::AppKitChromiumKeyDispatchResult> {
    Err(adapter_error(
        Status::GenericFailure,
        "The AppKit Chromium background-key submission is unavailable on this platform.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_requests_require_canonical_fences_and_known_modifier_bits() {
        let request = || AppKitNativeBackgroundKeyRequest {
            request_id: "request-1".to_owned(),
            role_id: "role-1".to_owned(),
            surface_generation: 1,
            input_epoch: "0".to_owned(),
            deadline_ms: "1".to_owned(),
            event_type: "keyDown".to_owned(),
            code: "KeyA".to_owned(),
            modifier_flags: 1 << 20,
            repeat: false,
        };
        assert!(validate_native_background_key_request(request()).is_ok());
        assert!(
            validate_native_background_key_request(AppKitNativeBackgroundKeyRequest {
                input_epoch: "00".to_owned(),
                ..request()
            })
            .is_err()
        );
        assert!(
            validate_native_background_key_request(AppKitNativeBackgroundKeyRequest {
                modifier_flags: 1,
                ..request()
            })
            .is_err()
        );
    }

    #[test]
    fn mouse_requests_require_canonical_css_coordinates_zoom_and_buttons() {
        let request = |zoom_factor| AppKitNativeBackgroundMouseRequest {
            request_id: "request-1".to_owned(),
            role_id: "role-1".to_owned(),
            surface_generation: 1,
            input_epoch: "0".to_owned(),
            deadline_ms: "1".to_owned(),
            client_x: 100.0,
            client_y: 200.0,
            zoom_factor,
            button: 2,
            modifier_flags: 1 << 17,
        };
        for zoom_factor in [1.0, 1.25, 2.0] {
            let validated = validate_native_background_mouse_request(request(zoom_factor))
                .expect("supported zoom must validate");
            assert_eq!(validated.client_x, 100.0);
            assert_eq!(validated.client_y, 200.0);
            assert_eq!(validated.zoom_factor, zoom_factor);
        }
        assert!(
            validate_native_background_mouse_request(AppKitNativeBackgroundMouseRequest {
                client_x: f64::NAN,
                ..request(1.0)
            })
            .is_err()
        );
        assert!(
            validate_native_background_mouse_request(AppKitNativeBackgroundMouseRequest {
                button: 3,
                ..request(1.0)
            })
            .is_err()
        );
        assert!(
            validate_native_background_mouse_request(AppKitNativeBackgroundMouseRequest {
                client_y: 200.5,
                ..request(1.0)
            })
            .is_err()
        );
        for zoom_factor in [0.0, 0.249, 5.001, f64::INFINITY] {
            assert!(
                validate_native_background_mouse_request(request(zoom_factor)).is_err(),
                "zoom {zoom_factor} must fail closed"
            );
        }
        assert!(
            validate_native_background_mouse_request(AppKitNativeBackgroundMouseRequest {
                input_epoch: "00".to_owned(),
                ..request(1.0)
            })
            .is_err()
        );
    }

    #[test]
    fn hidden_attached_web_contents_root_retains_exact_native_ownership() {
        let before = HashSet::from([0x1000usize]);
        let nodes = vec![
            AppKitNativeViewTreeNode {
                address: "1000".to_owned(),
                parent_address: None,
                depth: 0,
                class_name: "ElectronNativeWindowRoot".to_owned(),
                hidden: false,
                accepts_first_responder: false,
                attached_to_window: true,
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            AppKitNativeViewTreeNode {
                address: "2000".to_owned(),
                parent_address: Some("1000".to_owned()),
                depth: 1,
                class_name: "WebContentsViewCocoa".to_owned(),
                hidden: true,
                accepts_first_responder: false,
                attached_to_window: true,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        ];
        assert_eq!(
            exact_added_web_contents_root(&nodes, &before).unwrap(),
            0x2000
        );
    }

    #[test]
    fn request_ledger_reclaims_expired_entries_across_long_running_macros() {
        let mut ledger = HashMap::new();
        for sequence in 0..=MAX_NATIVE_INPUT_REQUESTS_PER_SURFACE * 2 {
            let now = (sequence as u64) * 10;
            assert!(
                admit_request_ledger(&mut ledger, &format!("request-{sequence}"), now + 5, now,)
                    .is_ok()
            );
        }
        assert_eq!(ledger.len(), 1);
    }

    #[test]
    fn request_ledger_rejects_live_duplicates_and_only_live_overflow() {
        let mut ledger = HashMap::new();
        assert!(admit_request_ledger(&mut ledger, "duplicate", 10, 1).is_ok());
        assert!(admit_request_ledger(&mut ledger, "duplicate", 10, 1).is_err());
        for index in 1..MAX_NATIVE_INPUT_REQUESTS_PER_SURFACE {
            assert!(admit_request_ledger(&mut ledger, &format!("live-{index}"), 10, 1).is_ok());
        }
        assert_eq!(ledger.len(), MAX_NATIVE_INPUT_REQUESTS_PER_SURFACE);
        assert!(admit_request_ledger(&mut ledger, "overflow", 10, 1).is_err());
        assert!(admit_request_ledger(&mut ledger, "after-expiry", 20, 10).is_ok());
        assert_eq!(ledger.len(), 1);
    }
}
