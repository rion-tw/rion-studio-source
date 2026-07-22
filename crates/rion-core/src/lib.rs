mod app;
mod bootstrap_settings;
mod browser_operations;
mod browser_preferences;
mod browser_runtime;
mod cdn;
mod chrome_cookies;
mod chrome_profile_import;
mod compatibility_runtime;
mod database;
mod domain;
mod embedded_input;
mod error;
mod external_automation;
mod external_chrome;
mod external_health;
mod external_processes;
mod external_sessions;
mod layout;
mod legal;
mod macro_graph;
mod macro_runtime;
mod model;
mod portable;
mod pressure;
mod resource;
mod resource_runtime;
mod role_browser_data;
mod scheduler;
mod system_fonts;
mod windows_graphics_events;

pub use app::AppCore;
pub use bootstrap_settings::read_graphics_settings as read_bootstrap_graphics_settings;
pub use error::{CoreError, CoreErrorPayload, CoreResult};
pub use external_chrome::{CdpEvent, ExternalChromeCdpSession};
pub use model::{
    AppCoreOptions, BrowserAction, BrowserActionRequest, BrowserActionResult,
    BrowserCdnCompatibilityRecord, BrowserFontSettingsRecord, BrowserGraphicsBackendSettingsRecord,
    BrowserGraphicsSettingsRecord, BrowserNetworkSettingsRecord, BrowserOperationLease,
    BrowserOperationRequest, BrowserProxySettingsRecord, BrowserRuntimeCommand,
    BrowserRuntimeDisplayRecord, BrowserRuntimeResult, BrowserRuntimeRoleRecord,
    BrowserRuntimeSnapshot, BrowserRuntimeTabRecord, BrowserRuntimeWorkspaceRecord, CdnRule,
    ChromeProfileEntryRecord, ChromeProfileImportCommitRecord, ChromeProfileImportPrepareRecord,
    ChromeProfileImportPreviewRecord, ChromeProfileImportRequest, ChromeProfileImportResultRecord,
    ChromeProfileImportWarningRecord, ChromeProfileImportedSessionRecord,
    CompatibilityCheckOutcome, CompatibilityCheckPlanRecord, CompatibilityRunPhase,
    CompatibilityRunStatusRecord, CompatibilityVersionRecord, CoreCommand, CoreEvent,
    CoreStateSnapshotRecord, EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord,
    ExternalBrowserActionDispatch, ExternalSessionCommand, ExternalSessionRecord,
    ExternalSessionResult, GameBrowserSettingsRecord, GameCreateInputRecord, GameCreateRequest,
    GameUpdateInputRecord, GameUpdateRequest, LayoutBounds, LayoutDividerBounds,
    LayoutDividerInput, LayoutRect, LayoutRoleBounds, LayoutRoleInput,
    LegalAcceptDocumentsInputRecord, LegalAcceptanceRecord, LegalAcceptanceStatusRecord,
    LegalDocumentVersionsRecord, LogEntry, LogErrorDetails, LogLevel, LogQuery, LogSource,
    MacroBadgePositionRecord, MacroCreateInputRecord, MacroCreateRequest, MacroDefinition,
    MacroInvocationRequest, MacroLastClick, MacroPressInvocationRequest, MacroPressRequest,
    MacroReleaseRequest, MacroRepeat, MacroRunStatus, MacroRuntimeSettings, MacroSettingsRecord,
    MacroStartRequest, MacroStepDefinition, MacroStepInputRecord, MacroTrigger,
    MacroUpdateInputRecord, MacroUpdateRequest, PortableDataRecord, PortableDataSelectionRecord,
    PortableGameRecord, PortableImportOperationSummaryRecord, PortableImportOperationsRecord,
    PortableImportPreviewRecord, PortableImportResultRecord, PortableImportWarningRecord,
    PortableLaunchWorkspaceRecord, PortableMacroConflictCandidateRecord,
    PortableMacroConflictRecord, PortableMacroConflictResolutionRecord, PortableMacroRecord,
    PortablePreferencesRecord, PortableRoleRecord, PressureLevel, ResourcePolicyDecision,
    ResourcePolicyInput, ResourceRuntimeCommand, ResourceRuntimeEffectRecord,
    ResourceRuntimeResult, ResourceRuntimeStatusRecord, ResourceRuntimeTargetRecord,
    RoleCreateInputRecord, RoleCreateRequest, RoleGameAssignmentRecord, RolePathsRecord,
    RoleUpdateInputRecord, RoleUpdateRequest, RuntimeWindowPreferencesRecord, StateCollection,
    StateCompatibilityChromeRecord, StateCompatibilityLoadRecord,
    StateCompatibilityObservationsRecord, StateCompatibilityRecommendationRecord,
    StateCompatibilityReportRecord, StateGameRecord, StateLaunchWorkspaceRecord, StateMacroRecord,
    StateNormalizedRectRecord, StatePixelBoundsRecord, StateResolutionRecord, StateRoleRecord,
    StateWebGraphicsRecord, StateWorkspaceDisplayFingerprintRecord,
    StateWorkspaceDisplayTargetRecord, StateWorkspaceResourcePolicyRecord,
    StateWorkspaceSlotRecord, SystemFontFamilyRecord, SystemPressureSnapshot,
    WindowsGraphicsEventCollectionRecord, WindowsGraphicsEventRecord,
    WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord, WorkspaceCreateRequest,
    WorkspaceDisplayInfoRecord, WorkspaceDividerDescriptor, WorkspaceDividerResizeInput,
    WorkspaceDividerResizeOutput, WorkspaceLayoutInput, WorkspaceLayoutOutput,
    WorkspaceSlotInputRecord, WorkspaceSlotRequest, WorkspaceUpdateInputRecord,
    WorkspaceUpdateRequest,
};

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod generated_contract_tests {
    use std::{fs, path::PathBuf};

    #[test]
    fn export_bindings_index() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/shared/generated/index.ts");
        fs::write(
            path,
            concat!(
                "// Generated by ts-rs from crates/rion-core. Do not edit exported type files by hand.\n",
                "export type { BrowserActionRequest } from \"./BrowserActionRequest\";\n",
                "export type { BrowserAction } from \"./BrowserAction\";\n",
                "export type { BrowserActionResult } from \"./BrowserActionResult\";\n",
                "export type { BrowserOperationLease } from \"./BrowserOperationLease\";\n",
                "export type { BrowserOperationRequest } from \"./BrowserOperationRequest\";\n",
                "export type { BrowserCdnCompatibilityRecord } from \"./BrowserCdnCompatibilityRecord\";\n",
                "export type { BrowserFontSettingsRecord } from \"./BrowserFontSettingsRecord\";\n",
                "export type { BrowserGraphicsBackendSettingsRecord } from \"./BrowserGraphicsBackendSettingsRecord\";\n",
                "export type { BrowserGraphicsSettingsRecord } from \"./BrowserGraphicsSettingsRecord\";\n",
                "export type { BrowserNetworkSettingsRecord } from \"./BrowserNetworkSettingsRecord\";\n",
                "export type { BrowserProxySettingsRecord } from \"./BrowserProxySettingsRecord\";\n",
                "export type { BrowserRuntimeCommand } from \"./BrowserRuntimeCommand\";\n",
                "export type { BrowserRuntimeDisplayRecord } from \"./BrowserRuntimeDisplayRecord\";\n",
                "export type { BrowserRuntimeResult } from \"./BrowserRuntimeResult\";\n",
                "export type { BrowserRuntimeRoleRecord } from \"./BrowserRuntimeRoleRecord\";\n",
                "export type { BrowserRuntimeSnapshot } from \"./BrowserRuntimeSnapshot\";\n",
                "export type { BrowserRuntimeTabRecord } from \"./BrowserRuntimeTabRecord\";\n",
                "export type { BrowserRuntimeWorkspaceRecord } from \"./BrowserRuntimeWorkspaceRecord\";\n",
                "export type { CdnRule } from \"./CdnRule\";\n",
                "export type { ChromeProfileEntryRecord } from \"./ChromeProfileEntryRecord\";\n",
                "export type { ChromeProfileImportCommitRecord } from \"./ChromeProfileImportCommitRecord\";\n",
                "export type { ChromeProfileImportPrepareRecord } from \"./ChromeProfileImportPrepareRecord\";\n",
                "export type { ChromeProfileImportPreviewRecord } from \"./ChromeProfileImportPreviewRecord\";\n",
                "export type { ChromeProfileImportRequest } from \"./ChromeProfileImportRequest\";\n",
                "export type { ChromeProfileImportResultRecord } from \"./ChromeProfileImportResultRecord\";\n",
                "export type { ChromeProfileImportWarningRecord } from \"./ChromeProfileImportWarningRecord\";\n",
                "export type { ChromeProfileImportedSessionRecord } from \"./ChromeProfileImportedSessionRecord\";\n",
                "export type { CompatibilityCheckOutcome } from \"./CompatibilityCheckOutcome\";\n",
                "export type { CompatibilityCheckPlanRecord } from \"./CompatibilityCheckPlanRecord\";\n",
                "export type { CompatibilityRunPhase } from \"./CompatibilityRunPhase\";\n",
                "export type { CompatibilityRunStatusRecord } from \"./CompatibilityRunStatusRecord\";\n",
                "export type { CompatibilityVersionRecord } from \"./CompatibilityVersionRecord\";\n",
                "export type { CoreErrorPayload } from \"./CoreErrorPayload\";\n",
                "export type { CoreCommand } from \"./CoreCommand\";\n",
                "export type { CoreEvent } from \"./CoreEvent\";\n",
                "export type { CoreStateSnapshotRecord } from \"./CoreStateSnapshotRecord\";\n",
                "export type { EmbeddedKeyEffectRecord } from \"./EmbeddedKeyEffectRecord\";\n",
                "export type { EmbeddedKeyTransitionRecord } from \"./EmbeddedKeyTransitionRecord\";\n",
                "export type { ExternalBrowserActionDispatch } from \"./ExternalBrowserActionDispatch\";\n",
                "export type { ExternalSessionCommand } from \"./ExternalSessionCommand\";\n",
                "export type { ExternalSessionRecord } from \"./ExternalSessionRecord\";\n",
                "export type { ExternalSessionResult } from \"./ExternalSessionResult\";\n",
                "export type { GameBrowserSettingsRecord } from \"./GameBrowserSettingsRecord\";\n",
                "export type { GameCreateInputRecord } from \"./GameCreateInputRecord\";\n",
                "export type { GameCreateRequest } from \"./GameCreateRequest\";\n",
                "export type { GameUpdateInputRecord } from \"./GameUpdateInputRecord\";\n",
                "export type { GameUpdateRequest } from \"./GameUpdateRequest\";\n",
                "export type { LayoutBounds } from \"./LayoutBounds\";\n",
                "export type { LayoutDividerBounds } from \"./LayoutDividerBounds\";\n",
                "export type { LayoutDividerInput } from \"./LayoutDividerInput\";\n",
                "export type { LayoutRect } from \"./LayoutRect\";\n",
                "export type { LayoutRoleBounds } from \"./LayoutRoleBounds\";\n",
                "export type { LayoutRoleInput } from \"./LayoutRoleInput\";\n",
                "export type { LegalAcceptanceRecord } from \"./LegalAcceptanceRecord\";\n",
                "export type { LegalAcceptDocumentsInputRecord } from \"./LegalAcceptDocumentsInputRecord\";\n",
                "export type { LegalAcceptanceStatusRecord } from \"./LegalAcceptanceStatusRecord\";\n",
                "export type { LegalDocumentVersionsRecord } from \"./LegalDocumentVersionsRecord\";\n",
                "export type { LogEntry } from \"./LogEntry\";\n",
                "export type { LogErrorDetails } from \"./LogErrorDetails\";\n",
                "export type { LogLevel } from \"./LogLevel\";\n",
                "export type { LogQuery } from \"./LogQuery\";\n",
                "export type { LogSource } from \"./LogSource\";\n",
                "export type { MacroBadgePositionRecord } from \"./MacroBadgePositionRecord\";\n",
                "export type { MacroCreateInputRecord } from \"./MacroCreateInputRecord\";\n",
                "export type { MacroCreateRequest } from \"./MacroCreateRequest\";\n",
                "export type { MacroDefinition } from \"./MacroDefinition\";\n",
                "export type { MacroInvocationRequest } from \"./MacroInvocationRequest\";\n",
                "export type { MacroLastClick } from \"./MacroLastClick\";\n",
                "export type { MacroPressInvocationRequest } from \"./MacroPressInvocationRequest\";\n",
                "export type { MacroPressRequest } from \"./MacroPressRequest\";\n",
                "export type { MacroReleaseRequest } from \"./MacroReleaseRequest\";\n",
                "export type { MacroRepeat } from \"./MacroRepeat\";\n",
                "export type { MacroRunStatus } from \"./MacroRunStatus\";\n",
                "export type { MacroRuntimeSettings } from \"./MacroRuntimeSettings\";\n",
                "export type { MacroSettingsRecord } from \"./MacroSettingsRecord\";\n",
                "export type { MacroStartRequest } from \"./MacroStartRequest\";\n",
                "export type { MacroStepDefinition } from \"./MacroStepDefinition\";\n",
                "export type { MacroStepInputRecord } from \"./MacroStepInputRecord\";\n",
                "export type { MacroTrigger } from \"./MacroTrigger\";\n",
                "export type { MacroUpdateInputRecord } from \"./MacroUpdateInputRecord\";\n",
                "export type { MacroUpdateRequest } from \"./MacroUpdateRequest\";\n",
                "export type { PressureLevel } from \"./PressureLevel\";\n",
                "export type { PortableDataRecord } from \"./PortableDataRecord\";\n",
                "export type { PortableDataSelectionRecord } from \"./PortableDataSelectionRecord\";\n",
                "export type { PortableGameRecord } from \"./PortableGameRecord\";\n",
                "export type { PortableImportOperationSummaryRecord } from \"./PortableImportOperationSummaryRecord\";\n",
                "export type { PortableImportOperationsRecord } from \"./PortableImportOperationsRecord\";\n",
                "export type { PortableImportPreviewRecord } from \"./PortableImportPreviewRecord\";\n",
                "export type { PortableImportResultRecord } from \"./PortableImportResultRecord\";\n",
                "export type { PortableImportWarningRecord } from \"./PortableImportWarningRecord\";\n",
                "export type { PortableLaunchWorkspaceRecord } from \"./PortableLaunchWorkspaceRecord\";\n",
                "export type { PortableMacroConflictCandidateRecord } from \"./PortableMacroConflictCandidateRecord\";\n",
                "export type { PortableMacroConflictRecord } from \"./PortableMacroConflictRecord\";\n",
                "export type { PortableMacroConflictResolutionRecord } from \"./PortableMacroConflictResolutionRecord\";\n",
                "export type { PortableMacroRecord } from \"./PortableMacroRecord\";\n",
                "export type { PortablePreferencesRecord } from \"./PortablePreferencesRecord\";\n",
                "export type { PortableRoleRecord } from \"./PortableRoleRecord\";\n",
                "export type { ResourcePolicyDecision } from \"./ResourcePolicyDecision\";\n",
                "export type { ResourcePolicyInput } from \"./ResourcePolicyInput\";\n",
                "export type { ResourceRuntimeCommand } from \"./ResourceRuntimeCommand\";\n",
                "export type { ResourceRuntimeEffectRecord } from \"./ResourceRuntimeEffectRecord\";\n",
                "export type { ResourceRuntimeResult } from \"./ResourceRuntimeResult\";\n",
                "export type { ResourceRuntimeStatusRecord } from \"./ResourceRuntimeStatusRecord\";\n",
                "export type { ResourceRuntimeTargetRecord } from \"./ResourceRuntimeTargetRecord\";\n",
                "export type { RoleCreateInputRecord } from \"./RoleCreateInputRecord\";\n",
                "export type { RoleCreateRequest } from \"./RoleCreateRequest\";\n",
                "export type { RoleGameAssignmentRecord } from \"./RoleGameAssignmentRecord\";\n",
                "export type { RolePathsRecord } from \"./RolePathsRecord\";\n",
                "export type { RoleUpdateInputRecord } from \"./RoleUpdateInputRecord\";\n",
                "export type { RoleUpdateRequest } from \"./RoleUpdateRequest\";\n",
                "export type { RuntimeWindowPreferencesRecord } from \"./RuntimeWindowPreferencesRecord\";\n",
                "export type { StateCollection } from \"./StateCollection\";\n",
                "export type { StateCompatibilityChromeRecord } from \"./StateCompatibilityChromeRecord\";\n",
                "export type { StateCompatibilityLoadRecord } from \"./StateCompatibilityLoadRecord\";\n",
                "export type { StateCompatibilityObservationsRecord } from \"./StateCompatibilityObservationsRecord\";\n",
                "export type { StateCompatibilityRecommendationRecord } from \"./StateCompatibilityRecommendationRecord\";\n",
                "export type { StateCompatibilityReportRecord } from \"./StateCompatibilityReportRecord\";\n",
                "export type { StateGameRecord } from \"./StateGameRecord\";\n",
                "export type { StateLaunchWorkspaceRecord } from \"./StateLaunchWorkspaceRecord\";\n",
                "export type { StateMacroRecord } from \"./StateMacroRecord\";\n",
                "export type { StateNormalizedRectRecord } from \"./StateNormalizedRectRecord\";\n",
                "export type { StatePixelBoundsRecord } from \"./StatePixelBoundsRecord\";\n",
                "export type { StateResolutionRecord } from \"./StateResolutionRecord\";\n",
                "export type { StateRoleRecord } from \"./StateRoleRecord\";\n",
                "export type { StateWebGraphicsRecord } from \"./StateWebGraphicsRecord\";\n",
                "export type { StateWorkspaceDisplayFingerprintRecord } from \"./StateWorkspaceDisplayFingerprintRecord\";\n",
                "export type { StateWorkspaceDisplayTargetRecord } from \"./StateWorkspaceDisplayTargetRecord\";\n",
                "export type { StateWorkspaceResourcePolicyRecord } from \"./StateWorkspaceResourcePolicyRecord\";\n",
                "export type { StateWorkspaceSlotRecord } from \"./StateWorkspaceSlotRecord\";\n",
                "export type { SystemPressureSnapshot } from \"./SystemPressureSnapshot\";\n",
                "export type { SystemFontFamilyRecord } from \"./SystemFontFamilyRecord\";\n",
                "export type { WorkspaceAppearanceSettingsRecord } from \"./WorkspaceAppearanceSettingsRecord\";\n",
                "export type { WorkspaceCreateInputRecord } from \"./WorkspaceCreateInputRecord\";\n",
                "export type { WorkspaceCreateRequest } from \"./WorkspaceCreateRequest\";\n",
                "export type { WorkspaceDisplayInfoRecord } from \"./WorkspaceDisplayInfoRecord\";\n",
                "export type { WorkspaceDividerDescriptor } from \"./WorkspaceDividerDescriptor\";\n",
                "export type { WorkspaceDividerResizeInput } from \"./WorkspaceDividerResizeInput\";\n",
                "export type { WorkspaceDividerResizeOutput } from \"./WorkspaceDividerResizeOutput\";\n",
                "export type { WorkspaceLayoutInput } from \"./WorkspaceLayoutInput\";\n",
                "export type { WorkspaceLayoutOutput } from \"./WorkspaceLayoutOutput\";\n",
                "export type { WorkspaceSlotInputRecord } from \"./WorkspaceSlotInputRecord\";\n",
                "export type { WorkspaceSlotRequest } from \"./WorkspaceSlotRequest\";\n",
                "export type { WorkspaceUpdateInputRecord } from \"./WorkspaceUpdateInputRecord\";\n",
                "export type { WorkspaceUpdateRequest } from \"./WorkspaceUpdateRequest\";\n",
                "export type { WindowsGraphicsEventCollectionRecord } from \"./WindowsGraphicsEventCollectionRecord\";\n",
                "export type { WindowsGraphicsEventRecord } from \"./WindowsGraphicsEventRecord\";\n",
            ),
        )
        .unwrap();
    }
}
