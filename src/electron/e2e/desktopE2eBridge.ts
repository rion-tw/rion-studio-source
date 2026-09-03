import { timingSafeEqual } from "node:crypto";
import type {
  ApplicationLifecycleStatusRecord,
  BrowserActionRequest
} from "../../shared/generated";
import {
  parseElectronDesktopE2eApplicationShortcutRuntimeInspection,
  type ElectronDesktopE2eApplicationShortcutRuntimeInspection
} from "./applicationShortcutRuntimeInspection";
export type { ElectronDesktopE2eApplicationShortcutRuntimeInspection } from
  "./applicationShortcutRuntimeInspection";
import type { ChromiumNativeTrustedInputReceipt } from
  "../main/chromiumTrustedInputCoordinator";
import {
  parseElectronDesktopE2eFullscreenToolbarInspection,
  type ElectronDesktopE2eFullscreenToolbarInspection
} from "./fullscreenToolbarInspection";
export type { ElectronDesktopE2eFullscreenToolbarInspection } from
  "./fullscreenToolbarInspection";
import {
  parseElectronDesktopE2eRolePlaceholderInspection,
  type ElectronDesktopE2eRolePlaceholderInspection
} from "./rolePlaceholderInspection";
export type { ElectronDesktopE2eRolePlaceholderInspection } from
  "./rolePlaceholderInspection";
import {
  parseElectronDesktopE2ePopupLifecycleJournalInspection,
  type ElectronDesktopE2ePopupLifecycleJournalInspection
} from "./popupLifecycleJournalInspection";
export type { ElectronDesktopE2ePopupLifecycleJournalInspection } from
  "./popupLifecycleJournalInspection";
import {
  parseElectronDesktopE2eWorkspaceWebInspection,
  type ElectronDesktopE2eWorkspaceWebInspection
} from "./workspaceWebInspection";
export type { ElectronDesktopE2eWorkspaceWebInspection } from
  "./workspaceWebInspection";
import {
  parseElectronDesktopE2eWorkspaceWebSecurityPolicyInspection,
  type ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection
} from "./workspaceWebSecurityPolicyInspection";
export type { ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection } from
  "./workspaceWebSecurityPolicyInspection";
import {
  parseElectronDesktopE2eRuntimeTabReloadInspection,
  type ElectronDesktopE2eRuntimeTabReloadInspection
} from "./runtimeTabReloadInspection";
export type { ElectronDesktopE2eRuntimeTabReloadInspection } from
  "./runtimeTabReloadInspection";

export const ELECTRON_DESKTOP_E2E_CHANNEL = "rion:e2e:invoke";
export const ELECTRON_DESKTOP_E2E_GLOBAL = "rionStudioDesktopE2e";
export const ELECTRON_DESKTOP_E2E_CLEAR_STORAGES = Object.freeze([
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "shadercache",
  "serviceworkers",
  "cachestorage"
] as const);

const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const ROLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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

export interface ElectronDesktopE2eRoleBrowserDataClearReceipt {
  clearedStorages: ReadonlyArray<
    (typeof ELECTRON_DESKTOP_E2E_CLEAR_STORAGES)[number]
  >;
  cookieReadbackCount: 0;
  evidence: "electron-clear-storage-data-promise-and-cookie-readback";
  operationId: string;
  roleId: string;
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
  receipt: ElectronDesktopE2eRoleBrowserDataClearReceipt | null;
  roleExists: boolean;
  roleId: string;
}

export interface ElectronDesktopE2eRoleSessionRuntimeInspection {
  currentRuntime: Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
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
  }> | null;
  latestSessionEnsure: Readonly<{
    chromiumPathSha256: string;
    chromiumUserDataDir: string;
    ensureCount: number;
    nativeSessionInstance: number;
    sessionStoragePath: string;
    sessionStoragePathSha256: string;
  }>;
  roleId: string;
}

export interface ElectronDesktopE2eGameWindowRuntimeInspection {
  currentRuntime: Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    appKitStatusPresentation: "failed" | "loading" | "ready" | null;
    coreTabIds: readonly string[];
    focused: boolean;
    hostKind: "appkit-chromium" | "bundled-chromium";
    nativeDisplay: Readonly<{
      bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
      displayId: number;
      presentation: "fullscreen" | "maximized" | "normal";
      scaleFactor: number;
      workArea: Readonly<{ height: number; width: number; x: number; y: number }>;
    }>;
    nativeTabIds: readonly string[];
    parentNativeHostId: number;
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
  }> | null;
  windowId: string;
}

export interface ElectronDesktopE2eApplicationLifecycleSignalReceipt {
  event: "resume" | "suspend";
  before: ApplicationLifecycleStatusRecord;
  terminal: ApplicationLifecycleStatusRecord;
}

export interface ElectronDesktopE2eTrustedInputObservation {
  request: BrowserActionRequest;
  receipt: ChromiumNativeTrustedInputReceipt;
  sequence: number;
}

export const ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY = 32;

export interface ElectronDesktopE2eDiagnosticsExportObservation {
  coreDiagnosticsExportInvocationCount: number;
  outcome: "cancelled" | "exported" | "rejected";
  sequence: number;
  typedOutcome: "diagnosticExportResult" | "rejected" | null;
}

export interface ElectronDesktopE2eDiagnosticsExportJournalInspection {
  capacity: typeof ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY;
  journalVersion: 1;
  observations: readonly ElectronDesktopE2eDiagnosticsExportObservation[];
}

type ElectronDesktopE2eRequest =
  | Readonly<{
    action: "close" | "diagnosticsExportJournal" | "focusMainWindow" | "probe" |
      "retainedV22Precondition";
    token: string;
  }>
  | Readonly<{
    action: "failNextRuntimeTabReload" | "showAppKitRuntimeTabMenu";
    tabId: string;
    token: string;
    windowId: string;
  }>
  | Readonly<{
    action: "applicationShortcutRuntime" | "fullscreenToolbarRuntime" | "gameWindowRuntime" |
      "popupLifecycleJournal" | "runtimeTabReload" | "workspaceWebRuntime" |
      "workspaceWebSecurityPolicy";
    token: string;
    windowId: string;
  }>
  | Readonly<{
    action: "rolePlaceholderRuntime" | "roleSessionMigration";
    roleId: string;
    token: string;
  }>
  | Readonly<{
    action: "roleSessionRuntime";
    roleId: string;
    token: string;
  }>
  | Readonly<{
    action: "applicationLifecycleSignal";
    event: "resume" | "suspend";
    token: string;
  }>
  | Readonly<{
    action: "trustedInputRuntime";
    roleId: string;
    token: string;
  }>;

export interface ElectronDesktopE2eCloseReceipt {
  pid: number;
  status: "submitted";
}

export interface ElectronDesktopE2eSenderPort {
  readonly id?: number;
  getURL: () => string;
}

interface ElectronDesktopE2eIpcEventPort {
  sender: ElectronDesktopE2eSenderPort;
}

interface ElectronDesktopE2eIpcMainPort {
  handle: (
    channel: string,
    listener: (event: ElectronDesktopE2eIpcEventPort, request: unknown) => Promise<unknown>
  ) => void;
  removeHandler: (channel: string) => void;
}

interface ElectronDesktopE2eIpcRendererPort {
  invoke: (channel: string, request: unknown) => Promise<unknown>;
}

interface ElectronDesktopE2eContextBridgePort {
  exposeInMainWorld: (apiKey: string, api: unknown) => void;
}

export interface ElectronDesktopE2ePreloadApi {
  applicationShortcutRuntime: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection>;
  applicationLifecycleSignal: (
    token: string,
    event: "resume" | "suspend"
  ) => Promise<ElectronDesktopE2eApplicationLifecycleSignalReceipt>;
  close: (token: string) => Promise<ElectronDesktopE2eCloseReceipt>;
  diagnosticsExportJournal: (
    token: string
  ) => Promise<ElectronDesktopE2eDiagnosticsExportJournalInspection>;
  focusMainWindow: (token: string) => Promise<void>;
  retainedV22Precondition: (
    token: string
  ) => Promise<ElectronDesktopE2eRetainedV22Precondition | null>;
  roleSessionMigration: (
    token: string,
    roleId: string
  ) => Promise<ElectronDesktopE2eRoleSessionMigrationInspection>;
  rolePlaceholderRuntime: (
    token: string,
    roleId: string
  ) => Promise<ElectronDesktopE2eRolePlaceholderInspection>;
  roleSessionRuntime: (
    token: string,
    roleId: string
  ) => Promise<ElectronDesktopE2eRoleSessionRuntimeInspection>;
  trustedInputRuntime: (
    token: string,
    roleId: string
  ) => Promise<readonly ElectronDesktopE2eTrustedInputObservation[]>;
  gameWindowRuntime: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eGameWindowRuntimeInspection>;
  fullscreenToolbarRuntime: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eFullscreenToolbarInspection>;
  failNextRuntimeTabReload: (
    token: string,
    windowId: string,
    tabId: string
  ) => Promise<void>;
  showAppKitRuntimeTabMenu: (
    token: string,
    windowId: string,
    tabId: string
  ) => Promise<void>;
  popupLifecycleJournal: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2ePopupLifecycleJournalInspection>;
  runtimeTabReload: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eRuntimeTabReloadInspection>;
  workspaceWebRuntime: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eWorkspaceWebInspection>;
  workspaceWebSecurityPolicy: (
    token: string,
    windowId: string
  ) => Promise<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection>;
  probe: (token: string) => Promise<ElectronDesktopE2eProbe>;
}

export interface RegisterElectronDesktopE2eBridgeInput {
  authorizeSenderUrl: (url: string) => boolean;
  chromeVersion: string;
  electronVersion: string;
  expectedSessionToken: () => string | undefined;
  failNextRuntimeTabReload: (windowId: string, tabId: string) => void;
  focusMainWindow: () => void;
  ipcMain: ElectronDesktopE2eIpcMainPort;
  isPackaged: () => boolean;
  platform: NodeJS.Platform;
  prepareQuit: () => Promise<void>;
  processId: number;
  readApplicationShortcutRuntime: (
    windowId: string,
    sender: ElectronDesktopE2eSenderPort
  ) => Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection>;
  readDiagnosticsExportJournal: () =>
    ElectronDesktopE2eDiagnosticsExportJournalInspection;
  readRetainedV22Precondition: () => ElectronDesktopE2eRetainedV22Precondition | null;
  readRoleSessionMigration: (
    roleId: string
  ) => ElectronDesktopE2eRoleSessionMigrationInspection;
  readRolePlaceholderRuntime: (
    roleId: string
  ) => Promise<ElectronDesktopE2eRolePlaceholderInspection>;
  readRoleSessionRuntime: (
    roleId: string
  ) => ElectronDesktopE2eRoleSessionRuntimeInspection;
  readGameWindowRuntime: (
    windowId: string
  ) => Promise<ElectronDesktopE2eGameWindowRuntimeInspection>;
  readFullscreenToolbarRuntime: (
    windowId: string
  ) => Promise<ElectronDesktopE2eFullscreenToolbarInspection>;
  readPopupLifecycleJournal: (
    windowId: string
  ) => ElectronDesktopE2ePopupLifecycleJournalInspection;
  readRuntimeTabReload: (
    windowId: string
  ) => ElectronDesktopE2eRuntimeTabReloadInspection;
  readWorkspaceWebRuntime: (
    windowId: string
  ) => Promise<ElectronDesktopE2eWorkspaceWebInspection>;
  readWorkspaceWebSecurityPolicy: (
    windowId: string
  ) => Promise<ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection>;
  readTrustedInputRuntime: (
    roleId: string
  ) => readonly ElectronDesktopE2eTrustedInputObservation[];
  requestQuit: () => void;
  runtimeTarget: () => string | undefined;
  showAppKitRuntimeTabMenu: (windowId: string, tabId: string) => void;
  signalApplicationLifecycle: (
    event: "resume" | "suspend"
  ) => Promise<ElectronDesktopE2eApplicationLifecycleSignalReceipt>;
}

function parseRequest(candidate: unknown): ElectronDesktopE2eRequest {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("Electron desktop E2E request is invalid.");
  }
  const request = candidate as Record<string, unknown>;
  const action = String(request.action);
  const requiresRoleId = new Set([
    "rolePlaceholderRuntime",
    "roleSessionMigration",
    "roleSessionRuntime",
    "trustedInputRuntime"
  ]).has(action);
  const requiresPowerEvent = action === "applicationLifecycleSignal";
  const requiresWindowAndTabIds = new Set([
    "failNextRuntimeTabReload",
    "showAppKitRuntimeTabMenu"
  ]).has(action);
  const requiresWindowId = new Set([
    "applicationShortcutRuntime",
    "fullscreenToolbarRuntime",
    "gameWindowRuntime",
    "popupLifecycleJournal",
    "runtimeTabReload",
    "workspaceWebRuntime",
    "workspaceWebSecurityPolicy"
  ]).has(action);
  const allowedKeys = new Set(
    requiresRoleId
      ? ["action", "roleId", "token"]
      : requiresPowerEvent
        ? ["action", "event", "token"]
        : requiresWindowAndTabIds
          ? ["action", "tabId", "token", "windowId"]
        : requiresWindowId
          ? ["action", "token", "windowId"]
          : ["action", "token"]
  );
  if (
    !new Set([
      "close",
      "applicationLifecycleSignal",
      "applicationShortcutRuntime",
      "diagnosticsExportJournal",
      "failNextRuntimeTabReload",
      "focusMainWindow",
      "fullscreenToolbarRuntime",
      "gameWindowRuntime",
      "popupLifecycleJournal",
      "runtimeTabReload",
      "probe",
      "retainedV22Precondition",
      "rolePlaceholderRuntime",
      "roleSessionMigration",
      "roleSessionRuntime",
      "showAppKitRuntimeTabMenu",
      "trustedInputRuntime",
      "workspaceWebRuntime",
      "workspaceWebSecurityPolicy"
    ]).has(action)
    || typeof request.token !== "string"
    || !SESSION_TOKEN_PATTERN.test(request.token)
    || (requiresRoleId && (
      typeof request.roleId !== "string" || !ROLE_ID_PATTERN.test(request.roleId)
    ))
    || (requiresPowerEvent && !new Set(["resume", "suspend"]).has(String(request.event)))
    || (requiresWindowAndTabIds && (
      typeof request.tabId !== "string" || !ROLE_ID_PATTERN.test(request.tabId) ||
      typeof request.windowId !== "string" || !ROLE_ID_PATTERN.test(request.windowId)
    ))
    || (requiresWindowId && (
      typeof request.windowId !== "string" || !ROLE_ID_PATTERN.test(request.windowId)
    ))
    || Object.keys(request).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error("Electron desktop E2E request is invalid.");
  }
  if (requiresWindowId) {
    return {
      action: action as "applicationShortcutRuntime" | "fullscreenToolbarRuntime" |
        "gameWindowRuntime" |
        "popupLifecycleJournal" | "runtimeTabReload" | "workspaceWebRuntime" |
        "workspaceWebSecurityPolicy",
      token: request.token,
      windowId: request.windowId as string
    };
  }
  if (requiresWindowAndTabIds) {
    return {
      action: action as "failNextRuntimeTabReload" | "showAppKitRuntimeTabMenu",
      tabId: request.tabId as string,
      token: request.token,
      windowId: request.windowId as string
    };
  }
  if (requiresPowerEvent) {
    return {
      action: "applicationLifecycleSignal",
      event: request.event as "resume" | "suspend",
      token: request.token
    };
  }
  return requiresRoleId
    ? {
        action: action as "rolePlaceholderRuntime" | "roleSessionMigration" |
          "roleSessionRuntime" | "trustedInputRuntime",
        roleId: request.roleId as string,
        token: request.token
      }
    : {
        action: action as
          | "close"
          | "diagnosticsExportJournal"
          | "focusMainWindow"
          | "probe"
          | "retainedV22Precondition",
        token: request.token
      };
}

function authenticate(candidate: string, expected: string | undefined): void {
  if (!expected || !SESSION_TOKEN_PATTERN.test(expected)) {
    throw new Error("Electron desktop E2E session is unavailable.");
  }
  const candidateBytes = Buffer.from(candidate, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    candidateBytes.byteLength !== expectedBytes.byteLength
    || !timingSafeEqual(candidateBytes, expectedBytes)
  ) {
    throw new Error("Electron desktop E2E request is unauthorized.");
  }
}

function targetForPlatform(platform: NodeJS.Platform): {
  platform: ElectronDesktopE2eProbe["platform"];
  runtimeTarget: ElectronDesktopE2eProbe["runtimeTarget"];
} {
  if (platform === "darwin") {
    return {
      platform: "macos",
      runtimeTarget: "chromium-v23-macos-appkit"
    };
  }
  if (platform === "win32") {
    return {
      platform: "windows",
      runtimeTarget: "chromium-v23-windows"
    };
  }
  throw new Error(`Electron desktop E2E does not support ${platform}.`);
}

export function registerElectronDesktopE2eBridge(
  input: RegisterElectronDesktopE2eBridgeInput
): { dispose: () => void } {
  const listener = async (
    event: ElectronDesktopE2eIpcEventPort,
    candidate: unknown
  ): Promise<
    | ElectronDesktopE2eProbe
    | ElectronDesktopE2eApplicationShortcutRuntimeInspection
    | ElectronDesktopE2eCloseReceipt
    | ElectronDesktopE2eDiagnosticsExportJournalInspection
    | ElectronDesktopE2eRetainedV22Precondition
    | ElectronDesktopE2eRoleSessionMigrationInspection
    | ElectronDesktopE2eRoleSessionRuntimeInspection
    | ElectronDesktopE2eApplicationLifecycleSignalReceipt
    | readonly ElectronDesktopE2eTrustedInputObservation[]
    | ElectronDesktopE2eGameWindowRuntimeInspection
    | ElectronDesktopE2eFullscreenToolbarInspection
    | ElectronDesktopE2eRolePlaceholderInspection
    | ElectronDesktopE2ePopupLifecycleJournalInspection
    | ElectronDesktopE2eRuntimeTabReloadInspection
    | ElectronDesktopE2eWorkspaceWebInspection
    | ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection
    | null
    | void
  > => {
    if (input.isPackaged()) {
      throw new Error("Electron desktop E2E controls are unavailable in packaged applications.");
    }
    if (!input.authorizeSenderUrl(event.sender.getURL())) {
      throw new Error("Electron desktop E2E sender is unauthorized.");
    }
    const request = parseRequest(candidate);
    authenticate(request.token, input.expectedSessionToken());
    const expected = targetForPlatform(input.platform);
    if (input.runtimeTarget() !== expected.runtimeTarget) {
      throw new Error("Electron desktop E2E runtime target does not match the host platform.");
    }
    if (request.action === "close") {
      if (!Number.isSafeInteger(input.processId) || input.processId <= 0) {
        throw new Error("Electron desktop E2E process identity is invalid.");
      }
      await input.prepareQuit();
      setImmediate(input.requestQuit);
      return Object.freeze({ pid: input.processId, status: "submitted" });
    }
    if (request.action === "diagnosticsExportJournal") {
      return input.readDiagnosticsExportJournal();
    }
    if (request.action === "focusMainWindow") {
      input.focusMainWindow();
      return;
    }
    if (request.action === "failNextRuntimeTabReload") {
      input.failNextRuntimeTabReload(request.windowId, request.tabId);
      return;
    }
    if (request.action === "showAppKitRuntimeTabMenu") {
      input.showAppKitRuntimeTabMenu(request.windowId, request.tabId);
      return;
    }
    if (request.action === "retainedV22Precondition") {
      return input.readRetainedV22Precondition();
    }
    if (request.action === "roleSessionMigration") {
      return input.readRoleSessionMigration(request.roleId);
    }
    if (request.action === "rolePlaceholderRuntime") {
      return input.readRolePlaceholderRuntime(request.roleId);
    }
    if (request.action === "roleSessionRuntime") {
      return input.readRoleSessionRuntime(request.roleId);
    }
    if (request.action === "applicationLifecycleSignal") {
      return input.signalApplicationLifecycle(request.event);
    }
    if (request.action === "trustedInputRuntime") {
      return input.readTrustedInputRuntime(request.roleId);
    }
    if (request.action === "applicationShortcutRuntime") {
      return input.readApplicationShortcutRuntime(request.windowId, event.sender);
    }
    if (request.action === "gameWindowRuntime") {
      return input.readGameWindowRuntime(request.windowId);
    }
    if (request.action === "fullscreenToolbarRuntime") {
      return input.readFullscreenToolbarRuntime(request.windowId);
    }
    if (request.action === "popupLifecycleJournal") {
      return input.readPopupLifecycleJournal(request.windowId);
    }
    if (request.action === "runtimeTabReload") {
      return input.readRuntimeTabReload(request.windowId);
    }
    if (request.action === "workspaceWebRuntime") {
      return input.readWorkspaceWebRuntime(request.windowId);
    }
    if (request.action === "workspaceWebSecurityPolicy") {
      return input.readWorkspaceWebSecurityPolicy(request.windowId);
    }
    if (!Number.isSafeInteger(input.processId) || input.processId <= 0) {
      throw new Error("Electron desktop E2E process identity is invalid.");
    }
    return Object.freeze({
      bridgeVersion: 1,
      chromeVersion: input.chromeVersion,
      driver: "electron",
      electronVersion: input.electronVersion,
      packaged: false,
      platform: expected.platform,
      processId: input.processId,
      runtimeTarget: expected.runtimeTarget
    });
  };

  input.ipcMain.handle(ELECTRON_DESKTOP_E2E_CHANNEL, listener);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      input.ipcMain.removeHandler(ELECTRON_DESKTOP_E2E_CHANNEL);
    }
  };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => key in record);
}

function isCanonicalRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function parseDiagnosticsExportJournal(
  candidate: unknown
): ElectronDesktopE2eDiagnosticsExportJournalInspection {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "capacity",
    "journalVersion",
    "observations"
  ]) || candidate.capacity !==
    ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY ||
    candidate.journalVersion !== 1 || !Array.isArray(candidate.observations) ||
    candidate.observations.length >
      ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY) {
    throw new Error("Electron desktop E2E diagnostics-export journal is invalid.");
  }
  let priorSequence = 0;
  const observations = candidate.observations.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      "coreDiagnosticsExportInvocationCount",
      "outcome",
      "sequence",
      "typedOutcome"
    ]) || !Number.isSafeInteger(entry.sequence) || Number(entry.sequence) < 1 ||
      (priorSequence !== 0 && Number(entry.sequence) !== priorSequence + 1) ||
      !Number.isSafeInteger(entry.coreDiagnosticsExportInvocationCount) ||
      Number(entry.coreDiagnosticsExportInvocationCount) < 0 ||
      Number(entry.coreDiagnosticsExportInvocationCount) > 1 ||
      !new Set(["cancelled", "exported", "rejected"]).has(String(entry.outcome)) ||
      (entry.outcome === "cancelled" && (
        entry.typedOutcome !== null || entry.coreDiagnosticsExportInvocationCount !== 0
      )) || (entry.outcome === "exported" && (
        entry.typedOutcome !== "diagnosticExportResult" ||
        entry.coreDiagnosticsExportInvocationCount !== 1
      )) || (entry.outcome === "rejected" && entry.typedOutcome !== "rejected")) {
      throw new Error("Electron desktop E2E diagnostics-export journal is invalid.");
    }
    priorSequence = Number(entry.sequence);
    return Object.freeze({
      coreDiagnosticsExportInvocationCount:
        Number(entry.coreDiagnosticsExportInvocationCount),
      outcome: entry.outcome as ElectronDesktopE2eDiagnosticsExportObservation["outcome"],
      sequence: priorSequence,
      typedOutcome:
        entry.typedOutcome as ElectronDesktopE2eDiagnosticsExportObservation["typedOutcome"]
    });
  });
  return Object.freeze({
    capacity: ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY,
    journalVersion: 1,
    observations: Object.freeze(observations)
  });
}

function parseRetainedV22Precondition(
  candidate: unknown
): ElectronDesktopE2eRetainedV22Precondition | null {
  if (candidate === null) return null;
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "contractVersion",
    "gameId",
    "gameName",
    "launchUrl",
    "platform",
    "roleId",
    "roleName",
    "runtimeContractVersion",
    "sourceEngine"
  ])) {
    throw new Error("Electron desktop E2E retained-v22 precondition is invalid.");
  }
  const expectedEngine = candidate.platform === "macos" ? "wkwebview" : "webview2";
  if (
    candidate.contractVersion !== 1
    || candidate.runtimeContractVersion !== 22
    || !new Set(["macos", "windows"]).has(String(candidate.platform))
    || candidate.sourceEngine !== expectedEngine
    || typeof candidate.gameId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.gameId)
    || typeof candidate.roleId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.roleId)
    || typeof candidate.gameName !== "string"
    || candidate.gameName.length === 0
    || typeof candidate.roleName !== "string"
    || candidate.roleName.length === 0
    || typeof candidate.launchUrl !== "string"
  ) {
    throw new Error("Electron desktop E2E retained-v22 precondition is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eRetainedV22Precondition;
}

function parseClearReceipt(
  candidate: unknown
): ElectronDesktopE2eRoleBrowserDataClearReceipt | null {
  if (candidate === null) return null;
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "clearedStorages",
    "cookieReadbackCount",
    "evidence",
    "operationId",
    "roleId"
  ])) {
    throw new Error("Electron desktop E2E Chromium clear receipt is invalid.");
  }
  const storages = candidate.clearedStorages;
  if (
    !Array.isArray(storages)
    || storages.length !== ELECTRON_DESKTOP_E2E_CLEAR_STORAGES.length
    || storages.some((storage, index) =>
      storage !== ELECTRON_DESKTOP_E2E_CLEAR_STORAGES[index]
    )
    || candidate.cookieReadbackCount !== 0
    || candidate.evidence !== "electron-clear-storage-data-promise-and-cookie-readback"
    || typeof candidate.operationId !== "string"
    || candidate.operationId.length === 0
    || typeof candidate.roleId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.roleId)
  ) {
    throw new Error("Electron desktop E2E Chromium clear receipt is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eRoleBrowserDataClearReceipt;
}

function parseMigrationJournal(
  candidate: unknown
): ElectronDesktopE2eRoleSessionMigrationJournal | null {
  if (candidate === null) return null;
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "cleanFlushReceiptId",
    "firstVerifiedLaunchAt",
    "journalRevision",
    "outcome",
    "phase",
    "platform",
    "resetReceiptId",
    "roleId",
    "sourceEngine",
    "sourceRevision",
    "targetEngine",
    "targetRevision",
    "transferId"
  ])) {
    throw new Error("Electron desktop E2E role-session migration journal is invalid.");
  }
  const expectedEngine = candidate.platform === "macos" ? "wkwebview" : "webview2";
  if (
    !new Set([
      "v22Ready",
      "exported",
      "importing",
      "verifying",
      "v23Ready",
      "failed",
      "indeterminate"
    ]).has(String(candidate.phase))
    || !new Set(["macos", "windows"]).has(String(candidate.platform))
    || candidate.sourceEngine !== expectedEngine
    || candidate.targetEngine !== "chromium"
    || !Number.isSafeInteger(candidate.journalRevision)
    || Number(candidate.journalRevision) < 1
    || !Number.isSafeInteger(candidate.sourceRevision)
    || Number(candidate.sourceRevision) < 0
    || (candidate.targetRevision !== null && (
      !Number.isSafeInteger(candidate.targetRevision) || Number(candidate.targetRevision) < 0
    ))
    || !new Set([null, "explicitReset", "failed", "indeterminate", "verified"]).has(
      candidate.outcome as null | string
    )
    || typeof candidate.roleId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.roleId)
    || typeof candidate.transferId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.transferId)
    || (candidate.cleanFlushReceiptId !== null
      && typeof candidate.cleanFlushReceiptId !== "string")
    || (candidate.firstVerifiedLaunchAt !== null
      && !isCanonicalRfc3339(candidate.firstVerifiedLaunchAt))
    || (candidate.resetReceiptId !== null && typeof candidate.resetReceiptId !== "string")
  ) {
    throw new Error("Electron desktop E2E role-session migration journal is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eRoleSessionMigrationJournal;
}

function parseMigrationInspection(
  candidate: unknown
): ElectronDesktopE2eRoleSessionMigrationInspection {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "journal",
    "pendingRoleBrowserDataClearOperations",
    "receipt",
    "roleExists",
    "roleId"
  ])) {
    throw new Error("Electron desktop E2E role-session migration inspection is invalid.");
  }
  if (
    typeof candidate.roleId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.roleId)
    || typeof candidate.roleExists !== "boolean"
    || !Number.isSafeInteger(candidate.pendingRoleBrowserDataClearOperations)
    || Number(candidate.pendingRoleBrowserDataClearOperations) < 0
  ) {
    throw new Error("Electron desktop E2E role-session migration inspection is invalid.");
  }
  const journal = parseMigrationJournal(candidate.journal);
  const receipt = parseClearReceipt(candidate.receipt);
  if (journal?.roleId !== undefined && journal.roleId !== candidate.roleId) {
    throw new Error("Electron desktop E2E role-session migration inspection is invalid.");
  }
  if (receipt?.roleId !== undefined && receipt.roleId !== candidate.roleId) {
    throw new Error("Electron desktop E2E role-session migration inspection is invalid.");
  }
  return {
    journal,
    pendingRoleBrowserDataClearOperations:
      candidate.pendingRoleBrowserDataClearOperations as number,
    receipt,
    roleExists: candidate.roleExists,
    roleId: candidate.roleId
  };
}

function parseRuntimeInspection(
  candidate: unknown
): ElectronDesktopE2eRoleSessionRuntimeInspection {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "currentRuntime",
    "latestSessionEnsure",
    "roleId"
  ])) {
    throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
  }
  const sha256Pattern = /^[a-f0-9]{64}$/u;
  if (
    typeof candidate.roleId !== "string"
    || !ROLE_ID_PATTERN.test(candidate.roleId)
    || !isRecord(candidate.latestSessionEnsure)
    || !hasExactKeys(candidate.latestSessionEnsure, [
      "chromiumPathSha256",
      "chromiumUserDataDir",
      "ensureCount",
      "nativeSessionInstance",
      "sessionStoragePath",
      "sessionStoragePathSha256"
    ])
  ) {
    throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
  }
  const session = candidate.latestSessionEnsure;
  if (
    typeof session.chromiumUserDataDir !== "string"
    || session.chromiumUserDataDir.length === 0
    || typeof session.sessionStoragePath !== "string"
    || session.sessionStoragePath.length === 0
    || typeof session.chromiumPathSha256 !== "string"
    || !sha256Pattern.test(session.chromiumPathSha256)
    || typeof session.sessionStoragePathSha256 !== "string"
    || !sha256Pattern.test(session.sessionStoragePathSha256)
    || session.sessionStoragePath !== session.chromiumUserDataDir
    || session.sessionStoragePathSha256 !== session.chromiumPathSha256
    || !Number.isSafeInteger(session.nativeSessionInstance)
    || Number(session.nativeSessionInstance) < 1
    || !Number.isSafeInteger(session.ensureCount)
    || Number(session.ensureCount) < 1
  ) {
    throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
  }
  if (candidate.currentRuntime === null) {
    return candidate as unknown as ElectronDesktopE2eRoleSessionRuntimeInspection;
  }
  if (!isRecord(candidate.currentRuntime) || !hasExactKeys(candidate.currentRuntime, [
    "appKitIdentity",
    "attemptGeneration",
    "focused",
    "generation",
    "hostKind",
    "ownerGeneration",
    "parentNativeHostId",
    "tabId",
    "topologyRevision",
    "visible",
    "windowGeneration",
    "windowId"
  ])) {
    throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
  }
  const runtime = candidate.currentRuntime;
  if (
    !new Set(["appkit-chromium", "bundled-chromium"]).has(String(runtime.hostKind))
    || typeof runtime.tabId !== "string"
    || !ROLE_ID_PATTERN.test(runtime.tabId)
    || typeof runtime.windowId !== "string"
    || !ROLE_ID_PATTERN.test(runtime.windowId)
    || (runtime.attemptGeneration !== null && (
      typeof runtime.attemptGeneration !== "string"
      || !ROLE_ID_PATTERN.test(runtime.attemptGeneration)
    ))
    || typeof runtime.focused !== "boolean"
    || !Number.isSafeInteger(runtime.generation)
    || Number(runtime.generation) < 1
    || !Number.isSafeInteger(runtime.ownerGeneration)
    || Number(runtime.ownerGeneration) < 1
    || !Number.isSafeInteger(runtime.parentNativeHostId)
    || Number(runtime.parentNativeHostId) < 1
    || !Number.isSafeInteger(runtime.topologyRevision)
    || Number(runtime.topologyRevision) < 1
    || !Number.isSafeInteger(runtime.windowGeneration)
    || Number(runtime.windowGeneration) < 1
    || typeof runtime.visible !== "boolean"
  ) {
    throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
  }
  if (runtime.appKitIdentity === null) {
    if (runtime.hostKind !== "bundled-chromium") {
      throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
    }
  } else {
    if (
      runtime.hostKind !== "appkit-chromium"
      || !isRecord(runtime.appKitIdentity)
      || !hasExactKeys(runtime.appKitIdentity, [
        "launchGeneration",
        "logicalWindowId",
        "nativeGeneration"
      ])
      || runtime.appKitIdentity.logicalWindowId !== runtime.windowId
      || typeof runtime.appKitIdentity.launchGeneration !== "string"
      || !ROLE_ID_PATTERN.test(runtime.appKitIdentity.launchGeneration)
      || !Number.isSafeInteger(runtime.appKitIdentity.nativeGeneration)
      || Number(runtime.appKitIdentity.nativeGeneration) < 1
    ) {
      throw new Error("Electron desktop E2E role-session runtime inspection is invalid.");
    }
  }
  return candidate as unknown as ElectronDesktopE2eRoleSessionRuntimeInspection;
}

function parseGameWindowRuntimeInspection(
  candidate: unknown
): ElectronDesktopE2eGameWindowRuntimeInspection {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "currentRuntime",
    "windowId"
  ]) || typeof candidate.windowId !== "string" ||
    !ROLE_ID_PATTERN.test(candidate.windowId)) {
    throw new Error("Electron desktop E2E Game Window runtime inspection is invalid.");
  }
  if (candidate.currentRuntime === null) {
    return candidate as unknown as ElectronDesktopE2eGameWindowRuntimeInspection;
  }
  if (!isRecord(candidate.currentRuntime) || !hasExactKeys(candidate.currentRuntime, [
    "appKitIdentity",
    "appKitStatusPresentation",
    "coreTabIds",
    "focused",
    "hostKind",
    "nativeDisplay",
    "nativeTabIds",
    "parentNativeHostId",
    "topologyRevision",
    "visible",
    "windowGeneration",
    "windowId"
  ])) {
    throw new Error("Electron desktop E2E Game Window runtime inspection is invalid.");
  }
  const runtime = candidate.currentRuntime;
  const validIds = (value: unknown): value is string[] => Array.isArray(value) &&
    value.every((id) => typeof id === "string" && ROLE_ID_PATTERN.test(id)) &&
    new Set(value).size === value.length;
  const validBounds = (value: unknown): boolean => isRecord(value) &&
    hasExactKeys(value, ["height", "width", "x", "y"]) &&
    [value.height, value.width, value.x, value.y].every(Number.isFinite) &&
    Number(value.height) > 0 && Number(value.width) > 0;
  if (
    runtime.windowId !== candidate.windowId ||
    !new Set([null, "failed", "loading", "ready"])
      .has(runtime.appKitStatusPresentation as null | string) ||
    !new Set(["appkit-chromium", "bundled-chromium"]).has(String(runtime.hostKind)) ||
    !validIds(runtime.coreTabIds) || !validIds(runtime.nativeTabIds) ||
    JSON.stringify(runtime.coreTabIds) !== JSON.stringify(runtime.nativeTabIds) ||
    !isRecord(runtime.nativeDisplay) || !hasExactKeys(runtime.nativeDisplay, [
      "bounds",
      "displayId",
      "presentation",
      "scaleFactor",
      "workArea"
    ]) || !validBounds(runtime.nativeDisplay.bounds) ||
    !validBounds(runtime.nativeDisplay.workArea) ||
    !Number.isSafeInteger(runtime.nativeDisplay.displayId) ||
    Number(runtime.nativeDisplay.displayId) < 0 ||
    !Number.isFinite(runtime.nativeDisplay.scaleFactor) ||
    Number(runtime.nativeDisplay.scaleFactor) <= 0 ||
    !new Set(["fullscreen", "maximized", "normal"])
      .has(String(runtime.nativeDisplay.presentation)) ||
    typeof runtime.focused !== "boolean" ||
    !Number.isSafeInteger(runtime.parentNativeHostId) ||
    Number(runtime.parentNativeHostId) < 1 ||
    !Number.isSafeInteger(runtime.topologyRevision) ||
    Number(runtime.topologyRevision) < 1 ||
    !Number.isSafeInteger(runtime.windowGeneration) ||
    Number(runtime.windowGeneration) < 1 ||
    typeof runtime.visible !== "boolean"
  ) {
    throw new Error("Electron desktop E2E Game Window runtime inspection is invalid.");
  }
  if (runtime.appKitIdentity === null) {
    if (runtime.hostKind !== "bundled-chromium" ||
        runtime.appKitStatusPresentation !== null) {
      throw new Error("Electron desktop E2E Game Window runtime inspection is invalid.");
    }
  } else if (
    runtime.hostKind !== "appkit-chromium" ||
    runtime.appKitStatusPresentation === null ||
    !isRecord(runtime.appKitIdentity) ||
    !hasExactKeys(runtime.appKitIdentity, [
      "launchGeneration",
      "logicalWindowId",
      "nativeGeneration"
    ]) ||
    runtime.appKitIdentity.logicalWindowId !== candidate.windowId ||
    typeof runtime.appKitIdentity.launchGeneration !== "string" ||
    !ROLE_ID_PATTERN.test(runtime.appKitIdentity.launchGeneration) ||
    !Number.isSafeInteger(runtime.appKitIdentity.nativeGeneration) ||
    Number(runtime.appKitIdentity.nativeGeneration) < 1
  ) {
    throw new Error("Electron desktop E2E Game Window runtime inspection is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eGameWindowRuntimeInspection;
}

function parseLifecycleStatus(candidate: unknown): ApplicationLifecycleStatusRecord {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "capturedAt",
    "lifecycleEpoch",
    "platform",
    "reason",
    "revision",
    "state"
  ]) || !isCanonicalRfc3339(candidate.capturedAt) ||
    !Number.isSafeInteger(candidate.lifecycleEpoch) ||
    Number(candidate.lifecycleEpoch) < 1 ||
    !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1 ||
    !new Set(["macos", "windows"]).has(String(candidate.platform)) ||
    !new Set([
      "active",
      "degraded",
      "resuming",
      "suspended",
      "suspending"
    ]).has(String(candidate.state)) || typeof candidate.reason !== "string" ||
    candidate.reason.length === 0) {
    throw new Error("Electron desktop E2E application lifecycle status is invalid.");
  }
  return candidate as unknown as ApplicationLifecycleStatusRecord;
}

function parseApplicationLifecycleSignalReceipt(
  candidate: unknown,
  expectedEvent: "resume" | "suspend"
): ElectronDesktopE2eApplicationLifecycleSignalReceipt {
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "before",
    "event",
    "terminal"
  ]) || !new Set(["resume", "suspend"]).has(String(candidate.event))) {
    throw new Error("Electron desktop E2E application lifecycle signal receipt is invalid.");
  }
  const before = parseLifecycleStatus(candidate.before);
  const terminal = parseLifecycleStatus(candidate.terminal);
  const expectedState = expectedEvent === "suspend" ? "suspended" : "active";
  if (terminal.lifecycleEpoch !== before.lifecycleEpoch + 1 ||
    terminal.revision !== before.revision + 2 || terminal.platform !== before.platform ||
    candidate.event !== expectedEvent ||
    !new Set([expectedState, "degraded"]).has(terminal.state)) {
    throw new Error("Electron desktop E2E application lifecycle signal receipt is invalid.");
  }
  return {
    before,
    event: candidate.event as "resume" | "suspend",
    terminal
  };
}

function isBrowserAction(candidate: unknown): candidate is BrowserActionRequest["action"] {
  if (!isRecord(candidate) || typeof candidate.type !== "string") return false;
  if (candidate.type === "focus") return hasExactKeys(candidate, ["type"]);
  if (candidate.type === "key") {
    return hasExactKeys(candidate, [
      "code",
      "key",
      "modifiers",
      "ownerId",
      "phase",
      "suppressOverlayShortcut",
      "type"
    ]) && new Set(["hold", "release", "tap"]).has(String(candidate.phase)) &&
      typeof candidate.key === "string" && candidate.key.length > 0 &&
      (candidate.code === null || typeof candidate.code === "string") &&
      Array.isArray(candidate.modifiers) && new Set(candidate.modifiers).size ===
        candidate.modifiers.length && candidate.modifiers.every((modifier) =>
        new Set(["alt", "ctrl", "meta", "primary", "shift"]).has(String(modifier))) &&
      typeof candidate.ownerId === "string" && candidate.ownerId.length > 0 &&
      typeof candidate.suppressOverlayShortcut === "boolean";
  }
  return candidate.type === "click" && hasExactKeys(candidate, [
    "anchor",
    "button",
    "type",
    "unit",
    "x",
    "y"
  ]) && new Set([
    null,
    "bottom-center",
    "bottom-left",
    "bottom-right",
    "center",
    "center-left",
    "center-right",
    "top-center",
    "top-left",
    "top-right"
  ]).has(candidate.anchor as string | null) && new Set(["left", "middle", "right"]).has(
    String(candidate.button)
  ) && new Set(["percent", "px", "reference-px"]).has(String(candidate.unit)) &&
    typeof candidate.x === "number" && Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" && Number.isFinite(candidate.y);
}

function parseTrustedInputObservation(
  candidate: unknown,
  expectedSequence: number
): ElectronDesktopE2eTrustedInputObservation {
  const request = isRecord(candidate) && isRecord(candidate.request)
    ? candidate.request
    : null;
  const baseRequestKeys = [
    "action",
    "deadlineMs",
    "inputEpoch",
    "intent",
    "origin",
    "requestId",
    "roleId",
    "scheduledAtMs"
  ];
  const exactSurfaceRequest = request && hasExactKeys(request, [
    ...baseRequestKeys,
    "documentInstanceId",
    "surfaceGeneration"
  ]);
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "receipt",
    "request",
    "sequence"
  ]) || candidate.sequence !== expectedSequence || !request ||
    (!hasExactKeys(request, baseRequestKeys) && !exactSurfaceRequest) ||
    typeof request.requestId !== "string" || request.requestId.length === 0 ||
    typeof request.roleId !== "string" || !ROLE_ID_PATTERN.test(request.roleId) ||
    request.origin !== "macro" ||
    !new Set(["cleanup", "normal"]).has(String(request.intent)) ||
    !Number.isSafeInteger(request.inputEpoch) || Number(request.inputEpoch) < 0 ||
    !Number.isSafeInteger(request.scheduledAtMs) || Number(request.scheduledAtMs) < 1 ||
    !Number.isSafeInteger(request.deadlineMs) ||
    Number(request.deadlineMs) < Number(request.scheduledAtMs) ||
    (exactSurfaceRequest && (
      !Number.isSafeInteger(request.surfaceGeneration) ||
      Number(request.surfaceGeneration) < 1 ||
      typeof request.documentInstanceId !== "string" ||
      request.documentInstanceId.length === 0 ||
      request.documentInstanceId.length > 256 ||
      request.documentInstanceId !== request.documentInstanceId.trim()
    )) || !isBrowserAction(request.action) || !isRecord(candidate.receipt) ||
    !hasExactKeys(candidate.receipt, [
      "completedAtMs",
      "confirmedInputNeutrality",
      "errorCode",
      "errorMessage",
      "inputEpoch",
      "requestId",
      "roleId",
      "status",
      "surfaceGeneration"
    ])) {
    throw new Error("Electron desktop E2E trusted-input observation is invalid.");
  }
  const receipt = candidate.receipt;
  if (receipt.requestId !== request.requestId || receipt.roleId !== request.roleId ||
    receipt.inputEpoch !== request.inputEpoch || receipt.status !== "applied" ||
    receipt.errorCode !== null || receipt.errorMessage !== null ||
    !Number.isSafeInteger(receipt.surfaceGeneration) ||
    Number(receipt.surfaceGeneration) < 1 ||
    !Number.isSafeInteger(receipt.completedAtMs) ||
    Number(receipt.completedAtMs) < Number(request.scheduledAtMs) ||
    typeof receipt.confirmedInputNeutrality !== "boolean") {
    throw new Error("Electron desktop E2E trusted-input observation is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eTrustedInputObservation;
}

function parseTrustedInputObservations(
  candidate: unknown,
  roleId: string
): readonly ElectronDesktopE2eTrustedInputObservation[] {
  if (!Array.isArray(candidate)) {
    throw new Error("Electron desktop E2E trusted-input observations are invalid.");
  }
  const observations = candidate.map((entry, index) =>
    parseTrustedInputObservation(entry, index + 1));
  if (observations.some((observation) => observation.request.roleId !== roleId)) {
    throw new Error("Electron desktop E2E trusted-input observations are invalid.");
  }
  return Object.freeze(observations);
}

function parseProbe(candidate: unknown): ElectronDesktopE2eProbe {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("Electron desktop E2E probe response is invalid.");
  }
  const probe = candidate as Partial<ElectronDesktopE2eProbe>;
  if (
    probe.bridgeVersion !== 1
    || probe.driver !== "electron"
    || probe.packaged !== false
    || typeof probe.chromeVersion !== "string"
    || typeof probe.electronVersion !== "string"
    || !new Set(["macos", "windows"]).has(probe.platform ?? "")
    || !Number.isSafeInteger(probe.processId)
    || Number(probe.processId) <= 0
    || !new Set([
      "chromium-v23-macos-appkit",
      "chromium-v23-windows"
    ]).has(probe.runtimeTarget ?? "")
  ) {
    throw new Error("Electron desktop E2E probe response is invalid.");
  }
  return probe as ElectronDesktopE2eProbe;
}

function parseCloseReceipt(candidate: unknown): ElectronDesktopE2eCloseReceipt {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("Electron desktop E2E close response is invalid.");
  }
  const receipt = candidate as Partial<ElectronDesktopE2eCloseReceipt>;
  if (receipt.status !== "submitted" || !Number.isSafeInteger(receipt.pid) || (receipt.pid ?? 0) <= 0) {
    throw new Error("Electron desktop E2E close response is invalid.");
  }
  return receipt as ElectronDesktopE2eCloseReceipt;
}

export function createElectronDesktopE2ePreloadApi(
  ipcRenderer: ElectronDesktopE2eIpcRendererPort
): Readonly<ElectronDesktopE2ePreloadApi> {
  return Object.freeze({
    applicationShortcutRuntime: async (token: string, windowId: string) =>
      parseElectronDesktopE2eApplicationShortcutRuntimeInspection(
        await ipcRenderer.invoke(
          ELECTRON_DESKTOP_E2E_CHANNEL,
          { action: "applicationShortcutRuntime", token, windowId }
        )
      ),
    applicationLifecycleSignal: async (
      token: string,
      event: "resume" | "suspend"
    ) => parseApplicationLifecycleSignalReceipt(
      await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "applicationLifecycleSignal", event, token }
      ),
      event
    ),
    close: async (token: string) => parseCloseReceipt(await ipcRenderer.invoke(
      ELECTRON_DESKTOP_E2E_CHANNEL,
      { action: "close", token }
    )),
    diagnosticsExportJournal: async (token: string) =>
      parseDiagnosticsExportJournal(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "diagnosticsExportJournal", token }
      )),
    focusMainWindow: async (token: string) => {
      await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "focusMainWindow", token }
      );
    },
    failNextRuntimeTabReload: async (
      token: string,
      windowId: string,
      tabId: string
    ) => {
      await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "failNextRuntimeTabReload", tabId, token, windowId }
      );
    },
    showAppKitRuntimeTabMenu: async (
      token: string,
      windowId: string,
      tabId: string
    ) => {
      await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "showAppKitRuntimeTabMenu", tabId, token, windowId }
      );
    },
    gameWindowRuntime: async (token: string, windowId: string) =>
      parseGameWindowRuntimeInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "gameWindowRuntime", token, windowId }
      )),
    fullscreenToolbarRuntime: async (token: string, windowId: string) =>
      parseElectronDesktopE2eFullscreenToolbarInspection(
        await ipcRenderer.invoke(
          ELECTRON_DESKTOP_E2E_CHANNEL,
          { action: "fullscreenToolbarRuntime", token, windowId }
        )
      ),
    popupLifecycleJournal: async (token: string, windowId: string) =>
      parseElectronDesktopE2ePopupLifecycleJournalInspection(
        await ipcRenderer.invoke(
          ELECTRON_DESKTOP_E2E_CHANNEL,
          { action: "popupLifecycleJournal", token, windowId }
        )
      ),
    runtimeTabReload: async (token: string, windowId: string) =>
      parseElectronDesktopE2eRuntimeTabReloadInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "runtimeTabReload", token, windowId }
      )),
    retainedV22Precondition: async (token: string) =>
      parseRetainedV22Precondition(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "retainedV22Precondition", token }
      )),
    roleSessionMigration: async (token: string, roleId: string) =>
      parseMigrationInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "roleSessionMigration", roleId, token }
      )),
    rolePlaceholderRuntime: async (token: string, roleId: string) =>
      parseElectronDesktopE2eRolePlaceholderInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "rolePlaceholderRuntime", roleId, token }
      )),
    roleSessionRuntime: async (token: string, roleId: string) =>
      parseRuntimeInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "roleSessionRuntime", roleId, token }
      )),
    trustedInputRuntime: async (token: string, roleId: string) =>
      parseTrustedInputObservations(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "trustedInputRuntime", roleId, token }
      ), roleId),
    workspaceWebRuntime: async (token: string, windowId: string) =>
      parseElectronDesktopE2eWorkspaceWebInspection(await ipcRenderer.invoke(
        ELECTRON_DESKTOP_E2E_CHANNEL,
        { action: "workspaceWebRuntime", token, windowId }
      )),
    workspaceWebSecurityPolicy: async (token: string, windowId: string) =>
      parseElectronDesktopE2eWorkspaceWebSecurityPolicyInspection(
        await ipcRenderer.invoke(
          ELECTRON_DESKTOP_E2E_CHANNEL,
          { action: "workspaceWebSecurityPolicy", token, windowId }
        )
      ),
    probe: async (token: string) => parseProbe(await ipcRenderer.invoke(
      ELECTRON_DESKTOP_E2E_CHANNEL,
      { action: "probe", token }
    ))
  });
}

export function installElectronDesktopE2ePreloadBridge(
  contextBridge: ElectronDesktopE2eContextBridgePort,
  ipcRenderer: ElectronDesktopE2eIpcRendererPort
): Readonly<ElectronDesktopE2ePreloadApi> {
  const api = createElectronDesktopE2ePreloadApi(ipcRenderer);
  contextBridge.exposeInMainWorld(ELECTRON_DESKTOP_E2E_GLOBAL, api);
  return api;
}
