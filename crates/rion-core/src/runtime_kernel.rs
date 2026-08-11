//! Platform-neutral runtime topology, identity, and lifecycle authority.

mod ports;
mod state;
mod types;

pub use ports::{
    FocusPort, RuntimeNativeProjection, RuntimeNativeSurfaceFence, RuntimeNativeTabProjection,
    SurfacePort, TabChromePort, WindowPort, apply_runtime_native_projection,
};
pub use state::RuntimeKernel;
pub use types::{
    LaunchAttemptId, NativeRuntimeEvent, OperationId, RuntimeCommit, RuntimeCommitStatus,
    RuntimeDesiredEffect, RuntimeIntent, RuntimeLaunchAdmission, RuntimeLaunchDisposition,
    RuntimeLiveTabRecord, RuntimeLiveWindowRecord, RuntimeLogicalSurfaceRecord,
    RuntimeOperationPhase, RuntimeOperationRecord, RuntimeSnapshot, RuntimeSurfaceGeneration,
    RuntimeSurfaceLifecycle, RuntimeTabActivationRecord, RuntimeTabId, RuntimeTabTombstone,
    RuntimeTerminalEvent, RuntimeTopologyCommitInput, RuntimeWindowContextInitializeInput,
    RuntimeWindowGeneration, RuntimeWindowPlacementCommitInput, RuntimeWindowTopologyCommit,
};

#[cfg(test)]
mod tests;
