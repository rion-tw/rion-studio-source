import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createElectronDesktopE2ePreloadApi,
  ELECTRON_DESKTOP_E2E_CLEAR_STORAGES,
  ELECTRON_DESKTOP_E2E_CHANNEL,
  registerElectronDesktopE2eBridge
} from "../src/electron/e2e/desktopE2eBridge";
import { ElectronDesktopE2eWindowZoomJournal } from
  "../src/electron/e2e/applicationShortcutRuntimeInspection";

import {
  TOKEN,
  GAME_ID,
  ROLE_ID,
  TRANSFER_ID,
  CLEAR_OPERATION_ID,
  TAB_ID,
  WINDOW_ID,
  ATTEMPT_ID,
  WINDOW_LAUNCH_ID,
  WEB_SLOT_ID,
  ROLE_SLOT_ID,
  TARGET_TAB_ID,
  TARGET_WINDOW_ID,
  TARGET_SLOT_ID,
  TARGET_ATTEMPT_ID,
  POPUP_ID,
  POPUP_OPEN_OPERATION_ID,
  POPUP_EVENT_IDS,
  ZOOM_OPERATION_ID,
  TARGET_WINDOW_LAUNCH_ID,
  workspaceWebInspection
} from "./support/electronDesktopE2eBridgeFixtures";

const runtimeTabReloadInspection = Object.freeze({
  capacity: 32 as const,
  failures: Object.freeze([]),
  journalVersion: 1 as const,
  nativeWindow: Object.freeze({
    appKitIdentity: Object.freeze({
      launchGeneration: WINDOW_LAUNCH_ID,
      logicalWindowId: WINDOW_ID,
      nativeGeneration: 1
    }),
    hostKind: "appkit-chromium" as const,
    parentNativeHostId: 41,
    tabIds: Object.freeze([TAB_ID]),
    topologyRevision: 2,
    windowGeneration: 1
  }),
  observations: Object.freeze([]),
  platform: "darwin" as const,
  popups: Object.freeze([]),
  roles: Object.freeze([]),
  windowId: WINDOW_ID,
  windowsMenuCaptures: Object.freeze([])
});
const precondition = Object.freeze({
  contractVersion: 1 as const,
  gameId: GAME_ID,
  gameName: "Chromium Retained v22 Game",
  launchUrl: "http://127.0.0.1:3210/role/chromium-explicit-reset",
  platform: "macos" as const,
  roleId: ROLE_ID,
  roleName: "Chromium Retained v22 Role",
  runtimeContractVersion: 22 as const,
  sourceEngine: "wkwebview" as const
});
const diagnosticsExportJournalInspection = Object.freeze({
  capacity: 32 as const,
  journalVersion: 1 as const,
  observations: Object.freeze([Object.freeze({
    coreDiagnosticsExportInvocationCount: 0,
    outcome: "cancelled" as const,
    sequence: 1,
    typedOutcome: null
  })])
});
const clearReceipt = Object.freeze({
  clearedStorages: ELECTRON_DESKTOP_E2E_CLEAR_STORAGES,
  cookieReadbackCount: 0 as const,
  evidence: "electron-clear-storage-data-promise-and-cookie-readback" as const,
  operationId: CLEAR_OPERATION_ID,
  roleId: ROLE_ID
});
const journal = Object.freeze({
  cleanFlushReceiptId: `chromium-session-clear:${CLEAR_OPERATION_ID}`,
  firstVerifiedLaunchAt: "2026-08-30T13:37:26.000Z",
  journalRevision: 2,
  outcome: "explicitReset" as const,
  phase: "v23Ready" as const,
  platform: "macos" as const,
  resetReceiptId: `role-browser-clear:role-browser-clear-${CLEAR_OPERATION_ID}`,
  roleId: ROLE_ID,
  sourceEngine: "wkwebview" as const,
  sourceRevision: 0,
  targetEngine: "chromium" as const,
  targetRevision: 1,
  transferId: TRANSFER_ID
});
const migrationInspection = Object.freeze({
  journal,
  pendingRoleBrowserDataClearOperations: 0,
  receipt: clearReceipt,
  roleExists: true,
  roleId: ROLE_ID
});
const runtimeInspection = Object.freeze({
  currentRuntime: Object.freeze({
    appKitIdentity: Object.freeze({
      launchGeneration: WINDOW_LAUNCH_ID,
      logicalWindowId: WINDOW_ID,
      nativeGeneration: 3
    }),
    attemptGeneration: ATTEMPT_ID,
    focused: true,
    generation: 4,
    hostKind: "appkit-chromium" as const,
    ownerGeneration: 4,
    parentNativeHostId: 41,
    tabId: TAB_ID,
    topologyRevision: 7,
    visible: true,
    windowGeneration: 2,
    windowId: WINDOW_ID
  }),
  latestSessionEnsure: Object.freeze({
    chromiumPathSha256: "b".repeat(64),
    chromiumUserDataDir: "/tmp/rion/roles/a/browser/chromium",
    ensureCount: 2,
    nativeSessionInstance: 1,
    sessionStoragePath: "/tmp/rion/roles/a/browser/chromium",
    sessionStoragePathSha256: "b".repeat(64)
  }),
  roleId: ROLE_ID
});
const gameWindowInspection = Object.freeze({
  currentRuntime: Object.freeze({
    appKitIdentity: Object.freeze({
      launchGeneration: ATTEMPT_ID,
      logicalWindowId: WINDOW_ID,
      nativeGeneration: 3
    }),
    appKitStatusPresentation: "ready" as const,
    coreTabIds: Object.freeze([]),
    focused: true,
    hostKind: "appkit-chromium" as const,
    nativeDisplay: Object.freeze({
      bounds: Object.freeze({ height: 640, width: 960, x: 80, y: 60 }),
      displayId: 41,
      presentation: "normal" as const,
      scaleFactor: 2,
      workArea: Object.freeze({ height: 932, width: 1512, x: 0, y: 25 })
    }),
    nativeTabIds: Object.freeze([]),
    parentNativeHostId: 41,
    topologyRevision: 7,
    visible: true,
    windowGeneration: 2,
    windowId: WINDOW_ID
  }),
  windowId: WINDOW_ID
});
const applicationShortcutInspection = Object.freeze({
  coreWindow: Object.freeze({
    activeTabId: TAB_ID,
    presentation: "normal" as const,
    tabIds: Object.freeze([TAB_ID]),
    topologyRevision: 8,
    windowGeneration: 2,
    windowId: WINDOW_ID,
    windowZoomFactor: 1.05
  }),
  globalWebSurfaces: Object.freeze([]),
  mainWindow: Object.freeze({
    browserWindowId: 1,
    fullscreen: false,
    webContentsId: 5,
    zoomFactor: 1
  }),
  nativeWindow: Object.freeze({
    activeTabId: TAB_ID,
    appKitIdentity: Object.freeze({
      launchGeneration: ATTEMPT_ID,
      logicalWindowId: WINDOW_ID,
      nativeGeneration: 3
    }),
    focused: true,
    hostKind: "appkit-chromium" as const,
    parentNativeHostId: 41,
    presentation: "normal" as const,
    tabIds: Object.freeze([TAB_ID]),
    topologyRevision: 8,
    visible: true,
    windowGeneration: 2,
    windowId: WINDOW_ID,
    windowZoomFactor: 1.05
  }),
  popupSurfaces: Object.freeze([]),
  roleSurfaces: Object.freeze([Object.freeze({
    appliedZoomFactor: 1.05,
    baseZoomFactor: 1,
    generation: 4,
    roleId: ROLE_ID,
    tabId: TAB_ID,
    visible: true
  })]),
  windowId: WINDOW_ID,
  zoomJournal: Object.freeze({
    capacity: 32 as const,
    journalVersion: 1 as const,
    observations: Object.freeze([Object.freeze({
      receipt: Object.freeze({
        action: "in" as const,
        globalWebSurfaceCount: 0,
        nextZoomFactor: 1.05,
        operationId: ZOOM_OPERATION_ID,
        popupSurfaceCount: 0,
        previousZoomFactor: 1,
        roleSurfaceCount: 1,
        sourceTopologyRevision: 7,
        status: "applied" as const,
        topologyRevision: 8,
        windowGeneration: 2,
        windowId: WINDOW_ID
      }),
      sequence: 1
    })])
  })
});
const fullscreenToolbarInspection = Object.freeze({
  hostKind: "appkit" as const,
  native: Object.freeze({
    alwaysShowToolbarInFullScreen: true,
    appKit: Object.freeze({
      accessoryOnScreen: true,
      accessoryVisibleHeight: 38,
      fullscreenHostReady: true,
      presentationAutoHideToolbar: false,
      revealLocked: false,
      tabCloseButtonEnabledCount: 1,
      tabStripOnScreen: true,
      toolbarPinned: true,
      visibleTrafficLightCount: 3
    }),
    fullscreen: true,
    nativeControlsVisible: true,
    nativeWindowControlCount: 3,
    projectionRevision: 8,
    revealed: false,
    toolbarVisible: true,
    topologyRevision: 7,
    windowGeneration: 2,
    windowId: WINDOW_ID
  }),
  presentation: "fullscreen" as const,
  surfaces: Object.freeze([Object.freeze({
    bounds: Object.freeze({ height: 642, width: 960, x: 0, y: 38 }),
    generation: 4,
    id: ROLE_ID,
    kind: "role" as const,
    tabId: TAB_ID,
    visible: true
  })]),
  tabIds: Object.freeze([TAB_ID]),
  topologyRevision: 7,
  windowGeneration: 2,
  windowId: WINDOW_ID
});
const workspaceWebSecurityPolicyInspection = Object.freeze({
  contentProfilePath: workspaceWebInspection.web.contentProfilePath,
  generation: workspaceWebInspection.web.generation,
  observations: Object.freeze([
    Object.freeze({
      callback: false as const,
      kind: "permission-request" as const,
      origin: "http://127.0.0.1:3210",
      permission: "geolocation",
      sequence: 1
    }),
    Object.freeze({
      defaultPrevented: true as const,
      kind: "will-download" as const,
      origin: "http://127.0.0.1:3210",
      sequence: 2,
      url: "http://127.0.0.1:3210/download/chromium-workspace-web"
    })
  ]),
  policyVersion: 1 as const,
  sessionStoragePath: workspaceWebInspection.web.contentProfilePath,
  surfaceId: workspaceWebInspection.web.surfaceId,
  windowId: WINDOW_ID
});
const popupParent = Object.freeze({
  ownerId: workspaceWebInspection.web.surfaceId,
  ownerKind: "globalWeb" as const,
  ownerNativeGeneration: workspaceWebInspection.web.generation,
  parentAppkitIdentity: Object.freeze({
    launchGeneration: ATTEMPT_ID,
    logicalWindowId: WINDOW_ID,
    nativeGeneration: 2
  }),
  parentAttemptGeneration: ATTEMPT_ID,
  parentNativeHostId: 41,
  parentTabId: TAB_ID,
  parentTopologyRevision: 9,
  parentWindowGeneration: 2,
  parentWindowId: WINDOW_ID,
  roleOwnerGeneration: null,
  slotId: WEB_SLOT_ID
});
const popupLifecycleJournalInspection = Object.freeze({
  capacity: 256 as const,
  journalVersion: 1 as const,
  observations: Object.freeze([
    Object.freeze({
      action: "nativeReady" as const,
      closeNative: false,
      closeReason: null,
      completionScope: "nativeAcknowledgement" as const,
      eventId: POPUP_EVENT_IDS[0],
      failureCode: null,
      lifecycleRevision: 2,
      lifecycleTerminal: false,
      openOperationId: POPUP_OPEN_OPERATION_ID,
      operationId: POPUP_OPEN_OPERATION_ID,
      operationTerminal: false,
      parent: popupParent,
      phase: "nativeReady" as const,
      popupId: POPUP_ID,
      sequence: 1,
      status: "applied" as const,
      terminalReason: null
    }),
    Object.freeze({
      action: "closeRequested" as const,
      closeNative: true,
      closeReason: "parentRetired" as const,
      completionScope: "stateCommit" as const,
      eventId: POPUP_EVENT_IDS[1],
      failureCode: null,
      lifecycleRevision: 3,
      lifecycleTerminal: false,
      openOperationId: POPUP_OPEN_OPERATION_ID,
      operationId: POPUP_OPEN_OPERATION_ID,
      operationTerminal: false,
      parent: popupParent,
      phase: "closing" as const,
      popupId: POPUP_ID,
      sequence: 2,
      status: "applied" as const,
      terminalReason: null
    }),
    Object.freeze({
      action: "nativeClosed" as const,
      closeNative: false,
      closeReason: "parentRetired" as const,
      completionScope: "nativeDestroyed" as const,
      eventId: POPUP_EVENT_IDS[2],
      failureCode: "CHROMIUM_POPUP_OWNER_RETIRED",
      lifecycleRevision: 4,
      lifecycleTerminal: true,
      openOperationId: POPUP_OPEN_OPERATION_ID,
      operationId: POPUP_OPEN_OPERATION_ID,
      operationTerminal: true,
      parent: popupParent,
      phase: "cancelled" as const,
      popupId: POPUP_ID,
      sequence: 3,
      status: "cancelled" as const,
      terminalReason: "parentRetired"
    })
  ]),
  windowId: WINDOW_ID
});
const webOnlyWorkspaceInspection = Object.freeze({
  ...workspaceWebInspection,
  coreSlots: Object.freeze([workspaceWebInspection.coreSlots[0]!]),
  role: null
});
const rolePlaceholderInspection = Object.freeze({
  coreOwner: Object.freeze({
    generation: 5,
    roleId: ROLE_ID,
    slotId: ROLE_SLOT_ID,
    state: "running" as const,
    tabId: TAB_ID,
    windowId: WINDOW_ID
  }),
  coreStatus: Object.freeze({
    automationState: "ready" as const,
    hostKind: "appkit-chromium" as const,
    issueReason: null,
    overlayState: "ready" as const,
    pageHealth: "healthy" as const,
    resolvedEngine: "chromium" as const,
    roleId: ROLE_ID,
    runtimeMode: "embedded" as const,
    state: "running" as const
  }),
  nativeOwner: Object.freeze({
    appKitIdentity: Object.freeze({
      launchGeneration: WINDOW_LAUNCH_ID,
      logicalWindowId: WINDOW_ID,
      nativeGeneration: 3
    }),
    attemptGeneration: ATTEMPT_ID,
    bounds: Object.freeze({ height: 600, width: 422, x: 538, y: 40 }),
    generation: 6,
    hostKind: "appkit-chromium" as const,
    ownerGeneration: 5,
    parentNativeHostId: 41,
    roleId: ROLE_ID,
    tabId: TAB_ID,
    topologyRevision: 8,
    visible: true,
    windowGeneration: 2,
    windowId: WINDOW_ID
  }),
  phase: "ready" as const,
  placeholders: Object.freeze([Object.freeze({
    appKitIdentity: Object.freeze({
      launchGeneration: TARGET_WINDOW_LAUNCH_ID,
      logicalWindowId: TARGET_WINDOW_ID,
      nativeGeneration: 4
    }),
    attemptGeneration: TARGET_ATTEMPT_ID,
    blocked: true as const,
    bounds: Object.freeze({ height: 600, width: 422, x: 538, y: 40 }),
    generation: 1,
    hostKind: "appkit-chromium" as const,
    nativeHostId: 42,
    ownerGeneration: 5,
    ownerTabName: "Shared Workspace A",
    placeholderId: `role-placeholder:${TARGET_TAB_ID}:${TARGET_SLOT_ID}`,
    roleId: ROLE_ID,
    roleName: "Shared Role",
    shellSession: "rion-web-chrome-shell:memory" as const,
    shellStoragePath: null,
    shellUrl: "file:///Rion/out/renderer/runtime-role-placeholder-electron.html",
    slotId: TARGET_SLOT_ID,
    tabId: TARGET_TAB_ID,
    topologyRevision: 9,
    visible: true,
    windowGeneration: 3,
    windowId: TARGET_WINDOW_ID
  })]),
  roleId: ROLE_ID
});

const lifecycleSignalReceipt = Object.freeze({
  before: Object.freeze({
    capturedAt: "2026-08-31T00:00:00.000Z",
    lifecycleEpoch: 1,
    platform: "macos" as const,
    reason: "startup",
    revision: 1,
    state: "active" as const
  }),
  event: "suspend" as const,
  terminal: Object.freeze({
    capturedAt: "2026-08-31T00:00:01.000Z",
    lifecycleEpoch: 2,
    platform: "macos" as const,
    reason: "power-suspended",
    revision: 3,
    state: "suspended" as const
  })
});
const trustedInputObservations = Object.freeze([Object.freeze({
  receipt: Object.freeze({
    completedAtMs: 12,
    confirmedInputNeutrality: false,
    errorCode: null,
    errorMessage: null,
    inputEpoch: 4,
    requestId: "macro-hold-1",
    roleId: ROLE_ID,
    status: "applied" as const,
    surfaceGeneration: 3
  }),
  request: Object.freeze({
    action: Object.freeze({
      code: "KeyS",
      key: "s",
      modifiers: [],
      ownerId: "macro-run-1",
      phase: "hold" as const,
      suppressOverlayShortcut: true,
      type: "key" as const
    }),
    deadlineMs: 20,
    inputEpoch: 4,
    intent: "normal" as const,
    origin: "macro" as const,
    requestId: "macro-hold-1",
    roleId: ROLE_ID,
    scheduledAtMs: 10
  }),
  sequence: 1
})]);

function registrationFixture(overrides: Partial<Parameters<
  typeof registerElectronDesktopE2eBridge
>[0]> = {}) {
  let listener: ((event: { sender: { getURL: () => string } }, request: unknown) => Promise<unknown>)
    | undefined;
  const removeHandler = vi.fn();
  const input = {
    armApplicationShortcutFullscreenExit: vi.fn(async () => undefined),
    authorizeSenderUrl: (url: string) => url === "file:///renderer/index.html",
    chromeVersion: "128.0.0.0",
    electronVersion: "32.0.0",
    expectedSessionToken: () => TOKEN,
    failNextRuntimeTabReload: vi.fn(),
    focusMainWindow: vi.fn(),
    ipcMain: {
      handle: vi.fn((_channel, nextListener) => {
        listener = nextListener;
      }),
      removeHandler
    },
    isPackaged: () => false,
    platform: "darwin" as NodeJS.Platform,
    prepareQuit: vi.fn(async () => undefined),
    processId: 4242,
    readApplicationShortcutRuntime: vi.fn(
      async () => applicationShortcutInspection
    ),
    readDiagnosticsExportJournal: vi.fn(() => diagnosticsExportJournalInspection),
    readFullscreenToolbarRuntime: vi.fn(async () => fullscreenToolbarInspection),
    readGameWindowRuntime: vi.fn(async () => gameWindowInspection),
    readPopupLifecycleJournal: vi.fn(() => popupLifecycleJournalInspection),
    readRuntimeTabReload: vi.fn(() => runtimeTabReloadInspection),
    readRetainedV22Precondition: vi.fn(() => precondition),
    readRolePlaceholderRuntime: vi.fn(async () => rolePlaceholderInspection),
    readRoleSessionMigration: vi.fn(() => migrationInspection),
    readRoleSessionRuntime: vi.fn(() => runtimeInspection),
    readTrustedInputRuntime: vi.fn(() => trustedInputObservations),
    readWorkspaceWebRuntime: vi.fn(async () => workspaceWebInspection),
    readWorkspaceWebSecurityPolicy: vi.fn(
      async () => workspaceWebSecurityPolicyInspection
    ),
    requestQuit: vi.fn(),
    runtimeTarget: () => "chromium-v23-macos-appkit",
    showAppKitRuntimeTabMenu: vi.fn(),
    signalApplicationLifecycle: vi.fn(async () => lifecycleSignalReceipt),
    ...overrides
  };
  const registration = registerElectronDesktopE2eBridge(input);
  if (!listener) throw new Error("Expected Electron desktop E2E listener registration");
  return { input, listener, registration, removeHandler };
}

describe("Electron desktop E2E-only bridge", () => {
  it("returns an exact platform-bound probe only to the main renderer with the session token", async () => {
    const fixture = registrationFixture();

    await expect(fixture.listener(
      { sender: { getURL: () => "file:///renderer/index.html" } },
      { action: "probe", token: TOKEN }
    )).resolves.toEqual({
      bridgeVersion: 1,
      chromeVersion: "128.0.0.0",
      driver: "electron",
      electronVersion: "32.0.0",
      packaged: false,
      platform: "macos",
      processId: 4242,
      runtimeTarget: "chromium-v23-macos-appkit"
    });

    fixture.registration.dispose();
    fixture.registration.dispose();
    expect(fixture.removeHandler).toHaveBeenCalledOnce();
    expect(fixture.removeHandler).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL);
  });

  it("exposes only token-authenticated retained-v22 and read-only runtime evidence", async () => {
    const fixture = registrationFixture();
    const sender = {
      sender: { getURL: () => "file:///renderer/index.html", id: 5 }
    };

    await expect(fixture.listener(sender, {
      action: "armApplicationShortcutFullscreenExit",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toBeUndefined();
    expect(fixture.input.armApplicationShortcutFullscreenExit)
      .toHaveBeenCalledWith(WINDOW_ID, sender.sender);
    await expect(fixture.listener(sender, {
      action: "applicationShortcutRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(applicationShortcutInspection);
    await expect(fixture.listener(sender, {
      action: "diagnosticsExportJournal",
      token: TOKEN
    })).resolves.toEqual(diagnosticsExportJournalInspection);
    await expect(fixture.listener(sender, {
      action: "failNextRuntimeTabReload",
      tabId: TAB_ID,
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toBeUndefined();
    expect(fixture.input.failNextRuntimeTabReload).toHaveBeenCalledWith(
      WINDOW_ID,
      TAB_ID
    );
    await expect(fixture.listener(sender, {
      action: "focusMainWindow",
      token: TOKEN
    })).resolves.toBeUndefined();
    expect(fixture.input.focusMainWindow).toHaveBeenCalledOnce();
    await expect(fixture.listener(sender, {
      action: "showAppKitRuntimeTabMenu",
      tabId: TAB_ID,
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toBeUndefined();
    expect(fixture.input.showAppKitRuntimeTabMenu).toHaveBeenCalledWith(
      WINDOW_ID,
      TAB_ID
    );
    await expect(fixture.listener(sender, {
      action: "fullscreenToolbarRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(fullscreenToolbarInspection);
    await expect(fixture.listener(sender, {
      action: "gameWindowRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(gameWindowInspection);
    await expect(fixture.listener(sender, {
      action: "popupLifecycleJournal",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(popupLifecycleJournalInspection);
    await expect(fixture.listener(sender, {
      action: "runtimeTabReload",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(runtimeTabReloadInspection);
    await expect(fixture.listener(sender, {
      action: "workspaceWebRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(workspaceWebInspection);
    await expect(fixture.listener(sender, {
      action: "workspaceWebSecurityPolicy",
      token: TOKEN,
      windowId: WINDOW_ID
    })).resolves.toEqual(workspaceWebSecurityPolicyInspection);
    await expect(fixture.listener(sender, {
      action: "showAppKitRuntimeTabMenu",
      tabId: "not-a-tab",
      token: TOKEN,
      windowId: WINDOW_ID
    })).rejects.toThrow("request is invalid");
    await expect(fixture.listener(sender, {
      action: "retainedV22Precondition",
      token: TOKEN
    })).resolves.toEqual(precondition);
    await expect(fixture.listener(sender, {
      action: "rolePlaceholderRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    })).resolves.toEqual(rolePlaceholderInspection);
    await expect(fixture.listener(sender, {
      action: "roleSessionMigration",
      roleId: ROLE_ID,
      token: TOKEN
    })).resolves.toEqual(migrationInspection);
    await expect(fixture.listener(sender, {
      action: "roleSessionRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    })).resolves.toEqual(runtimeInspection);
    await expect(fixture.listener(sender, {
      action: "trustedInputRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    })).resolves.toEqual(trustedInputObservations);
    await expect(fixture.listener(sender, {
      action: "applicationLifecycleSignal",
      event: "suspend",
      token: TOKEN
    })).resolves.toEqual(lifecycleSignalReceipt);
    expect(fixture.input.readFullscreenToolbarRuntime).toHaveBeenCalledWith(WINDOW_ID);
    expect(fixture.input.readApplicationShortcutRuntime).toHaveBeenCalledWith(
      WINDOW_ID,
      sender.sender
    );
    expect(fixture.input.readDiagnosticsExportJournal).toHaveBeenCalledOnce();
    expect(fixture.input.readGameWindowRuntime).toHaveBeenCalledWith(WINDOW_ID);
    expect(fixture.input.readPopupLifecycleJournal).toHaveBeenCalledWith(WINDOW_ID);
    expect(fixture.input.readRuntimeTabReload).toHaveBeenCalledWith(WINDOW_ID);
    expect(fixture.input.readRetainedV22Precondition).toHaveBeenCalledOnce();
    expect(fixture.input.readRolePlaceholderRuntime).toHaveBeenCalledWith(ROLE_ID);
    expect(fixture.input.readRoleSessionMigration).toHaveBeenCalledWith(ROLE_ID);
    expect(fixture.input.readRoleSessionRuntime).toHaveBeenCalledWith(ROLE_ID);
    expect(fixture.input.readTrustedInputRuntime).toHaveBeenCalledWith(ROLE_ID);
    expect(fixture.input.signalApplicationLifecycle).toHaveBeenCalledWith("suspend");
    expect(fixture.input.readWorkspaceWebRuntime).toHaveBeenCalledWith(WINDOW_ID);
    expect(fixture.input.readWorkspaceWebSecurityPolicy).toHaveBeenCalledWith(WINDOW_ID);

    await expect(fixture.listener(sender, {
      action: "gameWindowRuntime",
      token: TOKEN,
      windowId: "not-a-window"
    })).rejects.toThrow("request is invalid");
    await expect(fixture.listener(sender, {
      action: "roleSessionMigration",
      roleId: "not-a-role",
      token: TOKEN
    })).rejects.toThrow("request is invalid");
    await expect(fixture.listener(sender, {
      action: "retainedV22Precondition",
      extra: true,
      token: TOKEN
    })).rejects.toThrow("request is invalid");
    fixture.registration.dispose();
  });

  it("fails closed for packaged apps, foreign senders, wrong tokens, and cross-platform targets", async () => {
    const cases = [
      registrationFixture({ isPackaged: () => true }),
      registrationFixture({ authorizeSenderUrl: () => false }),
      registrationFixture({ expectedSessionToken: () => "b".repeat(64) }),
      registrationFixture({ runtimeTarget: () => "chromium-v23-windows" })
    ];
    const expectedMessages = [
      /unavailable in packaged/u,
      /sender is unauthorized/u,
      /request is unauthorized/u,
      /does not match the host platform/u
    ];

    for (const [index, fixture] of cases.entries()) {
      await expect(fixture.listener(
        { sender: { getURL: () => "file:///renderer/index.html" } },
        {
          action: "showAppKitRuntimeTabMenu",
          tabId: TAB_ID,
          token: TOKEN,
          windowId: WINDOW_ID
        }
      )).rejects.toThrow(expectedMessages[index]);
      expect(fixture.input.showAppKitRuntimeTabMenu).not.toHaveBeenCalled();
      fixture.registration.dispose();
    }
  });

  it("exposes a frozen preload API over the E2E-only channel", async () => {
    const invoke = vi.fn(async (_channel: string, request: unknown) => {
      switch ((request as { action?: string }).action) {
        case "applicationShortcutRuntime":
          return applicationShortcutInspection;
        case "close":
          return { pid: 4242, status: "submitted" };
        case "diagnosticsExportJournal":
          return diagnosticsExportJournalInspection;
        case "failNextRuntimeTabReload":
          return undefined;
        case "focusMainWindow":
          return undefined;
        case "showAppKitRuntimeTabMenu":
          return undefined;
        case "retainedV22Precondition":
          return precondition;
        case "gameWindowRuntime":
          return gameWindowInspection;
        case "fullscreenToolbarRuntime":
          return fullscreenToolbarInspection;
        case "popupLifecycleJournal":
          return popupLifecycleJournalInspection;
        case "runtimeTabReload":
          return runtimeTabReloadInspection;
        case "roleSessionMigration":
          return migrationInspection;
        case "rolePlaceholderRuntime":
          return rolePlaceholderInspection;
        case "roleSessionRuntime":
          return runtimeInspection;
        case "applicationLifecycleSignal":
          return lifecycleSignalReceipt;
        case "trustedInputRuntime":
          return trustedInputObservations;
        case "workspaceWebRuntime":
          return workspaceWebInspection;
        case "workspaceWebSecurityPolicy":
          return workspaceWebSecurityPolicyInspection;
        default:
          return {
            bridgeVersion: 1,
            chromeVersion: "128.0.0.0",
            driver: "electron",
            electronVersion: "32.0.0",
            packaged: false,
            platform: "windows",
            processId: 4242,
            runtimeTarget: "chromium-v23-windows"
          };
      }
    });
    const api = createElectronDesktopE2ePreloadApi({ invoke });

    expect(Object.isFrozen(api)).toBe(true);
    await expect(api.probe(TOKEN)).resolves.toMatchObject({
      platform: "windows",
      runtimeTarget: "chromium-v23-windows"
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "probe",
      token: TOKEN
    });
    await expect(api.applicationShortcutRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(applicationShortcutInspection);
    await expect(api.close(TOKEN)).resolves.toEqual({ pid: 4242, status: "submitted" });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "close",
      token: TOKEN
    });
    await expect(api.diagnosticsExportJournal(TOKEN))
      .resolves.toEqual(diagnosticsExportJournalInspection);
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "diagnosticsExportJournal",
      token: TOKEN
    });
    await expect(api.failNextRuntimeTabReload(TOKEN, WINDOW_ID, TAB_ID))
      .resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "failNextRuntimeTabReload",
      tabId: TAB_ID,
      token: TOKEN,
      windowId: WINDOW_ID
    });
    await expect(api.focusMainWindow(TOKEN)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "focusMainWindow",
      token: TOKEN
    });
    await expect(api.showAppKitRuntimeTabMenu(TOKEN, WINDOW_ID, TAB_ID))
      .resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "showAppKitRuntimeTabMenu",
      tabId: TAB_ID,
      token: TOKEN,
      windowId: WINDOW_ID
    });
    await expect(api.gameWindowRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(gameWindowInspection);
    await expect(api.fullscreenToolbarRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(fullscreenToolbarInspection);
    await expect(api.popupLifecycleJournal(TOKEN, WINDOW_ID))
      .resolves.toEqual(popupLifecycleJournalInspection);
    await expect(api.runtimeTabReload(TOKEN, WINDOW_ID))
      .resolves.toEqual(runtimeTabReloadInspection);
    await expect(api.retainedV22Precondition(TOKEN)).resolves.toEqual(precondition);
    await expect(api.roleSessionMigration(TOKEN, ROLE_ID))
      .resolves.toEqual(migrationInspection);
    await expect(api.rolePlaceholderRuntime(TOKEN, ROLE_ID))
      .resolves.toEqual(rolePlaceholderInspection);
    await expect(api.roleSessionRuntime(TOKEN, ROLE_ID))
      .resolves.toEqual(runtimeInspection);
    await expect(api.applicationLifecycleSignal(TOKEN, "suspend"))
      .resolves.toEqual(lifecycleSignalReceipt);
    await expect(api.trustedInputRuntime(TOKEN, ROLE_ID))
      .resolves.toEqual(trustedInputObservations);
    await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(workspaceWebInspection);
    await expect(api.workspaceWebSecurityPolicy(TOKEN, WINDOW_ID))
      .resolves.toEqual(workspaceWebSecurityPolicyInspection);
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "applicationShortcutRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "fullscreenToolbarRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "gameWindowRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "popupLifecycleJournal",
      token: TOKEN,
      windowId: WINDOW_ID
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "retainedV22Precondition",
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "rolePlaceholderRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "roleSessionMigration",
      roleId: ROLE_ID,
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "roleSessionRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "applicationLifecycleSignal",
      event: "suspend",
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "trustedInputRuntime",
      roleId: ROLE_ID,
      token: TOKEN
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "workspaceWebRuntime",
      token: TOKEN,
      windowId: WINDOW_ID
    });
    expect(invoke).toHaveBeenCalledWith(ELECTRON_DESKTOP_E2E_CHANNEL, {
      action: "workspaceWebSecurityPolicy",
      token: TOKEN,
      windowId: WINDOW_ID
    });
  });

  it("rejects forged Workspace Web permission and download deny evidence", async () => {
    const observations = workspaceWebSecurityPolicyInspection.observations;
    for (const candidate of [
      {
        ...workspaceWebSecurityPolicyInspection,
        sessionStoragePath: "/tmp/forged/web-profiles/global-web/chromium"
      },
      {
        ...workspaceWebSecurityPolicyInspection,
        observations: [{ ...observations[0], callback: true }]
      },
      {
        ...workspaceWebSecurityPolicyInspection,
        observations: [{ ...observations[1], defaultPrevented: false }]
      },
      {
        ...workspaceWebSecurityPolicyInspection,
        observations: [observations[1], observations[0]]
      }
    ]) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.workspaceWebSecurityPolicy(TOKEN, WINDOW_ID))
        .rejects.toThrow("security-policy inspection is invalid");
    }
  });

  it("rejects forged diagnostics cancellation and Core-invocation evidence", async () => {
    const observation = diagnosticsExportJournalInspection.observations[0]!;
    for (const candidate of [
      { ...diagnosticsExportJournalInspection, capacity: 31 },
      {
        ...diagnosticsExportJournalInspection,
        observations: [{
          ...observation,
          coreDiagnosticsExportInvocationCount: 1
        }]
      },
      {
        ...diagnosticsExportJournalInspection,
        observations: [{ ...observation, typedOutcome: "diagnosticExportResult" }]
      },
      {
        ...diagnosticsExportJournalInspection,
        observations: [observation, { ...observation, sequence: 3 }]
      }
    ]) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.diagnosticsExportJournal(TOKEN))
        .rejects.toThrow("diagnostics-export journal is invalid");
    }
  });

  it("rejects forged popup terminal receipts and parent-generation fences", async () => {
    const observations = popupLifecycleJournalInspection.observations;
    const terminal = observations[2]!;
    for (const candidate of [
      { ...popupLifecycleJournalInspection, capacity: 255 },
      {
        ...popupLifecycleJournalInspection,
        observations: [
          observations[0],
          observations[1],
          { ...terminal, operationTerminal: false }
        ]
      },
      {
        ...popupLifecycleJournalInspection,
        observations: [
          observations[0],
          {
            ...observations[1],
            parent: { ...popupParent, ownerNativeGeneration: 99 }
          }
        ]
      },
      {
        ...popupLifecycleJournalInspection,
        observations: [
          observations[0],
          observations[1],
          { ...terminal, completionScope: "stateCommit" }
        ]
      }
    ]) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.popupLifecycleJournal(TOKEN, WINDOW_ID))
        .rejects.toThrow("popup lifecycle journal is invalid");
    }
  });

  it("rejects forged Workspace Web session and paired native readback evidence", async () => {
    const forged = [
      {
        ...workspaceWebInspection,
        web: { ...workspaceWebInspection.web, chromeShellStoragePath: "/tmp/forged" }
      },
      {
        ...workspaceWebInspection,
        web: {
          ...workspaceWebInspection.web,
          contentSessionStoragePath: "/tmp/forged/web-profiles/global-web/chromium"
        }
      },
      {
        ...workspaceWebInspection,
        web: {
          ...workspaceWebInspection.web,
          contentBounds: { ...workspaceWebInspection.web.contentBounds, y: 75 }
        }
      },
      {
        ...workspaceWebInspection,
        coreSlots: workspaceWebInspection.coreSlots.map((slot) =>
          slot.web ? { ...slot, web: { ...slot.web, startUrl: "file:///forged" } } : slot
        )
      },
      {
        ...workspaceWebInspection,
        coreSlots: workspaceWebInspection.coreSlots.map((slot) =>
          slot.web ? { ...slot, id: " " } : slot
        )
      },
      { ...workspaceWebInspection, unexpected: true }
    ];
    for (const candidate of forged) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID))
        .rejects.toThrow("Workspace Web inspection is invalid");
    }
  });

  it("accepts Workspace Web evidence after visible navigation changes the content URL", async () => {
    const navigated = {
      ...workspaceWebInspection,
      phase: "degraded",
      web: {
        ...workspaceWebInspection.web,
        contentUrl: "http://127.0.0.1:1/rion-navigation-failure"
      }
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => navigated)
    });

    await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID)).resolves.toEqual(navigated);
  });

  it("accepts a Workspace tab whose shared AppKit host predates its attempt", async () => {
    const mixedWindow = {
      ...workspaceWebInspection,
      appKitIdentity: {
        ...workspaceWebInspection.appKitIdentity,
        launchGeneration: WINDOW_LAUNCH_ID
      }
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => mixedWindow)
    });

    await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(mixedWindow);
  });

  it("accepts an exact one-slot Web-only runtime without inventing a Role", async () => {
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => webOnlyWorkspaceInspection)
    });

    await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(webOnlyWorkspaceInspection);
    for (const candidate of [
      { ...webOnlyWorkspaceInspection, role: workspaceWebInspection.role },
      { ...workspaceWebInspection, role: null },
      {
        ...webOnlyWorkspaceInspection,
        coreSlots: [{
          ...webOnlyWorkspaceInspection.coreSlots[0],
          roleId: ROLE_ID
        }]
      }
    ]) {
      const forged = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(forged.workspaceWebRuntime(TOKEN, WINDOW_ID))
        .rejects.toThrow("Workspace Web inspection is invalid");
    }
  });

  it("accepts exact popup logical ownership and rejects a mismatched popup scope", async () => {
    const logicalWindowId = `popup-${POPUP_ID}`;
    const popup = Object.freeze({
      appKitIdentity: Object.freeze({
        launchGeneration: POPUP_OPEN_OPERATION_ID,
        logicalWindowId,
        nativeGeneration: 1
      }),
      bounds: Object.freeze({ height: 640, width: 960, x: 100, y: 80 }),
      hostKind: "appkit-chromium" as const,
      logicalWindowId,
      nativeHostId: 42,
      openOperationId: POPUP_OPEN_OPERATION_ID,
      popupId: POPUP_ID,
      presentation: "normal" as const,
      topologyRevision: 1,
      visible: true,
      windowGeneration: 1
    });
    const inspection = Object.freeze({
      ...workspaceWebInspection,
      popups: Object.freeze([popup])
    });
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => inspection)
    });
    await expect(api.workspaceWebRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(inspection);

    const mismatchedLogicalWindowId = `popup-${TARGET_TAB_ID}`;
    const forged = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => ({
        ...inspection,
        popups: [{
          ...popup,
          appKitIdentity: {
            ...popup.appKitIdentity,
            logicalWindowId: mismatchedLogicalWindowId
          },
          logicalWindowId: mismatchedLogicalWindowId
        }]
      }))
    });
    await expect(forged.workspaceWebRuntime(TOKEN, WINDOW_ID))
      .rejects.toThrow("invalid popup");
  });

  it("rejects forged Role-placeholder owner and retained-host fences", async () => {
    for (const candidate of [
      {
        ...rolePlaceholderInspection,
        coreOwner: { ...rolePlaceholderInspection.coreOwner, generation: 6 }
      },
      {
        ...rolePlaceholderInspection,
        coreStatus: { ...rolePlaceholderInspection.coreStatus, issueReason: "forged" }
      },
      {
        ...rolePlaceholderInspection,
        nativeOwner: { ...rolePlaceholderInspection.nativeOwner, windowId: TARGET_WINDOW_ID }
      },
      {
        ...rolePlaceholderInspection,
        placeholders: [{
          ...rolePlaceholderInspection.placeholders[0],
          shellStoragePath: "/tmp/persistent"
        }]
      },
      {
        ...rolePlaceholderInspection,
        placeholders: [{
          ...rolePlaceholderInspection.placeholders[0],
          appKitIdentity: null
        }]
      },
      {
        ...rolePlaceholderInspection,
        placeholders: [{
          ...rolePlaceholderInspection.placeholders[0],
          appKitIdentity: {
            ...rolePlaceholderInspection.placeholders[0]!.appKitIdentity,
            launchGeneration: "forged"
          }
        }]
      }
    ]) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.rolePlaceholderRuntime(TOKEN, ROLE_ID))
        .rejects.toThrow("Role placeholder inspection is invalid");
    }
  });

  it("rejects forged lifecycle terminals and trusted-input observations", async () => {
    const forgedLifecycle = [
      { ...lifecycleSignalReceipt, event: "resume" },
      { ...lifecycleSignalReceipt, terminal: {
        ...lifecycleSignalReceipt.terminal,
        lifecycleEpoch: 1
      } },
      { ...lifecycleSignalReceipt, terminal: {
        ...lifecycleSignalReceipt.terminal,
        state: "active"
      } },
      { ...lifecycleSignalReceipt, unexpected: true }
    ];
    for (const candidate of forgedLifecycle) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.applicationLifecycleSignal(TOKEN, "suspend"))
        .rejects.toThrow("lifecycle signal receipt is invalid");
    }

    const original = trustedInputObservations[0]!;
    const forgedTrustedInput = [
      [{ ...original, sequence: 2 }],
      [{ ...original, receipt: { ...original.receipt, roleId: WINDOW_ID } }],
      [{ ...original, request: {
        ...original.request,
        action: { ...original.request.action, phase: "forged" }
      } }],
      [{ ...original, receipt: { ...original.receipt, unexpected: true } }]
    ];
    for (const candidate of forgedTrustedInput) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.trustedInputRuntime(TOKEN, ROLE_ID))
        .rejects.toThrow("trusted-input observation");
    }
  });

  it("accepts a trusted-input observation fenced to the exact Chromium document", async () => {
    const original = trustedInputObservations[0]!;
    const exact = [{
      ...original,
      request: {
        ...original.request,
        documentInstanceId: "document-instance-1",
        surfaceGeneration: 3
      }
    }];
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => exact)
    });

    await expect(api.trustedInputRuntime(TOKEN, ROLE_ID)).resolves.toEqual(exact);
  });

  it("rejects forged runtime ownership evidence in the isolated preload parser", async () => {
    const forged = [
      {
        ...runtimeInspection,
        currentRuntime: {
          ...runtimeInspection.currentRuntime,
          hostKind: "bundled-chromium"
        }
      },
      {
        ...runtimeInspection,
        latestSessionEnsure: {
          ...runtimeInspection.latestSessionEnsure,
          sessionStoragePath: "/tmp/forged/chromium"
        }
      },
      {
        ...runtimeInspection,
        latestSessionEnsure: {
          ...runtimeInspection.latestSessionEnsure,
          sessionStoragePathSha256: "c".repeat(64)
        }
      },
      {
        ...runtimeInspection,
        currentRuntime: {
          ...runtimeInspection.currentRuntime,
          appKitIdentity: {
            ...runtimeInspection.currentRuntime.appKitIdentity!,
            launchGeneration: "forged"
          }
        }
      }
    ];
    for (const candidate of forged) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.roleSessionRuntime(TOKEN, ROLE_ID))
        .rejects.toThrow("runtime inspection is invalid");
    }
  });

  it("rejects forged Game Window Core/native ownership evidence", async () => {
    const forged = [
      {
        ...gameWindowInspection,
        currentRuntime: {
          ...gameWindowInspection.currentRuntime,
          hostKind: "bundled-chromium"
        }
      },
      {
        ...gameWindowInspection,
        currentRuntime: {
          ...gameWindowInspection.currentRuntime,
          nativeTabIds: [TAB_ID]
        }
      },
      {
        ...gameWindowInspection,
        currentRuntime: {
          ...gameWindowInspection.currentRuntime,
          focused: "yes"
        }
      },
      {
        ...gameWindowInspection,
        currentRuntime: {
          ...gameWindowInspection.currentRuntime,
          nativeDisplay: {
            ...gameWindowInspection.currentRuntime.nativeDisplay,
            scaleFactor: 0
          }
        }
      },
      {
        ...gameWindowInspection,
        currentRuntime: {
          ...gameWindowInspection.currentRuntime,
          windowId: ROLE_ID
        }
      }
    ];
    for (const candidate of forged) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.gameWindowRuntime(TOKEN, WINDOW_ID))
        .rejects.toThrow("Game Window runtime inspection is invalid");
    }
  });

  it("rejects forged application-shortcut receipts, factors, and native identity", async () => {
    const observation = applicationShortcutInspection.zoomJournal.observations[0]!;
    const forged = [
      {
        ...applicationShortcutInspection,
        nativeWindow: {
          ...applicationShortcutInspection.nativeWindow,
          windowZoomFactor: 1.1
        }
      },
      {
        ...applicationShortcutInspection,
        coreWindow: {
          ...applicationShortcutInspection.coreWindow,
          topologyRevision: 9
        }
      },
      {
        ...applicationShortcutInspection,
        roleSurfaces: [{
          ...applicationShortcutInspection.roleSurfaces[0],
          appliedZoomFactor: 1
        }]
      },
      {
        ...applicationShortcutInspection,
        popupSurfaces: [{ popupId: POPUP_ID }]
      },
      {
        ...applicationShortcutInspection,
        zoomJournal: {
          ...applicationShortcutInspection.zoomJournal,
          observations: [{
            ...observation,
            receipt: { ...observation.receipt, windowId: TARGET_WINDOW_ID }
          }]
        }
      },
      {
        ...applicationShortcutInspection,
        zoomJournal: {
          ...applicationShortcutInspection.zoomJournal,
          observations: [{ ...observation, sequence: 0 }]
        }
      },
      {
        ...applicationShortcutInspection,
        zoomJournal: {
          ...applicationShortcutInspection.zoomJournal,
          observations: [
            observation,
            { ...observation, sequence: 3 }
          ]
        }
      },
      {
        ...applicationShortcutInspection,
        nativeWindow: {
          ...applicationShortcutInspection.nativeWindow,
          appKitIdentity: null
        }
      }
    ];
    for (const candidate of forged) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.applicationShortcutRuntime(TOKEN, WINDOW_ID))
        .rejects.toThrow("application-shortcut runtime inspection is invalid");
    }
  });

  it("accepts equal direct Core/native factors before the first zoom receipt", async () => {
    const initial = {
      ...applicationShortcutInspection,
      coreWindow: {
        ...applicationShortcutInspection.coreWindow,
        windowZoomFactor: 1
      },
      nativeWindow: {
        ...applicationShortcutInspection.nativeWindow,
        windowZoomFactor: 1
      },
      roleSurfaces: [{
        ...applicationShortcutInspection.roleSurfaces[0],
        appliedZoomFactor: 1
      }],
      zoomJournal: {
        ...applicationShortcutInspection.zoomJournal,
        observations: []
      }
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => initial)
    });

    await expect(api.applicationShortcutRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(initial);
  });

  it("prunes old-generation zoom receipts without resetting the window sequence", () => {
    const journal = new ElectronDesktopE2eWindowZoomJournal();
    const receipt = applicationShortcutInspection.zoomJournal.observations[0]!.receipt;
    journal.append({ ...receipt });

    expect(journal.read(WINDOW_ID, 3)).toEqual([]);

    journal.append({
      ...receipt,
      operationId: "10000000-0000-4000-8000-000000000014",
      sourceTopologyRevision: 9,
      topologyRevision: 10,
      windowGeneration: 3
    });
    expect(journal.read(WINDOW_ID, 3)).toEqual([expect.objectContaining({
      receipt: expect.objectContaining({ windowGeneration: 3 }),
      sequence: 2
    })]);
  });

  it("rejects forged fullscreen-toolbar native evidence", async () => {
    const forged = [
      {
        ...fullscreenToolbarInspection,
        native: {
          ...fullscreenToolbarInspection.native,
          nativeControlsVisible: false
        }
      },
      {
        ...fullscreenToolbarInspection,
        native: {
          ...fullscreenToolbarInspection.native,
          appKit: {
            ...fullscreenToolbarInspection.native.appKit,
            accessoryOnScreen: "yes"
          }
        }
      },
      {
        ...fullscreenToolbarInspection,
        surfaces: [{
          ...fullscreenToolbarInspection.surfaces[0],
          tabId: ROLE_ID
        }]
      },
      {
        ...fullscreenToolbarInspection,
        unexpected: true
      }
    ];
    for (const candidate of forged) {
      const api = createElectronDesktopE2ePreloadApi({
        invoke: vi.fn(async () => candidate)
      });
      await expect(api.fullscreenToolbarRuntime(TOKEN, WINDOW_ID))
        .rejects.toThrow("fullscreen-toolbar inspection is invalid");
    }
  });

  it("accepts the canonical workspace Web surface identity", async () => {
    const candidate = {
      ...fullscreenToolbarInspection,
      surfaces: [
        ...fullscreenToolbarInspection.surfaces,
        {
          bounds: { height: 642, width: 320, x: 640, y: 38 },
          generation: 1,
          id: `web-${TAB_ID}-1`,
          kind: "web" as const,
          tabId: TAB_ID,
          visible: false
        }
      ]
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => candidate)
    });

    await expect(api.fullscreenToolbarRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(candidate);
  });

  it("accepts AppKit anchors for only the visible logical tabs", async () => {
    const candidate = {
      ...fullscreenToolbarInspection,
      native: {
        ...fullscreenToolbarInspection.native,
        appKit: {
          ...fullscreenToolbarInspection.native.appKit,
          tabAnchors: { [TAB_ID]: { x: 320, y: 20 } }
        }
      },
      tabIds: [TAB_ID, ROLE_ID]
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => candidate)
    });

    await expect(api.fullscreenToolbarRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(candidate);
  });

  it("accepts a pinned normal AppKit toolbar independently of fullscreen policy", async () => {
    const inspection = {
      ...fullscreenToolbarInspection,
      native: {
        ...fullscreenToolbarInspection.native,
        alwaysShowToolbarInFullScreen: false,
        appKit: {
          ...fullscreenToolbarInspection.native.appKit,
          fullscreenHostReady: false,
          toolbarPinned: true
        },
        fullscreen: false
      },
      presentation: "normal" as const
    };
    const api = createElectronDesktopE2ePreloadApi({
      invoke: vi.fn(async () => inspection)
    });

    await expect(api.fullscreenToolbarRuntime(TOKEN, WINDOW_ID))
      .resolves.toEqual(inspection);
  });

  it("prepares WebDriver close only after the same target and session fences", async () => {
    const prepareQuit = vi.fn(async () => undefined);
    const requestQuit = vi.fn();
    const fixture = registrationFixture({ prepareQuit, requestQuit });

    await expect(fixture.listener(
      { sender: { getURL: () => "file:///renderer/index.html" } },
      { action: "close", token: TOKEN }
    )).resolves.toEqual({ pid: 4242, status: "submitted" });
    expect(prepareQuit).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestQuit).toHaveBeenCalledOnce();
    fixture.registration.dispose();
  });

  it("does not prepare WebDriver close when the authoritative final flush fails", async () => {
    const prepareQuit = vi.fn(async () => {
      throw new Error("final flush failed");
    });
    const requestQuit = vi.fn();
    const fixture = registrationFixture({ prepareQuit, requestQuit });

    await expect(fixture.listener(
      { sender: { getURL: () => "file:///renderer/index.html" } },
      { action: "close", token: TOKEN }
    )).rejects.toThrow("final flush failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestQuit).not.toHaveBeenCalled();
    fixture.registration.dispose();
  });
  it("keeps the retained-v22 mutation entry E2E-only and outside product addon surfaces", async () => {
    const [e2eMain, productionMain, productionPreload, nodeAddon, viteConfig] =
      await Promise.all([
      readFile("src/electron/e2e/index.ts", "utf8"),
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/preload/index.ts", "utf8"),
      readFile("crates/rion-node/src/lib.rs", "utf8"),
      readFile("electron.vite.config.ts", "utf8")
      ]);

    expect(e2eMain).toContain("runtimeContractVersion: 22");
    expect(e2eMain).toContain("seedRetainedV22Role");
    expect(e2eMain).toContain('await import("../main/index")');
    expect(productionMain).not.toContain("retainedV22Precondition");
    expect(productionMain).not.toContain("diagnosticsExportJournal");
    expect(productionMain).not.toContain("../e2e");
    expect(productionPreload).not.toContain("retainedV22Precondition");
    expect(productionPreload).not.toContain("diagnosticsExportJournal");
    expect(productionPreload).not.toContain("../e2e");
    expect(nodeAddon).not.toContain("retainedV22Precondition");
    expect(nodeAddon).not.toContain("seedRetainedV22Role");
    expect(viteConfig).toContain('codeSplitting: false, format: "es" as const');
  });
});
