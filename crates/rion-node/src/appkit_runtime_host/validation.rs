use std::{ffi::c_void, ptr::NonNull};

use napi::{Status, bindgen_prelude::Result};

use super::errors::{adapter_error, malformed_handle_error};

pub(super) fn validate_identifier(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.contains(['/', '\\', '\0'])
        || value
            .chars()
            .any(|character| character.is_control() || character == '\u{7f}')
    {
        return Err(adapter_error(
            Status::InvalidArg,
            format!("The AppKit {field} identity is invalid."),
        ));
    }
    Ok(())
}

pub(super) fn decode_native_view_handle(bytes: &[u8]) -> Result<NonNull<c_void>> {
    if bytes.len() != std::mem::size_of::<usize>() {
        return Err(malformed_handle_error());
    }
    let native_bytes: [u8; std::mem::size_of::<usize>()] =
        bytes.try_into().map_err(|_| malformed_handle_error())?;
    let address = usize::from_ne_bytes(native_bytes);
    if address == 0 || !address.is_multiple_of(std::mem::align_of::<usize>()) {
        return Err(malformed_handle_error());
    }
    NonNull::new(address as *mut c_void).ok_or_else(malformed_handle_error)
}

pub(super) fn parse_native_address(value: &str) -> Result<usize> {
    let address = usize::from_str_radix(value, 16).map_err(|_| {
        adapter_error(
            Status::InvalidArg,
            "The AppKit native-view probe address is invalid.",
        )
    })?;
    if address == 0
        || format!("{address:x}") != value
        || !address.is_multiple_of(std::mem::align_of::<usize>())
    {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit native-view probe address is invalid.",
        ));
    }
    Ok(address)
}
