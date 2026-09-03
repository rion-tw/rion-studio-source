use napi::{Status, bindgen_prelude::Error};

pub(super) fn malformed_projection_error() -> Error {
    adapter_error(
        Status::InvalidArg,
        "The AppKit tab projection contains an invalid null byte.",
    )
}

pub(super) fn projection_readback_error() -> Error {
    adapter_error(
        Status::GenericFailure,
        "The AppKit controller did not retain the exact tab order and active identity.",
    )
}

pub(super) fn workspace_divider_projection_readback_error() -> Error {
    adapter_error(
        Status::GenericFailure,
        "The retained AppKit host did not preserve the exact native workspace-divider projection.",
    )
}

pub(super) fn malformed_handle_error() -> Error {
    adapter_error(
        Status::InvalidArg,
        "Electron returned a malformed native NSView handle.",
    )
}

pub(super) fn host_destroyed_error() -> Error {
    adapter_error(
        Status::InvalidArg,
        "The AppKit runtime host controller has already been destroyed.",
    )
}

pub(super) fn state_poisoned_error() -> Error {
    adapter_error(
        Status::GenericFailure,
        "The AppKit runtime host lifecycle state is unavailable.",
    )
}

pub(super) fn adapter_error(status: Status, message: impl Into<String>) -> Error {
    Error::new(status, message.into())
}
