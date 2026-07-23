export type RustBoundaryTargetCommit = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface RustBoundaryDebt {
  key: string;
  targetCommit: RustBoundaryTargetCommit;
  reason: string;
}

const debt = (
  key: string,
  targetCommit: RustBoundaryTargetCommit,
  reason: string
): RustBoundaryDebt => ({ key, targetCommit, reason });

/**
 * Exact production debt present when the 2.1 thin-TypeScript migration began.
 *
 * Architecture tests compare compiler-AST findings with this manifest in both
 * directions. New findings therefore fail immediately, while removing an item
 * requires deleting its manifest entry in the commit that transfers ownership.
 */
export const RUST_OWNED_MAIN_DEBT = {
  authoritativeMaps: [
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.handles",
      4,
      "External process and CDP session authority."
    ),
    debt(
      "src/main/core/ElectronBrowserActionAdapter.ts:ElectronBrowserActionAdapter.pendingActionCountsByRole",
      5,
      "Per-role browser action queue state."
    ),
    debt(
      "src/main/core/ElectronBrowserActionAdapter.ts:ElectronBrowserActionAdapter.roleTails",
      5,
      "Per-role browser action ordering."
    ),
    debt(
      "src/main/browser/WorkspaceResourceCoordinator.ts:WorkspaceResourceCoordinator.workspaces",
      5,
      "Workspace resource runtime authority."
    ),
    debt(
      "src/main/game-browser/CdnCompatibilityManager.ts:CdnCompatibilityManager.cache",
      8,
      "CDN detection cache and TTL authority."
    ),
    debt(
      "src/main/game-browser/CdnCompatibilityManager.ts:CdnCompatibilityManager.inFlightDetections",
      8,
      "CDN probe deduplication authority."
    ),
    debt(
      "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.externalRefreshStates",
      10,
      "External overlay refresh scheduling."
    ),
    debt(
      "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.contentRefreshStates",
      10,
      "Embedded overlay refresh scheduling."
    ),
    debt(
      "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.pendingClickStatuses",
      10,
      "Macro click status retention."
    ),
    debt(
      "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.previousMacroStatuses",
      10,
      "Macro status projection."
    ),
    debt(
      "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.previousRolePresentation",
      10,
      "Role status projection."
    )
  ],
  coreIntervals: [
    debt(
      "src/main/index.ts:performanceTelemetryTimer",
      9,
      "Performance sampling and persistence belong to Rust."
    )
  ],
  nodeIoImports: [
    debt("src/main/index.ts:node:fs", 9, "Startup and telemetry filesystem I/O."),
    debt("src/main/index.ts:node:fs/promises", 9, "Telemetry filesystem I/O."),
    debt("src/main/index.ts:node:os", 9, "Host performance sampling."),
    debt("src/main/logging/logSanitizer.ts:node:os", 9, "Path redaction inputs."),
    debt("src/main/logging/zipWriter.ts:node:fs", 9, "Diagnostic archive streaming."),
    debt("src/main/logging/zipWriter.ts:node:fs/promises", 9, "Diagnostic archive output."),
    debt(
      "src/main/portable/PortableDataManager.ts:node:fs/promises",
      7,
      "Portable file reading and writing."
    ),
    debt(
      "src/main/system-browser/SystemChromeCloser.ts:node:child_process",
      9,
      "System Chrome process control."
    )
  ],
  orchestrationMethods: [
    debt("src/main/browser/BrowserManager.ts:BrowserManager.invokeBrowserRuntime", 4, "External runtime transition bridge."),
    debt("src/main/browser/BrowserManager.ts:BrowserManager.launch", 4, "Embedded/external mode dispatch."),
    debt("src/main/browser/BrowserManager.ts:BrowserManager.launchWorkspace", 4, "Workspace mode dispatch."),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.listStatuses",
      4,
      "Embedded/external status projection."
    ),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.listWorkspaceDisplayReservations",
      4,
      "External display reservation projection."
    ),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.listWorkspaceRuntimeStatuses",
      4,
      "Embedded/external workspace projection."
    ),
    debt("src/main/browser/BrowserManager.ts:BrowserManager.stop", 4, "Embedded/external stop dispatch."),
    debt("src/main/browser/BrowserManager.ts:BrowserManager.stopWorkspace", 4, "Workspace stop dispatch."),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.withRoleOperation",
      6,
      "Mutation lease orchestration."
    ),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.launchExternal",
      4,
      "Embedded-to-external dispatch."
    ),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.launchExternalWorkspace",
      4,
      "Workspace external dispatch."
    ),
    debt(
      "src/main/browser/BrowserManager.ts:BrowserManager.recoverExternalRole",
      4,
      "External recovery orchestration."
    ),
    debt("src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.deleteSession", 4, "External session cleanup."),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.handleAutomationDisconnect",
      4,
      "CDP recovery decision."
    ),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.handleHealthChange",
      4,
      "External health transition."
    ),
    debt("src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.invokeSession", 4, "Granular session bridge."),
    debt("src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.launch", 4, "External role launch."),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.launchSession",
      4,
      "Process/CDP launch saga."
    ),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.launchWorkspace",
      4,
      "External workspace launch saga."
    ),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.listStatuses",
      4,
      "External status projection."
    ),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.listWorkspaceRuntimeStatuses",
      4,
      "External workspace projection."
    ),
    debt("src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.recover", 4, "External recovery saga."),
    debt("src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.stop", 4, "External role stop."),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.stopForRecovery",
      4,
      "External recovery cleanup."
    ),
    debt(
      "src/main/browser/ExternalChromeManager.ts:ExternalChromeManager.stopWorkspace",
      4,
      "External workspace rollback."
    )
  ],
  promiseTails: [
    debt(
      "src/main/browser/ElectronAutomationTarget.ts:ElectronAutomationTarget.inputDispatchTail",
      5,
      "Embedded input ordering."
    ),
    debt(
      "src/main/browser/WorkspaceResourceCoordinator.ts:WorkspaceResourceCoordinator.tail",
      5,
      "Resource effect ordering."
    ),
    debt(
      "src/main/persistence/SerialTaskQueue.ts:SerialTaskQueue.tail",
      6,
      "Cross-store mutation ordering."
    ),
    debt("src/main/logging/LogService.ts:LogService.queue", 9, "Log batching and flush ordering.")
  ],
  specializedNapiMethods: [
    debt("acquireBrowserOperation", 3, "Operation leases move behind invoke."),
    debt("alignExternalChromeWindow", 4, "External window operation actor effect."),
    debt("cancelWait", 5, "Scheduler cancellation moves behind invoke."),
    debt("captureExternalChromeDiagnostics", 4, "External diagnostics command."),
    debt("clearEmbeddedKeys", 5, "Held-key shutdown command."),
    debt("completeBrowserOperation", 3, "Operation leases move behind invoke."),
    debt("completeEmbeddedKeyTransition", 5, "Embedded effect acknowledgement."),
    debt("connectExternalChromeCdp", 4, "External CDP is Rust-owned."),
    debt("createWorkspaceDividers", 3, "Layout decision command."),
    debt("dispatchBrowserResults", 11, "Replaced by generic core effect results after browser cutover."),
    debt("dispatchExternalBrowserActions", 4, "External actions execute inside Rust."),
    debt("evaluateExternalChrome", 4, "External CDP command."),
    debt("findSystemChromeExecutable", 4, "External launch command."),
    debt("focusExternalChrome", 4, "External focus command."),
    debt("hasEmbeddedHeldKeys", 5, "Held-key state remains internal to Rust."),
    debt("invokeBrowserRuntime", 3, "Replaced by high-level invoke commands."),
    debt("invokeExternalSession", 4, "External session state remains internal to Rust."),
    debt("invokeResourceRuntime", 5, "Resource state remains internal to Rust."),
    debt("normalizeWorkspaceRects", 3, "Layout decision command."),
    debt("prepareEmbeddedKeyTransition", 5, "Embedded input effect."),
    debt("prepareExternalChromeProfile", 7, "Profile import operation actor."),
    debt("reassertEmbeddedKeys", 5, "Held-key recovery effect."),
    debt("replaceCdnRules", 8, "CDN rule update command."),
    debt("resizeWorkspaceDivider", 3, "Layout decision command."),
    debt("resolveAdaptiveWorkspaceZoom", 3, "Layout decision command."),
    debt("resolveResourcePolicy", 5, "Resource policy remains internal to Rust."),
    debt("resolveRolePaths", 7, "Profile filesystem operation."),
    debt("resolveWorkspaceLayout", 3, "Layout decision command."),
    debt("rewriteCdnUrl", 8, "Renamed to the explicit synchronous CDN hot path."),
    debt("scheduleWait", 5, "Scheduling remains internal to Rust."),
    debt("setExternalChromeWindowBounds", 4, "External window operation actor effect."),
    debt("unregisterExternalChromeAutomation", 4, "External CDP lifecycle remains internal to Rust."),
    debt("updateSystemPressureSignals", 5, "Pressure sampling enters via typed command/event.")
  ]
} satisfies Record<string, RustBoundaryDebt[]>;
