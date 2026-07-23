import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readSource = (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("Rust production architecture boundaries", () => {
  it("keeps generated core commands typed and independent from handwritten domain models", async () => {
    const [command, event, browserRuntime] = await Promise.all([
      readSource("src/shared/generated/CoreCommand.ts"),
      readSource("src/shared/generated/CoreEvent.ts"),
      readSource("src/shared/generated/BrowserRuntimeCommand.ts")
    ]);

    for (const contract of [command, event, browserRuntime]) {
      expect(contract).not.toContain("unknown");
      expect(contract).not.toContain("../types");
    }
    expect(command).not.toContain("../types");
    expect(command).not.toContain("ApplyDelta");
    expect(command).not.toContain("portableCommit");
    expect(command).not.toContain("portableNormalize");
  });

  it("uses Rust-generated public domain and mutation contracts", async () => {
    const sharedTypes = await readSource("src/shared/types.ts");

    for (const handwritten of [
      "export interface Game ",
      "export interface Role ",
      "export interface LaunchWorkspace ",
      "export interface Macro ",
      "export interface CreateGameInput ",
      "export interface CreateRoleInput ",
      "export interface CreateLaunchWorkspaceInput ",
      "export interface CreateMacroInput "
    ]) {
      expect(sharedTypes).not.toContain(handwritten);
    }

    expect(sharedTypes).toContain("export type CreateGameInput = GameCreateRequest");
    expect(sharedTypes).toContain("export type CreateRoleInput = RoleCreateRequest");
    expect(sharedTypes).toContain("export type CreateLaunchWorkspaceInput = WorkspaceCreateRequest");
    expect(sharedTypes).toContain("export type CreateMacroInput = MacroCreateRequest");
  });

  it("keeps workspace reservations and role operation ordering in Rust", async () => {
    const manager = await readSource("src/main/browser/ElectronBrowserRuntime.ts");
    const runtime = await readSource("crates/rion-core/src/browser_runtime.rs");
    const operations = await readSource("crates/rion-core/src/browser_operations.rs");

    expect(manager).not.toContain("pendingWorkspaceLaunchIds");
    expect(manager).not.toContain("workspaceDisplayReservations");
    expect(manager).not.toContain("roleOperationTails");
    expect(manager).not.toContain("roleOperationVersions");
    expect(manager).not.toContain("blockedRoleIds");
    const sessionHandle = /interface BrowserSession \{([\s\S]*?)\n\}/.exec(manager)?.[1] ?? "";
    expect(sessionHandle).not.toContain("state:");
    expect(sessionHandle).not.toContain("launchedAt");
    expect(runtime).toContain("WORKSPACE_DISPLAY_OCCUPIED");
    expect(operations).toContain("BrowserOperationCoordinator");
  });

  it("keeps workspace geometry, divider resize, and adaptive zoom decisions in Rust", async () => {
    const [manager, layout, sharedLayout] = await Promise.all([
      readSource("src/main/browser/ElectronBrowserRuntime.ts"),
      readSource("crates/rion-core/src/layout.rs"),
      readSource("src/shared/workspaceLayout.ts")
    ]);

    for (const source of [manager, sharedLayout]) {
      expect(source).not.toContain("getAdaptiveWorkspaceBrowserZoomPercent");
      expect(source).not.toContain("normalizeWorkspaceRectEdges");
    }
    expect(manager).not.toContain("snapWorkspaceResizePosition");
    expect(manager).not.toContain("createDividerDescriptors");
    expect(manager).not.toContain("workspaceLayoutResolver?.");
    expect(layout).toContain("pub fn adaptive_zoom_percent");
    expect(layout).toContain("pub fn normalize_rect_edges");
    expect(layout).toContain("pub fn create_dividers");
    expect(layout).toContain("pub fn resize_divider");
  });

  it("keeps CDN URL matching in Rust and the Electron webRequest layer primitive-only", async () => {
    const [manager, matcher] = await Promise.all([
      readSource("src/main/game-browser/CdnCompatibilityManager.ts"),
      readSource("crates/rion-core/src/cdn.rs")
    ]);

    expect(manager).not.toContain("new RegExp");
    expect(manager).not.toContain("rewriteCdnCompatibilityUrl");
    expect(manager).not.toContain("compiledRules");
    expect(manager).not.toContain("inFlightDetections");
    expect(manager).not.toContain("DetectionCacheEntry");
    expect(manager).not.toContain("setTimeout");
    expect(manager).toContain('type: "cdnResolveSession"');
    expect(manager).toContain("this.options.matchCdnUrl(details.url)");
    expect(matcher).toContain("pub fn bundled()");
    expect(matcher).toContain("pub fn rewrite(&self");
  });

  it("routes external macro actions through the Rust CDP executor", async () => {
    const [adapter, external, core] = await Promise.all([
      readSource("src/main/core/ElectronBrowserActionAdapter.ts"),
      readSource("crates/rion-core/src/external_automation.rs"),
      readSource("crates/rion-core/src/app.rs")
    ]);

    expect(adapter).toContain("executeEffect");
    expect(adapter).not.toContain("dispatchExternalBrowserActions");
    expect(external).toContain("held_key_owners");
    expect(external).toContain("Input.dispatchKeyEvent");
    expect(external).toContain("Input.dispatchMouseEvent");
    expect(core).not.toContain("CoreEffectAction::ExternalOverlayRequest");
    expect(core).toContain("handle_overlay_request(role_id, &request_json, None)");
    expect(core).toContain("handle_external_cdp_event");
  });

  it("keeps portable parsing, pending sessions, planning, and persistence out of TypeScript", async () => {
    const manager = await readSource("src/main/portable/PortableDataManager.ts");

    expect(manager).not.toContain("pendingImport");
    expect(manager).not.toContain("parsePortableData");
    expect(manager).not.toContain("buildImportPlan");
    expect(manager).not.toContain("writeJsonFileAtomically");
    expect(manager).not.toContain("node:fs");
    expect(manager).not.toContain("readFile");
    expect(manager).not.toContain("writeFile");
    expect(manager).not.toContain("setInterval");
    expect(manager).toContain('type: "portableExportTo"');
    expect(manager).toContain('type: "portablePreviewFile"');
  });

  it("keeps Chrome profile discovery, pending state, file saga, and recovery out of TypeScript", async () => {
    const [manager, effectAdapter, core] = await Promise.all([
      readSource("src/main/browser/ChromeProfileImportManager.ts"),
      readSource("src/main/browser/ElectronProfileEffectAdapter.ts"),
      readSource("crates/rion-core/src/app.rs")
    ]);

    expect(manager).not.toContain("node:fs");
    expect(manager).not.toContain("pending =");
    expect(manager).not.toContain("copyDirectory");
    expect(manager).not.toContain("writeJsonFileAtomically");
    expect(manager).not.toContain("recoverChromeProfileImport");
    expect(manager).toContain('type: "chromeProfileApply"');
    expect(manager).not.toContain('"chromeProfilePrepare"');
    expect(manager).not.toContain('"chromeProfileCommit"');
    expect(manager).not.toContain('"chromeProfileRollback"');
    expect(effectAdapter).not.toContain("node:fs");
    expect(effectAdapter).toContain("cookies.set");
    expect(core).toContain("apply_chrome_profile_import");
    expect(core).toContain("rollback_chrome_profile_import");
  });

  it("does not keep a JavaScript state snapshot cache or stringify diff", async () => {
    const [client, database] = await Promise.all([
      readSource("src/main/core/nativeCore.ts"),
      readSource("crates/rion-core/src/database/state.rs")
    ]);

    expect(client).not.toContain("cachedSnapshot");
    expect(client).not.toContain("private tail");
    expect(client).not.toContain("private serialize");
    const ordinaryMutation = database.slice(
      database.indexOf("fn apply_domain_mutation"),
      database.indexOf("fn validate_workspace_role_references")
    );
    expect(ordinaryMutation).not.toContain("read_snapshot");
    expect(ordinaryMutation).not.toContain("snapshot_hash");
    expect(database).toContain("fn read_typed_collection");
  });

  it("keeps runtime-aware mutations, bulk classification, and rollback journals in Rust", async () => {
    const [handlers, app, database] = await Promise.all([
      readSource("src/main/ipc/registerHandlers.ts"),
      readSource("crates/rion-core/src/app.rs"),
      readSource("crates/rion-core/src/database/state.rs")
    ]);

    expect(handlers).not.toContain("runWithExistingRoles");
    expect(handlers).not.toContain("runBulkDelete");
    expect(handlers).not.toContain("withDataMutation");
    expect(handlers).not.toContain("stopAndRunMutation");
    expect(app).toContain("delete_role_saga");
    expect(app).toContain("quarantine");
    expect(database).toContain("operation_journal");
    expect(database).toContain("StateMutation::GamesDelete");
    expect(database).toContain("StateMutation::WorkspacesDelete");
  });

  it("does not expose the removed TypeScript runtime fallback switch", async () => {
    const main = await readSource("src/main/index.ts");

    expect(main).not.toContain("RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS");
    expect(main).not.toContain("isRustSubsystemEnabled");
    expect(main).not.toContain("rust_subsystem_fallback_active");
  });

  it("keeps log identity, filtering, redaction, persistence and batching in Rust", async () => {
    const [adapter, capture, persistence] = await Promise.all([
      readSource("src/main/logging/LogService.ts"),
      readSource("crates/rion-core/src/log_capture.rs"),
      readSource("crates/rion-core/src/database/logs.rs")
    ]);

    expect(adapter).not.toContain("randomUUID");
    expect(adapter).not.toContain("private sequence");
    expect(adapter).not.toContain("currentLevel");
    expect(adapter).not.toContain("pendingEntries");
    expect(adapter).not.toContain("sanitizeText");
    expect(adapter).not.toContain("node:fs");
    expect(adapter).toContain('type: "logsCapture"');
    expect(capture).toContain("CAPTURE_QUEUE_CAPACITY");
    expect(capture).toContain("sanitize_value");
    expect(persistence).toContain("BATCH_INTERVAL");
    expect(persistence).toContain("BATCH_MAX_ENTRIES");
  });

  it("keeps external Chrome health scheduling and probes out of TypeScript", async () => {
    const [main, health] = await Promise.all([
      readSource("src/main/index.ts"),
      readSource("crates/rion-core/src/external_health.rs")
    ]);

    expect(main).not.toContain("RustExternalChromeHealthMonitor");
    expect(main).not.toContain("externalChromeManager.handleSuspend");
    expect(health).toContain("PROBE_INTERVAL");
    expect(health).toContain("ExternalHealthChanged");
  });

  it("keeps embedded runtime diagnostics event-driven", async () => {
    const [preload, diagnostics] = await Promise.all([
      readSource("src/preload/embedded.ts"),
      readSource("src/main/browser/EmbeddedRuntimeDiagnostics.ts")
    ]);

    expect(preload).not.toContain("window.setInterval");
    expect(preload).not.toContain("EMBEDDED_HEARTBEAT_INTERVAL_MS");
    expect(diagnostics).not.toContain("setInterval");
    expect(diagnostics).not.toContain("EMBEDDED_HEARTBEAT_STALL_MS");
    expect(diagnostics).toContain('contents.on("unresponsive"');
    expect(diagnostics).toContain('contents.on("responsive"');
  });

  it("keeps resource policy state and pressure sampling in Rust", async () => {
    const [controller, runtime, browser, pressure] = await Promise.all([
      readSource("crates/rion-core/src/resource_controller.rs"),
      readSource("crates/rion-core/src/resource_runtime.rs"),
      readSource("src/main/browser/ElectronBrowserRuntime.ts"),
      readSource("src/main/browser/RustSystemPressureMonitor.ts")
    ]);

    expect(browser).not.toContain("WorkspaceResourceCoordinator");
    expect(browser).not.toContain("resourcePressureMonitor");
    expect(controller).toContain("struct ResourceController");
    expect(controller).toContain("EmbeddedApplyResourceEffects");
    expect(controller).toContain("ResourceRuntimeCommand");
    expect(runtime).toContain("struct ResourceRuntime");
    expect(pressure).not.toContain("setInterval");
  });

  it("keeps external Chrome process, CDP, and session authority in Rust", async () => {
    const [main, app, automation, sessions, processes, addon] = await Promise.all([
      readSource("src/main/index.ts"),
      readSource("crates/rion-core/src/app.rs"),
      readSource("crates/rion-core/src/external_chrome.rs"),
      readSource("crates/rion-core/src/external_sessions.rs"),
      readSource("crates/rion-core/src/external_processes.rs"),
      readSource("crates/rion-node/src/lib.rs")
    ]);

    expect(main).not.toContain("ExternalChromeManager");
    expect(main).not.toContain("connectExternalChromeAutomation");
    expect(app).toContain("launch_external_session");
    expect(app).toContain("launch_external_workspace");
    expect(app).toContain("recover_external_role");
    expect(automation).toContain("Fetch.requestPaused");
    expect(automation).toContain("RECONNECT_TIMEOUT");
    expect(automation).toContain("connect_devtools_socket");
    expect(sessions).toContain("ExternalSessionRuntime");
    expect(processes).toContain("ExternalProcessRuntime");
    expect(processes).toContain("ExternalProcessSupervisor");
    expect(addon).not.toContain("NativeExternalChromeProcess");
    expect(addon).not.toContain("launch_external_chrome");
  });

  it("keeps role-scoped macro cancellation and held-key ownership in Rust", async () => {
    const [manager, runtime, target, embeddedInput] = await Promise.all([
      readSource("src/main/macros/RustMacroManager.ts"),
      readSource("crates/rion-core/src/macro_runtime.rs"),
      readSource("src/main/browser/ElectronAutomationTarget.ts"),
      readSource("crates/rion-core/src/embedded_input.rs")
    ]);

    expect(manager).not.toContain("macroStore");
    expect(manager).toContain('type: "macroStopForRole"');
    expect(runtime).toContain("cancelled_role_ids");
    expect(runtime).toContain("held_keys: HashMap");
    expect(runtime).toContain("stop_role_matching");
    expect(target).not.toContain("macroInvocations");
    expect(target).not.toContain("heldKeyOwners");
    expect(target).toContain('type: "embeddedKeyPrepare"');
    expect(target).not.toContain("prepareEmbeddedKeyTransition");
    expect(embeddedInput).toContain("struct EmbeddedInputRuntime");
    expect(embeddedInput).toContain("pending_role_ids");
    expect(embeddedInput).toContain("apply_release");
  });

  it("does not retain the legacy TypeScript CDP transport or metadata migration", async () => {
    const [cdpBridge, context] = await Promise.all([
      readSource("src/main/browser/ExternalChromeCdpBridge.ts"),
      readSource(".agents/context.md")
    ]);

    expect(cdpBridge).not.toContain("WebSocket");
    expect(cdpBridge).not.toContain("setTimeout");
    expect(cdpBridge).not.toContain("readFile");
    expect(context).toContain("SQLite is the only production metadata write source");
  });

  it("keeps Chromium Preferences parsing and atomic writes in Rust", async () => {
    const [main, preferences] = await Promise.all([
      readSource("src/main/index.ts"),
      readSource("crates/rion-core/src/browser_preferences.rs")
    ]);

    expect(main).not.toContain("BrowserFontApplier");
    expect(main).not.toContain("ChromeZoomPreferenceApplier");
    expect(main).toContain('type: "browserPreferencesApply"');
    expect(preferences).toContain("fn write_atomically");
    expect(preferences).toContain("fn apply_fonts");
    expect(preferences).toContain("fn apply_zoom");
  });

  it("keeps system font discovery and caching in Rust", async () => {
    const [adapter, platform] = await Promise.all([
      readSource("src/main/game-browser/RustSystemFontService.ts"),
      readSource("crates/rion-platform/src/system_fonts.rs")
    ]);

    expect(adapter).not.toContain("node:child_process");
    expect(adapter).not.toContain("system_profiler");
    expect(adapter).not.toContain("powershell.exe");
    expect(adapter).toContain('type: "systemFontsList"');
    expect(platform).toContain("query_system_font_names");
  });

  it("keeps Windows graphics event-log access and parsing in Rust", async () => {
    const [main, platform, parser] = await Promise.all([
      readSource("src/main/index.ts"),
      readSource("crates/rion-platform/src/windows_events.rs"),
      readSource("crates/rion-core/src/windows_graphics_events.rs")
    ]);

    expect(main).not.toContain("RustWindowsGraphicsEventCollector");
    expect(main).toContain('type: "windowsGraphicsEventsCollect"');
    expect(platform).toContain('Command::new("wevtutil")');
    expect(parser).toContain("fn parse");
  });

  it("keeps diagnostic ZIP, telemetry timers and system process control in Rust", async () => {
    const [main, native, diagnostics, telemetry, platform] = await Promise.all([
      readSource("src/main/index.ts"),
      readSource("src/main/core/nativeCore.ts"),
      readSource("crates/rion-core/src/diagnostics.rs"),
      readSource("crates/rion-core/src/telemetry.rs"),
      readSource("crates/rion-platform/src/system.rs")
    ]);

    expect(main).not.toContain("node:fs");
    expect(main).not.toContain("node:os");
    expect(main).not.toContain("performanceTelemetryTimer");
    expect(main).not.toContain("writeZip");
    expect(main).toContain('type: "diagnosticsExport"');
    expect(native).not.toContain("class PerformanceMetrics");
    expect(diagnostics).toContain("atomic_replace_file");
    expect(telemetry).toContain("WRITE_INTERVAL");
    expect(platform).toContain("request_graceful_chrome_quit");
  });

  it("keeps scalar production metadata stores free of filesystem persistence", async () => {
    const sources = await Promise.all([
      readSource("src/main/game-browser/GameBrowserSettingsStore.ts"),
      readSource("src/main/macros/MacroSettingsStore.ts"),
      readSource("src/main/legal/LegalAcceptanceStore.ts"),
      readSource("src/main/window/RuntimeWindowPreferencesStore.ts")
    ]);

    for (const source of sources) {
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("readFile");
      expect(source).not.toContain("writeFile");
      expect(source).not.toContain("?? DEFAULT_");
    }
    expect(sources[2]).not.toContain("normalizeAcceptanceFile");
    expect(sources[3]).not.toContain("normalizeRuntimeWindowPreferences");
  });

  it("keeps collection metadata stores free of JSON files and snapshot caches", async () => {
    const sources = await Promise.all([
      readSource("src/main/games/GameStore.ts"),
      readSource("src/main/workspaces/LaunchWorkspaceStore.ts"),
      readSource("src/main/macros/MacroStore.ts")
    ]);

    for (const source of sources) {
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("writeJsonFileAtomically");
      expect(source).not.toContain("cachedFile");
      expect(source).not.toContain("stateRepository?:");
    }

    expect(sources[2]).not.toContain(".sort(");

    const roleStore = await readSource("src/main/roles/RoleStore.ts");
    expect(roleStore).not.toContain("node:fs");
    expect(roleStore).not.toContain("node:path");
    expect(roleStore).not.toContain("mkdir(");
    expect(roleStore).not.toContain("rm(");
    expect(roleStore).not.toContain("readFile");
    expect(roleStore).not.toContain("writeFile");
    expect(roleStore).not.toContain("writeJsonFileAtomically");
    expect(roleStore).not.toContain("cachedFile");
    expect(roleStore).toContain('type: "rolePathsResolve"');
  });

  it("keeps compatibility decisions and run state in Rust", async () => {
    const manager = await readSource("src/main/games/GameCompatibilityManager.ts");
    const runtime = await readSource("crates/rion-core/src/compatibility_runtime.rs");

    expect(manager).not.toContain("createHash");
    expect(manager).not.toContain("configurationFingerprint");
    expect(manager).not.toContain("activeChecks");
    expect(manager).toContain('type: "compatibilityRun"');
    expect(manager).not.toContain('type: "compatibilityPrepare"');
    expect(manager).not.toContain('type: "compatibilityComplete"');
    expect(manager).not.toContain("setTimeout");
    expect(runtime).toContain("configuration_fingerprint");
    expect(runtime).toContain("cancel_requested");
    expect(runtime).toContain("effect_operation_id");
  });

  it("keeps graphics normalization, switch selection, and report assembly in Rust", async () => {
    const [adapter, graphics, bootstrap] = await Promise.all([
      readSource("src/main/game-browser/GraphicsDiagnosticsService.ts"),
      readSource("crates/rion-core/src/graphics_diagnostics.rs"),
      readSource("crates/rion-core/src/bootstrap_settings.rs")
    ]);

    expect(adapter).not.toContain("normalizeAvailability");
    expect(adapter).not.toContain("readGpuDevice");
    expect(adapter).not.toContain("getGraphicsSwitches");
    expect(adapter).toContain('type: "graphicsDiagnosticsAssemble"');
    expect(graphics).toContain("normalize_web_graphics");
    expect(graphics).toContain("GraphicsDiagnosticsRecord");
    expect(bootstrap).toContain("fn graphics_switches");
  });

  it("keeps overlay projection, request validation, refresh ordering, and external CDP in Rust", async () => {
    const [adapter, overlay, core, page] = await Promise.all([
      readSource("src/main/macros/MacroOverlayInjector.ts"),
      readSource("crates/rion-core/src/overlay.rs"),
      readSource("crates/rion-core/src/app.rs"),
      readSource("src/main/macros/overlay/macroOverlayRuntime.js")
    ]);

    for (const forbidden of [
      "externalRefreshStates",
      "contentRefreshStates",
      "pendingClickStatuses",
      "previousMacroStatuses",
      "previousRolePresentation",
      "findUnassignedMacroDependency",
      "listStatuses",
      "setTimeout"
    ]) {
      expect(adapter).not.toContain(forbidden);
    }
    expect(adapter).toContain('type: "overlayRequest"');
    expect(overlay).toContain("struct OverlayProjection");
    expect(overlay).toContain("REFRESH_MIN_INTERVAL");
    expect(core).toContain("handle_overlay_request");
    expect(core).toContain("OverlayCopyCoordinate");
    expect(core).toContain("OverlayOpenMacroPage");
    expect(page).toContain("retainedClickStatuses");
    expect(page).toContain("clickStatusRetentionTimer");
  });
});
