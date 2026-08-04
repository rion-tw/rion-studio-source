mod app;
mod bootstrap_settings;
mod browser_action_effects;
mod browser_operations;
mod browser_runtime;
mod chrome_profile_import;
mod database;
mod diagnostics;
mod domain;
mod embedded_input;
mod engine_resolution;
mod error;
mod font_catalog;
mod layout;
mod legal;
mod log_capture;
mod macro_graph;
mod macro_runtime;
mod model;
pub mod operation_actor;
mod overlay;
mod portable;
mod role_browser_data;
mod runtime_sequence;
mod scheduler;
mod session_import;
mod system_fonts;
mod telemetry;
mod windows_graphics_events;

pub use app::{AppCore, BrowserLaunchCompletionRecord};
pub use bootstrap_settings::additional_browser_arguments;
pub use error::{CoreError, CoreErrorPayload, CoreResult};
pub use legal::current_versions as current_legal_document_versions;
pub use model::{
    AppCoreOptions, AppUpdateInstallAttemptRecord, AppUpdateStatusRecord,
    ApplicationDiagnosticsSnapshotRecord, ApplicationLifecycleStatusRecord, BrowserAction,
    BrowserActionRequest, BrowserActionResult, BrowserEngineResolutionRecord,
    BrowserFontCatalogEntryRecord, BrowserFontInstallResultRecord, BrowserFontRuntimeFaceRecord,
    BrowserFontRuntimePayloadRecord, BrowserFontSelectionRecord, BrowserFontSettingsRecord,
    BrowserHostKind, BrowserOperationLease, BrowserOperationRequest,
    BrowserPerformanceDiagnosticStatus, BrowserPerformanceDiagnosticsRecord,
    BrowserPerformanceSettingsRecord, BrowserPerformanceSurfaceDiagnosticRecord,
    BrowserRoleStatusRecord, BrowserRuntimeCommand, BrowserRuntimeResult,
    BrowserRuntimeRoleOwnerRecord, BrowserRuntimeRoleRecord, BrowserRuntimeSnapshot,
    BrowserRuntimeTabRecord, BrowserRuntimeWindowRecord, BrowserRuntimeWorkspaceRecord,
    BrowserWorkspaceStatusRecord, BulkDeleteResultRecord, BulkDeleteSkippedItemRecord,
    ChromeProfileEntryRecord, ChromeProfileImportAuthStateRecord,
    ChromeProfileImportItemResultRecord, ChromeProfileImportPreviewRecord,
    ChromeProfileImportProgressRecord, ChromeProfileImportResolutionRecord,
    ChromeProfileImportResultRecord, ChromeProfileImportUnsupportedCountsRecord, CoreCommand,
    CoreEffectAction, CoreEffectDispatchReport, CoreEffectMetricsRecord, CoreEffectRequest,
    CoreEffectResult, CoreEffectTarget, CoreEffectTargetKind, CoreEvent, CoreStateSnapshotRecord,
    CountedLatencySummaryRecord, DiagnosticDisplayRecord, DiagnosticExportResultRecord,
    DisplayFingerprintRecord, DisplayInfoRecord, DisplayTargetRecord,
    DisplayTopologySnapshotRecord, EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord,
    EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
    EmbeddedRoleSlotEffectRecord, EmbeddedRoleViewEffectRecord, EmbeddedTabEffectRecord,
    EngineCapabilityEvidenceRecord, EngineCapabilitySnapshotRecord, EngineCapabilityStatus,
    GameBrowserSettingsPatchRecord, GameBrowserSettingsRecord, GameCreateInputRecord,
    GameCreateRequest, GameUpdateInputRecord, GameUpdateRequest, GameWindowCreateInputRecord,
    GameWindowDisplayRemapRecord, GameWindowPlacementRecord, GameWindowRoleSlotRecord,
    GameWindowRoleViewRecord, GameWindowSaveRuntimeInputRecord, GameWindowTabRecord,
    GameWindowUpdateInputRecord, HighRefreshRateDiagnosticStatus, LatencySummaryRecord,
    LayoutBounds, LayoutDividerBounds, LayoutDividerInput, LayoutRect, LayoutRoleBounds,
    LayoutRoleInput, LegalAcceptDocumentsInputRecord, LegalAcceptanceRecord,
    LegalAcceptanceStatusRecord, LegalDocumentVersionsRecord, LocalStorageEntryRecord,
    LogCaptureRecord, LogEntry, LogErrorDetails, LogLevel, LogPageRecord, LogQuery, LogSource,
    LogStorageStatusRecord, MacroBadgePositionRecord, MacroCoordinateRecord,
    MacroCreateInputRecord, MacroCreateRequest, MacroDefinition, MacroInputDiagnosticsRecord,
    MacroInputEpochRecord, MacroInputRoleDiagnosticRecord, MacroInvocationRequest, MacroLastClick,
    MacroOverlayRequestRecord, MacroOverlayStartSummaryRecord, MacroOverlayViewModelRecord,
    MacroPressInvocationRequest, MacroPressRequest, MacroReleaseRequest, MacroRepeat,
    MacroRunStatus, MacroRuntimeSettings, MacroSettingsRecord, MacroShortcutSourceScope,
    MacroStartRequest, MacroStepDefinition, MacroStepInputRecord, MacroTrigger,
    MacroUpdateInputRecord, MacroUpdateRequest, NativeWindowStateRecord,
    OperationCancelResultRecord, PerformanceTelemetryRecord, PortableDataRecord,
    PortableDataSelectionRecord, PortableExportResultRecord, PortableGameRecord,
    PortableGameWindowRecord, PortableImportOperationSummaryRecord, PortableImportOperationsRecord,
    PortableImportPreviewRecord, PortableImportResultRecord, PortableImportWarningRecord,
    PortableLaunchWorkspaceRecord, PortableMacroConflictCandidateRecord,
    PortableMacroConflictRecord, PortableMacroConflictResolutionRecord, PortableMacroRecord,
    PortablePreferencesRecord, PortableRoleRecord, ResolvedBrowserEngine, RoleCreateInputRecord,
    RoleCreateRequest, RoleGameAssignmentRecord, RolePathsRecord, RoleUpdateInputRecord,
    RoleUpdateRequest, RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord,
    RuntimeRestoreWindowRecord, RuntimeRoleSlotInputRecord, RuntimeRoleSlotRecord,
    RuntimeTabActivationAcknowledgementRecord, RuntimeTabActivationRequestRecord,
    RuntimeTabChromeAcknowledgementRecord, RuntimeTabChromeItemRecord,
    RuntimeTabChromeProjectionRecord, RuntimeTabChromeReadyRecord, RuntimeTabDragSessionRecord,
    RuntimeTabMoveResultRecord, RuntimeTabMutationRequestRecord, RuntimeWindowPreferencesRecord,
    SessionCookieRecord, SessionTransferPayloadRecord, StateCollection, StateGameRecord,
    StateGameWindowRecord, StateLaunchWorkspaceRecord, StateMacroRecord, StateNormalizedRectRecord,
    StatePixelBoundsRecord, StateResolutionRecord, StateRoleRecord, StateWebGraphicsRecord,
    StateWorkspaceSlotRecord, SurfaceRecoveryAttemptRecord, SystemFontFamilyRecord,
    SystemRuntimeDiagnosticsRecord, SystemRuntimeFailureRecord, SystemRuntimeInputFenceEventRecord,
    SystemRuntimeInputFenceRecord, SystemRuntimeOperationCompletionScope,
    SystemRuntimeOperationStatus, SystemRuntimeOperationSubsystem,
    SystemRuntimeOperationSummaryRecord, SystemWebViewIssueReason, SystemWebViewProbeRecord,
    SystemWebViewRuntimeRegistrationRecord, TelemetryMetric, TelemetrySampleRecord,
    WindowsGraphicsEventCollectionRecord, WindowsGraphicsEventRecord,
    WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord, WorkspaceCreateRequest,
    WorkspaceDividerDescriptor, WorkspaceDividerResizeInput, WorkspaceDividerResizeOutput,
    WorkspaceLayoutInput, WorkspaceLayoutOutput, WorkspaceSlotInputRecord, WorkspaceSlotRequest,
    WorkspaceUpdateInputRecord, WorkspaceUpdateRequest,
};
pub use portable::PORTABLE_SCHEMA_VERSION;

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod contract_generation;
