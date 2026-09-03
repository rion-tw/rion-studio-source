import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generated Rust core contracts", () => {
  it("exports a typed browser-action union instead of unvalidated payload JSON", async () => {
    const [action, request, index] = await Promise.all([
      readFile("src/shared/generated/BrowserAction.ts", "utf8"),
      readFile("src/shared/generated/BrowserActionRequest.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(action).toContain('{ "type": "focus" }');
    expect(action).toContain('{ "type": "key"');
    expect(action).toContain('{ "type": "click"');
    expect(action).not.toContain('{ "type": "evaluate"');
    expect(action).not.toContain('{ "type": "cookies"');
    expect(action).not.toContain('{ "type": "session"');
    expect(action).not.toContain('{ "type": "debugger"');
    expect(request).toContain("action: BrowserAction");
    expect(request).not.toContain("payload_json");
    expect(index).toContain('export type { BrowserAction } from "./BrowserAction";');
  });

  it("restricts generic core effects to app and role web-content targets", async () => {
    const [target, kind] = await Promise.all([
      readFile("src/shared/generated/CoreEffectTarget.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectTargetKind.ts", "utf8")
    ]);

    expect(target).toContain("kind: CoreEffectTargetKind");
    expect(kind).toContain('"app" | "webContents"');
    for (const retired of ["window", "view", "session"]) {
      expect(kind).not.toContain(`"${retired}"`);
    }
  });

  it("carries bounded browser action batches through the generated core event union", async () => {
    const contract = await readFile("src/shared/generated/CoreEvent.ts", "utf8");

    expect(contract).toContain('{ "type": "browserActions"');
    expect(contract).toContain("actions: Array<BrowserActionRequest>");
  });

  it("exports optional per-entry build attribution for retained logs", async () => {
    const contract = await readFile("src/shared/generated/LogEntry.ts", "utf8");

    expect(contract).toContain("buildCommit?: string");
    expect(contract).toContain("applicationVersion?: string");
    expect(contract).toContain("runtimeContractVersion?: number");
    expect(contract).toContain("packaged?: boolean");
  });

  it("projects independently patchable macro overlay visibility through generated settings", async () => {
    const [settings, patch, overlay, index] = await Promise.all([
      readFile("src/shared/generated/GameBrowserSettingsRecord.ts", "utf8"),
      readFile("src/shared/generated/GameBrowserSettingsPatchRecord.ts", "utf8"),
      readFile("src/shared/generated/MacroOverlayViewModelRecord.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(settings).toContain("macroOverlay: MacroOverlaySettingsRecord");
    expect(patch).toContain("macroOverlay?: MacroOverlaySettingsPatchRecord");
    expect(overlay).toContain("macroOverlay: MacroOverlaySettingsRecord");
    expect(index).toContain('export type { MacroOverlaySettingsRecord } from "./MacroOverlaySettingsRecord";');
    expect(index).toContain('export type { MacroOverlaySettingsPatchRecord } from "./MacroOverlaySettingsPatchRecord";');
  });

  it("keeps launch preview correlation separate from native cleanup generations", async () => {
    const [command, tabEffect] = await Promise.all([
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/EmbeddedTabEffectRecord.ts", "utf8")
    ]);

    expect(command).toContain(
      '"type": "browserRoleLaunch", roleId: string, target: EmbeddedLaunchTargetRecord, launchPreviewId?: string'
    );
    expect(command).toContain(
      '"type": "browserWorkspaceLaunch", workspaceId: string, target: EmbeddedLaunchTargetRecord, launchPreviewId?: string'
    );
    expect(tabEffect).toContain("attemptGeneration?: string, launchPreviewId?: string");
  });

  it("generates the generic operation effect and command-result protocol", async () => {
    const [event, request, action, result, resultMap] = await Promise.all([
      readFile("src/shared/generated/CoreEvent.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectRequest.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectResult.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8")
    ]);

    expect(event).toContain('{ "type": "coreEffects"');
    expect(request).toContain("effectId: string");
    expect(request).toContain("operationId: string");
    expect(request).toContain("completionPolicy: OperationCompletionPolicy");
    expect(request).toContain("deadlineMs?: number");
    expect(action).toContain('{ "type": "embeddedCreateTab"');
    expect(action).toContain('{ "type": "browserAction"');
    expect(action).not.toContain('{ "type": "createWindow"');
    expect(action).not.toContain('{ "type": "debuggerCommand"');
    expect(action).not.toContain('{ "type": "cookieSet"');
    expect(result).toContain("error: CoreErrorPayload | null");
    expect(resultMap).toContain("export type CoreCommandResultMap");
    const metrics = await readFile("src/shared/generated/CoreEffectMetricsRecord.ts", "utf8");
    expect(metrics).toContain("peakPendingEffectCount: number");
    expect(metrics).toContain("effectAckLatency: LatencySummaryRecord");
    expect(metrics).toContain("launchOperationCount: number");
    expect(metrics).toContain("launchEffectCount: number");
    for (const contract of [event, request, action, result, resultMap]) {
      expect(contract).not.toContain("unknown");
    }
  });

  it("pins the Core-owned runtime-window zoom command and terminal receipts", async () => {
    const [command, resultMap, action, receipt, nativeReceipt, snapshot, index] =
      await Promise.all([
        readFile("src/shared/generated/CoreCommand.ts", "utf8"),
        readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
        readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
        readFile("src/shared/generated/RuntimeWindowZoomReceiptRecord.ts", "utf8"),
        readFile("src/shared/generated/RuntimeWindowZoomNativeReceiptRecord.ts", "utf8"),
        readFile("src/shared/generated/RuntimeWindowTabSnapshotRecord.ts", "utf8"),
        readFile("src/shared/generated/index.ts", "utf8")
      ]);

    expect(command).toContain(
      '{ "type": "browserRuntimeWindowZoom", operationId: string, windowId: string, windowGeneration: number, topologyRevision: number, action: "in" | "out" | "reset"'
    );
    expect(resultMap).toContain(
      "browserRuntimeWindowZoom: RuntimeWindowZoomReceiptRecord"
    );
    expect(action).toContain(
      '{ "type": "embeddedSetRuntimeWindowZoom", windowId: string, windowGeneration: number, topologyRevision: number, zoomFactor: number, previousZoomFactor: number'
    );
    expect(receipt).toContain(
      'status: "applied" | "superseded" | "failed" | "indeterminate"'
    );
    expect(receipt).toContain("sourceTopologyRevision: number");
    expect(nativeReceipt).toContain('status: "applied"');
    expect(snapshot).toContain("windowZoomFactor: number");
    for (const typeName of [
      "RuntimeWindowZoomNativeReceiptRecord",
      "RuntimeWindowZoomReceiptRecord"
    ]) {
      expect(index).toContain(`export type { ${typeName} } from "./${typeName}";`);
    }
  });

  it("generates an explicit v23 global Web profile and Chromium surface load effect", async () => {
    const [action, profile, surface, index] = await Promise.all([
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/GlobalWebProfilePathsRecord.ts", "utf8"),
      readFile("src/shared/generated/EmbeddedWebSurfaceLoadEffectRecord.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(action).toContain(
      '{ "type": "embeddedLoadWebSurfaces", tabId: string, attemptGeneration: string, profile: GlobalWebProfilePathsRecord, surfaces: Array<EmbeddedWebSurfaceLoadEffectRecord>'
    );
    expect(profile).toContain('profileKey: "global-web"');
    expect(profile).toContain("chromiumUserDataDir: string");
    expect(profile).not.toContain("RolePathsRecord");
    for (const field of [
      "surfaceId: string",
      "slotId: string",
      "url: string",
      "zoomFactor: number",
      "resolvedEngine: ResolvedBrowserEngine"
    ]) {
      expect(surface).toContain(field);
    }
    expect(index).toContain(
      'export type { GlobalWebProfilePathsRecord } from "./GlobalWebProfilePathsRecord";'
    );
    expect(index).toContain(
      'export type { EmbeddedWebSurfaceLoadEffectRecord } from "./EmbeddedWebSurfaceLoadEffectRecord";'
    );
  });

  it("generates Core-owned global Web clear, audio, and AppKit surface fences", async () => {
    const [
      command,
      resultMap,
      action,
      receipt,
      identity,
      browserTab,
      appKitWindow,
      appKitSurface,
      index
    ] = await Promise.all([
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/GlobalWebProfileClearReceiptRecord.ts", "utf8"),
      readFile("src/shared/generated/EmbeddedWebSurfaceIdentityRecord.ts", "utf8"),
      readFile("src/shared/generated/BrowserRuntimeTabRecord.ts", "utf8"),
      readFile("src/shared/generated/AppKitRuntimeWindowProjectionRecord.ts", "utf8"),
      readFile("src/shared/generated/AppKitRuntimeWebSurfaceLayoutRecord.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(command).toContain('{ "type": "globalWebProfilePathsResolve" }');
    expect(command).toContain('{ "type": "globalWebProfileClear" }');
    expect(resultMap).toContain(
      "globalWebProfilePathsResolve: GlobalWebProfilePathsRecord"
    );
    expect(resultMap).toContain(
      "globalWebProfileClear: GlobalWebProfileClearReceiptRecord"
    );
    expect(action).toContain(
      '{ "type": "globalWebProfileClear", profile: GlobalWebProfilePathsRecord'
    );
    expect(action).toContain(
      'roles: Array<EmbeddedTabAudioMuteRoleEffectRecord>, webSurfaces: Array<EmbeddedWebSurfaceIdentityRecord>'
    );
    expect(appKitWindow).toContain("logicalTabIds: Array<string>");
    expect(appKitWindow).toContain("hiddenTabIds: Array<string>");
    expect(receipt).toContain("operationId: string");
    expect(receipt).toContain("profile: GlobalWebProfilePathsRecord");
    expect(receipt).toContain("status: SystemRuntimeOperationStatus");
    expect(identity).toContain("surfaceId: string");
    expect(identity).toContain("slotId: string");
    expect(browserTab).toContain(
      "webSurfaces: Array<EmbeddedWebSurfaceIdentityRecord>"
    );
    expect(appKitWindow).toContain(
      "webSurfaces: Array<AppKitRuntimeWebSurfaceLayoutRecord>"
    );
    for (const field of [
      "surfaceId: string",
      "slotId: string",
      "tabId: string",
      "attemptGeneration: string",
      "bounds: LayoutBounds",
      "visible: boolean"
    ]) {
      expect(appKitSurface).toContain(field);
    }
    for (const typeName of [
      "GlobalWebProfileClearReceiptRecord",
      "EmbeddedWebSurfaceIdentityRecord",
      "AppKitRuntimeWebSurfaceLayoutRecord"
    ]) {
      expect(index).toContain(`export type { ${typeName} } from "./${typeName}";`);
    }
  });

  it("exposes the durable role-session migration journal without session values", async () => {
    const [command, phase, engine, start, transition, record, resultMap, index] = await Promise.all([
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/RoleSessionMigrationPhase.ts", "utf8"),
      readFile("src/shared/generated/RoleSessionMigrationEngine.ts", "utf8"),
      readFile("src/shared/generated/RoleSessionMigrationStartInput.ts", "utf8"),
      readFile("src/shared/generated/RoleSessionMigrationTransitionInput.ts", "utf8"),
      readFile("src/shared/generated/RoleSessionMigrationRecord.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(command).toContain('{ "type": "roleSessionMigrationGet", roleId: string');
    expect(command).toContain('{ "type": "roleSessionMigrationsList" }');
    expect(command).not.toContain(
      '{ "type": "roleSessionMigrationStart", input: RoleSessionMigrationStartInput'
    );
    expect(command).not.toContain(
      '{ "type": "roleSessionMigrationTransition", input: RoleSessionMigrationTransitionInput'
    );
    expect(phase).toContain(
      '"v22Ready" | "exported" | "importing" | "verifying" | "v23Ready" | "failed" | "indeterminate"'
    );
    expect(engine).toContain('"wkwebview" | "webview2" | "chromium"');
    expect(start).toContain("sourceRevision: number");
    expect(transition).toContain("expectedJournalRevision: number");
    expect(transition).toContain("envelopeSha256?: string");
    expect(transition).toContain("localStorageEntryCount?: number");
    expect(record).toContain("journalRevision: number");
    expect(record).toContain("firstVerifiedLaunchAt?: string");
    expect(resultMap).toContain(
      "roleSessionMigrationGet: RoleSessionMigrationRecord | null"
    );
    expect(resultMap).toContain("roleSessionMigrationsList: RoleSessionMigrationRecord[]");
    expect(resultMap).not.toContain("roleSessionMigrationStart:");
    expect(resultMap).not.toContain("roleSessionMigrationTransition:");
    for (const typeName of [
      "RoleSessionMigrationEngine",
      "RoleSessionMigrationOutcome",
      "RoleSessionMigrationPhase",
      "RoleSessionMigrationPlatform",
      "RoleSessionMigrationRecord",
      "RoleSessionMigrationStartInput",
      "RoleSessionMigrationTransitionInput"
    ]) {
      expect(index).toContain(`export type { ${typeName} } from "./${typeName}";`);
    }
    for (const metadataContract of [start, transition, record]) {
      expect(metadataContract).not.toContain("cookieValue");
      expect(metadataContract).not.toContain("localStorageValue");
      expect(metadataContract).not.toContain("origin: string");
      expect(metadataContract).not.toContain("cookies: Array");
    }
  });

  it("keeps the secret-bearing session-transfer envelope out of renderer contracts", async () => {
    const [api, command, resultMap, index, preload, preloadBridge, ipcMethods, ipcProtocol] = await Promise.all([
      readFile("src/shared/api.ts", "utf8"),
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8"),
      readFile("src/electron/preload/index.ts", "utf8"),
      readFile("src/electron/preload/installRionStudioBridge.ts", "utf8"),
      readFile("src/electron/ipc/apiMethods.ts", "utf8"),
      readFile("src/electron/ipc/protocol.ts", "utf8")
    ]);

    const publicRendererContracts = [
      api,
      command,
      resultMap,
      index,
      preload,
      preloadBridge,
      ipcMethods,
      ipcProtocol
    ];

    for (const secretContract of [
      "RoleSessionTransferEnvelopeRecord",
      "RoleSessionTransferInventoryRecord",
      "RoleSessionTransferCookieRecord",
      "RoleSessionTransferBytesRecord",
      "RoleSessionTransferLocalStorageEntryRecord",
      "RoleSessionTransferLocalStorageOriginRecord"
    ]) {
      for (const rendererContract of publicRendererContracts) {
        expect(rendererContract).not.toContain(secretContract);
      }
    }
    for (const secretField of [
      "cookieValue",
      "cookies:",
      "localStorage",
      "partitionKey",
      "unsupportedAttributeCodes",
      "base64Utf16Le"
    ]) {
      for (const rendererContract of publicRendererContracts) {
        expect(rendererContract).not.toContain(secretField);
      }
    }
    for (const privilegedMethod of [
      "beginRoleSessionMigrationImportInternal",
      "transitionRoleSessionMigrationTargetInternal",
      "readRoleSessionTransferVaultInternal",
      "recoverPendingChromeProfileImportsInternal"
    ]) {
      for (const rendererContract of publicRendererContracts) {
        expect(rendererContract).not.toContain(privilegedMethod);
      }
    }
  });

  it("stages the v23 Chromium registration without removing the v22 System WebView boundary", async () => {
    const [engine, host, failure, registration, status, command, resultMap, index] = await Promise.all([
      readFile("src/shared/generated/ResolvedBrowserEngine.ts", "utf8"),
      readFile("src/shared/generated/BrowserHostKind.ts", "utf8"),
      readFile("src/shared/generated/BrowserRuntimeFailureReason.ts", "utf8"),
      readFile("src/shared/generated/BrowserRuntimeRegistrationRecord.ts", "utf8"),
      readFile("src/shared/generated/BrowserRoleStatusRecord.ts", "utf8"),
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(engine).toContain('"webview2" | "wkwebview" | "chromium"');
    expect(host).toContain(
      '"system-native" | "appkit-chromium" | "bundled-chromium"'
    );
    expect(failure).toContain(
      '"trusted-input-unavailable" | "macro-input-unavailable" | "session-migration-required" | "runtime-creation-failed" | "runtime-crashed"'
    );
    expect(failure).not.toContain("webkit-spi-unavailable");
    expect(registration).toContain("contractVersion: number");
    expect(registration).toContain('platform: "macos" | "windows"');
    expect(registration).toContain("engine: ResolvedBrowserEngine");
    expect(registration).toContain("adapterVersion: string");
    expect(registration).toContain("available: boolean");
    expect(registration).toContain("capabilities: EngineCapabilitySnapshotRecord");
    expect(registration).toContain("failureReason?: BrowserRuntimeFailureReason");
    expect(registration).not.toContain("SystemWebViewIssueReason");
    expect(status).toContain("issueReason?: BrowserRuntimeFailureReason");
    expect(status).not.toContain("SystemWebViewIssueReason");
    expect(command).toContain(
      '{ "type": "browserRuntimeRegister", registration: BrowserRuntimeRegistrationRecord'
    );
    expect(command).toContain(
      '{ "type": "systemWebViewRuntimeRegister", registration: SystemWebViewRuntimeRegistrationRecord'
    );
    expect(resultMap).toContain(
      "browserRuntimeRegister: BrowserRuntimeRegistrationRecord"
    );
    expect(index).toContain(
      'export type { BrowserRuntimeRegistrationRecord } from "./BrowserRuntimeRegistrationRecord";'
    );
    expect(index).toContain(
      'export type { BrowserRuntimeFailureReason } from "./BrowserRuntimeFailureReason";'
    );
  });

  it("generates stable quick access refs, preferences, commands, and snapshot projection", async () => {
    const [item, preferences, command, resultMap, snapshot, shell] = await Promise.all([
      readFile("src/shared/generated/QuickAccessItemRefRecord.ts", "utf8"),
      readFile("src/shared/generated/QuickAccessPreferencesRecord.ts", "utf8"),
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8"),
      readFile("src/shared/generated/CoreStateSnapshotRecord.ts", "utf8"),
      readFile("src-tauri/src/lib/section_03_rion_overlay_request.rs", "utf8")
    ]);

    expect(item).toContain('kind: "role" | "workspace" | "gameWindow" | "macro"');
    expect(preferences).toContain("pinnedItems: Array<QuickAccessItemRefRecord>");
    expect(preferences).toContain("recentItems: Array<QuickAccessItemRefRecord>");
    expect(command).toContain('{ "type": "quickAccessPinSet"');
    expect(command).toContain('{ "type": "quickAccessRecentRecord"');
    expect(command).toContain('{ "type": "quickAccessRecentClear" }');
    expect(resultMap).toContain("quickAccessPinSet: QuickAccessPreferencesRecord");
    expect(snapshot).toContain("quickAccessPreferences?: QuickAccessPreferencesRecord");
    expect(shell).toContain('"quickAccessPreferences"');
  });

  it("omits the removed workspace resource policy from every generated boundary", async () => {
    const contracts = await Promise.all([
      readFile("src/shared/generated/WorkspaceCreateInputRecord.ts", "utf8"),
      readFile("src/shared/generated/WorkspaceUpdateInputRecord.ts", "utf8"),
      readFile("src/shared/generated/StateLaunchWorkspaceRecord.ts", "utf8"),
      readFile("src/shared/generated/PortableLaunchWorkspaceRecord.ts", "utf8"),
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/BrowserRoleStatusRecord.ts", "utf8"),
      readFile("src/shared/generated/MacroOverlayViewModelRecord.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    for (const contract of contracts) {
      expect(contract).not.toContain("resourcePolicy");
      expect(contract).not.toContain("policyMode");
      expect(contract).not.toContain("StateWorkspaceResourcePolicyRecord");
      expect(contract).not.toContain("ResourceRuntime");
      expect(contract).not.toContain("resourceState");
      expect(contract).not.toContain("cpuThrottleRate");
      expect(contract).not.toContain("resourcePressureLevel");
      expect(contract).not.toContain("resourceReason");
    }
  });
});

describe("direct Rust core build verification", () => {
  it("builds one Cargo-owned core for the Tauri transition shell and Electron Node-API adapter", async () => {
    const [manifest, shellManifest, packageJsonSource, workflow] = await Promise.all([
      readFile("Cargo.toml", "utf8"),
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };

    expect(manifest).toContain('"crates/rion-node"');
    expect(manifest).toContain('napi-build = "2.3.2"');
    expect(shellManifest).toContain(
      'rion-core = { path = "../crates/rion-core", features = ["system-webview-probe"] }'
    );
    expect(packageJson.scripts["build:electron:rust"])
      .toBe("node scripts/buildElectronRust.mjs");
    expect(packageJson.scripts["build:electron"])
      .toContain("pnpm run build:electron:rust");
    expect(packageJson.scripts.build).toContain("cargo build -p rion-tauri");
    expect(workflow).toContain("pnpm run build");
    expect(workflow).not.toContain("retired native addon");
  });

  it("does not generate the retired addon latency contract", async () => {
    const [model, telemetry, generated] = await Promise.all([
      readFile("crates/rion-core/src/model/mod.rs", "utf8"),
      readFile("crates/rion-core/src/telemetry.rs", "utf8"),
      readFile("src/shared/generated/PerformanceTelemetryRecord.ts", "utf8")
    ]);
    for (const source of [model, telemetry, generated]) {
      expect(source).not.toContain("NapiLatency");
      expect(source).not.toContain("record_napi");
    }
  });
});
