import { app, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ChromiumPopupAdmissionRecord,
  ChromiumPopupNativeHostReceiptRecord,
  CoreEffectResult,
  RolePathsRecord,
  RuntimeTabActivationPhaseRecord
} from "../../shared/generated";
import {
  CoreAddonClient,
  type RawNodeApiCoreFactory
} from "../core/coreAddonClient";
import {
  ElectronApplicationLifecycleController,
  type ElectronApplicationPowerEvent
} from "../main/applicationLifecycleController";
import {
  ChromiumTrustedInputCoordinator
} from "../main/chromiumTrustedInputCoordinator";
import { authorizeDesktopE2eChromiumCommandLine } from
  "../main/chromiumCommandLinePolicy";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionHandle
} from "../main/chromiumRoleSessionRegistry";
import {
  ChromiumGlobalWebPresentationRegistry,
  type ChromiumWorkspaceWebPresentationEvidence
} from "../main/chromiumGlobalWebPresentationRegistry";
import { ChromiumPopupLifecycleCoordinator } from
  "../main/chromiumPopupLifecycleCoordinator";
import { ChromiumRoleSurfaceRegistry } from
  "../main/chromiumRoleSurfaceRegistry";
import {
  ChromiumRuntimeRolePlaceholderRegistry,
  type ChromiumRuntimeRolePlaceholderDescriptor
} from "../main/chromiumRuntimeRolePlaceholderRegistry";
import { ChromiumPlatformRuntimeHostFactory } from
  "../main/chromiumRuntimeHostFactory";
import type { ChromiumRuntimeHostPort } from
  "../main/chromiumRuntimeHostPorts";
import { ChromiumRuntimeBootstrap } from
  "../main/chromiumRuntimeBootstrap";
import { ChromiumRuntimeEffectExecutor } from
  "../main/chromiumRuntimeEffectExecutor";
import { ChromiumRuntimeLaunchCoordinator } from
  "../main/chromiumRuntimeLaunchCoordinator";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../main/chromiumRuntimeSnapshot";
import {
  ELECTRON_DESKTOP_E2E_CLEAR_STORAGES,
  type ElectronDesktopE2eApplicationLifecycleSignalReceipt,
  type ElectronDesktopE2eFullscreenToolbarInspection,
  type ElectronDesktopE2eGameWindowRuntimeInspection,
  type ElectronDesktopE2eRetainedV22Precondition,
  type ElectronDesktopE2eRoleBrowserDataClearReceipt,
  type ElectronDesktopE2eRolePlaceholderInspection,
  type ElectronDesktopE2eRoleSessionRuntimeInspection,
  type ElectronDesktopE2ePopupLifecycleJournalInspection,
  type ElectronDesktopE2eTrustedInputObservation,
  type ElectronDesktopE2eWorkspaceWebInspection,
  type ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection,
  registerElectronDesktopE2eBridge
} from "./desktopE2eBridge";
import {
  appendCoreFlowObservation,
  describeCoreFlowError,
  describeRuntimeEffectAction,
  installElectronDesktopE2eDiagnosticsExportObserver,
  installElectronDesktopE2eGuardedQuitObserver,
  installElectronDesktopE2eLaunchCompletionObserver,
  nextCoreFlowIdentity,
  readDiagnosticsExportJournal
} from "./coreFlowDiagnosticsObserver";
import { parseElectronDesktopE2ePopupLifecycleJournalInspection } from
  "./popupLifecycleJournalInspection";
import { parseElectronDesktopE2eFullscreenToolbarInspection } from
  "./fullscreenToolbarInspection";
import { parseElectronDesktopE2eRolePlaceholderInspection } from
  "./rolePlaceholderInspection";
import { parseElectronDesktopE2eWorkspaceWebInspection } from
  "./workspaceWebInspection";
import {
  installWorkspaceWebSecurityPolicyObserver,
  readWorkspaceWebSecurityPolicy as readObservedWorkspaceWebSecurityPolicy
} from "./workspaceWebSecurityPolicyObserver";
import { ElectronDesktopE2eApplicationShortcutRuntimeObserver } from
  "./applicationShortcutRuntimeObserver";
import { ElectronDesktopE2eRuntimeTabReloadObserver } from
  "./runtimeTabReloadObserver";
import { ElectronDesktopE2eAppKitTabMenuRuntimeObserver } from
  "./appKitTabMenuRuntimeObserver";
import { readElectronDesktopE2eRoleSessionMigration } from
  "./roleSessionMigrationInspection";
import { installElectronDesktopE2eRoleSurfaceLifecycleObserver } from
  "./roleSurfaceLifecycleObserver";

authorizeDesktopE2eChromiumCommandLine();
app.commandLine.appendSwitch("force-renderer-accessibility");

interface NativeAppCoreOptions {
  appVersion: string;
  packaged: boolean;
  platform: "darwin" | "win32";
  runtimeContractVersion: number;
  startupBackupLabel: string;
  userDataDir: string;
}

interface DesktopE2eNativeCoreFactory {
  createAppCoreForDesktopE2e:
    RawNodeApiCoreFactory<NativeAppCoreOptions>["createAppCore"];
}

const RETAINED_V22_PHASE = "chromium-role-session-reset-seed";
const RETAINED_V22_GAME_NAME = "Chromium Retained v22 Game";
const RETAINED_V22_ROLE_NAME = "Chromium Retained v22 Role";
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const ROLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const requireNativeModule = createRequire(import.meta.url);
const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
const phase = process.env.RION_STUDIO_E2E_PHASE;
const userDataDirectory = process.env.RION_STUDIO_USER_DATA_DIR;
const clearReceiptsByRole = new Map<
  string,
  ElectronDesktopE2eRoleBrowserDataClearReceipt
>();
const roleSessionObservations = new Map<
  string,
  ElectronDesktopE2eRoleSessionRuntimeInspection["latestSessionEnsure"]
>();
const roleRuntimeObservations = new Map<
  string,
  ElectronDesktopE2eRoleSessionRuntimeInspection["currentRuntime"]
>();
const runtimeTopologyObservations: Array<Readonly<{
  roles: ChromiumRuntimeExecutorSnapshot["roles"];
  sequence: number;
  tabs: ChromiumRuntimeExecutorSnapshot["tabs"];
  webSurfaces: ChromiumRuntimeExecutorSnapshot["webSurfaces"];
  windows: ChromiumRuntimeExecutorSnapshot["windows"];
}>> = [];
const gameWindowRuntimeObservations = new Map<
  string,
  ElectronDesktopE2eGameWindowRuntimeInspection
>();
const fullscreenToolbarRuntimeObservations:
  ElectronDesktopE2eFullscreenToolbarInspection[] = [];
const workspaceWebRuntimeObservations:
  ElectronDesktopE2eWorkspaceWebInspection[] = [];
const workspaceWebPresentationOwners = new Map<string, Readonly<{
  generation: number;
  registry: ChromiumGlobalWebPresentationRegistry;
  slotId: string;
}>>();
const workspaceRoleSurfaceOwners = new Map<string, Readonly<{
  generation: number;
  registry: ChromiumRoleSurfaceRegistry;
  tabId: string;
}>>();
const rolePlaceholderOwners = new Map<string, Readonly<{
  registry: ChromiumRuntimeRolePlaceholderRegistry;
  roleId: string;
}>>();
const rolePlaceholderIdsByRegistry = new WeakMap<
  ChromiumRuntimeRolePlaceholderRegistry,
  ReadonlySet<string>
>();
const rolePlaceholderRuntimeObservations:
  ElectronDesktopE2eRolePlaceholderInspection[] = [];
const workspacePopupHostOwners = new Map<string, Readonly<{
  admission: ChromiumPopupAdmissionRecord;
  host: ChromiumRuntimeHostPort;
  receipt: ChromiumPopupNativeHostReceiptRecord;
}>>();
const runtimeTabPhases = new Map<string, Readonly<{
  phase: RuntimeTabActivationPhaseRecord;
  topologyRevision: number;
  windowGeneration: number;
  windowId: string;
}>>();
const nativeSessionInstances = new WeakMap<object, number>();
let nextNativeSessionInstance = 1;
let nextRuntimeTopologySequence = 1;
let lastRuntimeTopologySignature: string | null = null;
const shutdownMarkerPath = artifactDirectory && isAbsolute(artifactDirectory)
  ? join(artifactDirectory, "electron-final-flush.json")
  : undefined;
let observedCore: CoreAddonClient | null = null;
let observedApplicationLifecycle: ElectronApplicationLifecycleController | null = null;
let observedRuntime: Pick<
  ChromiumRuntimeBootstrap,
  "desktopE2eStatusPresentation" | "inspectFullscreenToolbar" | "snapshot"
> | null = null;
let observedPopupLifecycle: ChromiumPopupLifecycleCoordinator | null = null;
const trustedInputObservationsByRole = new Map<
  string,
  ElectronDesktopE2eTrustedInputObservation[]
>();
const applicationShortcutRuntimeObserver =
  new ElectronDesktopE2eApplicationShortcutRuntimeObserver({
    artifactDirectory,
    globalWebSurfaceOwners: workspaceWebPresentationOwners,
    platform: () => e2ePlatform().platform,
    popupHostOwners: workspacePopupHostOwners,
    readCore: () => observedCore,
    readRuntime: () => observedRuntime,
    roleSurfaceOwners: workspaceRoleSurfaceOwners
  });
const runtimeTabReloadObserver = new ElectronDesktopE2eRuntimeTabReloadObserver({
  artifactDirectory,
  platform: () => e2ePlatform().platform,
  popupHostOwners: workspacePopupHostOwners,
  readRuntime: () => observedRuntime,
  roleSurfaceOwners: workspaceRoleSurfaceOwners
});
const appKitTabMenuRuntimeObserver =
  new ElectronDesktopE2eAppKitTabMenuRuntimeObserver();

function writeFinalFlushMarker(): void {
  if (!shutdownMarkerPath || !phase) return;
  writeFileSync(shutdownMarkerPath, `${JSON.stringify({
    complete: true,
    phase,
    pid: process.pid,
    runtimeTarget: process.env.RION_STUDIO_E2E_RUNTIME_TARGET
  })}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeRoleSessionRuntimeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const observations = [...roleSessionObservations.entries()].map(
    ([roleId, latestSessionEnsure]) => ({
      currentRuntime: roleRuntimeObservations.get(roleId) ?? null,
      latestSessionEnsure,
      roleId
    })
  );
  writeFileSync(
    join(artifactDirectory, "electron-role-session-runtime-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`
  );
}

function writeRuntimeTopologyObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  writeFileSync(
    join(artifactDirectory, "electron-runtime-topology-observations.json"),
    `${JSON.stringify(runtimeTopologyObservations, null, 2)}\n`
  );
}

function writeGameWindowRuntimeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  writeFileSync(
    join(artifactDirectory, "electron-game-window-runtime-observations.json"),
    `${JSON.stringify([...gameWindowRuntimeObservations.values()], null, 2)}\n`
  );
}

function writeFullscreenToolbarRuntimeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  writeFileSync(
    join(artifactDirectory, "electron-fullscreen-toolbar-observations.json"),
    `${JSON.stringify(fullscreenToolbarRuntimeObservations, null, 2)}\n`
  );
}

function writeWorkspaceWebRuntimeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const fileName = phase?.startsWith("chromium-workspace-web-fullscreen-")
    ? "electron-workspace-web-fullscreen-observations.json"
    : phase?.startsWith("chromium-workspace-web-only-")
      ? "electron-workspace-web-only-observations.json"
      : "electron-workspace-web-runtime-observations.json";
  writeFileSync(
    join(artifactDirectory, fileName),
    `${JSON.stringify(workspaceWebRuntimeObservations, null, 2)}\n`
  );
}

function writeRolePlaceholderRuntimeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  writeFileSync(
    join(artifactDirectory, "electron-role-placeholder-observations.json"),
    `${JSON.stringify(rolePlaceholderRuntimeObservations, null, 2)}\n`
  );
}

function observeRuntimeSnapshot(snapshot: ChromiumRuntimeExecutorSnapshot): void {
  const topology = {
    roles: snapshot.roles,
    tabs: snapshot.tabs,
    webSurfaces: snapshot.webSurfaces,
    windows: snapshot.windows
  };
  const topologySignature = JSON.stringify(topology);
  if (topologySignature !== lastRuntimeTopologySignature) {
    lastRuntimeTopologySignature = topologySignature;
    runtimeTopologyObservations.push(Object.freeze({
      ...topology,
      sequence: nextRuntimeTopologySequence++
    }));
    if (runtimeTopologyObservations.length > 128) {
      runtimeTopologyObservations.shift();
    }
    writeRuntimeTopologyObservations();
  }
  const observedRoleIds = new Set<string>();
  for (const role of snapshot.roles) {
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === role.tabId);
    const window = snapshot.windows.find((candidate) => candidate.windowId === role.windowId);
    if (!tab || !window) continue;
    observedRoleIds.add(role.roleId);
    const presented = window.activeTabId === role.tabId;
    roleRuntimeObservations.set(role.roleId, Object.freeze({
      appKitIdentity: window.appKitIdentity
        ? Object.freeze({ ...window.appKitIdentity })
        : null,
      attemptGeneration: tab.attemptGeneration ?? null,
      focused: window.focused && presented,
      generation: role.generation,
      hostKind: window.appKitIdentity ? "appkit-chromium" : "bundled-chromium",
      ownerGeneration: role.ownerGeneration,
      parentNativeHostId: window.parentNativeHostId ?? 0,
      tabId: role.tabId,
      topologyRevision: window.topologyRevision,
      visible: window.visible && presented,
      windowGeneration: window.windowGeneration,
      windowId: role.windowId
    }));
  }
  for (const roleId of new Set([
    ...roleSessionObservations.keys(),
    ...roleRuntimeObservations.keys()
  ])) {
    if (!observedRoleIds.has(roleId)) roleRuntimeObservations.set(roleId, null);
  }
  writeRoleSessionRuntimeObservations();
}

function installElectronDesktopE2eRoleRuntimeObserver(): void {
  type SessionEnsurePort = {
    ensure: (roleId: string, rolePaths: RolePathsRecord) => ChromiumRoleSessionHandle;
  };
  const sessions = ChromiumRoleSessionRegistry.prototype as unknown as SessionEnsurePort;
  const originalEnsure = sessions.ensure;
  sessions.ensure = function (roleId, rolePaths) {
    const handle = originalEnsure.call(this, roleId, rolePaths);
    const nativeSession = handle.session as object;
    let nativeSessionInstance = nativeSessionInstances.get(nativeSession);
    if (nativeSessionInstance === undefined) {
      nativeSessionInstance = nextNativeSessionInstance;
      nextNativeSessionInstance += 1;
      nativeSessionInstances.set(nativeSession, nativeSessionInstance);
    }
    const existing = roleSessionObservations.get(roleId);
    const sessionStoragePath = handle.session.storagePath;
    if (typeof sessionStoragePath !== "string" || sessionStoragePath.length === 0) {
      throw new Error(`Role ${roleId} did not bind a persistent Chromium Session path.`);
    }
    roleSessionObservations.set(roleId, Object.freeze({
      chromiumPathSha256: sha256(handle.chromiumUserDataDir),
      chromiumUserDataDir: handle.chromiumUserDataDir,
      ensureCount: (existing?.ensureCount ?? 0) + 1,
      nativeSessionInstance,
      sessionStoragePath,
      sessionStoragePathSha256: sha256(sessionStoragePath)
    }));
    writeRoleSessionRuntimeObservations();
    return handle;
  };

  type RuntimeSnapshotPort = Pick<
    ChromiumRuntimeBootstrap,
    "desktopE2eStatusPresentation" | "inspectFullscreenToolbar" | "snapshot"
  >;
  const runtime = ChromiumRuntimeBootstrap.prototype as unknown as RuntimeSnapshotPort;
  const originalSnapshot = runtime.snapshot;
  const observeRuntimeOwner = (owner: RuntimeSnapshotPort): void => {
    observedRuntime = owner;
  };
  runtime.snapshot = function () {
    observeRuntimeOwner(this);
    const snapshot = originalSnapshot.call(this);
    observeRuntimeSnapshot(snapshot);
    return snapshot;
  };
}

function installElectronDesktopE2eWorkspaceWebObserver(): void {
  installWorkspaceWebSecurityPolicyObserver(artifactDirectory);

  const registry = ChromiumGlobalWebPresentationRegistry.prototype;
  const originalCreate = registry.create;
  const originalCloseSurface = registry.closeSurface;
  registry.create = async function (input) {
    const handle = await originalCreate.call(this, input);
    workspaceWebPresentationOwners.set(input.surfaceId, Object.freeze({
      generation: input.generation,
      registry: this,
      slotId: input.slotId
    }));
    return handle;
  };
  registry.closeSurface = async function (surfaceId, generation) {
    const closed = await originalCloseSurface.call(this, surfaceId, generation);
    const owner = workspaceWebPresentationOwners.get(surfaceId);
    if (closed && owner?.registry === this && owner.generation === generation) {
      workspaceWebPresentationOwners.delete(surfaceId);
    }
    return closed;
  };

  const roleRegistry = ChromiumRoleSurfaceRegistry.prototype;
  const originalRoleCreate = roleRegistry.create;
  const originalCloseRole = roleRegistry.closeRole;
  roleRegistry.create = async function (input) {
    const handle = await originalRoleCreate.call(this, input);
    workspaceRoleSurfaceOwners.set(input.roleId, Object.freeze({
      generation: input.generation,
      registry: this,
      tabId: input.tabId
    }));
    return handle;
  };
  roleRegistry.closeRole = async function (roleId, generation) {
    const closed = await originalCloseRole.call(this, roleId, generation);
    const owner = workspaceRoleSurfaceOwners.get(roleId);
    if (closed && owner?.registry === this && owner.generation === generation) {
      workspaceRoleSurfaceOwners.delete(roleId);
    }
    return closed;
  };

  const runtimeExecutor = ChromiumRuntimeEffectExecutor.prototype;
  const originalExecuteRuntimeEffect = runtimeExecutor.execute;
  runtimeExecutor.execute = async function (effect, context) {
    const action = effect.action;
    const details = describeRuntimeEffectAction(action);
    appendCoreFlowObservation({
      boundary: "effect",
      ...(details === undefined
        ? {}
        : { details: { action: details, target: effect.target } }),
      identity: effect.effectId,
      status: "started",
      type: action.type
    });
    let result: unknown;
    try {
      result = await originalExecuteRuntimeEffect.call(this, effect, context);
      appendCoreFlowObservation({
        boundary: "effect",
        ...(action.type === "embeddedDestroyTab"
          ? { details: { native: this.snapshot(), result } }
          : {}),
        identity: effect.effectId,
        status: "completed",
        type: action.type
      });
    } catch (error) {
      appendCoreFlowObservation({
        boundary: "effect",
        error: error instanceof Error ? error.message : String(error),
        identity: effect.effectId,
        status: "rejected",
        type: action.type
      });
      throw error;
    }
    if (action.type === "embeddedFollowRoleOwnership") {
      for (const projection of action.windows ?? []) {
        for (const tab of projection.tabPhases) {
          runtimeTabPhases.set(tab.tabId, Object.freeze({
            phase: tab.phase,
            topologyRevision: projection.topologyRevision,
            windowGeneration: projection.windowGeneration,
            windowId: projection.windowId
          }));
        }
      }
    } else if (action.type === "embeddedApplyAppKitProjection") {
      for (const projection of action.projection.windows) {
        for (const tab of projection.tabs) {
          runtimeTabPhases.set(tab.tabId, Object.freeze({
            phase: tab.phase,
            topologyRevision: projection.topologyRevision,
            windowGeneration: projection.windowGeneration,
            windowId: projection.identity.logicalWindowId
          }));
        }
      }
    }
    return result;
  };

  const launchCoordinator = ChromiumRuntimeLaunchCoordinator.prototype;
  const originalLaunchRole = launchCoordinator.launchRole;
  const originalRestoreSavedGameWindow = launchCoordinator.restoreSavedGameWindow;
  launchCoordinator.launchRole = function (roleId, destination) {
    const identity = nextCoreFlowIdentity(`role:${roleId}`);
    appendCoreFlowObservation({
      boundary: "launch",
      identity,
      status: "started",
      type: destination?.kind ?? "default"
    });
    return originalLaunchRole.call(this, roleId, destination).then((result) => {
      appendCoreFlowObservation({
        boundary: "launch",
        identity,
        status: "completed",
        type: destination?.kind ?? "default"
      });
      return result;
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "launch",
        error: describeCoreFlowError(error),
        identity,
        status: "rejected",
        type: destination?.kind ?? "default"
      });
      throw error;
    });
  };
  launchCoordinator.restoreSavedGameWindow = function (window) {
    const identity = nextCoreFlowIdentity(`restore:${window.id}`);
    appendCoreFlowObservation({
      boundary: "launch",
      details: { tabIds: window.tabs.map((tab) => tab.id) },
      identity,
      status: "started",
      type: "restoreSavedGameWindow"
    });
    return originalRestoreSavedGameWindow.call(this, window).then(() => {
      appendCoreFlowObservation({
        boundary: "launch",
        identity,
        status: "completed",
        type: "restoreSavedGameWindow"
      });
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "launch",
        error: describeCoreFlowError(error),
        identity,
        status: "rejected",
        type: "restoreSavedGameWindow"
      });
      throw error;
    });
  };

  const hostFactory = ChromiumPlatformRuntimeHostFactory.prototype;
  const originalCreatePopup = hostFactory.createPopup;
  hostFactory.createPopup = async function (admission) {
    const created = await originalCreatePopup.call(this, admission);
    workspacePopupHostOwners.set(admission.popupId, Object.freeze({
      admission,
      host: created.host,
      receipt: created.receipt
    }));
    return created;
  };
}

function observePopupLifecycle(
  coordinator: ChromiumPopupLifecycleCoordinator
): void {
  observedPopupLifecycle = coordinator;
}

function installElectronDesktopE2ePopupLifecycleObserver(): void {
  const coordinator = ChromiumPopupLifecycleCoordinator.prototype;
  const originalRequestOpen = coordinator.requestOpen;
  const originalRetireOwner = coordinator.retireOwner;
  coordinator.requestOpen = function (source, details) {
    observePopupLifecycle(this);
    return originalRequestOpen.call(this, source, details);
  };
  coordinator.retireOwner = function (owner) {
    observePopupLifecycle(this);
    return originalRetireOwner.call(this, owner);
  };
}

function installElectronDesktopE2eRolePlaceholderObserver(): void {
  const registry = ChromiumRuntimeRolePlaceholderRegistry.prototype;
  const originalReconcile = registry.reconcile;
  const originalDispose = registry.dispose;
  const removeRegistryPlaceholders = (
    owner: ChromiumRuntimeRolePlaceholderRegistry
  ): void => {
    for (const placeholderId of rolePlaceholderIdsByRegistry.get(owner) ?? []) {
      if (rolePlaceholderOwners.get(placeholderId)?.registry === owner) {
        rolePlaceholderOwners.delete(placeholderId);
      }
    }
    rolePlaceholderIdsByRegistry.delete(owner);
  };
  registry.reconcile = async function (
    descriptors: readonly ChromiumRuntimeRolePlaceholderDescriptor[]
  ): Promise<void> {
    await originalReconcile.call(this, descriptors);
    removeRegistryPlaceholders(this);
    const next = new Set<string>();
    for (const descriptor of descriptors) {
      next.add(descriptor.placeholderId);
      rolePlaceholderOwners.set(descriptor.placeholderId, Object.freeze({
        registry: this,
        roleId: descriptor.roleId
      }));
    }
    rolePlaceholderIdsByRegistry.set(this, next);
  };
  registry.dispose = async function (): Promise<void> {
    try {
      await originalDispose.call(this);
    } finally {
      removeRegistryPlaceholders(this);
    }
  };
}

function e2ePlatform(): {
  platform: "darwin" | "win32";
  productPlatform: "macos" | "windows";
  runtimeTarget: "chromium-v23-macos-appkit" | "chromium-v23-windows";
  sourceEngine: "wkwebview" | "webview2";
} {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      productPlatform: "macos",
      runtimeTarget: "chromium-v23-macos-appkit",
      sourceEngine: "wkwebview"
    };
  }
  if (process.platform === "win32") {
    return {
      platform: "win32",
      productPlatform: "windows",
      runtimeTarget: "chromium-v23-windows",
      sourceEngine: "webview2"
    };
  }
  throw new Error(`Electron desktop E2E does not support ${process.platform}.`);
}

function requireE2eEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Electron desktop E2E entry`);
  return value;
}

function fixtureLaunchUrl(): string {
  const origin = new URL(requireE2eEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  if (
    origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || origin.username !== ""
    || origin.password !== ""
  ) {
    throw new Error("The Electron desktop E2E fixture origin is not loopback HTTP.");
  }
  const launchUrl = new URL("/role/chromium-explicit-reset", origin);
  launchUrl.searchParams.set("marker", "chromium-explicit-reset");
  launchUrl.searchParams.set("mode", "observe");
  return launchUrl.href;
}

async function seedRetainedV22Role(): Promise<
  ElectronDesktopE2eRetainedV22Precondition | null
> {
  if (phase !== RETAINED_V22_PHASE) return null;
  const token = requireE2eEnvironment("RION_STUDIO_E2E_SESSION_TOKEN");
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new Error("The Electron desktop E2E session token is invalid.");
  }
  const platform = e2ePlatform();
  if (requireE2eEnvironment("RION_STUDIO_E2E_RUNTIME_TARGET") !== platform.runtimeTarget) {
    throw new Error("The retained-v22 pre-seed target does not match the host platform.");
  }
  if (!userDataDirectory || !isAbsolute(userDataDirectory)) {
    throw new Error("The retained-v22 pre-seed requires an absolute user-data directory.");
  }
  const addonPath = join(
    import.meta.dirname,
    `../../build/native/${process.platform}-${process.arch}/rion-core.node`
  );
  const addon = requireNativeModule(addonPath) as DesktopE2eNativeCoreFactory;
  const core = await CoreAddonClient.create({
    createAppCore: (options) => addon.createAppCoreForDesktopE2e(options)
  }, {
    appVersion: app.getVersion(),
    packaged: false,
    platform: platform.platform,
    runtimeContractVersion: 22,
    startupBackupLabel: "electron-desktop-e2e-retained-v22",
    userDataDir: userDataDirectory
  });
  try {
    const launchUrl = fixtureLaunchUrl();
    const game = await core.invoke({
      type: "gameCreate",
      input: {
        defaultLaunchUrl: launchUrl,
        name: RETAINED_V22_GAME_NAME
      }
    });
    const role = await core.invoke({
      type: "roleCreate",
      input: {
        gameId: game.id,
        launchUrl,
        name: RETAINED_V22_ROLE_NAME,
        notes: "Created only by the Chromium desktop E2E v22 pre-seed."
      }
    });
    await core.invoke({ type: "roleBrowserDirectoryEnsure", id: role.id });
    const precondition = Object.freeze({
      contractVersion: 1,
      gameId: game.id,
      gameName: game.name,
      launchUrl,
      platform: platform.productPlatform,
      roleId: role.id,
      roleName: role.name,
      runtimeContractVersion: 22,
      sourceEngine: platform.sourceEngine
    } satisfies ElectronDesktopE2eRetainedV22Precondition);
    if (artifactDirectory && isAbsolute(artifactDirectory)) {
      writeFileSync(
        join(artifactDirectory, "retained-v22-precondition.json"),
        `${JSON.stringify(precondition, null, 2)}\n`
      );
    }
    return precondition;
  } finally {
    await core.shutdown();
  }
}

function exactClearReceipt(
  result: CoreEffectResult
): ElectronDesktopE2eRoleBrowserDataClearReceipt | null {
  if (!result.ok || result.error !== null || result.valueJson === null) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(result.valueJson);
  } catch {
    return null;
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const receipt = candidate as Record<string, unknown>;
  const storages = receipt.clearedStorages;
  if (
    Object.keys(receipt).length !== 5
    || typeof receipt.roleId !== "string"
    || !ROLE_ID_PATTERN.test(receipt.roleId)
    || receipt.operationId !== result.operationId
    || !Array.isArray(storages)
    || storages.length !== ELECTRON_DESKTOP_E2E_CLEAR_STORAGES.length
    || storages.some((storage, index) =>
      storage !== ELECTRON_DESKTOP_E2E_CLEAR_STORAGES[index]
    )
    || receipt.cookieReadbackCount !== 0
    || receipt.evidence !== "electron-clear-storage-data-promise-and-cookie-readback"
  ) {
    return null;
  }
  return Object.freeze({
    clearedStorages: Object.freeze([...storages]) as
      ElectronDesktopE2eRoleBrowserDataClearReceipt["clearedStorages"],
    cookieReadbackCount: 0,
    evidence: "electron-clear-storage-data-promise-and-cookie-readback",
    operationId: result.operationId,
    roleId: receipt.roleId
  });
}

function installElectronDesktopE2eReceiptObserver(): void {
  const originalDispatch = CoreAddonClient.prototype.dispatchCoreEffectResults;
  const observeCoreOwner = (owner: CoreAddonClient): void => {
    observedCore = owner;
  };
  CoreAddonClient.prototype.dispatchCoreEffectResults = async function (results) {
    observeCoreOwner(this);
    const identity = results.map((result) => result.effectId).join(",");
    appendCoreFlowObservation({
      boundary: "ack",
      details: results.map((result) => ({
        effectId: result.effectId,
        ok: result.ok,
        operationId: result.operationId,
        ...(result.error ? {
          error: {
            code: result.error.code,
            message: result.error.message
          }
        } : {})
      })),
      identity,
      status: "started",
      type: "dispatchCoreEffectResults"
    });
    try {
      const report = await originalDispatch.call(this, results);
      appendCoreFlowObservation({
        boundary: "ack",
        details: report,
        identity,
        status: "completed",
        type: "dispatchCoreEffectResults"
      });
      for (const result of results) {
        const receipt = exactClearReceipt(result);
        if (receipt) clearReceiptsByRole.set(receipt.roleId, receipt);
      }
      return report;
    } catch (error) {
      appendCoreFlowObservation({
        boundary: "ack",
        error: describeCoreFlowError(error),
        identity,
        status: "rejected",
        type: "dispatchCoreEffectResults"
      });
      throw error;
    }
  };
}

function installElectronDesktopE2eApplicationLifecycleObserver(): void {
  const lifecycle = ElectronApplicationLifecycleController.prototype;
  const originalStart = lifecycle.start;
  const observeLifecycleOwner = (
    owner: ElectronApplicationLifecycleController
  ): void => {
    observedApplicationLifecycle = owner;
  };
  lifecycle.start = function () {
    observeLifecycleOwner(this);
    return originalStart.call(this);
  };
}

function installElectronDesktopE2eTrustedInputObserver(): void {
  const coordinator = ChromiumTrustedInputCoordinator.prototype;
  const originalExecute = coordinator.execute;
  coordinator.execute = async function (request) {
    const receipt = await originalExecute.call(this, request);
    const existing = trustedInputObservationsByRole.get(request.roleId) ?? [];
    const action = request.action.type === "key"
      ? Object.freeze({
          ...request.action,
          modifiers: [...request.action.modifiers]
        })
      : Object.freeze({ ...request.action });
    existing.push(Object.freeze({
      receipt: Object.freeze({ ...receipt }),
      request: Object.freeze({ ...request, action }) as typeof request,
      sequence: existing.length + 1
    }));
    trustedInputObservationsByRole.set(request.roleId, existing);
    return receipt;
  };
}

async function signalApplicationLifecycle(
  event: ElectronApplicationPowerEvent
): Promise<ElectronDesktopE2eApplicationLifecycleSignalReceipt> {
  const lifecycle = observedApplicationLifecycle;
  if (!lifecycle) {
    throw new Error("The Electron application lifecycle controller is unavailable.");
  }
  const before = lifecycle.snapshot();
  const terminal = await lifecycle.signal(event);
  return Object.freeze({
    before: Object.freeze({ ...before }),
    event,
    terminal: Object.freeze({ ...terminal })
  });
}

function readTrustedInputRuntime(
  roleId: string
): readonly ElectronDesktopE2eTrustedInputObservation[] {
  return Object.freeze([...(trustedInputObservationsByRole.get(roleId) ?? [])]);
}

async function readGameWindowRuntime(
  windowId: string
): Promise<ElectronDesktopE2eGameWindowRuntimeInspection> {
  const core = observedCore;
  const runtime = observedRuntime;
  if (!core || !runtime) {
    throw new Error(
      `Game Window ${windowId} has no observed Core/native Chromium ownership.`
    );
  }
  const coreSnapshot = await core.invoke({ type: "appSnapshot" });
  const nativeSnapshot = runtime.snapshot();
  const logicalWindows = coreSnapshot.logicalWindows.filter(
    (window) => window.windowId === windowId
  );
  const browserWindows = coreSnapshot.browserRuntime.windows.filter(
    (window) => window.windowId === windowId
  );
  const nativeWindows = nativeSnapshot.windows.filter(
    (window) => window.windowId === windowId
  );
  if (
    logicalWindows.length === 0 &&
    browserWindows.length === 0 &&
    nativeWindows.length === 0
  ) {
    const inspection = Object.freeze({
      currentRuntime: null,
      windowId
    } satisfies ElectronDesktopE2eGameWindowRuntimeInspection);
    gameWindowRuntimeObservations.set(windowId, inspection);
    writeGameWindowRuntimeObservations();
    return inspection;
  }
  if (
    logicalWindows.length !== 1 ||
    browserWindows.length !== 1 ||
    nativeWindows.length !== 1
  ) {
    throw new Error(
      `Game Window ${windowId} has divergent Core/browser/native Chromium ownership.`
    );
  }
  const logical = logicalWindows[0]!;
  const browserWindow = browserWindows[0]!;
  const native = nativeWindows[0]!;
  const nativeTarget = native.target;
  const coreTabIds = logical.tabs.map((tab) => tab.id);
  if (
    logical.windowGeneration !== native.windowGeneration ||
    logical.revision !== native.topologyRevision ||
    JSON.stringify(coreTabIds) !== JSON.stringify(browserWindow.tabIds) ||
    JSON.stringify(coreTabIds) !== JSON.stringify(native.tabIds) ||
    !nativeTarget ||
    nativeTarget.windowId !== windowId ||
    nativeTarget.displayId !== native.displayId ||
    nativeTarget.presentation !== native.presentation ||
    JSON.stringify(nativeTarget.bounds) !== JSON.stringify(native.bounds) ||
    !Number.isFinite(nativeTarget.scaleFactor) || nativeTarget.scaleFactor <= 0 ||
    !Number.isSafeInteger(native.parentNativeHostId) ||
    (native.parentNativeHostId ?? 0) < 1
  ) {
    const fence = {
      browserTabIds: browserWindow.tabIds,
      coreTabIds,
      logicalRevision: logical.revision,
      logicalWindowGeneration: logical.windowGeneration,
      nativeBounds: native.bounds,
      nativeDisplayId: native.displayId,
      nativeParentHostId: native.parentNativeHostId,
      nativePresentation: native.presentation,
      nativeTabIds: native.tabIds,
      nativeTarget,
      nativeTopologyRevision: native.topologyRevision,
      nativeWindowGeneration: native.windowGeneration
    };
    throw new Error(
      `Game Window ${windowId} has a stale Core/native Chromium fence: ${JSON.stringify(fence)}`
    );
  }
  const platform = e2ePlatform();
  if (
    (platform.platform === "darwin" && !native.appKitIdentity) ||
    (platform.platform === "win32" && native.appKitIdentity)
  ) {
    throw new Error(
      `Game Window ${windowId} has an invalid platform-native Chromium host.`
    );
  }
  const rawStatusPresentation = native.appKitIdentity
    ? runtime.desktopE2eStatusPresentation(windowId)
    : undefined;
  if (native.appKitIdentity && (
    rawStatusPresentation === undefined ||
    !new Set([0, 1, 2]).has(rawStatusPresentation)
  )) {
    throw new Error(
      `Game Window ${windowId} has no exact AppKit status presentation.`
    );
  }
  const appKitStatusPresentation = rawStatusPresentation === 1
    ? "loading"
    : rawStatusPresentation === 2
      ? "failed"
      : native.appKitIdentity
        ? "ready"
        : null;
  const inspection = Object.freeze({
    currentRuntime: Object.freeze({
      appKitIdentity: native.appKitIdentity
        ? Object.freeze({ ...native.appKitIdentity })
        : null,
      appKitStatusPresentation,
      coreTabIds: Object.freeze([...coreTabIds]),
      focused: native.focused,
      hostKind: native.appKitIdentity ? "appkit-chromium" : "bundled-chromium",
      nativeDisplay: Object.freeze({
        bounds: Object.freeze({ ...native.bounds }),
        displayId: native.displayId,
        presentation: native.presentation,
        scaleFactor: nativeTarget.scaleFactor,
        workArea: Object.freeze({ ...nativeTarget.workArea })
      }),
      nativeTabIds: Object.freeze([...native.tabIds]),
      parentNativeHostId: native.parentNativeHostId!,
      topologyRevision: native.topologyRevision,
      visible: native.visible,
      windowGeneration: native.windowGeneration,
      windowId
    }),
    windowId
  } satisfies ElectronDesktopE2eGameWindowRuntimeInspection);
  gameWindowRuntimeObservations.set(windowId, inspection);
  writeGameWindowRuntimeObservations();
  return inspection;
}

async function readWorkspaceWebRuntime(
  windowId: string
): Promise<ElectronDesktopE2eWorkspaceWebInspection> {
  const core = observedCore;
  const runtime = observedRuntime;
  if (!core || !runtime) {
    throw new Error(
      `Workspace Web ${windowId} has no observed Core/native Chromium ownership.`
    );
  }
  const coreSnapshot = await core.invoke({ type: "appSnapshot" });
  const nativeSnapshot = runtime.snapshot();
  const logicalWindows = coreSnapshot.logicalWindows.filter(
    (window) => window.windowId === windowId
  );
  const browserWindows = coreSnapshot.browserRuntime.windows.filter(
    (window) => window.windowId === windowId
  );
  const nativeWindows = nativeSnapshot.windows.filter(
    (window) => window.windowId === windowId
  );
  const browserTabs = coreSnapshot.browserRuntime.tabs.filter((tab) =>
    tab.windowId === windowId && tab.tabType === "workspace" &&
    tab.webSurfaces.length > 0
  );
  if (
    logicalWindows.length !== 1 || browserWindows.length !== 1 ||
    nativeWindows.length !== 1 || browserTabs.length !== 1
  ) {
    throw new Error(
      `Workspace Web ${windowId} has divergent Core/browser/native ownership.`
    );
  }
  const logical = logicalWindows[0]!;
  const browserWindow = browserWindows[0]!;
  const nativeWindow = nativeWindows[0]!;
  const browserTab = browserTabs[0]!;
  const tabPhase = runtimeTabPhases.get(browserTab.id);
  const logicalTabs = logical.tabs.filter((tab) => tab.id === browserTab.id);
  const nativeSurfaces = nativeSnapshot.webSurfaces.filter((surface) =>
    surface.windowId === windowId && surface.tabId === browserTab.id
  );
  if (
    logicalTabs.length !== 1 || browserTab.webSurfaces.length !== 1 ||
    nativeSurfaces.length !== 1 || !browserTab.attemptGeneration ||
    !tabPhase || tabPhase.windowId !== windowId ||
    tabPhase.windowGeneration !== nativeWindow.windowGeneration ||
    tabPhase.topologyRevision > nativeWindow.topologyRevision ||
    logical.windowGeneration !== nativeWindow.windowGeneration ||
    logical.revision !== nativeWindow.topologyRevision ||
    JSON.stringify(browserWindow.tabIds) !== JSON.stringify(nativeWindow.tabIds)
  ) {
    throw new Error(
      `Workspace Web ${windowId} lost its exact Core/native generation fence: ${JSON.stringify({
        browserTabIds: browserWindow.tabIds,
        logicalRevision: logical.revision,
        logicalTabCount: logicalTabs.length,
        logicalWindowGeneration: logical.windowGeneration,
        nativeTabIds: nativeWindow.tabIds,
        nativeTopologyRevision: nativeWindow.topologyRevision,
        nativeWindowGeneration: nativeWindow.windowGeneration,
        tabPhase: tabPhase ?? null
      })}`
    );
  }
  const logicalTab = logicalTabs[0]!;
  const identity = browserTab.webSurfaces[0]!;
  const nativeSurface = nativeSurfaces[0]!;
  const owner = workspaceWebPresentationOwners.get(identity.surfaceId);
  const roleSlot = (logicalTab.workspaceSlots ?? []).find(
    (slot) => slot.roleId !== undefined
  );
  const nativeRoles = nativeSnapshot.roles.filter((role) =>
    role.windowId === windowId && role.tabId === browserTab.id
  );
  const nativeRole = roleSlot?.roleId
    ? nativeRoles.find((role) => role.roleId === roleSlot.roleId)
    : undefined;
  const roleOwner = roleSlot?.roleId
    ? workspaceRoleSurfaceOwners.get(roleSlot.roleId)
    : undefined;
  const roleOwnershipExact = roleSlot?.roleId
    ? nativeRoles.length === 1 && roleOwner !== undefined &&
      nativeRole !== undefined && roleOwner.tabId === browserTab.id &&
      roleOwner.generation === nativeRole.generation
    : nativeRoles.length === 0;
  if (
    !owner || owner.slotId !== identity.slotId ||
    owner.generation !== nativeSurface.generation ||
    nativeSurface.surfaceId !== identity.surfaceId ||
    nativeSurface.slotId !== identity.slotId ||
    roleSessionObservations.has(identity.surfaceId) || !roleOwnershipExact
  ) {
    throw new Error(
      `Workspace Web ${windowId} lost its isolated paired presentation owner.`
    );
  }
  const presentation: ChromiumWorkspaceWebPresentationEvidence =
    owner.registry.runtimeEvidence(identity.surfaceId, owner.generation);
  const coreSlots = Object.freeze((logicalTab.workspaceSlots ?? []).map((slot) =>
    Object.freeze({
      id: slot.id,
      rect: Object.freeze({ ...slot.rect }),
      roleId: slot.roleId ?? null,
      web: slot.web ? Object.freeze({ ...slot.web }) : null
    })
  ));
  const roleProjection = roleSlot?.roleId && roleOwner
    ? roleOwner.registry.readProjection(roleSlot.roleId, roleOwner.generation)
    : null;
  const popups = Object.freeze([...workspacePopupHostOwners.values()]
    .filter(({ admission, host }) =>
      admission.parent.parentWindowId === windowId && !host.isDestroyed()
    )
    .map(({ admission, host, receipt }) => {
      const projection = host.readProjection();
      if (
        host.id !== receipt.nativeHostId ||
        host.logicalWindowId !== receipt.logicalWindowId ||
        receipt.logicalWindowId !== admission.target.windowId ||
        JSON.stringify(host.appKitIdentity ?? null) !==
          JSON.stringify(receipt.appkitIdentity ?? null)
      ) {
        throw new Error(
          `Workspace Web popup ${admission.popupId} lost its native ownership fence.`
        );
      }
      return Object.freeze({
        appKitIdentity: receipt.appkitIdentity
          ? Object.freeze({ ...receipt.appkitIdentity })
          : null,
        bounds: Object.freeze({ ...projection.bounds }),
        hostKind: receipt.platform === "macos"
          ? "appkit-chromium" as const
          : "bundled-chromium" as const,
        logicalWindowId: receipt.logicalWindowId,
        nativeHostId: receipt.nativeHostId,
        openOperationId: admission.openOperationId,
        popupId: admission.popupId,
        presentation: projection.presentation,
        topologyRevision: receipt.topologyRevision,
        visible: projection.visible,
        windowGeneration: receipt.windowGeneration
      });
    })
    .sort((left, right) => left.popupId.localeCompare(right.popupId)));
  const inspection = parseElectronDesktopE2eWorkspaceWebInspection({
    appKitIdentity: nativeWindow.appKitIdentity
      ? Object.freeze({ ...nativeWindow.appKitIdentity })
      : null,
    attemptGeneration: browserTab.attemptGeneration,
    coreSlots,
    focused: nativeWindow.focused,
    hostKind: nativeWindow.appKitIdentity
      ? "appkit-chromium"
      : "bundled-chromium",
    parentNativeHostId: nativeWindow.parentNativeHostId,
    phase: tabPhase.phase,
    popups,
    presentation: nativeWindow.presentation,
    role: roleProjection && roleOwner && roleSlot?.roleId
      ? Object.freeze({
          bounds: Object.freeze({ ...roleProjection.bounds }),
          generation: roleOwner.generation,
          roleId: roleSlot.roleId,
          visible: roleProjection.visible
        })
      : null,
    tabId: browserTab.id,
    topologyRevision: nativeWindow.topologyRevision,
    visible: nativeWindow.visible,
    web: Object.freeze({
      ...presentation,
      chromeBounds: Object.freeze({ ...presentation.chromeBounds }),
      contentBounds: Object.freeze({ ...presentation.contentBounds }),
      slotBounds: Object.freeze({ ...presentation.slotBounds }),
      slotId: identity.slotId,
      tabId: browserTab.id
    }),
    windowBounds: Object.freeze({ ...nativeWindow.bounds }),
    windowGeneration: nativeWindow.windowGeneration,
    windowId
  });
  const prior = workspaceWebRuntimeObservations.at(-1);
  if (
    phase?.startsWith("chromium-workspace-web-fullscreen-") ||
    JSON.stringify(prior) !== JSON.stringify(inspection)
  ) {
    workspaceWebRuntimeObservations.push(inspection);
  }
  writeWorkspaceWebRuntimeObservations();
  return inspection;
}

async function readWorkspaceWebSecurityPolicy(
  windowId: string
): Promise<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection> {
  const workspace = await readWorkspaceWebRuntime(windowId);
  return readObservedWorkspaceWebSecurityPolicy(workspace);
}

function readPopupLifecycleJournal(
  windowId: string
): ElectronDesktopE2ePopupLifecycleJournalInspection {
  const coordinator = observedPopupLifecycle;
  if (!coordinator) {
    throw new Error(`Runtime window ${windowId} has no observed popup lifecycle owner.`);
  }
  const journal = coordinator.readLifecycleJournal();
  const inspection = parseElectronDesktopE2ePopupLifecycleJournalInspection({
    capacity: journal.capacity,
    journalVersion: journal.journalVersion,
    observations: journal.observations
      .filter((observation) => observation.parent.parentWindowId === windowId)
      .map((observation) => Object.freeze({
        ...observation,
        parent: Object.freeze({
          ownerId: observation.parent.ownerId,
          ownerKind: observation.parent.ownerKind,
          ownerNativeGeneration: observation.parent.ownerNativeGeneration,
          parentAppkitIdentity: observation.parent.parentAppkitIdentity
            ? Object.freeze({ ...observation.parent.parentAppkitIdentity })
            : null,
          parentAttemptGeneration: observation.parent.parentAttemptGeneration,
          parentNativeHostId: observation.parent.parentNativeHostId,
          parentTabId: observation.parent.parentTabId,
          parentTopologyRevision: observation.parent.parentTopologyRevision,
          parentWindowGeneration: observation.parent.parentWindowGeneration,
          parentWindowId: observation.parent.parentWindowId,
          roleOwnerGeneration: observation.parent.roleOwnerGeneration ?? null,
          slotId: observation.parent.slotId ?? null
        })
      })),
    windowId
  });
  if (artifactDirectory && isAbsolute(artifactDirectory)) {
    writeFileSync(
      join(artifactDirectory, "electron-popup-lifecycle-journal.json"),
      `${JSON.stringify(inspection, null, 2)}\n`
    );
  }
  return inspection;
}

async function readRolePlaceholderRuntime(
  roleId: string
): Promise<ElectronDesktopE2eRolePlaceholderInspection> {
  const core = observedCore;
  const runtime = observedRuntime;
  if (!core || !runtime) {
    throw new Error(
      `Role ${roleId} has no observed Core/native placeholder ownership.`
    );
  }
  const [coreSnapshot, nativeSnapshot] = await Promise.all([
    core.invoke({ type: "appSnapshot" }),
    Promise.resolve(runtime.snapshot())
  ]);
  const coreRoles = coreSnapshot.browserRuntime.roles.filter(
    (role) => role.roleId === roleId
  );
  if (coreRoles.length !== 1 || coreRoles[0]!.state !== "running") {
    throw new Error(`Role ${roleId} has no exact running Core owner.`);
  }
  const coreRole = coreRoles[0]!;
  const coreStatuses = coreSnapshot.roleStatuses.filter(
    (status) => status.roleId === roleId
  );
  const coreTabs = coreSnapshot.browserRuntime.tabs.filter(
    (tab) => tab.id === coreRole.owner.tabId
  );
  const nativeRoles = nativeSnapshot.roles.filter((role) => role.roleId === roleId);
  const nativeTabs = nativeSnapshot.tabs.filter(
    (tab) => tab.tabId === coreRole.owner.tabId
  );
  if (
    coreStatuses.length !== 1 || coreTabs.length !== 1 ||
    nativeRoles.length !== 1 || nativeTabs.length !== 1 ||
    !coreTabs[0]!.attemptGeneration || !nativeTabs[0]!.attemptGeneration
  ) {
    throw new Error(`Role ${roleId} lost its exact Core/native tab fence.`);
  }
  const coreTab = coreTabs[0]!;
  const coreStatus = coreStatuses[0]!;
  const nativeRole = nativeRoles[0]!;
  const nativeTab = nativeTabs[0]!;
  const tabPhase = runtimeTabPhases.get(coreTab.id);
  const nativeWindows = nativeSnapshot.windows.filter(
    (window) => window.windowId === coreTab.windowId
  );
  const nativeSurfaceOwner = workspaceRoleSurfaceOwners.get(roleId);
  const coreSlot = coreTab.slots.find((slot) =>
    slot.slotId === coreRole.owner.slotId && slot.roleId === roleId
  );
  if (
    nativeWindows.length !== 1 || !nativeSurfaceOwner || !coreSlot || !tabPhase ||
    nativeRole.tabId !== coreRole.owner.tabId ||
    nativeRole.windowId !== coreTab.windowId ||
    nativeRole.ownerGeneration !== coreRole.owner.generation ||
    nativeSurfaceOwner.tabId !== nativeRole.tabId ||
    nativeSurfaceOwner.generation !== nativeRole.generation
  ) {
    throw new Error(`Role ${roleId} lost its exact terminal native owner.`);
  }
  const nativeWindow = nativeWindows[0]!;
  const nativeProjection = nativeSurfaceOwner.registry.readProjection(
    roleId,
    nativeSurfaceOwner.generation
  );
  if (
    !Number.isSafeInteger(nativeWindow.parentNativeHostId) ||
    nativeWindow.windowGeneration < 1 || nativeWindow.topologyRevision < 1 ||
    nativeTab.windowId !== nativeWindow.windowId ||
    tabPhase.windowId !== nativeWindow.windowId ||
    tabPhase.windowGeneration !== nativeWindow.windowGeneration ||
    tabPhase.topologyRevision > nativeWindow.topologyRevision
  ) {
    throw new Error(`Role ${roleId} lost its native window identity.`);
  }
  const placeholders = [];
  for (const [placeholderId, owner] of rolePlaceholderOwners) {
    if (owner.roleId !== roleId) continue;
    const evidence = owner.registry.readEvidence(placeholderId);
    const targetWindows = nativeSnapshot.windows.filter(
      (window) => window.windowId === evidence.windowId
    );
    const targetTabs = nativeSnapshot.tabs.filter(
      (tab) => tab.tabId === evidence.tabId && tab.windowId === evidence.windowId
    );
    const targetCoreTabs = coreSnapshot.browserRuntime.tabs.filter(
      (tab) => tab.id === evidence.tabId && tab.windowId === evidence.windowId
    );
    const blockedSlot = targetCoreTabs[0]?.slots.find((slot) =>
      slot.slotId === evidence.slotId && slot.roleId === roleId &&
      slot.state === "blocked"
    );
    if (
      targetWindows.length !== 1 || targetTabs.length !== 1 ||
      targetCoreTabs.length !== 1 || !blockedSlot ||
      blockedSlot.owner?.tabId !== coreRole.owner.tabId ||
      blockedSlot.owner.slotId !== coreRole.owner.slotId ||
      blockedSlot.owner.generation !== coreRole.owner.generation ||
      evidence.ownerTabName !== coreTab.name ||
      !targetTabs[0]!.attemptGeneration ||
      targetWindows[0]!.parentNativeHostId !== evidence.nativeHostId ||
      targetWindows[0]!.windowGeneration !== evidence.windowGeneration ||
      targetWindows[0]!.topologyRevision !== evidence.topologyRevision
    ) {
      throw new Error(
        `Role placeholder ${placeholderId} lost its retained native host fence.`
      );
    }
    const targetWindow = targetWindows[0]!;
    placeholders.push(Object.freeze({
      ...evidence,
      appKitIdentity: targetWindow.appKitIdentity
        ? Object.freeze({ ...targetWindow.appKitIdentity })
        : null,
      attemptGeneration: targetTabs[0]!.attemptGeneration,
      bounds: Object.freeze({ ...evidence.bounds }),
      hostKind: targetWindow.appKitIdentity
        ? "appkit-chromium" as const
        : "bundled-chromium" as const
    }));
  }
  const inspection = parseElectronDesktopE2eRolePlaceholderInspection({
    coreOwner: Object.freeze({
      generation: coreRole.owner.generation,
      roleId,
      slotId: coreRole.owner.slotId,
      state: "running" as const,
      tabId: coreRole.owner.tabId,
      windowId: coreTab.windowId
    }),
    coreStatus: Object.freeze({
      automationState: coreStatus.automationState ?? null,
      hostKind: coreStatus.hostKind ?? null,
      issueReason: coreStatus.issueReason ?? null,
      overlayState: coreStatus.overlayState ?? null,
      pageHealth: coreStatus.pageHealth ?? null,
      resolvedEngine: coreStatus.resolvedEngine ?? null,
      roleId,
      runtimeMode: coreStatus.runtimeMode,
      state: coreStatus.state
    }),
    nativeOwner: Object.freeze({
      appKitIdentity: nativeWindow.appKitIdentity
        ? Object.freeze({ ...nativeWindow.appKitIdentity })
        : null,
      attemptGeneration: nativeTab.attemptGeneration,
      bounds: Object.freeze({ ...nativeProjection.bounds }),
      generation: nativeRole.generation,
      hostKind: nativeWindow.appKitIdentity
        ? "appkit-chromium" as const
        : "bundled-chromium" as const,
      ownerGeneration: nativeRole.ownerGeneration,
      parentNativeHostId: nativeWindow.parentNativeHostId,
      roleId,
      tabId: nativeRole.tabId,
      topologyRevision: nativeWindow.topologyRevision,
      visible: nativeProjection.visible,
      windowGeneration: nativeWindow.windowGeneration,
      windowId: nativeRole.windowId
    }),
    phase: tabPhase.phase,
    placeholders: Object.freeze(placeholders),
    roleId
  });
  const previous = rolePlaceholderRuntimeObservations.at(-1);
  if (JSON.stringify(previous) !== JSON.stringify(inspection)) {
    rolePlaceholderRuntimeObservations.push(inspection);
  }
  writeRolePlaceholderRuntimeObservations();
  return inspection;
}

async function readFullscreenToolbarRuntime(
  windowId: string
): Promise<ElectronDesktopE2eFullscreenToolbarInspection> {
  const core = observedCore;
  const runtime = observedRuntime;
  if (!core || !runtime) {
    throw new Error(
      `Fullscreen toolbar ${windowId} has no observed Core/native Chromium ownership.`
    );
  }
  const [coreSnapshot, preferences] = await Promise.all([
    core.invoke({ type: "appSnapshot" }),
    core.invoke({ type: "runtimeWindowPreferencesGet" })
  ]);
  const nativeSnapshot = runtime.snapshot();
  const logicalWindows = coreSnapshot.logicalWindows.filter(
    (window) => window.windowId === windowId
  );
  const browserWindows = coreSnapshot.browserRuntime.windows.filter(
    (window) => window.windowId === windowId
  );
  const nativeWindows = nativeSnapshot.windows.filter(
    (window) => window.windowId === windowId
  );
  if (
    logicalWindows.length !== 1 || browserWindows.length !== 1 ||
    nativeWindows.length !== 1
  ) {
    throw new Error(
      `Fullscreen toolbar ${windowId} has divergent Core/browser/native ownership.`
    );
  }
  const logical = logicalWindows[0]!;
  const browserWindow = browserWindows[0]!;
  const nativeWindow = nativeWindows[0]!;
  const inspection = parseElectronDesktopE2eFullscreenToolbarInspection(
    runtime.inspectFullscreenToolbar(windowId)
  );
  const coreTabIds = logical.tabs.map((tab) => tab.id);
  const platform = e2ePlatform();
  if (
    coreTabIds.length === 0 || inspection.surfaces.length === 0 ||
    logical.windowGeneration !== inspection.windowGeneration ||
    logical.revision !== inspection.topologyRevision ||
    nativeWindow.windowGeneration !== inspection.windowGeneration ||
    nativeWindow.topologyRevision !== inspection.topologyRevision ||
    logical.presentation !== inspection.presentation ||
    nativeWindow.presentation !== inspection.presentation ||
    inspection.native.fullscreen !== (inspection.presentation === "fullscreen") ||
    inspection.native.alwaysShowToolbarInFullScreen !==
      preferences.alwaysShowToolbarInFullScreen ||
    JSON.stringify(coreTabIds) !== JSON.stringify(browserWindow.tabIds) ||
    JSON.stringify(coreTabIds) !== JSON.stringify(nativeWindow.tabIds) ||
    JSON.stringify(coreTabIds) !== JSON.stringify(inspection.tabIds) ||
    (platform.platform === "darwin" && (
      inspection.hostKind !== "appkit" || inspection.native.appKit === undefined
    )) ||
    (platform.platform === "win32" && (
      inspection.hostKind !== "windows" || inspection.native.appKit !== undefined
    ))
  ) {
    throw new Error(
      `Fullscreen toolbar ${windowId} has stale preference, presentation, or native fences.`
    );
  }
  const prior = fullscreenToolbarRuntimeObservations.at(-1);
  if (JSON.stringify(prior) !== JSON.stringify(inspection)) {
    fullscreenToolbarRuntimeObservations.push(inspection);
  }
  writeFullscreenToolbarRuntimeObservations();
  return inspection;
}

function readRoleSessionMigration(roleId: string) {
  if (!userDataDirectory || !isAbsolute(userDataDirectory)) {
    throw new Error("The Electron desktop E2E migration inspection has no user-data directory.");
  }
  return readElectronDesktopE2eRoleSessionMigration({
    receipt: clearReceiptsByRole.get(roleId) ?? null,
    roleId,
    userDataDirectory
  });
}

function readRoleSessionRuntime(
  roleId: string
): ElectronDesktopE2eRoleSessionRuntimeInspection {
  const session = roleSessionObservations.get(roleId);
  if (!session) {
    throw new Error(`Role ${roleId} has no observed Chromium Session ownership.`);
  }
  return Object.freeze({
    currentRuntime: roleRuntimeObservations.get(roleId) ?? null,
    latestSessionEnsure: session,
    roleId
  });
}

const retainedV22Precondition = await seedRetainedV22Role();
installElectronDesktopE2eReceiptObserver();
installElectronDesktopE2eGuardedQuitObserver(writeFinalFlushMarker);
installElectronDesktopE2eDiagnosticsExportObserver();
installElectronDesktopE2eLaunchCompletionObserver();
installElectronDesktopE2eApplicationLifecycleObserver();
installElectronDesktopE2eRoleRuntimeObserver();
installElectronDesktopE2eRoleSurfaceLifecycleObserver(app, artifactDirectory);
installElectronDesktopE2eTrustedInputObserver();
installElectronDesktopE2eWorkspaceWebObserver();
installElectronDesktopE2ePopupLifecycleObserver();
installElectronDesktopE2eRolePlaceholderObserver();
applicationShortcutRuntimeObserver.install();
runtimeTabReloadObserver.install();
appKitTabMenuRuntimeObserver.install();
const { focusElectronMainWindow, prepareElectronMainQuit } =
  await import("../main/index");

const mainRendererUrl = pathToFileURL(
  join(import.meta.dirname, "../renderer/index.html")
).href;
const registration = registerElectronDesktopE2eBridge({
  authorizeSenderUrl: (url) => {
    try {
      const candidate = new URL(url);
      candidate.hash = "";
      return candidate.href === mainRendererUrl;
    } catch {
      return false;
    }
  },
  chromeVersion: process.versions.chrome,
  electronVersion: process.versions.electron,
  expectedSessionToken: () => process.env.RION_STUDIO_E2E_SESSION_TOKEN,
  failNextRuntimeTabReload: (windowId, tabId) =>
    runtimeTabReloadObserver.failNext(windowId, tabId),
  focusMainWindow: focusElectronMainWindow,
  ipcMain,
  isPackaged: () => app.isPackaged,
  platform: process.platform,
  prepareQuit: async () => {
    try {
      await prepareElectronMainQuit();
      writeFinalFlushMarker();
    } catch (error) {
      if (artifactDirectory && isAbsolute(artifactDirectory)) {
        writeFileSync(
          join(artifactDirectory, "electron-quit-error.txt"),
          `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
        );
      }
      throw error;
    }
  },
  processId: process.pid,
  readApplicationShortcutRuntime: (windowId, sender) =>
    applicationShortcutRuntimeObserver.read(windowId, sender),
  readDiagnosticsExportJournal,
  readRetainedV22Precondition: () => retainedV22Precondition,
  readFullscreenToolbarRuntime,
  readGameWindowRuntime,
  readPopupLifecycleJournal,
  readRolePlaceholderRuntime,
  readRoleSessionMigration,
  readRoleSessionRuntime,
  readRuntimeTabReload: (windowId) => runtimeTabReloadObserver.read(windowId),
  readTrustedInputRuntime,
  readWorkspaceWebRuntime,
  readWorkspaceWebSecurityPolicy,
  requestQuit: () => app.quit(),
  runtimeTarget: () => process.env.RION_STUDIO_E2E_RUNTIME_TARGET,
  showAppKitRuntimeTabMenu: (windowId, tabId) =>
    appKitTabMenuRuntimeObserver.show(windowId, tabId),
  signalApplicationLifecycle
});

app.once("will-quit", () => registration.dispose());
