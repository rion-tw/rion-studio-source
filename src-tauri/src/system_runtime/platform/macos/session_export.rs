use std::{
    ffi::c_void,
    sync::{Arc, Mutex},
};

use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::system_runtime::{MacosWkRoleSessionPublicObservation, RuntimeError, RuntimeResult};

const WK_ROLE_SESSION_PUBLIC_EVIDENCE_OBSERVED: i32 = 0;

type ObservationResult = RuntimeResult<MacosWkRoleSessionPublicObservation>;

struct MacosWkRoleSessionObservationContext {
    sender: Mutex<Option<oneshot::Sender<ObservationResult>>>,
}

impl MacosWkRoleSessionObservationContext {
    fn finish(&self, result: ObservationResult) {
        if let Ok(mut sender) = self.sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(result);
        }
    }
}

unsafe extern "C" {
    fn rion_wk_observe_role_session_public_evidence(
        data_store_identifier_bytes: *const u8,
        context: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, i32, u64, u64, u64),
        context_destructor: unsafe extern "C" fn(*mut c_void),
    ) -> bool;
}

unsafe extern "C" fn observe_role_session_public_evidence_callback(
    raw_context: *mut c_void,
    status: i32,
    cookie_count: u64,
    http_only_cookie_count: u64,
    local_storage_record_count: u64,
) {
    if raw_context.is_null() {
        return;
    }
    let context = unsafe { &*(raw_context.cast::<MacosWkRoleSessionObservationContext>()) };
    let result = if status != WK_ROLE_SESSION_PUBLIC_EVIDENCE_OBSERVED
        || http_only_cookie_count > cookie_count
    {
        Err(wkwebview_public_observation_error())
    } else {
        Ok(MacosWkRoleSessionPublicObservation {
            cookie_count,
            http_only_cookie_count,
            local_storage_record_count,
        })
    };
    context.finish(result);
}

unsafe extern "C" fn destroy_role_session_public_evidence_context(raw_context: *mut c_void) {
    if !raw_context.is_null() {
        drop(unsafe { Arc::from_raw(raw_context.cast::<MacosWkRoleSessionObservationContext>()) });
    }
}

/// Observes only the public macOS 14 WebKit capability surface. The two exact
/// callbacks are event-bound and carry no timer. Their counts are diagnostic
/// evidence only: this function never claims a stable or complete inventory.
pub(in crate::system_runtime) async fn observe_macos_wk_role_session_public_evidence(
    app: &AppHandle,
    data_store_identifier: [u8; 16],
) -> RuntimeResult<MacosWkRoleSessionPublicObservation> {
    let (sender, receiver) = oneshot::channel();
    let context = Arc::new(MacosWkRoleSessionObservationContext {
        sender: Mutex::new(Some(sender)),
    });
    let scheduled_context = Arc::clone(&context);
    let schedule = app.run_on_main_thread(move || {
        let native_context = Arc::into_raw(Arc::clone(&scheduled_context))
            .cast_mut()
            .cast();
        let accepted = unsafe {
            rion_wk_observe_role_session_public_evidence(
                data_store_identifier.as_ptr(),
                native_context,
                observe_role_session_public_evidence_callback,
                destroy_role_session_public_evidence_context,
            )
        };
        if !accepted {
            unsafe { destroy_role_session_public_evidence_context(native_context) };
            scheduled_context.finish(Err(wkwebview_public_observation_error()));
        }
    });
    if schedule.is_err() {
        context.finish(Err(wkwebview_public_observation_error()));
    }
    drop(context);
    receiver.await.map_err(|_| {
        RuntimeError::new(
            "ROLE_SESSION_TRANSFER_WKWEBVIEW_EVENT_STREAM_CANCELLED",
            "The exact WKWebsiteDataStore public observation event stream stopped.",
        )
    })?
}

fn wkwebview_public_observation_error() -> RuntimeError {
    RuntimeError::new(
        "ROLE_SESSION_TRANSFER_WKWEBVIEW_PUBLIC_OBSERVATION_FAILED",
        "WKWebsiteDataStore could not provide both public capability observations.",
    )
}
