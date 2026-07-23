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
      "src/main/system-browser/SystemChromeCloser.ts:node:child_process",
      9,
      "System Chrome process control."
    )
  ],
  orchestrationMethods: [],
  promiseTails: [
    debt("src/main/logging/LogService.ts:LogService.queue", 9, "Log batching and flush ordering.")
  ],
  specializedNapiMethods: [
    debt("acquireBrowserOperation", 3, "Operation leases move behind invoke."),
    debt("alignExternalChromeWindow", 4, "External window operation actor effect."),
    debt("browserStatuses", 11, "Synchronous status projection becomes a typed core event."),
    debt("browserWorkspaceStatuses", 11, "Synchronous workspace projection becomes a typed core event."),
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
    debt("invokeResourceRuntime", 11, "Resource state remains internal to Rust."),
    debt("normalizeWorkspaceRects", 3, "Layout decision command."),
    debt("prepareEmbeddedKeyTransition", 5, "Embedded input effect."),
    debt("prepareExternalChromeProfile", 7, "Profile import operation actor."),
    debt("reassertEmbeddedKeys", 5, "Held-key recovery effect."),
    debt("resizeWorkspaceDivider", 3, "Layout decision command."),
    debt("resolveAdaptiveWorkspaceZoom", 3, "Layout decision command."),
    debt("resolveResourcePolicy", 5, "Resource policy remains internal to Rust."),
    debt("resolveRolePaths", 7, "Profile filesystem operation."),
    debt("resolveWorkspaceLayout", 3, "Layout decision command."),
    debt("scheduleWait", 5, "Scheduling remains internal to Rust."),
    debt("setExternalChromeWindowBounds", 4, "External window operation actor effect."),
    debt("unregisterExternalChromeAutomation", 4, "External CDP lifecycle remains internal to Rust."),
    debt("updateSystemPressureSignals", 5, "Pressure sampling enters via typed command/event.")
  ]
} satisfies Record<string, RustBoundaryDebt[]>;
