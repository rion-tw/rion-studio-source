import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  LaunchWorkspaceStore,
  LaunchWorkspaceStoreError
} from "../src/main/workspaces/LaunchWorkspaceStore";

const legacyRoleIdField = "profile" + "Id";

describe("LaunchWorkspaceStore", () => {
  let store: LaunchWorkspaceStore;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-workspace-test-"));
    store = new LaunchWorkspaceStore(baseDir);
  });

  it("creates a launch workspace with default layout slots", async () => {
    const workspace = await store.createWorkspace({ name: "Boss run" });

    expect(workspace).toMatchObject({
      name: "Boss run",
      template: "two_columns",
      browserZoomPercent: 100
    });
    expect(workspace.slots).toEqual([
      {
        id: "slot-1",
        rect: { x: 0, y: 0, width: 0.5, height: 1 }
      },
      {
        id: "slot-2",
        rect: { x: 0.5, y: 0, width: 0.5, height: 1 }
      }
    ]);
    await expect(store.getWorkspace(workspace.id)).resolves.toMatchObject({
      id: workspace.id,
      name: "Boss run"
    });
  });

  it("serializes concurrent role cleanup across the same workspace", async () => {
    const workspace = await store.createWorkspace({
      name: "Concurrent cleanup",
      slots: [
        { roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { roleId: "role-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    });

    await expect(Promise.all([store.clearRole("role-1"), store.clearRole("role-2")])).resolves.toEqual([
      undefined,
      undefined
    ]);
    const updated = await store.getWorkspace(workspace.id);
    expect(updated.slots.every((slot) => slot.roleId === undefined)).toBe(true);
  });

  it("reorders workspaces atomically without changing timestamps and keeps new workspaces last", async () => {
    const first = await store.createWorkspace({ name: "First" });
    const second = await store.createWorkspace({ name: "Second" });
    const third = await store.createWorkspace({ name: "Third" });

    const reordered = await store.reorderWorkspaces({ orderedIds: [third.id, first.id, second.id] });

    expect(reordered.map((workspace) => workspace.id)).toEqual([third.id, first.id, second.id]);
    expect(reordered.map((workspace) => workspace.updatedAt)).toEqual([
      third.updatedAt,
      first.updatedAt,
      second.updatedAt
    ]);
    await expect(new LaunchWorkspaceStore(baseDir).listWorkspaces()).resolves.toEqual(reordered);

    const fourth = await store.createWorkspace({ name: "Fourth" });
    await expect(store.listWorkspaces()).resolves.toEqual([...reordered, fourth]);
  });

  it("rejects incomplete, duplicate, and unknown workspace orders without changing the file", async () => {
    const first = await store.createWorkspace({ name: "First" });
    const second = await store.createWorkspace({ name: "Second" });
    const path = join(baseDir, "launch-workspaces.json");
    const unchanged = await readFile(path, "utf8");

    for (const orderedIds of [[first.id], [first.id, first.id], [first.id, "unknown"]]) {
      await expect(store.reorderWorkspaces({ orderedIds })).rejects.toMatchObject({
        code: "WORKSPACE_ORDER_INVALID"
      });
      await expect(readFile(path, "utf8")).resolves.toBe(unchanged);
    }

    await expect(store.listWorkspaces()).resolves.toEqual([first, second]);
  });

  it("updates layout, slots, and keeps duplicate role assignments out", async () => {
    const workspace = await store.createWorkspace({ name: "Party" });

    const updated = await store.updateWorkspace(workspace.id, {
      template: "two_columns",
      slots: [
        {
          id: "left",
          roleId: "role-1",
          rect: { x: 0, y: 0, width: 0.6, height: 1 }
        },
        {
          id: "right",
          roleId: "role-2",
          rect: { x: 0.6, y: 0, width: 0.4, height: 1 }
        }
      ]
    });

    expect(updated.slots).toMatchObject([
      { id: "left", roleId: "role-1", rect: { x: 0, y: 0, width: 0.6, height: 1 } },
      { id: "right", roleId: "role-2", rect: { x: 0.6, y: 0, width: 0.4, height: 1 } }
    ]);

    await expect(
      store.updateWorkspace(workspace.id, {
        slots: [
          { roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
          { roleId: "role-1", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
        ]
      })
    ).rejects.toMatchObject({
      code: "WORKSPACE_ROLE_DUPLICATE"
    });

    const trimmed = await store.updateWorkspace(workspace.id, {
      template: "single"
    });

    expect(trimmed.slots).toMatchObject([{ roleId: "role-1" }]);
    expect(trimmed.slots).toHaveLength(1);
  });

  it("creates and persists a resizable three-column workspace", async () => {
    const workspace = await store.createWorkspace({
      name: "Three roles",
      template: "three_columns",
      slots: [
        { roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
        { roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.35, height: 1 } },
        { roleId: "role-3", rect: { x: 0.55, y: 0, width: 0.45, height: 1 } }
      ]
    });

    expect(workspace.slots).toEqual([
      { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
      { id: "slot-2", roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.35, height: 1 } },
      { id: "slot-3", roleId: "role-3", rect: { x: 0.55, y: 0, width: 0.45, height: 1 } }
    ]);
    expect(workspace.browserZoomPercent).toBe(90);
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
  });

  it("uses three equal columns when no custom slots are provided", async () => {
    const workspace = await store.createWorkspace({ name: "Equal thirds", template: "three_columns" });

    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 1 / 3, height: 1 },
      { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }
    ]);
  });

  it("uses a right main pane with stacked left panes for main_right_stack_left", async () => {
    const workspace = await store.createWorkspace({ name: "Right main", template: "main_right_stack_left" });

    expect(workspace).toMatchObject({
      template: "main_right_stack_left",
      browserZoomPercent: 100
    });
    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0.5, y: 0, width: 0.5, height: 1 },
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 }
    ]);
  });

  it("creates and persists a resizable right-main left-stack workspace", async () => {
    const workspace = await store.createWorkspace({
      name: "Right main custom",
      template: "main_right_stack_left",
      slots: [
        { roleId: "role-1", rect: { x: 0.4, y: 0, width: 0.6, height: 1 } },
        { roleId: "role-2", rect: { x: 0, y: 0, width: 0.4, height: 0.65 } },
        { roleId: "role-3", rect: { x: 0, y: 0.65, width: 0.4, height: 0.35 } }
      ]
    });

    expect(workspace.slots).toEqual([
      { id: "slot-1", roleId: "role-1", rect: { x: 0.4, y: 0, width: 0.6, height: 1 } },
      { id: "slot-2", roleId: "role-2", rect: { x: 0, y: 0, width: 0.4, height: 0.65 } },
      { id: "slot-3", roleId: "role-3", rect: { x: 0, y: 0.65, width: 0.4, height: 0.35 } }
    ]);
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
  });

  it("creates and persists a five-slot workspace with a centered main pane", async () => {
    const workspace = await store.createWorkspace({
      name: "Centered main",
      template: "main_center_side_stacks"
    });

    expect(workspace).toMatchObject({
      template: "main_center_side_stacks",
      browserZoomPercent: 80
    });
    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0.25, y: 0, width: 0.5, height: 1 },
      { x: 0, y: 0, width: 0.25, height: 0.5 },
      { x: 0, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }
    ]);
    await expect(new LaunchWorkspaceStore(baseDir).getWorkspace(workspace.id)).resolves.toEqual(workspace);
  });

  it("creates and persists a resizable four-column workspace", async () => {
    const workspace = await store.createWorkspace({
      name: "Four roles",
      template: "four_columns",
      slots: [
        { roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
        { roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.3, height: 1 } },
        { roleId: "role-3", rect: { x: 0.5, y: 0, width: 0.18, height: 1 } },
        { roleId: "role-4", rect: { x: 0.68, y: 0, width: 0.32, height: 1 } }
      ]
    });

    expect(workspace.slots).toEqual([
      { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
      { id: "slot-2", roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.3, height: 1 } },
      { id: "slot-3", roleId: "role-3", rect: { x: 0.5, y: 0, width: 0.18, height: 1 } },
      { id: "slot-4", roleId: "role-4", rect: { x: 0.68, y: 0, width: 0.32, height: 1 } }
    ]);
    expect(workspace.browserZoomPercent).toBe(90);
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
  });

  it.each(["three_columns", "quad", "four_columns"] as const)(
    "defaults %s workspaces to 90 percent browser zoom",
    async (template) => {
      const workspace = await store.createWorkspace({ name: `${template} zoom`, template });

      expect(workspace.browserZoomPercent).toBe(90);
    }
  );

  it("persists, updates, and validates a custom browser zoom", async () => {
    const workspace = await store.createWorkspace({
      name: "Custom zoom",
      browserZoomPercent: 75
    });

    expect(workspace.browserZoomPercent).toBe(75);

    const preserved = await store.updateWorkspace(workspace.id, {
      name: "Custom zoom renamed",
      template: "three_columns"
    });
    expect(preserved.browserZoomPercent).toBe(75);

    const updated = await store.updateWorkspace(workspace.id, { browserZoomPercent: 80 });
    expect(updated.browserZoomPercent).toBe(80);
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(updated);

    await expect(
      store.updateWorkspace(workspace.id, { browserZoomPercent: 95 as never })
    ).rejects.toMatchObject({ code: "WORKSPACE_BROWSER_ZOOM_INVALID" });
  });

  it("persists, clears, and validates a target display", async () => {
    const workspace = await store.createWorkspace({ name: "Second screen", targetDisplayId: 42 });
    expect(workspace.targetDisplayId).toBe(42);
    await expect(new LaunchWorkspaceStore(baseDir).getWorkspace(workspace.id)).resolves.toMatchObject({
      targetDisplayId: 42
    });

    const cleared = await store.updateWorkspace(workspace.id, { targetDisplayId: null });
    expect(cleared).not.toHaveProperty("targetDisplayId");
    await expect(new LaunchWorkspaceStore(baseDir).getWorkspace(workspace.id)).resolves.not.toHaveProperty(
      "targetDisplayId"
    );

    const unchanged = await readFile(join(baseDir, "launch-workspaces.json"), "utf8");
    await expect(
      store.updateWorkspace(workspace.id, { targetDisplayId: -1 })
    ).rejects.toMatchObject({ code: "WORKSPACE_TARGET_DISPLAY_INVALID" });
    await expect(
      store.updateWorkspace(workspace.id, { targetDisplayId: 1.5 })
    ).rejects.toMatchObject({ code: "WORKSPACE_TARGET_DISPLAY_INVALID" });
    await expect(readFile(join(baseDir, "launch-workspaces.json"), "utf8")).resolves.toBe(unchanged);
  });

  it("uses four equal columns when no custom slots are provided", async () => {
    const workspace = await store.createWorkspace({ name: "Equal columns", template: "four_columns" });

    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 1 },
      { x: 0.25, y: 0, width: 0.25, height: 1 },
      { x: 0.5, y: 0, width: 0.25, height: 1 },
      { x: 0.75, y: 0, width: 0.25, height: 1 }
    ]);
  });

  it("creates a six-grid workspace with three slots per row and 80 percent zoom", async () => {
    const workspace = await store.createWorkspace({ name: "Six roles", template: "six_grid" });

    expect(workspace.browserZoomPercent).toBe(80);
    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 1 / 3, height: 0.5 },
      { x: 1 / 3, y: 0, width: 1 / 3, height: 0.5 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 0.5 },
      { x: 0, y: 0.5, width: 1 / 3, height: 0.5 },
      { x: 1 / 3, y: 0.5, width: 1 / 3, height: 0.5 },
      { x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.5 }
    ]);
    await expect(store.getWorkspace(workspace.id)).resolves.toMatchObject({
      template: "six_grid",
      browserZoomPercent: 80,
      slots: [
        { rect: { x: 0, y: 0, width: 0.3333, height: 0.5 } },
        { rect: { x: 0.3333, y: 0, width: 0.3333, height: 0.5 } },
        { rect: { x: 0.6667, y: 0, width: 0.3333, height: 0.5 } },
        { rect: { x: 0, y: 0.5, width: 0.3333, height: 0.5 } },
        { rect: { x: 0.3333, y: 0.5, width: 0.3333, height: 0.5 } },
        { rect: { x: 0.6667, y: 0.5, width: 0.3333, height: 0.5 } }
      ]
    });
  });

  it("creates an eight-grid workspace with four slots per row and 75 percent zoom", async () => {
    const workspace = await store.createWorkspace({ name: "Eight roles", template: "eight_grid" });

    expect(workspace.browserZoomPercent).toBe(75);
    expect(workspace.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 0.5 },
      { x: 0.25, y: 0, width: 0.25, height: 0.5 },
      { x: 0.5, y: 0, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0, width: 0.25, height: 0.5 },
      { x: 0, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.25, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }
    ]);
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
  });

  it("rejects duplicate names and roles outside the selected template", async () => {
    await store.createWorkspace({ name: "Party" });

    await expect(store.createWorkspace({ name: "party" })).rejects.toBeInstanceOf(LaunchWorkspaceStoreError);
    await expect(store.createWorkspace({ name: "party" })).rejects.toMatchObject({
      code: "WORKSPACE_NAME_DUPLICATE"
    });

    await expect(
      store.createWorkspace({
        name: "Solo",
        template: "single",
        slots: [{ roleId: "role-1" }, { roleId: "role-2" }]
      })
    ).rejects.toMatchObject({
      code: "WORKSPACE_SLOT_OUTSIDE_LAYOUT"
    });

    await expect(
      store.createWorkspace({
        name: "Three plus one",
        template: "three_columns",
        slots: [{ roleId: "role-1" }, { roleId: "role-2" }, { roleId: "role-3" }, { roleId: "role-4" }]
      })
    ).rejects.toMatchObject({
      code: "WORKSPACE_SLOT_OUTSIDE_LAYOUT"
    });

    await expect(
      store.createWorkspace({
        name: "Too many",
        template: "quad",
        slots: [{}, {}, {}, {}, {}, {}, {}, {}, {}]
      })
    ).rejects.toMatchObject({
      code: "WORKSPACE_TOO_MANY_SLOTS"
    });
  });

  it("normalizes stored legacy workspaces", async () => {
    await writeFile(
      join(baseDir, "launch-workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "workspace-1",
            name: "Legacy",
            template: "quad",
            slots: [
              { id: "a", roleId: "role-1" },
              { id: "b" },
              { id: "c" },
              { id: "d" }
            ],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const workspace = await store.getWorkspace("workspace-1");
    const unchanged = await readFile(join(baseDir, "launch-workspaces.json"), "utf8");

    expect(workspace.browserZoomPercent).toBe(100);
    expect(unchanged).not.toContain("browserZoomPercent");
    expect(workspace.slots).toMatchObject([
      { id: "a", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { id: "b", rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      { id: "c", rect: { x: 0, y: 0.5, width: 0.5, height: 0.5 } },
      { id: "d", rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }
    ]);
  });

  it("migrates legacy workspace slot role references and writes roleId", async () => {
    const path = join(baseDir, "launch-workspaces.json");
    await writeFile(
      path,
      JSON.stringify({
        workspaces: [
          {
            id: "workspace-1",
            name: "Legacy",
            template: "two_columns",
            slots: [
              { id: "left", [legacyRoleIdField]: " role-1 " },
              { id: "right", roleId: "role-2", [legacyRoleIdField]: "role-old" }
            ],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const workspace = await store.getWorkspace("workspace-1");

    expect(workspace.slots).toMatchObject([{ roleId: "role-1" }, { roleId: "role-2" }]);
    const migrated = await readFile(path, "utf8");
    expect(migrated).toContain('"roleId": "role-1"');
    expect(migrated).toContain('"roleId": "role-2"');
    expect(migrated).not.toContain(legacyRoleIdField);
  });

  it("clears deleted role references without deleting the workspace", async () => {
    const workspace = await store.createWorkspace({
      name: "Party",
      template: "two_columns",
      slots: [{ roleId: "role-1" }, { roleId: "role-2" }]
    });

    await store.clearRole("role-1");

    const updated = await store.getWorkspace(workspace.id);

    expect(updated.slots[0]).not.toHaveProperty("roleId");
    expect(updated.slots[1]).toMatchObject({ roleId: "role-2" });
  });
});
