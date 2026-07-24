import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoleStore } from "../src/main/roles/RoleStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("RoleStore Rust adapter", () => {
  let store: RoleStore;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-role-adapter-"));
    const memoryCore = new MemoryStateRepository();
    invoke = vi.fn(async (command: { id?: string; type: string }) =>
      command.type === "rolePathsResolve" ||
      command.type === "roleBrowserDirectoryEnsure" ||
      command.type === "roleBrowserDirectoryReset"
        ? { browserUserDataDir: join(baseDir, "roles", command.id ?? "unknown", "browser") }
        : memoryCore.invoke(command as never)
    );
    store = new RoleStore(
      baseDir,
      { invoke } as never
    );
  });

  it("delegates metadata CRUD and requests browser-directory effects from Rust", async () => {
    const role = await store.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ type: "roleCreate" }));
    await expect(store.updateRole(role.id, { name: "Updated" })).resolves.toMatchObject({ name: "Updated" });
    await expect(store.updateBrowserSessionSource(role.id, "chrome-profile")).resolves.toMatchObject({
      browserSessionSource: "chrome-profile"
    });
    await store.deleteRole(role.id);
    expect(invoke).toHaveBeenCalledWith({ type: "roleDelete", id: role.id });
    await expect(store.getRole(role.id)).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("routes ensure and reset through Rust without filesystem access", async () => {
    const role = await store.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    invoke.mockClear();

    await expect(store.ensureBrowserUserDataDir(role.id)).resolves.toContain(role.id);
    await expect(store.resetBrowserUserDataDir(role.id)).resolves.toContain(role.id);

    expect(invoke).toHaveBeenCalledWith({ type: "roleBrowserDirectoryReset", id: role.id });
    await expect(store.getRolePaths(role.id)).resolves.toMatchObject({
      browserUserDataDir: expect.stringContaining(role.id)
    });
  });

  it("reorders roles through the repository", async () => {
    const first = await store.createRole({ gameId: "builtin-flyff-universe", name: "First" });
    const second = await store.createRole({ gameId: "builtin-flyff-universe", name: "Second" });
    await expect(store.reorderRoles({ orderedIds: [second.id, first.id] })).resolves.toMatchObject([
      { id: second.id }, { id: first.id }
    ]);
  });
});
