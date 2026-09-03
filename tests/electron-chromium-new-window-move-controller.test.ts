import { describe, expect, it, vi } from "vitest";

import {
  ChromiumNewWindowMoveController
} from "../src/electron/main/chromiumNewWindowMoveController";
import type { ElectronCoreCommandPort } from
  "../src/electron/main/coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";
import type { MacosAppKitRuntimeHostFactoryPort } from
  "../src/electron/main/chromiumRuntimeHostFactory";
import type { MacosAppKitRendererActionPort } from
  "../src/electron/main/macosAppKitRuntimeEventBridge";
import type {
  AppKitRuntimeEventReceiptRecord,
  AppKitRuntimeHostObservationRecord,
  CoreAppSnapshotRecord,
  CoreCommand,
  GameWindowTabRecord,
  RuntimeWindowProvisionReceiptRecord,
  RuntimeWindowProvisionTargetRecord,
  SystemRuntimeOperationStatus,
  SystemRuntimeOperationSummaryRecord
} from "../src/shared/generated";

const SOURCE_WINDOW_ID = "source-window";
const TARGET_WINDOW_ID = "target-window";
const TAB_ID = "tab-one";
const SECOND_TAB_ID = "tab-two";
const CAPTURED_AT = "2026-08-30T12:00:00.000Z";
const BOUNDS = { x: 100, y: 80, width: 900, height: 640 };
const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 };

function tab(id: string, hidden = false): GameWindowTabRecord {
  return {
    id,
    tabType: "role",
    sourceId: "role-" + id,
    name: "Role " + id,
    roleSlots: [],
    hidden,
    audioMuted: false
  };
}

function proposedTarget(): RuntimeWindowProvisionTargetRecord {
  return {
    persistedName: "Detached",
    displayId: 41,
    scaleFactor: 2,
    bounds: { ...BOUNDS },
    workArea: { ...WORK_AREA },
    presentation: "normal"
  };
}

function emptySnapshot(tabs: GameWindowTabRecord[]): CoreAppSnapshotRecord {
  return {
    revision: 1,
    stateRevision: 1,
    runtimeRevision: 1,
    state: {
      revision: 1,
      games: [],
      roles: [],
      launchWorkspaces: [],
      gameWindows: [],
      macros: []
    },
    browserRuntime: {
      windows: [],
      roles: [],
      tabs: [],
      workspaces: []
    },
    logicalWindows: [{
      windowId: SOURCE_WINDOW_ID,
      windowGeneration: 3,
      revision: 8,
      windowZoomFactor: 1,
      tabs: structuredClone(tabs),
      activeTabId: tabs[0]?.id
    }],
    roleStatuses: [],
    macroStatuses: []
  };
}

function nativeWindow(
  windowId: string,
  tabIds: readonly string[],
  windowGeneration: number,
  topologyRevision: number
): ChromiumRuntimeExecutorSnapshot["windows"][number] {
  return {
    windowId,
    activeTabId: tabIds[0] ?? "",
    tabIds: [...tabIds],
    displayId: 41,
    bounds: { ...BOUNDS },
    visible: false,
    focused: false,
    presentation: "normal",
    windowGeneration,
    topologyRevision
  };
}

function summary(
  operationId: string,
  windowId: string,
  generation: number,
  revision: number,
  status: SystemRuntimeOperationStatus = "applied"
): SystemRuntimeOperationSummaryRecord {
  return {
    acceptedAt: CAPTURED_AT,
    capturedAt: CAPTURED_AT,
    completionPolicy: "eventBound",
    platform: "windows",
    subsystem: "drag",
    status,
    stage: status === "applied" ? "projectionApplied" : "projectionSuperseded",
    completionScope: "dragCommitted",
    operationId,
    trigger: "embeddedTabMove",
    elapsedMs: 0,
    windowId,
    windowGeneration: generation,
    revision,
    topologyRevision: revision,
    tabId: TAB_ID,
    ...(status === "applied" ? {} : { failureCode: "RUNTIME_UI_ACTION_STALE" })
  };
}

class MoveHarness {
  readonly coreSnapshot: CoreAppSnapshotRecord;
  readonly nativeSnapshot: {
    windows: Array<ChromiumRuntimeExecutorSnapshot["windows"][number]>;
    tabs: [];
    roles: [];
    webSurfaces: [];
  };
  readonly commands: CoreCommand[] = [];
  readonly targetResolver = vi.fn(async () => proposedTarget());
  readonly captureHostObservations = vi.fn((windowIds: readonly string[]) =>
    windowIds.map((windowId) => this.observation(windowId))
  );
  readonly quarantineHost = vi.fn();
  readonly appKitMove = vi.fn(async (
    _hosts: readonly AppKitRuntimeHostObservationRecord[],
    input: Parameters<MacosAppKitRendererActionPort["moveTab"]>[1]
  ) => {
    this.move(input.sourceWindowId, input.targetWindowId, input.tabId, input.beforeTabId);
    const target = this.logical(input.targetWindowId);
    return this.appKitReceipt(target.windowGeneration, target.revision);
  });
  readonly appKitSetHidden = vi.fn(async (
    _hosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    hidden: boolean
  ) => {
    for (const window of this.coreSnapshot.logicalWindows) {
      const exact = window.tabs.find((candidate) => candidate.id === tabId);
      if (exact) exact.hidden = hidden;
    }
    const owner = this.coreSnapshot.logicalWindows.find(
      (window) => window.tabs.some((candidate) => candidate.id === tabId)
    )!;
    return this.appKitReceipt(owner.windowGeneration, owner.revision);
  });
  provision: RuntimeWindowProvisionReceiptRecord | null = null;
  displayScaleFactor = 2;
  failSave = false;
  moveStatus: SystemRuntimeOperationStatus = "applied";

  constructor(
    readonly platform: "darwin" | "win32",
    sourceTabs: GameWindowTabRecord[]
  ) {
    this.coreSnapshot = emptySnapshot(sourceTabs);
    this.nativeSnapshot = {
      windows: [nativeWindow(
        SOURCE_WINDOW_ID,
        sourceTabs.map((item) => item.id),
        3,
        8
      )],
      tabs: [],
      roles: [],
      webSurfaces: []
    };
  }

  readonly invoke = async (command: CoreCommand): Promise<unknown> => {
    this.commands.push(structuredClone(command));
    switch (command.type) {
      case "appSnapshot":
        return structuredClone(this.coreSnapshot);
      case "embeddedWindowProvisionResume":
        if (this.provision && this.provision.operationId === command.operationId) {
          if (command.tabId !== TAB_ID) throw new Error("operation reused");
          return structuredClone(this.provision);
        }
        return null;
      case "embeddedWindowProvisionForTabMove": {
        this.provision = {
          operationId: command.operationId,
          sourceWindowId: command.sourceWindowId,
          target: {
            windowId: TARGET_WINDOW_ID,
            ...structuredClone(command.target)
          },
          windowGeneration: 11,
          topologyRevision: 12
        };
        this.coreSnapshot.logicalWindows.push({
          windowId: TARGET_WINDOW_ID,
          windowGeneration: 11,
          revision: 12,
          windowZoomFactor: 1,
          tabs: []
        });
        this.nativeSnapshot.windows.push(
          nativeWindow(TARGET_WINDOW_ID, [], 11, 12)
        );
        return structuredClone(this.provision);
      }
      case "embeddedTabMove": {
        if (this.moveStatus !== "applied") {
          return summary(
            command.operationId,
            command.targetWindowId,
            command.targetWindowGeneration,
            command.targetTopologyRevision,
            this.moveStatus
          );
        }
        this.move(
          command.sourceWindowId,
          command.targetWindowId,
          command.tabId,
          command.beforeTabId
        );
        const target = this.logical(command.targetWindowId);
        return summary(
          command.operationId,
          target.windowId,
          target.windowGeneration,
          target.revision
        );
      }
      case "gameWindowSaveRuntime": {
        if (this.failSave) {
          this.failSave = false;
          throw new Error("persistence failed");
        }
        const saved = {
          id: command.input.windowId,
          name: command.input.name,
          targetDisplay: structuredClone(command.input.targetDisplay),
          placement: structuredClone(command.input.placement),
          tabs: structuredClone(command.input.tabs),
          ...(command.input.activeTabId === undefined
            ? {}
            : { activeTabId: command.input.activeTabId }),
          createdAt: CAPTURED_AT,
          updatedAt: CAPTURED_AT
        };
        const prior = this.coreSnapshot.state.gameWindows.findIndex(
          (window) => window.id === saved.id
        );
        if (prior < 0) this.coreSnapshot.state.gameWindows.push(saved);
        else this.coreSnapshot.state.gameWindows[prior] = saved;
        return structuredClone(saved);
      }
      case "embeddedWindowRetireProvision": {
        const logical = this.logical(command.windowId);
        if (logical.tabs.length !== 0) throw new Error("retire nonempty");
        this.coreSnapshot.logicalWindows = this.coreSnapshot.logicalWindows.filter(
          (window) => window.windowId !== command.windowId
        );
        this.nativeSnapshot.windows = this.nativeSnapshot.windows.filter(
          (window) => window.windowId !== command.windowId
        );
        return { retired: true };
      }
      case "embeddedTabHide": {
        const owner = this.logical(command.windowId);
        owner.tabs.find((candidate) => candidate.id === command.tabId)!.hidden =
          command.hidden;
        return summary(
          command.operationId,
          owner.windowId,
          owner.windowGeneration,
          owner.revision
        );
      }
      case "embeddedWindowsShow": {
        const native = this.native(command.windowId!);
        Object.assign(native, { visible: true, focused: true });
        return structuredClone(this.coreSnapshot.browserRuntime);
      }
      default:
        throw new Error("Unexpected Core command: " + command.type);
    }
  };

  controller(): ChromiumNewWindowMoveController {
    const appKit = this.platform === "darwin"
      ? {
          factory: {
            nativeHostKind: "rust-napi-appkit",
            captureHostObservations: this.captureHostObservations,
            quarantineHost: this.quarantineHost
          } as unknown as MacosAppKitRuntimeHostFactoryPort,
          events: {
            moveTab: this.appKitMove,
            setTabHidden: this.appKitSetHidden
          } as unknown as MacosAppKitRendererActionPort
        }
      : undefined;
    return new ChromiumNewWindowMoveController({
      platform: this.platform,
      core: { invoke: this.invoke } as unknown as ElectronCoreCommandPort,
      readDisplayTopology: () => ({
        revision: 1,
        capturedAt: CAPTURED_AT,
        cause: "electron-initial",
        primaryDisplayId: "41",
        displays: [{
          id: 41,
          label: "Built-in Display",
          bounds: { ...WORK_AREA },
          workArea: { ...WORK_AREA },
          resolution: { width: 2880, height: 1800 },
          scaleFactor: this.displayScaleFactor,
          isPrimary: true,
          isInternal: true
        }]
      }),
      readNativeSnapshot: () => structuredClone(this.nativeSnapshot),
      targets: { resolve: this.targetResolver },
      ...(appKit === undefined ? {} : { appKit })
    });
  }

  logical(windowId: string) {
    const window = this.coreSnapshot.logicalWindows.find(
      (candidate) => candidate.windowId === windowId
    );
    if (!window) throw new Error("missing logical window " + windowId);
    return window;
  }

  native(windowId: string) {
    const window = this.nativeSnapshot.windows.find(
      (candidate) => candidate.windowId === windowId
    );
    if (!window) throw new Error("missing native window " + windowId);
    return window;
  }

  move(
    sourceWindowId: string,
    targetWindowId: string,
    tabId: string,
    beforeTabId?: string
  ): void {
    const source = this.logical(sourceWindowId);
    const target = this.logical(targetWindowId);
    const sourceIndex = source.tabs.findIndex((candidate) => candidate.id === tabId);
    const [moved] = source.tabs.splice(sourceIndex, 1);
    if (!moved) throw new Error("missing tab " + tabId);
    const targetIndex = beforeTabId === undefined
      ? target.tabs.length
      : target.tabs.findIndex((candidate) => candidate.id === beforeTabId);
    target.tabs.splice(targetIndex < 0 ? target.tabs.length : targetIndex, 0, moved);
    source.activeTabId = source.tabs[0]?.id;
    target.activeTabId = tabId;
    source.revision += 1;
    target.revision += 1;

    const sourceNative = this.native(sourceWindowId);
    const targetNative = this.native(targetWindowId);
    const nativeSourceIndex = sourceNative.tabIds.indexOf(tabId);
    const sourceIds = [...sourceNative.tabIds];
    sourceIds.splice(nativeSourceIndex, 1);
    const targetIds = [...targetNative.tabIds];
    const nativeTargetIndex = beforeTabId === undefined
      ? targetIds.length
      : targetIds.indexOf(beforeTabId);
    targetIds.splice(nativeTargetIndex < 0 ? targetIds.length : nativeTargetIndex, 0, tabId);
    Object.assign(sourceNative, {
      tabIds: sourceIds,
      activeTabId: sourceIds[0] ?? "",
      topologyRevision: source.revision
    });
    Object.assign(targetNative, {
      tabIds: targetIds,
      activeTabId: tabId,
      topologyRevision: target.revision
    });
  }

  observation(windowId: string): AppKitRuntimeHostObservationRecord {
    const logical = this.logical(windowId);
    const native = this.native(windowId);
    return {
      identity: {
        logicalWindowId: windowId,
        launchGeneration: "launch-" + windowId,
        nativeGeneration: 1
      },
      windowGeneration: logical.windowGeneration,
      topologyRevision: logical.revision,
      contentBounds: { x: 0, y: 40, width: 900, height: 600 },
      normalBounds: { ...BOUNDS },
      savedWorkArea: { ...WORK_AREA },
      targetDisplay: { id: 41 },
      presentation: "normal",
      focused: native.focused,
      minimized: false,
      visible: native.visible
    };
  }

  appKitReceipt(
    windowGeneration: number,
    topologyRevision: number
  ): AppKitRuntimeEventReceiptRecord {
    return {
      eventId: "appkit-event",
      adapterSequence: 1,
      status: "applied",
      topologyCommitted: true,
      nativeApplied: true,
      windowGeneration,
      topologyRevision
    };
  }
}

describe("Chromium Core-owned move to new window", () => {
  it("provisions, moves, persists, and replays a Windows cross-window move", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID), tab(SECOND_TAB_ID)]);
    const controller = harness.controller();

    const first = await controller.moveTabToNewWindow("move-one", TAB_ID);
    const duplicate = await controller.moveTabToNewWindow("move-one", TAB_ID);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      targetWindowId: TARGET_WINDOW_ID,
      receipt: { status: "applied" }
    });
    expect(harness.logical(SOURCE_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([SECOND_TAB_ID]);
    expect(harness.logical(TARGET_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([TAB_ID]);
    expect(harness.coreSnapshot.state.gameWindows[0]).toMatchObject({
      id: TARGET_WINDOW_ID,
      activeTabId: TAB_ID,
      targetDisplay: {
        id: 41,
        fingerprint: {
          label: "Built-in Display",
          scaleFactor: 2,
          isPrimary: true,
          isInternal: true
        }
      }
    });
    expect(harness.commands.filter(
      (command) => command.type === "embeddedWindowProvisionForTabMove"
    )).toHaveLength(1);
    expect(harness.commands.filter(
      (command) => command.type === "embeddedTabMove"
    )).toHaveLength(1);
    expect(harness.commands).toContainEqual({
      type: "embeddedWindowsShow",
      windowId: TARGET_WINDOW_ID
    });
    expect(harness.native(TARGET_WINDOW_ID)).toMatchObject({
      focused: true,
      visible: true
    });
  });

  it("retires the exact empty source after moving its last tab", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID)]);

    await harness.controller().moveTabToNewWindow("move-last", TAB_ID);

    expect(harness.coreSnapshot.logicalWindows.map((window) => window.windowId))
      .toEqual([TARGET_WINDOW_ID]);
    expect(harness.nativeSnapshot.windows.map((window) => window.windowId))
      .toEqual([TARGET_WINDOW_ID]);
  });

  it("rejects a stale generation before target resolution or provision", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID)]);
    harness.nativeSnapshot.windows[0] = {
      ...harness.native(SOURCE_WINDOW_ID),
      topologyRevision: 7
    };

    await expect(
      harness.controller().moveTabToNewWindow("move-stale", TAB_ID)
    ).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_NEW_WINDOW_FENCE_STALE"
    });
    expect(harness.targetResolver).not.toHaveBeenCalled();
    expect(harness.commands.some(
      (command) => command.type === "embeddedWindowProvisionForTabMove"
    )).toBe(false);
  });

  it("retires the empty target when Core supersedes the ownership move", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID)]);
    harness.moveStatus = "superseded";

    const result = await harness.controller().moveTabToNewWindow(
      "move-superseded",
      TAB_ID
    );

    expect(result.receipt.status).toBe("superseded");
    expect(harness.coreSnapshot.logicalWindows.map((window) => window.windowId))
      .toEqual([SOURCE_WINDOW_ID]);
    expect(harness.logical(SOURCE_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([TAB_ID]);
  });

  it("restores exact order and retires the target when persistence fails", async () => {
    const harness = new MoveHarness(
      "win32",
      [tab(TAB_ID, true), tab(SECOND_TAB_ID)]
    );
    harness.failSave = true;

    await expect(
      harness.controller().moveTabToNewWindow("move-save-fails", TAB_ID)
    ).rejects.toThrow("persistence failed");

    expect(harness.logical(SOURCE_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([TAB_ID, SECOND_TAB_ID]);
    expect(harness.logical(SOURCE_WINDOW_ID).tabs[0]?.hidden).toBe(true);
    expect(harness.coreSnapshot.logicalWindows.map((window) => window.windowId))
      .toEqual([SOURCE_WINDOW_ID]);
    expect(harness.commands.some(
      (command) => command.type === "embeddedTabHide"
    )).toBe(true);
  });

  it("rolls back when the display changes before the detached window persists", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID), tab(SECOND_TAB_ID)]);
    harness.displayScaleFactor = 1;

    await expect(
      harness.controller().moveTabToNewWindow("move-display-stale", TAB_ID)
    ).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_NEW_WINDOW_DISPLAY_STALE"
    });

    expect(harness.logical(SOURCE_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([TAB_ID, SECOND_TAB_ID]);
    expect(harness.coreSnapshot.logicalWindows.map((window) => window.windowId))
      .toEqual([SOURCE_WINDOW_ID]);
  });

  it("resumes after a crash at committed ownership without reprovisioning", async () => {
    const harness = new MoveHarness("win32", [tab(TAB_ID)]);
    await harness.invoke({
      type: "embeddedWindowProvisionForTabMove",
      operationId: "move-resume:provision",
      tabId: TAB_ID,
      sourceWindowId: SOURCE_WINDOW_ID,
      sourceWindowGeneration: 3,
      sourceTopologyRevision: 8,
      target: proposedTarget()
    });
    harness.move(SOURCE_WINDOW_ID, TARGET_WINDOW_ID, TAB_ID);
    harness.commands.length = 0;

    const result = await harness.controller().moveTabToNewWindow(
      "move-resume",
      TAB_ID
    );

    expect(result.receipt).toMatchObject({
      status: "applied",
      stage: "newWindowMoveResumedFromCoreOwnership"
    });
    expect(harness.targetResolver).not.toHaveBeenCalled();
    expect(harness.commands.some(
      (command) => command.type === "embeddedWindowProvisionForTabMove"
    )).toBe(false);
    expect(harness.commands.some(
      (command) => command.type === "embeddedTabMove"
    )).toBe(false);
    expect(harness.coreSnapshot.logicalWindows.map((window) => window.windowId))
      .toEqual([TARGET_WINDOW_ID]);
  });

  it("uses only the privileged AppKit event lane for a macOS move", async () => {
    const harness = new MoveHarness("darwin", [tab(TAB_ID), tab(SECOND_TAB_ID)]);

    const result = await harness.controller().moveTabToNewWindow(
      "move-appkit",
      TAB_ID
    );

    expect(result.receipt).toMatchObject({
      platform: "macos",
      status: "applied",
      stage: "appKitNewWindowMoveApplied"
    });
    expect(harness.captureHostObservations).toHaveBeenCalledWith([
      TARGET_WINDOW_ID,
      SOURCE_WINDOW_ID
    ]);
    expect(harness.appKitMove).toHaveBeenCalledOnce();
    expect(harness.commands.some(
      (command) => command.type === "embeddedTabMove"
    )).toBe(false);
    expect(harness.commands).toContainEqual({
      type: "embeddedWindowsShow",
      windowId: TARGET_WINDOW_ID
    });
    expect(harness.native(TARGET_WINDOW_ID)).toMatchObject({
      focused: true,
      visible: true
    });
    expect(harness.logical(TARGET_WINDOW_ID).tabs.map((item) => item.id))
      .toEqual([TAB_ID]);
  });
});
