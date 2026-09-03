import type {
  CoreCommand,
  CoreCommandResult,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import type { ChromiumRuntimeHostPort } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";
import { ChromiumRuntimeLayoutResolver } from
  "../src/electron/main/chromiumRuntimeLayoutResolver";

function tab(): EmbeddedTabEffectRecord {
  const role = (roleId: string, x: number) => ({
    role: {
      id: roleId,
      gameId: "game-1",
      name: roleId,
      launchUrl: `https://${roleId}.test`,
      notes: "",
      createdAt: "2026-08-30T00:00:00Z",
      updatedAt: "2026-08-30T00:00:00Z"
    },
    resolvedEngine: "chromium" as never,
    rect: { x, y: 0, width: 0.5, height: 1 },
    zoomFactor: 1,
    zoomMode: "fixed" as const
  });
  const roles = [role("role-a", 0), role("role-b", 0.5)];
  return {
    tabId: "tab-1",
    audioMuted: false,
    sourceId: "workspace-1",
    name: "Workspace",
    workspaceId: "workspace-1",
    workspaceAppearance: { background: "black", gap: 4 },
    target: {
      windowId: "window-1",
      displayId: 1,
      scaleFactor: 1,
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      presentation: "normal"
    },
    slots: roles.map((entry, index) => ({
      slotId: `slot-${index}`,
      role: entry.role,
      rect: entry.rect,
      zoomFactor: 1,
      zoomMode: "fixed",
      state: "launching"
    })),
    roles
  };
}

function host(overrides: Partial<ChromiumRuntimeHostPort> = {}): ChromiumRuntimeHostPort {
  return {
    id: 1,
    logicalWindowId: "window-1",
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    },
    close: vi.fn(async () => undefined),
    focus: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 44, width: 1000, height: 656 }),
    readProjection: () => ({
      displayId: 7,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      visible: true,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => false,
    isVisible: () => true,
    show: vi.fn(),
    ...overrides,
    hide: overrides.hide ?? vi.fn()
  };
}

function core(outputRoles = [
  { roleId: "role-a", bounds: { x: 0, y: 44, width: 498, height: 656 } },
  { roleId: "role-b", bounds: { x: 502, y: 44, width: 498, height: 656 } }
]) {
  const invoke = vi.fn(async (command: CoreCommand): Promise<unknown> => {
    if (command.type === "layoutCreateDividers") {
      return [{
        axis: "vertical",
        beforeRoleIds: ["role-a"],
        afterRoleIds: ["role-b"],
        defaultPosition: 0.5
      }];
    }
    if (command.type === "layoutResolve") {
      return {
        visible: true,
        roles: outputRoles,
        dividers: [{
          index: 0,
          bounds: { x: 498, y: 44, width: 4, height: 656 }
        }]
      };
    }
    throw new Error("unexpected command");
  });
  return {
    invoke: invoke as <Command extends CoreCommand>(
      command: Command
    ) => Promise<CoreCommandResult<Command>>
  };
}

describe("Electron Chromium runtime layout resolver", () => {
  it("uses Rust divider and layout authority with live Electron content bounds", async () => {
    const corePort = core();
    const subject = new ChromiumRuntimeLayoutResolver(corePort);

    const result = await subject.resolveRoleBounds(tab(), host());
    const workspaceLayout = await subject.resolveWorkspaceLayout(tab(), host());

    expect([...result.entries()]).toEqual([
      ["role-a", { x: 0, y: 44, width: 498, height: 656 }],
      ["role-b", { x: 502, y: 44, width: 498, height: 656 }]
    ]);
    expect(workspaceLayout.dividers).toEqual([{
      axis: "vertical",
      bounds: { x: 498, y: 44, width: 4, height: 656 },
      index: 0
    }]);
    expect(corePort.invoke).toHaveBeenNthCalledWith(1, {
      type: "layoutCreateDividers",
      roles: [
        { roleId: "role-a", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { roleId: "role-b", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    });
    expect(corePort.invoke).toHaveBeenNthCalledWith(2, {
      type: "layoutResolve",
      input: expect.objectContaining({
        active: true,
        hidden: false,
        windowVisible: true,
        contentBounds: { x: 0, y: 44, width: 1000, height: 656 },
        gap: 4,
        dividers: [{
          axis: "vertical",
          beforeRoleIds: ["role-a"],
          afterRoleIds: ["role-b"]
        }]
      })
    });
  });

  it("rejects missing and out-of-host Core role bounds", async () => {
    const missing = new ChromiumRuntimeLayoutResolver(core([
      { roleId: "role-a", bounds: { x: 0, y: 44, width: 498, height: 656 } }
    ]));
    await expect(missing.resolveRoleBounds(tab(), host())).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAYOUT_RESULT_INVALID"
    });

    const escaped = new ChromiumRuntimeLayoutResolver(core([
      { roleId: "role-a", bounds: { x: -1, y: 44, width: 498, height: 656 } },
      { roleId: "role-b", bounds: { x: 502, y: 44, width: 498, height: 656 } }
    ]));
    await expect(escaped.resolveRoleBounds(tab(), host())).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAYOUT_RESULT_INVALID"
    });
  });

  it("rejects a stale native host before asking Core for layout", async () => {
    const corePort = core();
    const subject = new ChromiumRuntimeLayoutResolver(corePort);

    await expect(subject.resolveRoleBounds(tab(), host({
      logicalWindowId: "window-stale"
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_LAYOUT_HOST_INVALID" });
    expect(corePort.invoke).not.toHaveBeenCalled();
  });
});
