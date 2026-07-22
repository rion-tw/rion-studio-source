import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { MacroStore } from "../src/main/macros/MacroStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("MacroStore Rust adapter", () => {
  let store: MacroStore;

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-macro-adapter-"));
    store = new MacroStore(baseDir, new MemoryStateRepository());
  });

  it("normalizes input and delegates CRUD", async () => {
    const macro = await store.createMacro({
      name: "Buff",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    await expect(store.updateMacro(macro.id, { name: "Buff 2" })).resolves.toMatchObject({ name: "Buff 2" });
    await store.deleteMacro(macro.id);
    await expect(store.getMacro(macro.id)).rejects.toMatchObject({ code: "MACRO_NOT_FOUND" });
  });

  it("delegates role cleanup and bulk deletion", async () => {
    const macro = await store.createMacro({
      name: "Heal",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });
    await store.clearRoleAssignment("role-1");
    expect((await store.getMacro(macro.id)).roleIds).toEqual([]);
    await expect(store.deleteMacros([macro.id, "missing"])).resolves.toEqual({
      deletedIds: [macro.id],
      skipped: [{ id: "missing", reason: "not_found" }]
    });
  });
});
