import { describe, expect, it } from "vitest";

import {
  ChromiumRuntimeRestoreSessionCoordinator,
  type ChromiumRuntimeRestoreSessionCorePort
} from "../src/electron/main/chromiumRuntimeRestoreSessionCoordinator";
import type {
  CoreCommand,
  RuntimeRestoreSessionRecord
} from "../src/shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeSnapshot";

const CAPTURED_AT = "2026-08-31T12:00:00.000Z";

function session(): RuntimeRestoreSessionRecord {
  return {
    schemaVersion: 2,
    sessionGeneration: 7,
    updatedAt: CAPTURED_AT,
    cleanExit: true,
    lastFocusedWindowId: "window-a",
    restoreInProgressWindowIds: [],
    liveWindowIds: ["window-a"],
    windows: []
  };
}

function snapshot(
  windows: ReadonlyArray<Readonly<{
    id: string;
    focused?: boolean;
    visible?: boolean;
    tabIds?: readonly string[];
  }>>
): ChromiumRuntimeExecutorSnapshot {
  return {
    windows: windows.map((window, index) => ({
      windowId: window.id,
      activeTabId: window.tabIds?.[0] ?? "",
      tabIds: window.tabIds ?? [],
      displayId: 41,
      bounds: { x: index * 20, y: index * 20, width: 900, height: 640 },
      visible: window.visible ?? true,
      focused: window.focused ?? false,
      presentation: "normal",
      windowGeneration: 1,
      topologyRevision: 1
    })),
    tabs: [],
    roles: [],
    webSurfaces: []
  };
}

class CoreHarness {
  current = session();
  readonly commands: CoreCommand[] = [];

  readonly invoke = async (command: CoreCommand): Promise<unknown> => {
    this.commands.push(structuredClone(command));
    if (command.type === "runtimeRestoreSessionGet") {
      return structuredClone(this.current);
    }
    if (command.type === "runtimeRestoreSessionReplace") {
      this.current = structuredClone(command.session);
      return structuredClone(this.current);
    }
    throw new Error(`Unexpected command ${command.type}`);
  };

  coordinator(): ChromiumRuntimeRestoreSessionCoordinator {
    return new ChromiumRuntimeRestoreSessionCoordinator({
      core: { invoke: this.invoke } as unknown as
        ChromiumRuntimeRestoreSessionCorePort,
      now: () => CAPTURED_AT
    });
  }
}

describe("Chromium runtime restore-session coordinator", () => {
  it("persists an ordered unclean native cohort and its exact focused owner", async () => {
    const core = new CoreHarness();

    await core.coordinator().synchronize(snapshot([
      { id: "window-b", tabIds: ["tab-b"] },
      { id: "window-a", focused: true, tabIds: ["tab-a"] }
    ]));

    expect(core.current).toEqual({
      schemaVersion: 2,
      sessionGeneration: 8,
      updatedAt: CAPTURED_AT,
      cleanExit: false,
      lastFocusedWindowId: "window-a",
      restoreInProgressWindowIds: [],
      liveWindowIds: ["window-a", "window-b"],
      windows: []
    });
  });

  it("serializes concurrent commits and clears interrupted state only at clean exit", async () => {
    const core = new CoreHarness();
    core.current = {
      ...core.current,
      cleanExit: false,
      restoreInProgressWindowIds: ["window-b"]
    };
    const coordinator = core.coordinator();

    await Promise.all([
      coordinator.synchronize(snapshot([
        { id: "window-a", focused: true, tabIds: ["tab-a"] },
        { id: "window-b", tabIds: ["tab-b"] }
      ])),
      coordinator.persistCleanExit(snapshot([
        { id: "window-b", tabIds: ["tab-b"] }
      ]))
    ]);

    expect(core.current).toMatchObject({
      cleanExit: true,
      lastFocusedWindowId: "window-b",
      liveWindowIds: ["window-b"],
      restoreInProgressWindowIds: [],
      sessionGeneration: 9
    });
    expect(core.commands.map((command) => command.type)).toEqual([
      "runtimeRestoreSessionGet",
      "runtimeRestoreSessionReplace",
      "runtimeRestoreSessionGet",
      "runtimeRestoreSessionReplace"
    ]);
  });

  it("serializes restore progress with topology commits without losing either update", async () => {
    const core = new CoreHarness();
    const coordinator = core.coordinator();

    await Promise.all([
      coordinator.mutate((current) => ({
        cleanExit: false,
        restoreInProgressWindowIds: [
          ...current.restoreInProgressWindowIds,
          "window-b"
        ]
      })),
      coordinator.synchronize(snapshot([
        { id: "window-a", focused: true, tabIds: ["tab-a"] },
        { id: "window-b", tabIds: ["tab-b"] }
      ]))
    ]);

    expect(core.current).toMatchObject({
      cleanExit: false,
      liveWindowIds: ["window-a", "window-b"],
      restoreInProgressWindowIds: ["window-b"],
      sessionGeneration: 9
    });
  });

  it("removes a closed cohort without declaring the active process clean", async () => {
    const core = new CoreHarness();

    await core.coordinator().synchronize(snapshot([]));

    expect(core.current).toMatchObject({
      cleanExit: false,
      liveWindowIds: [],
      restoreInProgressWindowIds: []
    });
    expect(core.current).not.toHaveProperty("lastFocusedWindowId");
  });

  it("fails closed for duplicate tabs or ambiguous native focus", async () => {
    const coordinator = new CoreHarness().coordinator();

    await expect(coordinator.synchronize(snapshot([
      { id: "window-a", focused: true, tabIds: ["tab-shared"] },
      { id: "window-b", focused: true, tabIds: ["tab-shared"] }
    ]))).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_RESTORE_NATIVE_SNAPSHOT_INVALID"
    });
  });

  it("rejects a mismatched Core replacement receipt", async () => {
    const current = session();
    const coordinator = new ChromiumRuntimeRestoreSessionCoordinator({
      core: {
        invoke: async (command: CoreCommand) => {
          if (command.type === "runtimeRestoreSessionGet") return current;
          if (command.type === "runtimeRestoreSessionReplace") {
            return { ...command.session, cleanExit: true };
          }
          throw new Error("unexpected command");
        }
      } as ChromiumRuntimeRestoreSessionCorePort,
      now: () => CAPTURED_AT
    });

    await expect(coordinator.synchronize(snapshot([
      { id: "window-a", tabIds: ["tab-a"] }
    ]))).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_RESTORE_SESSION_RECEIPT_INVALID"
    });
  });

  it("accepts a structurally exact serde receipt with reordered object keys", async () => {
    const current = session();
    const coordinator = new ChromiumRuntimeRestoreSessionCoordinator({
      core: {
        invoke: async (command: CoreCommand) => {
          if (command.type === "runtimeRestoreSessionGet") return current;
          if (command.type !== "runtimeRestoreSessionReplace") {
            throw new Error("unexpected command");
          }
          const window = command.session.windows?.[0];
          if (!window) throw new Error("missing restore window");
          const tab = window.tabs[0]!;
          return {
            schemaVersion: command.session.schemaVersion,
            sessionGeneration: command.session.sessionGeneration,
            updatedAt: command.session.updatedAt,
            cleanExit: command.session.cleanExit,
            lastFocusedWindowId: command.session.lastFocusedWindowId,
            restoreInProgressWindowIds: command.session.restoreInProgressWindowIds,
            liveWindowIds: command.session.liveWindowIds,
            windows: [{
              activeSourceId: window.activeSourceId,
              id: window.id,
              tabs: [{
                audioMuted: tab.audioMuted,
                hidden: tab.hidden,
                name: tab.name,
                roleIds: tab.roleIds,
                sourceId: tab.sourceId,
                tabType: tab.tabType
              }],
              targetDisplay: window.targetDisplay,
              wasVisible: window.wasVisible
            }]
          };
        }
      } as ChromiumRuntimeRestoreSessionCorePort,
      now: () => CAPTURED_AT
    });

    await expect(coordinator.mutate(() => ({
      restoreInProgressWindowIds: ["window-a"],
      windows: [{
        id: "window-a",
        targetDisplay: { id: 41 },
        wasVisible: true,
        activeSourceId: "workspace-a",
        tabs: [{
          tabType: "workspace",
          sourceId: "workspace-a",
          name: "Workspace A",
          roleIds: ["role-a"],
          hidden: false,
          audioMuted: false
        }]
      }]
    }))).resolves.toMatchObject({
      restoreInProgressWindowIds: ["window-a"],
      windows: [{ id: "window-a" }]
    });
  });
});
