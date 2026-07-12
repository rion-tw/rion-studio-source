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
      template: "two_columns"
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
    await expect(store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
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
        slots: [{}, {}, {}, {}, {}]
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
