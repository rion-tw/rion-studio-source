//! Shared handle parsing and opaque focus identity; no native mutation or discovery.
#[cfg(any(windows, test))]
use napi::bindgen_prelude::{Buffer, Result};
use napi::{Error, Status};
#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(any(windows, test))]
use std::mem::size_of;

#[cfg(any(windows, test))]
pub(crate) fn parse_electron_native_handle(buffer: &Buffer, field: &str) -> Result<usize> {
    if buffer.len() != size_of::<usize>() {
        return Err(probe_error(
            Status::InvalidArg,
            format!("Electron returned an invalid {field} native-handle width."),
        ));
    }
    let mut bytes = [0_u8; size_of::<usize>()];
    bytes.copy_from_slice(buffer.as_ref());
    let address = usize::from_ne_bytes(bytes);
    if address == 0 {
        return Err(probe_error(
            Status::InvalidArg,
            format!("Electron returned a null {field} native handle."),
        ));
    }
    Ok(address)
}

/// Process/UI-thread-bound read-only observation. It identifies all three
/// native focus slots without exposing HWND addresses across the addon boundary.
#[cfg(any(windows, test))]
pub(crate) fn windows_focus_identity(
    process_id: u32,
    ui_thread_id: u32,
    foreground: usize,
    active: usize,
    focus: usize,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rion-windows-focus-observation-v1");
    hasher.update(process_id.to_le_bytes());
    hasher.update(ui_thread_id.to_le_bytes());
    for address in [foreground, active, focus] {
        hasher.update((address as u64).to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn probe_error(status: Status, message: impl Into<String>) -> Error {
    Error::new(status, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_identity_binds_every_focus_slot_and_the_calling_owner() {
        let baseline = windows_focus_identity(7, 9, 42, 43, 44);
        assert_eq!(baseline.len(), 64);
        assert_eq!(baseline, windows_focus_identity(7, 9, 42, 43, 44));
        for changed in [
            windows_focus_identity(8, 9, 42, 43, 44),
            windows_focus_identity(7, 10, 42, 43, 44),
            windows_focus_identity(7, 9, 45, 43, 44),
            windows_focus_identity(7, 9, 42, 45, 44),
            windows_focus_identity(7, 9, 42, 43, 45),
            windows_focus_identity(7, 9, 43, 42, 44),
        ] {
            assert_ne!(baseline, changed);
        }
    }

    #[test]
    fn native_handle_parsing_preserves_the_exact_nonzero_address() {
        for address in [1_usize, 42, usize::MAX] {
            let buffer = Buffer::from(address.to_ne_bytes().to_vec());
            assert_eq!(
                parse_electron_native_handle(&buffer, "parent").unwrap(),
                address
            );
        }
    }

    #[test]
    fn native_handle_parsing_rejects_null_and_wrong_width_before_native_access() {
        for bytes in [
            vec![],
            vec![1; size_of::<usize>() - 1],
            vec![1; size_of::<usize>() + 1],
            vec![0; size_of::<usize>()],
        ] {
            let error = parse_electron_native_handle(&Buffer::from(bytes), "parent").unwrap_err();
            assert_eq!(error.status, Status::InvalidArg);
            assert!(error.reason.contains("parent"));
        }
    }
}
