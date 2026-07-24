import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { LaunchWorkspaceStore } from "../src/main/workspaces/LaunchWorkspaceStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("LaunchWorkspaceStore Rust adapter", () => {
  let store: LaunchWorkspaceStore;

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-workspace-adapter-"));
    store = new LaunchWorkspaceStore(baseDir, new MemoryStateRepository());
  });

  it("normalizes the Electron input and delegates CRUD", async () => {
    const workspace = await store.createWorkspace({ name: "Party" });
    expect(workspace).toMatchObject({
      name: "Party",
      template: "two_columns"
    });
    await expect(store.updateWorkspace(workspace.id, { browserZoomPercent: 90 })).resolves.toMatchObject({
      browserZoomPercent: 90
    });
    await store.deleteWorkspace(workspace.id);
    await expect(store.getWorkspace(workspace.id)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("delegates role cleanup and ordering", async () => {
    const first = await store.createWorkspace({ name: "First", slots: [{ roleId: "role-1" }, {}] });
    const second = await store.createWorkspace({ name: "Second" });
    await store.clearRole("role-1");
    expect((await store.getWorkspace(first.id)).slots[0]).not.toHaveProperty("roleId");
    await expect(store.reorderWorkspaces({ orderedIds: [second.id, first.id] })).resolves.toMatchObject([
      { id: second.id }, { id: first.id }
    ]);
  });
});
