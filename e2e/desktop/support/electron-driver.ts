import { browser } from "@wdio/globals";
import type {
  ApplicationLifecycleStatusRecord,
  BrowserActionRequest,
  RuntimeWindowZoomReceiptRecord
} from "../../../src/shared/generated";
import type { ElectronDesktopE2ePopupLifecycleJournalInspection } from
  "../../../src/electron/e2e/popupLifecycleJournalInspection";
export type { ElectronDesktopE2ePopupLifecycleJournalInspection } from
  "../../../src/electron/e2e/popupLifecycleJournalInspection";
import type { ElectronDesktopE2eRuntimeTabReloadInspection } from
  "../../../src/electron/e2e/runtimeTabReloadInspection";
export type { ElectronDesktopE2eRuntimeTabReloadInspection } from
  "../../../src/electron/e2e/runtimeTabReloadInspection";

export interface ElectronDesktopE2eRolePlaceholderInspection {
  readonly coreOwner: Readonly<{
    generation: number;
    roleId: string;
    slotId: string;
    state: "running";
    tabId: string;
    windowId: string;
  }>;
  readonly coreStatus: Readonly<{
    automationState: "ready" | "unavailable" | null;
    hostKind: "appkit-chromium" | "bundled-chromium";
    issueReason: "macro-input-unavailable" | "runtime-crashed" |
      "runtime-creation-failed" | "session-migration-required" |
      "trusted-input-unavailable" | null;
    overlayState: "ready" | "unavailable" | null;
    pageHealth: "healthy" | "unresponsive" | null;
    resolvedEngine: "chromium";
    roleId: string;
    runtimeMode: "embedded";
    state: "running";
  }>;
  readonly nativeOwner: Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    attemptGeneration: string;
    bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    generation: number;
    hostKind: "appkit-chromium" | "bundled-chromium";
    ownerGeneration: number;
    parentNativeHostId: number;
    roleId: string;
    tabId: string;
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
  }>;
  readonly phase: "activating" | "attaching" | "degraded" | "dormant" |
    "failed" | "loading" | "ready";
  readonly placeholders: readonly Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    attemptGeneration: string;
    blocked: true;
    bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    generation: number;
    hostKind: "appkit-chromium" | "bundled-chromium";
    nativeHostId: number;
    ownerGeneration: number;
    ownerTabName: string;
    placeholderId: string;
    roleId: string;
    roleName: string;
    shellSession: "rion-web-chrome-shell:memory";
    shellStoragePath: null;
    shellUrl: string;
    slotId: string;
    tabId: string;
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
  }>[];
  readonly roleId: string;
}

interface ChromiumNativeTrustedInputReceipt {
  completedAtMs: number;
  confirmedInputNeutrality: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  inputEpoch: number;
  requestId: string;
  roleId: string;
  status: "applied" | "failed" | "indeterminate" | "superseded";
  surfaceGeneration: number;
}

export interface ElectronDesktopE2eProbe {
  bridgeVersion: 1;
  chromeVersion: string;
  driver: "electron";
  electronVersion: string;
  packaged: false;
  platform: "macos" | "windows";
  processId: number;
  runtimeTarget: "chromium-v23-macos-appkit" | "chromium-v23-windows";
}

export interface ElectronDesktopE2eDiagnosticsExportJournalInspection {
  capacity: 32;
  journalVersion: 1;
  observations: readonly Readonly<{
    coreDiagnosticsExportInvocationCount: number;
    outcome: "cancelled" | "exported" | "rejected";
    sequence: number;
    typedOutcome: "diagnosticExportResult" | "rejected" | null;
  }>[];
}

export interface ElectronDesktopE2eCloseReceipt {
  pid: number;
  status: "submitted";
}

export interface ElectronDesktopE2eApplicationLifecycleSignalReceipt {
  before: ApplicationLifecycleStatusRecord;
  event: "resume" | "suspend";
  terminal: ApplicationLifecycleStatusRecord;
}

export interface ElectronDesktopE2eTrustedInputObservation {
  receipt: ChromiumNativeTrustedInputReceipt;
  request: BrowserActionRequest;
  sequence: number;
}

export interface ElectronDesktopE2eRetainedV22Precondition {
  contractVersion: 1;
  gameId: string;
  gameName: string;
  launchUrl: string;
  platform: "macos" | "windows";
  roleId: string;
  roleName: string;
  runtimeContractVersion: 22;
  sourceEngine: "wkwebview" | "webview2";
}

export interface ElectronDesktopE2eRoleSessionMigrationJournal {
  cleanFlushReceiptId: string | null;
  firstVerifiedLaunchAt: string | null;
  journalRevision: number;
  outcome: "explicitReset" | "failed" | "indeterminate" | "verified" | null;
  phase: "v22Ready" | "exported" | "importing" | "verifying" | "v23Ready"
    | "failed" | "indeterminate";
  platform: "macos" | "windows";
  resetReceiptId: string | null;
  roleId: string;
  sourceEngine: "wkwebview" | "webview2";
  sourceRevision: number;
  targetEngine: "chromium";
  targetRevision: number | null;
  transferId: string;
}

export interface ElectronDesktopE2eRoleSessionMigrationInspection {
  journal: ElectronDesktopE2eRoleSessionMigrationJournal | null;
  pendingRoleBrowserDataClearOperations: number;
  receipt: {
    clearedStorages: ReadonlyArray<
      "cookies" | "filesystem" | "indexdb" | "localstorage" | "shadercache"
      | "serviceworkers" | "cachestorage"
    >;
    cookieReadbackCount: 0;
    evidence: "electron-clear-storage-data-promise-and-cookie-readback";
    operationId: string;
    roleId: string;
  } | null;
  roleExists: boolean;
  roleId: string;
}

export interface ElectronDesktopE2eRoleSessionRuntimeInspection {
  currentRuntime: {
    appKitIdentity: {
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    } | null;
    attemptGeneration: string | null;
    focused: boolean;
    generation: number;
    hostKind: "appkit-chromium" | "bundled-chromium";
    ownerGeneration: number;
    parentNativeHostId: number;
    tabId: string;
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
  } | null;
  latestSessionEnsure: {
    chromiumPathSha256: string;
    chromiumUserDataDir: string;
    ensureCount: number;
    nativeSessionInstance: number;
    sessionStoragePath: string;
    sessionStoragePathSha256: string;
  };
  roleId: string;
}

export interface ElectronDesktopE2eGameWindowRuntimeInspection {
  currentRuntime: {
    appKitIdentity: {
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    } | null;
    appKitStatusPresentation: "failed" | "loading" | "ready" | null;
    coreTabIds: readonly string[];
    focused: boolean;
    hostKind: "appkit-chromium" | "bundled-chromium";
    nativeDisplay: {
      bounds: { height: number; width: number; x: number; y: number };
      displayId: number;
      presentation: "fullscreen" | "maximized" | "normal";
      scaleFactor: number;
      workArea: { height: number; width: number; x: number; y: number };
    };
    nativeTabIds: readonly string[];
    parentNativeHostId: number;
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
  } | null;
  windowId: string;
}

export interface ElectronDesktopE2eApplicationShortcutRuntimeInspection {
  coreWindow: {
    activeTabId: string;
    presentation: "fullscreen" | "maximized" | "normal";
    tabIds: readonly string[];
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
    windowZoomFactor: number;
  };
  globalWebSurfaces: readonly {
    appliedZoomFactor: number;
    baseZoomFactor: number;
    generation: number;
    slotId: string;
    surfaceId: string;
    tabId: string;
    visible: boolean;
  }[];
  mainWindow: {
    browserWindowId: number;
    fullscreen: boolean;
    webContentsId: number;
    zoomFactor: number;
  };
  nativeWindow: {
    activeTabId: string;
    appKitIdentity: {
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    } | null;
    focused: boolean;
    hostKind: "appkit-chromium" | "bundled-chromium";
    parentNativeHostId: number;
    presentation: "fullscreen" | "maximized" | "normal";
    tabIds: readonly string[];
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
    windowZoomFactor: number;
  };
  popupSurfaces: readonly never[];
  roleSurfaces: readonly {
    appliedZoomFactor: number;
    baseZoomFactor: number;
    generation: number;
    roleId: string;
    tabId: string;
    visible: boolean;
  }[];
  windowId: string;
  zoomJournal: {
    capacity: 32;
    journalVersion: 1;
    observations: readonly {
      receipt: Readonly<RuntimeWindowZoomReceiptRecord>;
      sequence: number;
    }[];
  };
}

export interface ElectronDesktopE2eFullscreenToolbarRuntimeInspection {
  hostKind: "appkit" | "windows";
  native: {
    alwaysShowToolbarInFullScreen: boolean;
    appKit?: {
      accessoryOnScreen: boolean;
      accessoryVisibleHeight: number;
      fullscreenHostReady: boolean;
      presentationAutoHideToolbar: boolean;
      revealLocked: boolean;
      tabCloseButtonEnabledCount: number;
      fullscreenControlScreenBounds?: {
        height: number;
        width: number;
        x: number;
        y: number;
      };
      tabScreenBounds?: { height: number; width: number; x: number; y: number };
      tabAnchors?: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
      tabStripOnScreen: boolean;
      toolbarPinned: boolean;
      visibleTrafficLightCount: number;
    };
    fullscreen: boolean;
    nativeControlsVisible: boolean;
    nativeWindowControlCount: number;
    projectionRevision: number;
    revealed: boolean;
    toolbarVisible: boolean;
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
  };
  presentation: "fullscreen" | "maximized" | "normal";
  surfaces: readonly {
    bounds: { height: number; width: number; x: number; y: number };
    generation: number;
    id: string;
    kind: "role" | "web";
    tabId: string;
    visible: boolean;
  }[];
  tabIds: readonly string[];
  topologyRevision: number;
  windowGeneration: number;
  windowId: string;
}

export interface ElectronDesktopE2eWorkspaceWebRuntimeInspection {
  appKitIdentity: {
    launchGeneration: string;
    logicalWindowId: string;
    nativeGeneration: number;
  } | null;
  attemptGeneration: string;
  coreSlots: readonly {
    id: string;
    rect: { height: number; width: number; x: number; y: number };
    roleId: string | null;
    web: { name: string; startUrl: string } | null;
  }[];
  focused: boolean;
  hostKind: "appkit-chromium" | "bundled-chromium";
  parentNativeHostId: number;
  phase: "activating" | "attaching" | "degraded" | "dormant" |
    "failed" | "loading" | "ready";
  popups: readonly {
    appKitIdentity: {
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    } | null;
    bounds: { height: number; width: number; x: number; y: number };
    hostKind: "appkit-chromium" | "bundled-chromium";
    logicalWindowId: string;
    nativeHostId: number;
    openOperationId: string;
    popupId: string;
    presentation: "fullscreen" | "maximized" | "normal";
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
  }[];
  presentation: "fullscreen" | "maximized" | "normal";
  role: {
    bounds: { height: number; width: number; x: number; y: number };
    generation: number;
    roleId: string;
    visible: boolean;
  } | null;
  tabId: string;
  topologyRevision: number;
  visible: boolean;
  web: {
    canGoBack: boolean;
    canGoForward: boolean;
    chromeBounds: { height: number; width: number; x: number; y: number };
    chromeVisible: boolean;
    chromeShellSession: "rion-web-chrome-shell:memory";
    chromeShellStoragePath: null;
    chromeShellUrl: string;
    contentBounds: { height: number; width: number; x: number; y: number };
    contentVisible: boolean;
    contentProfilePath: string;
    contentSession: "global-web-persistent";
    contentSessionStoragePath: string;
    contentUrl: string;
    containedFullscreen: boolean;
    containedFullscreenRevision: number;
    generation: number;
    isolatedSessions: true;
    slotBounds: { height: number; width: number; x: number; y: number };
    slotId: string;
    surfaceId: string;
    tabId: string;
    visible: boolean;
  };
  windowBounds: { height: number; width: number; x: number; y: number };
  windowGeneration: number;
  windowId: string;
}

export type ElectronDesktopE2eWorkspaceWebSecurityPolicyObservation =
  | Readonly<{
      callback: false;
      kind: "permission-request";
      origin: string;
      permission: string;
      sequence: number;
    }>
  | Readonly<{
      defaultPrevented: true;
      kind: "will-download";
      origin: string;
      sequence: number;
      url: string;
    }>;

export interface ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection {
  contentProfilePath: string;
  generation: number;
  observations: readonly ElectronDesktopE2eWorkspaceWebSecurityPolicyObservation[];
  policyVersion: 1;
  sessionStoragePath: string;
  surfaceId: string;
  windowId: string;
}

interface ElectronBridgeResult<Value> {
  error?: string;
  ok: boolean;
  value?: Value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Electron desktop E2E driver`);
  return value;
}

export async function electronDesktopE2eProbe(): Promise<ElectronDesktopE2eProbe> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  await browser.waitUntil(
    () => browser.execute(() => typeof (
      window as typeof window & {
        rionStudioDesktopE2e?: { probe?: unknown };
      }
    ).rionStudioDesktopE2e?.probe === "function"),
    {
      timeout: 20_000,
      timeoutMsg: "Electron desktop E2E preload bridge did not become ready"
    }
  );
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      done: (result: ElectronBridgeResult<ElectronDesktopE2eProbe>) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          probe: (token: string) => Promise<ElectronDesktopE2eProbe>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.probe(sessionToken).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token
  ) as ElectronBridgeResult<ElectronDesktopE2eProbe>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E probe failed");
  }
  return result.value;
}

export async function electronDesktopE2eDiagnosticsExportJournal(): Promise<
  ElectronDesktopE2eDiagnosticsExportJournalInspection
> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      done: (
        result: ElectronBridgeResult<
          ElectronDesktopE2eDiagnosticsExportJournalInspection
        >
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          diagnosticsExportJournal: (
            token: string
          ) => Promise<ElectronDesktopE2eDiagnosticsExportJournalInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.diagnosticsExportJournal(sessionToken).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token
  ) as ElectronBridgeResult<ElectronDesktopE2eDiagnosticsExportJournalInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E diagnostics journal failed");
  }
  return result.value;
}

export async function electronDesktopE2eRetainedV22Precondition(): Promise<
  ElectronDesktopE2eRetainedV22Precondition | null
> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eRetainedV22Precondition | null>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          retainedV22Precondition: (
            token: string
          ) => Promise<ElectronDesktopE2eRetainedV22Precondition | null>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.retainedV22Precondition(sessionToken).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token
  ) as ElectronBridgeResult<ElectronDesktopE2eRetainedV22Precondition | null>;
  if (!result.ok || result.value === undefined) {
    throw new Error(result.error ?? "Electron desktop E2E retained-v22 precondition failed");
  }
  return result.value;
}

export async function electronDesktopE2eRoleSessionMigration(
  roleId: string
): Promise<ElectronDesktopE2eRoleSessionMigrationInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetRoleId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eRoleSessionMigrationInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          roleSessionMigration: (
            token: string,
            roleId: string
          ) => Promise<ElectronDesktopE2eRoleSessionMigrationInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.roleSessionMigration(sessionToken, targetRoleId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    roleId
  ) as ElectronBridgeResult<ElectronDesktopE2eRoleSessionMigrationInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E migration inspection failed");
  }
  return result.value;
}

export async function electronDesktopE2eRoleSessionRuntime(
  roleId: string
): Promise<ElectronDesktopE2eRoleSessionRuntimeInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetRoleId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eRoleSessionRuntimeInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          roleSessionRuntime: (
            token: string,
            roleId: string
          ) => Promise<ElectronDesktopE2eRoleSessionRuntimeInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.roleSessionRuntime(sessionToken, targetRoleId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    roleId
  ) as ElectronBridgeResult<ElectronDesktopE2eRoleSessionRuntimeInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E runtime inspection failed");
  }
  return result.value;
}

export async function electronDesktopE2eApplicationLifecycleSignal(
  event: "resume" | "suspend"
): Promise<ElectronDesktopE2eApplicationLifecycleSignalReceipt> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      powerEvent: "resume" | "suspend",
      done: (
        result: ElectronBridgeResult<
          ElectronDesktopE2eApplicationLifecycleSignalReceipt
        >
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          applicationLifecycleSignal: (
            token: string,
            event: "resume" | "suspend"
          ) => Promise<ElectronDesktopE2eApplicationLifecycleSignalReceipt>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.applicationLifecycleSignal(sessionToken, powerEvent).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    event
  ) as ElectronBridgeResult<ElectronDesktopE2eApplicationLifecycleSignalReceipt>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E lifecycle signal failed");
  }
  return result.value;
}

export async function electronDesktopE2eTrustedInputRuntime(
  roleId: string
): Promise<readonly ElectronDesktopE2eTrustedInputObservation[]> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetRoleId: string,
      done: (
        result: ElectronBridgeResult<readonly ElectronDesktopE2eTrustedInputObservation[]>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          trustedInputRuntime: (
            token: string,
            roleId: string
          ) => Promise<readonly ElectronDesktopE2eTrustedInputObservation[]>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.trustedInputRuntime(sessionToken, targetRoleId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    roleId
  ) as ElectronBridgeResult<readonly ElectronDesktopE2eTrustedInputObservation[]>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E trusted-input inspection failed");
  }
  return result.value;
}

export async function electronDesktopE2eRolePlaceholderRuntime(
  roleId: string
): Promise<ElectronDesktopE2eRolePlaceholderInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetRoleId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eRolePlaceholderInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          rolePlaceholderRuntime: (
            token: string,
            roleId: string
          ) => Promise<ElectronDesktopE2eRolePlaceholderInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.rolePlaceholderRuntime(sessionToken, targetRoleId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    roleId
  ) as ElectronBridgeResult<ElectronDesktopE2eRolePlaceholderInspection>;
  if (!result.ok || !result.value) {
    throw new Error(
      result.error ?? "Electron desktop E2E Role-placeholder inspection failed"
    );
  }
  return result.value;
}

export async function electronDesktopE2eGameWindowRuntime(
  windowId: string
): Promise<ElectronDesktopE2eGameWindowRuntimeInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eGameWindowRuntimeInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          gameWindowRuntime: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eGameWindowRuntimeInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.gameWindowRuntime(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eGameWindowRuntimeInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E Game Window inspection failed");
  }
  return result.value;
}

export async function electronDesktopE2eApplicationShortcutRuntime(
  windowId: string
): Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<
          ElectronDesktopE2eApplicationShortcutRuntimeInspection
        >
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          applicationShortcutRuntime: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.applicationShortcutRuntime(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eApplicationShortcutRuntimeInspection>;
  if (!result.ok || !result.value) {
    throw new Error(
      result.error ?? "Electron desktop E2E application-shortcut inspection failed"
    );
  }
  return result.value;
}

export async function electronDesktopE2eFullscreenToolbarRuntime(
  windowId: string
): Promise<ElectronDesktopE2eFullscreenToolbarRuntimeInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<
          ElectronDesktopE2eFullscreenToolbarRuntimeInspection
        >
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          fullscreenToolbarRuntime: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eFullscreenToolbarRuntimeInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.fullscreenToolbarRuntime(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eFullscreenToolbarRuntimeInspection>;
  if (!result.ok || !result.value) {
    throw new Error(
      result.error ?? "Electron desktop E2E fullscreen-toolbar inspection failed"
    );
  }
  return result.value;
}

export async function electronDesktopE2eWorkspaceWebRuntime(
  windowId: string
): Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eWorkspaceWebRuntimeInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          workspaceWebRuntime: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.workspaceWebRuntime(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eWorkspaceWebRuntimeInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E Workspace Web inspection failed");
  }
  return result.value;
}

export async function electronDesktopE2ePopupLifecycleJournal(
  windowId: string
): Promise<ElectronDesktopE2ePopupLifecycleJournalInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2ePopupLifecycleJournalInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          popupLifecycleJournal: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2ePopupLifecycleJournalInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.popupLifecycleJournal(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2ePopupLifecycleJournalInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E popup lifecycle journal failed");
  }
  return result.value;
}

export async function electronDesktopE2eRuntimeTabReload(
  windowId: string
): Promise<ElectronDesktopE2eRuntimeTabReloadInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<ElectronDesktopE2eRuntimeTabReloadInspection>
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          runtimeTabReload: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eRuntimeTabReloadInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.runtimeTabReload(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eRuntimeTabReloadInspection>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E runtime-tab Reload failed");
  }
  return result.value;
}

/** Arms one token-authenticated E2E failure; the next action must still use visible UI. */
export async function failNextElectronDesktopE2eRuntimeTabReload(
  windowId: string,
  tabId: string
): Promise<void> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      targetTabId: string,
      done: (result: ElectronBridgeResult<true>) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          failNextRuntimeTabReload: (
            token: string,
            windowId: string,
            tabId: string
          ) => Promise<void>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.failNextRuntimeTabReload(sessionToken, targetWindowId, targetTabId).then(
        () => done({ ok: true, value: true }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId,
    tabId
  ) as ElectronBridgeResult<true>;
  if (!result.ok) {
    throw new Error(result.error ?? "Electron desktop E2E Reload failure arm failed");
  }
}

/** Opens the exact retained-AppKit menu; the visible item is selected through AX. */
export async function showElectronDesktopE2eAppKitRuntimeTabMenu(
  windowId: string,
  tabId: string
): Promise<void> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      targetTabId: string,
      done: (result: ElectronBridgeResult<true>) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          showAppKitRuntimeTabMenu: (
            token: string,
            windowId: string,
            tabId: string
          ) => Promise<void>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.showAppKitRuntimeTabMenu(
        sessionToken,
        targetWindowId,
        targetTabId
      ).then(
        () => done({ ok: true, value: true }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId,
    tabId
  ) as ElectronBridgeResult<true>;
  if (!result.ok) {
    throw new Error(result.error ?? "Electron desktop E2E AppKit tab menu failed");
  }
}

export async function electronDesktopE2eWorkspaceWebSecurityPolicy(
  windowId: string
): Promise<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      targetWindowId: string,
      done: (
        result: ElectronBridgeResult<
          ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection
        >
      ) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          workspaceWebSecurityPolicy: (
            token: string,
            windowId: string
          ) => Promise<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.workspaceWebSecurityPolicy(sessionToken, targetWindowId).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token,
    windowId
  ) as ElectronBridgeResult<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection>;
  if (!result.ok || !result.value) {
    throw new Error(
      result.error ?? "Electron desktop E2E Workspace Web security-policy inspection failed"
    );
  }
  return result.value;
}

export async function electronDesktopE2eFocusMainWindow(): Promise<void> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      done: (result: ElectronBridgeResult<void>) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          focusMainWindow: (token: string) => Promise<void>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.focusMainWindow(sessionToken).then(
        () => done({ ok: true }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token
  ) as ElectronBridgeResult<void>;
  if (!result.ok) {
    throw new Error(result.error ?? "Electron desktop E2E main-window focus failed");
  }
}

export async function requestElectronDesktopE2eClose(): Promise<ElectronDesktopE2eCloseReceipt> {
  const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
  const result = await browser.executeAsync(
    (
      sessionToken: string,
      done: (result: ElectronBridgeResult<ElectronDesktopE2eCloseReceipt>) => void
    ) => {
      const api = (window as typeof window & {
        rionStudioDesktopE2e?: {
          close: (token: string) => Promise<ElectronDesktopE2eCloseReceipt>;
        };
      }).rionStudioDesktopE2e;
      if (!api) {
        done({ error: "Electron desktop E2E preload bridge is unavailable", ok: false });
        return;
      }
      void api.close(sessionToken).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    token
  ) as ElectronBridgeResult<ElectronDesktopE2eCloseReceipt>;
  if (!result.ok || !result.value) {
    throw new Error(result.error ?? "Electron desktop E2E close preparation failed");
  }
  return result.value;
}
