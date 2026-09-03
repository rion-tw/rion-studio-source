mod app;
mod bootstrap_settings;
mod browser_action_effects;
mod browser_operations;
mod browser_runtime;
mod chrome_profile_import;
mod chrome_profile_import_contract;
mod database;
mod diagnostics;
mod domain;
mod embedded_input;
mod engine_resolution;
mod error;
mod font_catalog;
mod global_web_profile;
mod layout;
mod legal;
mod log_capture;
mod macro_graph;
mod macro_runtime;
mod model;
pub mod operation_actor;
mod overlay;
mod popup_lifecycle;
mod portable;
mod role_browser_data;
mod runtime_kernel;
mod runtime_sequence;
mod runtime_window_visibility_replay;
mod scheduler;
mod session_import;
mod session_migration;
mod session_transfer;
mod system_fonts;
mod telemetry;
mod v23_role_initialization;
mod windows_graphics_events;

pub use app::{
    AppCore, AppCoreShutdownOutcome, BrowserLaunchCompletionRecord,
    CHROMIUM_RUNTIME_CONTRACT_VERSION, WindowsChromiumHeldKeyContinuityInput,
    WindowsChromiumHeldKeyContinuityReceipt,
};
pub use bootstrap_settings::additional_browser_arguments;
pub use chrome_profile_import_contract::{
    CHROME_PROFILE_IMPORT_CONTRACT_VERSION, CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES,
    CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES, ChromeProfileImportFreshVerificationReceipt,
    ChromeProfileImportTransactionAcquireInput, ChromeProfileImportTransactionDescriptor,
    ChromeProfileImportTransactionFence, ChromeProfileImportTransactionReleaseInput,
    ChromeProfileImportVaultEvidence,
};
pub use error::{CoreError, CoreErrorPayload, CoreResult};
pub use legal::current_versions as current_legal_document_versions;
pub use macro_runtime::{MacroInputRecoveryCompletion, MacroInputRecoveryTicket};
pub use model::{
    AppCoreOptions, AppKitRuntimeEventActionRecord, AppKitRuntimeEventReceiptRecord,
    AppKitRuntimeEventRecord, AppKitRuntimeHostIdentityRecord, AppKitRuntimeHostObservationRecord,
    AppKitRuntimeProjectionEffectRecord, AppKitRuntimeRoleLayoutRecord,
    AppKitRuntimeTabProjectionRecord, AppKitRuntimeWebSurfaceLayoutRecord,
    AppKitRuntimeWindowProjectionRecord, AppKitRuntimeWorkspaceDividerLayoutRecord,
    AppUpdateInstallAttemptRecord, AppUpdateStatusRecord, ApplicationDiagnosticsSnapshotRecord,
    ApplicationLifecycleStatusRecord, BrowserAction, BrowserActionRequest, BrowserActionResult,
    BrowserCanvasDiagnosticRecord, BrowserEngineResolutionRecord, BrowserFontCatalogEntryRecord,
    BrowserFontInstallResultRecord, BrowserFontRuntimeFaceRecord, BrowserFontRuntimePayloadRecord,
    BrowserFontSelectionRecord, BrowserFontSettingsRecord, BrowserHostKind,
    BrowserLaunchAdmissionCompletion, BrowserLaunchAdmissionRecord, BrowserOperationLease,
    BrowserOperationRequest, BrowserPerformanceDiagnosticOperationPhase,
    BrowserPerformanceDiagnosticOperationRecord, BrowserPerformanceDiagnosticStatus,
    BrowserPerformanceDiagnosticsRecord, BrowserPerformanceSettingsRecord,
    BrowserPerformanceSurfaceDiagnosticRecord, BrowserRoleReloadReceiptRecord,
    BrowserRoleStatusRecord, BrowserRuntimeCommand, BrowserRuntimeFailureReason,
    BrowserRuntimeRegistrationRecord, BrowserRuntimeResult, BrowserRuntimeRoleOwnerRecord,
    BrowserRuntimeRoleRecord, BrowserRuntimeSnapshot, BrowserRuntimeTabRecord,
    BrowserRuntimeWindowRecord, BrowserRuntimeWorkspaceRecord, BrowserTabReloadReceiptRecord,
    BrowserWebGlContextAttributesRecord, BrowserWorkspaceDividerHostIdentityRecord,
    BrowserWorkspaceDividerPlatform, BrowserWorkspaceDividerPointerPhase,
    BrowserWorkspaceDividerPointerReceiptRecord, BrowserWorkspaceDividerPointerRecord,
    BrowserWorkspaceStatusRecord, BulkDeleteResultRecord, BulkDeleteSkippedItemRecord,
    ChromeProfileEntryRecord, ChromeProfileImportAuthStateRecord,
    ChromeProfileImportItemResultRecord, ChromeProfileImportPreviewRecord,
    ChromeProfileImportProgressRecord, ChromeProfileImportResolutionRecord,
    ChromeProfileImportResultRecord, ChromeProfileImportUnsupportedCountsRecord,
    ChromiumPopupAdmissionRecord, ChromiumPopupCloseReason, ChromiumPopupDisposition,
    ChromiumPopupLifecycleActionRecord, ChromiumPopupLifecycleEventRecord,
    ChromiumPopupLifecyclePhase, ChromiumPopupLifecycleReceiptRecord,
    ChromiumPopupNativeHostReceiptRecord, ChromiumPopupOpenRequestRecord,
    ChromiumPopupOpenerPolicy, ChromiumPopupOwnerKind, ChromiumPopupParentFenceRecord,
    CoreAppSnapshotRecord, CoreCommand, CoreEffectAction, CoreEffectCancellationReason,
    CoreEffectCancellationRecord, CoreEffectDispatchReport, CoreEffectMetricsRecord,
    CoreEffectRequest, CoreEffectResult, CoreEffectTarget, CoreEffectTargetKind, CoreEvent,
    CoreStateSnapshotRecord, CountedLatencySummaryRecord, DiagnosticDisplayRecord,
    DiagnosticExportResultRecord, DisplayFingerprintRecord, DisplayInfoRecord, DisplayTargetRecord,
    DisplayTopologySnapshotRecord, EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord,
    EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
    EmbeddedRoleReloadFenceRecord, EmbeddedRoleReloadNativeReceiptRecord,
    EmbeddedRoleReloadPreparationRecord, EmbeddedRoleReloadSupersedeReceiptRecord,
    EmbeddedRoleSlotEffectRecord, EmbeddedRoleViewEffectRecord,
    EmbeddedRuntimeWindowProjectionRecord, EmbeddedRuntimeWorkspaceTabProjectionRecord,
    EmbeddedTabAudioMuteRoleEffectRecord, EmbeddedTabEffectRecord,
    EmbeddedTabRoleReloadNativeReceiptRecord, EmbeddedTabRoleReloadPreparationReceiptRecord,
    EmbeddedTabRoleReloadSupersedeReceiptRecord, EmbeddedWebSurfaceIdentityRecord,
    EmbeddedWebSurfaceLoadEffectRecord, EngineCapabilityEvidenceRecord,
    EngineCapabilitySnapshotRecord, EngineCapabilityStatus, GameBrowserSettingsPatchRecord,
    GameBrowserSettingsRecord, GameCreateInputRecord, GameCreateRequest, GameUpdateInputRecord,
    GameUpdateRequest, GameWindowCreateInputRecord, GameWindowDisplayRemapRecord,
    GameWindowPlacementRecord, GameWindowRoleSlotRecord, GameWindowRoleViewRecord,
    GameWindowRuntimeSnapshotBatchCommitInputRecord, GameWindowRuntimeSnapshotCommitInputRecord,
    GameWindowSaveRuntimeInputRecord, GameWindowTabRecord, GameWindowUpdateInputRecord,
    GlobalWebProfileClearReceiptRecord, GlobalWebProfilePathsRecord,
    HighRefreshRateDiagnosticStatus, LatencySummaryRecord, LayoutBounds, LayoutDividerBounds,
    LayoutDividerInput, LayoutRect, LayoutRoleBounds, LayoutRoleInput,
    LegalAcceptDocumentsInputRecord, LegalAcceptanceRecord, LegalAcceptanceStatusRecord,
    LegalDocumentVersionsRecord, LocalStorageEntryRecord, LogCaptureRecord, LogEntry,
    LogErrorDetails, LogLevel, LogPageRecord, LogQuery, LogSource, LogStorageStatusRecord,
    MacosHighRefreshMode, MacroBadgePositionRecord, MacroCoordinateContextRecord,
    MacroCoordinateRecord, MacroCreateInputRecord, MacroCreateRequest, MacroDefinition,
    MacroInputDiagnosticsRecord, MacroInputEpochRecord, MacroInputRecoveryCompletionReceiptRecord,
    MacroInputRecoveryFailureReceiptRecord, MacroInputRecoveryTicketRecord,
    MacroInputRoleDiagnosticRecord, MacroInvocationRequest, MacroLastClick,
    MacroOverlayRequestRecord, MacroOverlaySettingsPatchRecord, MacroOverlaySettingsRecord,
    MacroOverlayStartSummaryRecord, MacroOverlayViewModelRecord, MacroPressInvocationRequest,
    MacroPressRequest, MacroReleaseRequest, MacroRepeat, MacroRunStatus, MacroRuntimeSettings,
    MacroSettingsRecord, MacroShortcutSourceScope, MacroStartAttemptDiagnosticRecord,
    MacroStartRequest, MacroStepDefinition, MacroStepInputRecord, MacroTrigger,
    MacroUpdateInputRecord, MacroUpdateRequest, ManagedShortcutPhaseReceiptRecord,
    NativeWindowStateRecord, OperationCancelResultRecord, OperationCompletionPolicy,
    PerformanceTargetStatus, PerformanceTelemetryRecord, PortableDataRecord,
    PortableDataSelectionRecord, PortableExportResultRecord, PortableGameRecord,
    PortableGameWindowRecord, PortableImportOperationSummaryRecord, PortableImportOperationsRecord,
    PortableImportPreviewRecord, PortableImportResultRecord, PortableImportWarningRecord,
    PortableLaunchWorkspaceRecord, PortableMacroConflictCandidateRecord,
    PortableMacroConflictRecord, PortableMacroConflictResolutionRecord, PortableMacroRecord,
    PortablePreferencesRecord, PortableRoleRecord, QuickAccessItemRefRecord,
    QuickAccessPreferencesRecord, ResolvedBrowserEngine, RoleCreateInputRecord, RoleCreateRequest,
    RoleGameAssignmentRecord, RolePathsRecord, RoleUpdateInputRecord, RoleUpdateRequest,
    RuntimeLaunchDestinationRequest, RuntimeLaunchIntentReceiptRecord, RuntimeLaunchIntentRecord,
    RuntimeOperationTraceRecord, RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord,
    RuntimeRestoreWindowRecord, RuntimeRoleSlotInputRecord, RuntimeRoleSlotRecord,
    RuntimeTabActivationPhaseRecord, RuntimeTabChromeAcknowledgementRecord,
    RuntimeTabChromeItemRecord, RuntimeTabChromeProjectionRecord, RuntimeTabChromeReadyRecord,
    RuntimeTabDragSessionRecord, RuntimeTabIntentReceiptRecord, RuntimeTabIntentRecord,
    RuntimeTabMoveResultRecord, RuntimeTabMutationRequestRecord, RuntimeTabStatusIdentityRecord,
    RuntimeWindowPersistenceBatchReceiptRecord, RuntimeWindowPersistenceReceiptRecord,
    RuntimeWindowPreferencesRecord, RuntimeWindowProvisionReceiptRecord,
    RuntimeWindowProvisionTargetRecord, RuntimeWindowStopRequestRecord,
    RuntimeWindowTabSnapshotRecord, RuntimeWindowZoomNativeReceiptRecord,
    RuntimeWindowZoomReceiptRecord, SessionCookieRecord, SessionTransferPayloadRecord,
    StateCollection, StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord,
    StateMacroRecord, StateNormalizedRectRecord, StatePixelBoundsRecord, StateResolutionRecord,
    StateRoleRecord, StateWebGraphicsRecord, StateWorkspaceSlotRecord,
    SurfaceRecoveryAttemptRecord, SystemFontFamilyRecord, SystemRuntimeDiagnosticsRecord,
    SystemRuntimeFailureRecord, SystemRuntimeInputFenceEventRecord, SystemRuntimeInputFenceRecord,
    SystemRuntimeOperationCompletionScope, SystemRuntimeOperationStatus,
    SystemRuntimeOperationSubsystem, SystemRuntimeOperationSummaryRecord, SystemWebViewIssueReason,
    SystemWebViewProbeRecord, SystemWebViewRuntimeRegistrationRecord, TelemetryMetric,
    TelemetrySampleRecord, WebGlCommandBatchingStatus, WebGlExecutionPath,
    WindowsGraphicsEventCollectionRecord, WindowsGraphicsEventRecord,
    WindowsRuntimeWindowPlacementEventRecord, WindowsRuntimeWindowPlacementReceiptRecord,
    WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord, WorkspaceCreateRequest,
    WorkspaceDividerDescriptor, WorkspaceDividerResizeInput, WorkspaceDividerResizeOutput,
    WorkspaceLayoutInput, WorkspaceLayoutOutput, WorkspaceSlotInputRecord, WorkspaceSlotRequest,
    WorkspaceUpdateInputRecord, WorkspaceUpdateRequest, WorkspaceWebContentRecord,
};
pub use portable::PORTABLE_SCHEMA_VERSION;
pub use runtime_kernel::{
    FocusPort, LaunchAttemptId, NativeRuntimeEvent, OperationId, RuntimeCommit,
    RuntimeCommitStatus, RuntimeDesiredEffect, RuntimeIntent, RuntimeKernel,
    RuntimeLaunchAdmission, RuntimeLaunchDisposition, RuntimeLiveTabRecord,
    RuntimeLiveWindowRecord, RuntimeLogicalSurfaceRecord, RuntimeNativeProjection,
    RuntimeNativeSurfaceFence, RuntimeNativeTabProjection, RuntimeOperationPhase,
    RuntimeOperationRecord, RuntimeSnapshot, RuntimeSurfaceGeneration, RuntimeSurfaceLifecycle,
    RuntimeTabActivationRecord, RuntimeTabId, RuntimeTabTombstone, RuntimeTerminalEvent,
    RuntimeTopologyCommitInput, RuntimeWindowContextInitializeInput, RuntimeWindowGeneration,
    RuntimeWindowPlacementCommitInput, RuntimeWindowTopologyCommit, SurfacePort, TabChromePort,
    WindowPort, apply_runtime_native_projection,
};
pub use session_migration::{
    RoleSessionMigrationEngine, RoleSessionMigrationImportBeginInput, RoleSessionMigrationOutcome,
    RoleSessionMigrationPhase, RoleSessionMigrationPlatform, RoleSessionMigrationRecord,
    RoleSessionMigrationStartInput, RoleSessionMigrationTargetTransitionInput,
    RoleSessionMigrationTransitionInput,
};
pub use session_transfer::{
    ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES, ROLE_SESSION_TRANSFER_MAX_COOKIES,
    ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ENTRIES,
    ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ORIGINS, ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES,
    ROLE_SESSION_TRANSFER_VERSION, RoleSessionTransferByteEncoding, RoleSessionTransferBytesRecord,
    RoleSessionTransferCookieExpiry, RoleSessionTransferCookiePartitionCapability,
    RoleSessionTransferCookiePartitionEvidence, RoleSessionTransferCookieRecord,
    RoleSessionTransferCookieSameSite, RoleSessionTransferEnvelopeRecord,
    RoleSessionTransferFormat, RoleSessionTransferInventoryRecord,
    RoleSessionTransferJournalEvidence, RoleSessionTransferLocalStorageEntryRecord,
    RoleSessionTransferLocalStorageOriginRecord, RoleSessionTransferMetadataRecord,
    RoleSessionTransferSourceEvidenceKind, RoleSessionTransferSourceEvidenceRecord,
    read_webview2_local_storage_source_internal,
};

/// Resolves workspace surface geometry without entering [`AppCore`]. Native
/// window adapters use this during UI-thread resize callbacks, where re-entering
/// the command coordinator would risk a lock inversion.
pub fn resolve_workspace_layout(input: &WorkspaceLayoutInput) -> WorkspaceLayoutOutput {
    layout::resolve(input)
}

/// Builds the divider descriptors consumed by [`resolve_workspace_layout`].
/// This is kept beside the resolver so native and command-driven layouts share
/// the same edge matching rules.
pub fn create_workspace_dividers(roles: &[LayoutRoleInput]) -> Vec<WorkspaceDividerDescriptor> {
    layout::create_dividers(roles)
}

/// Resolves adaptive page zoom without re-entering [`AppCore`] from a native resize callback.
pub fn resolve_adaptive_zoom_percent(viewport_width: f64, current_percent: Option<u32>) -> u32 {
    layout::adaptive_zoom_percent(viewport_width, current_percent)
}

/// Resolves a divider drag without re-entering [`AppCore`] from an AppKit/Win32 callback.
pub fn resize_workspace_divider(
    input: &WorkspaceDividerResizeInput,
) -> Option<WorkspaceDividerResizeOutput> {
    layout::resize_divider(input)
}

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod contract_generation;
