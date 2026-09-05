import { describe, expect, it, vi } from "vitest";

import type {
  AppKitRuntimeEventReceiptRecord,
  AppKitRuntimeHostObservationRecord,
  CoreCommand,
  CoreEvent
} from "../src/shared/generated";
import { MacosAppKitRuntimeEventBridge } from
  "../src/electron/main/macosAppKitRuntimeEventBridge";

const identity = Object.freeze({
  logicalWindowId: "window-1",
  launchGeneration: "launch-1",
  nativeGeneration: 1
});

function observation(
  logicalWindowId = "window-1",
  nativeGeneration = 1
): AppKitRuntimeHostObservationRecord {
  return {
    identity: {
      logicalWindowId,
      launchGeneration: `launch-${logicalWindowId}`,
      nativeGeneration
    },
    windowGeneration: 3,
    topologyRevision: 7,
    contentBounds: { x: 0, y: 0, width: 900, height: 600 },
    normalBounds: { x: 20, y: 30, width: 900, height: 640 },
    savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
    targetDisplay: { id: 1 },
    presentation: "normal",
    focused: true,
    minimized: false,
    visible: true
  };
}

function primaryObservation(): AppKitRuntimeHostObservationRecord {
  return { ...observation(), identity };
}

function receipt(command: Extract<CoreCommand, {
  type: "browserAppKitRuntimeEvent";
}>): AppKitRuntimeEventReceiptRecord {
  return {
    eventId: command.event.eventId,
    adapterSequence: command.event.adapterSequence,
    status: "applied",
    topologyCommitted: command.event.action.type !== "layout",
    nativeApplied: true,
    windowGeneration: 3,
    topologyRevision: 8
  };
}

describe("macOS AppKit privileged runtime event bridge", () => {
  it("exposes an event-bound fence for already admitted native callbacks", async () => {
    let release!: () => void;
    const nativeTerminal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          await nativeTerminal;
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError: vi.fn()
    });
    bridge.receiveAction({
      identity,
      hosts: [primaryObservation()],
      action: {
        type: "activate",
        sourceWindowId: "window-1",
        tabId: "tab-1"
      }
    });

    let settled = false;
    const fence = bridge.settleCurrentEvents().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await fence;
    expect(settled).toBe(true);
    await bridge.dispose();
  });

  it("does not dispatch a native layout ahead of the current application effect", async () => {
    let release!: () => void;
    const applicationEffect = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async (command: CoreCommand) => receipt(
      command as Extract<CoreCommand, { type: "browserAppKitRuntimeEvent" }>
    ) as never);
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke,
        subscribeCoreEvents: () => () => undefined
      },
      preparePassiveEventDispatch: async (hosts) => {
        await applicationEffect;
        return hosts;
      },
      onError: vi.fn()
    });

    bridge.receiveLayout({
      identity,
      hosts: [primaryObservation()]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    release();
    await bridge.dispose();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("refreshes an action observation after the current application effect", async () => {
    let release!: () => void;
    const applicationEffect = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      preparePassiveEventDispatch: async (hosts) => {
        await applicationEffect;
        return hosts.map((host) => ({ ...host, topologyRevision: 9 }));
      },
      onError: vi.fn()
    });

    bridge.receiveAction({
      identity,
      hosts: [primaryObservation()],
      action: { type: "windowFocusChanged", sourceWindowId: "window-1" }
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(commands).toHaveLength(0);

    release();
    await bridge.dispose();
    expect(commands[0]!.event.hosts[0]!.topologyRevision).toBe(9);
    expect(commands[0]!.event.action).toEqual({
      type: "windowState",
      placementSequence: 1
    });
  });

  it("rejects a refreshed action whose native host identity changed", async () => {
    const invoke = vi.fn();
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke,
        subscribeCoreEvents: () => () => undefined
      },
      preparePassiveEventDispatch: async (hosts) => hosts.map((host) => ({
        ...host,
        identity: { ...host.identity, nativeGeneration: 2 }
      })),
      onError
    });

    bridge.receiveAction({
      identity,
      hosts: [primaryObservation()],
      action: { type: "windowFocusChanged", sourceWindowId: "window-1" }
    });
    await bridge.dispose();

    expect(invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_EVENT_HOST_STALE"
    }));
  });

  it("does not make an interactive stop wait behind a passive-event fence", async () => {
    const preparePassiveEventDispatch = vi.fn(() => new Promise<
      readonly AppKitRuntimeHostObservationRecord[]
    >(() => undefined));
    const invoke = vi.fn(async (command: CoreCommand) => receipt(
      command as Extract<CoreCommand, { type: "browserAppKitRuntimeEvent" }>
    ) as never);
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke,
        subscribeCoreEvents: () => () => undefined
      },
      preparePassiveEventDispatch,
      onError: vi.fn()
    });

    await expect(bridge.stopTab(
      [primaryObservation()],
      "tab-1",
      []
    )).resolves.toMatchObject({ status: "applied" });
    expect(preparePassiveEventDispatch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    await bridge.dispose();
  });

  it("keeps native divider pointer moves on the ordered AppKit Core lane", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserWorkspaceDividerPointer";
    }>[] = [];
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const pointer = command as Extract<CoreCommand, {
            type: "browserWorkspaceDividerPointer";
          }>;
          commands.push(pointer);
          return {
            eventId: pointer.event.eventId,
            gestureId: pointer.event.gestureId,
            pointerSequence: pointer.event.pointerSequence,
            phase: pointer.event.phase,
            status: "applied",
            changed: pointer.event.phase === "move",
            durable: pointer.event.phase === "end",
            ...(pointer.event.phase === "move"
              ? { position: pointer.event.requestedPosition }
              : {}),
            windowGeneration: pointer.event.windowGeneration,
            topologyRevision: pointer.event.phase === "move"
              ? pointer.event.topologyRevision + 1
              : pointer.event.topologyRevision,
            workspaceSlots: []
          } as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });
    const emit = (
      phase: "start" | "move" | "end",
      pointerSequence: number
    ): void => {
      bridge.receiveAction({
        identity,
        hosts: [primaryObservation()],
        action: {
          type: "workspaceDividerPointer",
          sessionId: "divider-gesture-1",
          sourceWindowId: "window-1",
          tabId: "tab-1",
          statusIdentity: {
            phase,
            pointerSequence,
            attemptGeneration: "workspace-attempt-1",
            dividerIndex: 0,
            axis: "vertical",
            ...(phase === "move" ? { requestedPosition: 0.65 } : {})
          }
        }
      });
    };

    emit("start", 1);
    emit("move", 2);
    emit("end", 3);
    await bridge.dispose();

    expect(commands.map(({ event }) => ({
      adapterSequence: event.appkitAdapterSequence,
      phase: event.phase,
      pointerSequence: event.pointerSequence,
      topologyRevision: event.topologyRevision
    }))).toEqual([
      { adapterSequence: 1, phase: "start", pointerSequence: 1, topologyRevision: 7 },
      { adapterSequence: 2, phase: "move", pointerSequence: 2, topologyRevision: 7 },
      { adapterSequence: 3, phase: "end", pointerSequence: 3, topologyRevision: 8 }
    ]);
    expect(commands[0]!.event).toMatchObject({
      hostIdentity: { kind: "appkit", identity },
      platform: "macos",
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("serializes action, layout, and close events through exact Core receipts", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });
    const hosts = [primaryObservation()];

    bridge.receiveAction({
      identity,
      hosts,
      action: {
        type: "activate",
        sourceWindowId: "window-1",
        tabId: "tab-1"
      }
    });
    bridge.receiveLayout({ identity, hosts });
    bridge.receiveCloseRequested(identity, hosts);
    await bridge.dispose();

    expect(commands.map((command) => command.event.action.type)).toEqual([
      "activate",
      "layout",
      "closeWindow"
    ]);
    expect(commands.map((command) => command.event.adapterSequence)).toEqual([1, 2, 3]);
    expect(commands[1]!.event.action).toEqual({
      type: "layout",
      layoutSequence: 1
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("coalesces identical native layout observations while preserving changed truth", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError: vi.fn()
    });
    const hosts = [primaryObservation()];
    const changedHosts = [{
      ...primaryObservation(),
      contentBounds: { x: 0, y: 8, width: 900, height: 592 }
    }];

    bridge.receiveLayout({ identity, hosts });
    bridge.receiveLayout({ identity, hosts });
    bridge.receiveLayout({ identity, hosts: changedHosts });
    bridge.receiveLayout({ identity, hosts: changedHosts });
    await bridge.dispose();

    expect(commands.map(({ event }) => ({
      adapterSequence: event.adapterSequence,
      action: event.action
    }))).toEqual([
      { adapterSequence: 1, action: { type: "layout", layoutSequence: 1 } },
      { adapterSequence: 2, action: { type: "layout", layoutSequence: 2 } }
    ]);
  });

  it("defers and coalesces restore layouts until the exact topology is terminal", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError: vi.fn()
    });
    const firstHosts = [primaryObservation()];
    const finalHosts = [{
      ...primaryObservation(),
      contentBounds: { x: 0, y: 12, width: 900, height: 588 }
    }];

    bridge.beginSavedWindowRestore("window-1");
    bridge.receiveLayout({ identity, hosts: firstHosts });
    bridge.receiveLayout({ identity, hosts: finalHosts });
    await Promise.resolve();
    expect(commands).toHaveLength(0);

    await bridge.finishSavedWindowRestore("window-1");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.event).toMatchObject({
      action: { type: "layout", layoutSequence: 1 },
      hosts: finalHosts
    });
    await bridge.dispose();
  });

  it("allows an identical native layout observation to retry after failure", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          if (commands.length === 1) throw new Error("injected layout failure");
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });
    const hosts = [primaryObservation()];

    bridge.receiveLayout({ identity, hosts });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    bridge.receiveLayout({ identity, hosts });
    await bridge.dispose();

    expect(commands.map(({ event }) => event.action)).toEqual([
      { type: "layout", layoutSequence: 1 },
      { type: "layout", layoutSequence: 2 }
    ]);
  });

  it("fences a cross-window drop by drag session and both native generations", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });
    const source = primaryObservation();
    const targetIdentity = {
      logicalWindowId: "window-2",
      launchGeneration: "launch-window-2",
      nativeGeneration: 4
    };
    const target = observation("window-2", 4);

    bridge.receiveAction({
      identity,
      hosts: [source],
      action: {
        type: "tabDragStart",
        sourceWindowId: "window-1",
        sessionId: "drag-1",
        tabId: "tab-1"
      }
    });
    bridge.receiveAction({
      identity: targetIdentity,
      hosts: [target, source],
      action: {
        type: "tabDragDrop",
        sourceWindowId: "window-1",
        targetWindowId: "window-2",
        sessionId: "drag-1",
        tabId: "tab-1",
        orderedTabIds: ["tab-2", "tab-1"]
      }
    });
    await bridge.dispose();

    expect(commands).toHaveLength(1);
    expect(commands[0]!.event.action).toEqual({
      type: "move",
      sessionId: "drag-1",
      tabId: "tab-1",
      sourceWindowId: "window-1",
      targetWindowId: "window-2",
      orderedTabIds: ["tab-2", "tab-1"],
      phase: "drop"
    });
    expect(commands[0]!.event.hosts.map((host) =>
      host.identity.logicalWindowId
    )).toEqual(["window-2", "window-1"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("places renderer actions on the same privileged AppKit lane with exact host observations", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: async (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          return receipt(eventCommand) as never;
        },
        subscribeCoreEvents: () => () => undefined
      },
      onError: vi.fn()
    });
    const source = primaryObservation();
    const target = observation("window-2", 4);

    const activation = bridge.activateTab([source], "tab-1");
    const move = bridge.moveTab([target, source], {
      sessionId: "renderer-drag-1",
      tabId: "tab-1",
      sourceWindowId: "window-1",
      targetWindowId: "window-2",
      orderedTabIds: ["tab-2", "tab-1"]
    });

    await expect(activation).resolves.toMatchObject({ status: "applied" });
    await expect(move).resolves.toMatchObject({ status: "applied" });
    expect(commands.map((command) => command.event.adapterSequence)).toEqual([1, 2]);
    expect(commands[0]!.event.action).toEqual({ type: "activate", tabId: "tab-1" });
    expect(commands[1]!.event.action).toEqual({
      type: "move",
      sessionId: "renderer-drag-1",
      tabId: "tab-1",
      sourceWindowId: "window-1",
      targetWindowId: "window-2",
      orderedTabIds: ["tab-2", "tab-1"],
      phase: "drop"
    });
  });

  it("releases the ordered lane on exact visibility dispatch before the first native acknowledgement", async () => {
    const commands: Extract<CoreCommand, {
      type: "browserAppKitRuntimeEvent";
    }>[] = [];
    let coreListener: ((event: CoreEvent) => void) | undefined;
    let resolveHideInvoked!: () => void;
    let resolveShowInvoked!: () => void;
    let resolveCloseInvoked!: () => void;
    let resolveHideReceipt!: (value: AppKitRuntimeEventReceiptRecord) => void;
    let hideAcknowledged = false;
    const hideInvoked = new Promise<void>((resolve) => {
      resolveHideInvoked = resolve;
    });
    const showInvoked = new Promise<void>((resolve) => {
      resolveShowInvoked = resolve;
    });
    const closeInvoked = new Promise<void>((resolve) => {
      resolveCloseInvoked = resolve;
    });
    const hideTerminal = new Promise<AppKitRuntimeEventReceiptRecord>((resolve) => {
      resolveHideReceipt = (value) => {
        hideAcknowledged = true;
        resolve(value);
      };
    });
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: (command) => {
          const eventCommand = command as Extract<CoreCommand, {
            type: "browserAppKitRuntimeEvent";
          }>;
          commands.push(eventCommand);
          if (eventCommand.event.action.type === "setWindowVisibility" &&
            !eventCommand.event.action.visible) {
            resolveHideInvoked();
            return hideTerminal as never;
          }
          if (eventCommand.event.action.type === "setWindowVisibility") {
            resolveShowInvoked();
          } else if (eventCommand.event.action.type === "closeWindow") {
            resolveCloseInvoked();
          }
          return Promise.resolve(receipt(eventCommand)) as never;
        },
        subscribeCoreEvents: (listener) => {
          coreListener = listener;
          return () => {
            if (coreListener === listener) coreListener = undefined;
          };
        }
      },
      onError: vi.fn()
    });

    const hide = bridge.setWindowVisibility([primaryObservation()], false);
    const hiddenObservation = primaryObservation();
    hiddenObservation.visible = false;
    hiddenObservation.focused = false;
    const show = bridge.setWindowVisibility([hiddenObservation], true);
    const close = bridge.closeWindow([hiddenObservation]);
    await hideInvoked;

    expect(commands).toHaveLength(1);
    const hideCommand = commands[0]!;
    coreListener?.({
      type: "coreEffects",
      effects: [{
        effectId: "visibility-hide-effect",
        operationId: "visibility-hide-operation",
        parentOperationId: hideCommand.event.eventId,
        target: { kind: "app", handleId: "window-1" },
        completionPolicy: "eventBound",
        action: {
          type: "embeddedSetRuntimeWindowVisibility",
          lifecycleEpoch: 1,
          windowId: "window-1",
          windowGeneration: 3,
          topologyRevision: 7,
          appkitIdentity: identity,
          visible: false
        }
      }]
    });
    await showInvoked;
    await closeInvoked;

    expect(hideAcknowledged).toBe(false);
    expect(commands.map((command) => ({
      adapterSequence: command.event.adapterSequence,
      action: command.event.action.type,
      visible: command.event.action.type === "setWindowVisibility"
        ? command.event.action.visible
        : undefined
    }))).toEqual([
      { action: "setWindowVisibility", adapterSequence: 1, visible: false },
      { action: "setWindowVisibility", adapterSequence: 2, visible: true },
      { action: "closeWindow", adapterSequence: 3, visible: undefined }
    ]);

    resolveHideReceipt(receipt(hideCommand));
    await expect(hide).resolves.toMatchObject({ status: "applied" });
    await expect(show).resolves.toMatchObject({ status: "applied" });
    await expect(close).resolves.toMatchObject({ status: "applied" });
    await bridge.dispose();
  });

  it("routes a visible retained-AppKit tab menu through its exact native host fence", async () => {
    const onOpenTabMenu = vi.fn(async () => undefined);
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: vi.fn(),
        subscribeCoreEvents: () => () => undefined
      },
      onError,
      onOpenTabMenu
    });
    const hosts = [primaryObservation()];

    bridge.receiveAction({
      identity,
      hosts,
      action: {
        type: "openTabMenu",
        sourceWindowId: "window-1",
        tabId: "tab-1"
      }
    });
    await vi.waitFor(() => expect(onOpenTabMenu).toHaveBeenCalledOnce());
    await bridge.dispose();

    expect(onOpenTabMenu).toHaveBeenCalledWith({
      hosts,
      identity,
      tabId: "tab-1"
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails closed when the retained-AppKit tab menu handler is unavailable", async () => {
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke: vi.fn(),
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });

    bridge.receiveAction({
      identity,
      hosts: [primaryObservation()],
      action: {
        type: "openTabMenu",
        sourceWindowId: "window-1",
        tabId: "tab-1"
      }
    });
    await bridge.dispose();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_TAB_MENU_UNAVAILABLE"
    }));
  });

  it("fails closed for unsupported actions and stale callbacks after dispose", async () => {
    const invoke = vi.fn();
    const onError = vi.fn();
    const bridge = new MacosAppKitRuntimeEventBridge({
      core: {
        invoke,
        subscribeCoreEvents: () => () => undefined
      },
      onError
    });
    const hosts = [primaryObservation()];

    bridge.receiveAction({
      identity,
      hosts,
      action: {
        type: "openLauncher",
        sourceWindowId: "window-1"
      }
    });
    await bridge.dispose();
    bridge.receiveLayout({ identity, hosts });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_ACTION_UNSUPPORTED"
    }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
