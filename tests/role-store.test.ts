import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoleStore } from "../src/main/roles/RoleStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("RoleStore Rust adapter", () => {
  let store: RoleStore;
  let invoke: ReturnType<typeof vi.fn>;
  let resolveRolePaths: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-role-adapter-"));
    invoke = vi.fn(async (command: { id?: string; type: string }) => ({
      browserUserDataDir: join(baseDir, "roles", command.id ?? "unknown", "browser")
    }));
    resolveRolePaths = vi.fn((id: string) => ({
      browserUserDataDir: join(baseDir, "roles", id, "browser")
    }));
    store = new RoleStore(
      baseDir,
      new MemoryStateRepository(),
      { invoke, resolveRolePaths } as never
    );
  });

  it("delegates metadata CRUD and requests browser-directory effects from Rust", async () => {
    const role = await store.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    expect(invoke).not.toHaveBeenCalled();
    await expect(store.updateRole(role.id, { name: "Updated" })).resolves.toMatchObject({ name: "Updated" });
    await expect(store.updateBrowserSessionSource(role.id, "chrome-profile")).resolves.toMatchObject({
      browserSessionSource: "chrome-profile"
    });
    await store.deleteRole(role.id);
    expect(invoke).not.toHaveBeenCalled();
    await expect(store.getRole(role.id)).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("routes ensure and reset through Rust without filesystem access", async () => {
    const role = await store.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    invoke.mockClear();

    await expect(store.ensureBrowserUserDataDir(role.id)).resolves.toContain(role.id);
    await expect(store.resetBrowserUserDataDir(role.id)).resolves.toContain(role.id);

    expect(invoke).toHaveBeenCalledWith({ type: "roleBrowserDirectoryReset", id: role.id });
    expect(store.getRolePaths(role.id).browserUserDataDir).toContain(role.id);
    expect(resolveRolePaths).toHaveBeenCalledWith(role.id);
  });

  it("reorders roles through the repository", async () => {
    const first = await store.createRole({ gameId: "builtin-flyff-universe", name: "First" });
    const second = await store.createRole({ gameId: "builtin-flyff-universe", name: "Second" });
    await expect(store.reorderRoles({ orderedIds: [second.id, first.id] })).resolves.toMatchObject([
      { id: second.id }, { id: first.id }
    ]);
  });
});
