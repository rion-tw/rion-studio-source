import type {
  CoreCommand,
  CoreCommandResult,
  DisplayTopologySnapshotRecord,
  WindowsRuntimeWindowPlacementEventRecord,
  WindowsRuntimeWindowPlacementReceiptRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import type {
  ChromiumRuntimeHostPort,
  WindowsRuntimeWindowPlacementObservation
} from "../src/electron/main/chromiumRuntimeHostPorts";
import { WindowsRuntimeWindowPlacementController } from
  "../src/electron/main/windowsRuntimeWindowPlacementController";

import { commitChromiumRuntimeWindowsPlacementTarget } from
  "../src/electron/main/chromiumRuntimePlacementTarget";
import type { ChromiumRuntimeWindowRecord } from
  "../src/electron/main/chromiumRuntimeAppKitProjection";

const windowId = "10000000-0000-4000-8000-000000000001";

function topology(revision = 3): DisplayTopologySnapshotRecord {
  return {
    revision,
    capturedAt: "2026-08-31T00:00:00.000Z",
    cause: "test",
    primaryDisplayId: "7",
    displays: [{
      id: 7,
      label: "Built-in Display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      resolution: { width: 3840, height: 2160 },
      scaleFactor: 2,
      isPrimary: true,
      isInternal: true
    }]
  };
}

function observation(): WindowsRuntimeWindowPlacementObservation {
  return {
    nativeHostId: 41,
    nativeGeneration: 2,
    windowId,
    windowGeneration: 4,
    topologyRevision: 10,
    displayId: 7,
    normalBounds: { x: 120, y: 80, width: 960, height: 680 },
    savedWorkArea: { x: 0, y: 0, width: 1920, height: 1040 },
    presentation: "normal"
  };
}

function hostFor(read: () => WindowsRuntimeWindowPlacementObservation) {
  return {
    readRuntimeWindowPlacement: read,
    isDestroyed: () => false
  } as unknown as ChromiumRuntimeHostPort;
}

function receiptFor(
  command: Extract<CoreCommand, { type: "browserWindowsRuntimeWindowPlacement" }>,
  overrides: Partial<WindowsRuntimeWindowPlacementReceiptRecord> = {}
): WindowsRuntimeWindowPlacementReceiptRecord {
  const { event } = command;
  return {
    eventId: event.eventId,
    adapterSequence: event.adapterSequence,
    nativeHostId: event.nativeHostId,
    nativeGeneration: event.nativeGeneration,
    windowId: event.windowId,
    windowGeneration: event.windowGeneration,
    sourceTopologyRevision: event.topologyRevision,
    topologyRevision: event.topologyRevision + 1,
    status: "applied",
    persistenceStatus: "applied",
    coreProjectionApplied: true,
    ...overrides
  };
}

describe("Windows runtime-window placement controller", () => {
  it.each(["applied", "notRequired"] as const)(
    "accepts %s persistence only after exact Core, native, and display readback",
    async persistenceStatus => {
    let current = observation();
    const invokeMock = vi.fn(async (command: CoreCommand) => {
      expect(command.type).toBe("browserWindowsRuntimeWindowPlacement");
      const placement = command as Extract<
        CoreCommand,
        { type: "browserWindowsRuntimeWindowPlacement" }
      >;
      current = { ...current, topologyRevision: current.topologyRevision + 1 };
      return receiptFor(placement, { persistenceStatus });
    });
    const invoke = <Command extends CoreCommand>(command: Command) =>
      invokeMock(command) as Promise<CoreCommandResult<Command>>;
    const errors = vi.fn();
    const onApplied = vi.fn((event: WindowsRuntimeWindowPlacementEventRecord,
      receipt: WindowsRuntimeWindowPlacementReceiptRecord) =>
      commitChromiumRuntimeWindowsPlacementTarget({ event, receipt, windows }));
    const controller = new WindowsRuntimeWindowPlacementController({
      core: { invoke },
      readDisplayTopology: () => topology(),
      onError: errors,
      onApplied
    });
    const host = hostFor(() => current);
    const windows = new Map([[windowId, {
      host, windowGeneration: 4, topologyRevision: 11, hostTarget: {}
    } as unknown as ChromiumRuntimeWindowRecord]]);

    await controller.observe(host);
    await controller.observe(host);

    expect(invokeMock).toHaveBeenCalledOnce();
    const command = invokeMock.mock.calls[0]![0] as Extract<
      CoreCommand,
      { type: "browserWindowsRuntimeWindowPlacement" }
    >;
    expect(command.event).toMatchObject({
      nativeHostId: 41,
      nativeGeneration: 2,
      windowId,
      windowGeneration: 4,
      topologyRevision: 10,
      targetDisplay: {
        id: 7,
        fingerprint: { label: "Built-in Display", scaleFactor: 2 }
      },
      placement: {
        normalBounds: { x: 120, y: 80, width: 960, height: 680 },
        savedWorkArea: { x: 0, y: 0, width: 1920, height: 1040 },
        presentation: "normal"
      }
    });
    expect(controller.inspect(windowId)).toEqual([expect.objectContaining({
      status: "applied",
      verified: true,
      receipt: expect.objectContaining({
        persistenceStatus,
        coreProjectionApplied: true,
        topologyRevision: 11
      })
    })]);
    expect(errors).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledOnce();
    expect(windows.get(windowId)?.hostTarget).toMatchObject({
      displayId: 7, bounds: current.normalBounds, presentation: "normal"
    });
  });

  it("never upgrades a superseded durable receipt to applied", async () => {
    const current = observation();
    const controller = new WindowsRuntimeWindowPlacementController({
      core: {
        invoke: async <Command extends CoreCommand>(command: Command) => {
          const placement = command as Extract<
            CoreCommand,
            { type: "browserWindowsRuntimeWindowPlacement" }
          >;
          return receiptFor(placement, {
            status: "superseded",
            persistenceStatus: "superseded",
            coreProjectionApplied: false,
            topologyRevision: placement.event.topologyRevision,
            failureCode: "WINDOWS_RUNTIME_PLACEMENT_STALE"
          }) as CoreCommandResult<Command>;
        }
      },
      readDisplayTopology: () => topology(),
      onError: vi.fn()
    });

    await controller.observe(hostFor(() => current));

    expect(controller.inspect()).toEqual([expect.objectContaining({
      status: "superseded",
      verified: false,
      failureCode: "WINDOWS_RUNTIME_PLACEMENT_STALE"
    })]);
  });

  it("marks an applied Core receipt indeterminate when native generation changes", async () => {
    let current = observation();
    const errors = vi.fn();
    const controller = new WindowsRuntimeWindowPlacementController({
      core: {
        invoke: async <Command extends CoreCommand>(command: Command) => {
          const placement = command as Extract<
            CoreCommand,
            { type: "browserWindowsRuntimeWindowPlacement" }
          >;
          current = {
            ...current,
            nativeGeneration: current.nativeGeneration + 1,
            topologyRevision: current.topologyRevision + 1
          };
          return receiptFor(placement) as CoreCommandResult<Command>;
        }
      },
      readDisplayTopology: () => topology(),
      onError: errors
    });

    await controller.observe(hostFor(() => current));

    expect(controller.inspect()).toEqual([expect.objectContaining({
      status: "indeterminate",
      verified: false,
      failureCode: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_POSTCONDITION_STALE"
    })]);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_POSTCONDITION_STALE"
    }));
  });

  it("rechecks the latest display topology after the Core receipt", async () => {
    let current = observation();
    let topologyReads = 0;
    const controller = new WindowsRuntimeWindowPlacementController({
      core: {
        invoke: async <Command extends CoreCommand>(command: Command) => {
          const placement = command as Extract<
            CoreCommand,
            { type: "browserWindowsRuntimeWindowPlacement" }
          >;
          current = { ...current, topologyRevision: current.topologyRevision + 1 };
          return receiptFor(placement) as CoreCommandResult<Command>;
        }
      },
      readDisplayTopology: () => topology(++topologyReads < 3 ? 3 : 4),
      onError: vi.fn()
    });

    await controller.observe(hostFor(() => current));

    expect(controller.inspect()).toEqual([expect.objectContaining({
      status: "indeterminate",
      verified: false,
      failureCode: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_POSTCONDITION_STALE"
    })]);
  });
});
