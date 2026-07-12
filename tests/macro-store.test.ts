import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { MacroStore, MacroStoreError } from "../src/main/macros/MacroStore";

const legacyRoleIdField = "profile" + "Id";

describe("MacroStore", () => {
  let baseDir: string;
  let store: MacroStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-macro-test-"));
    store = new MacroStore(baseDir);
  });

  it("creates, updates, lists, and deletes macros", async () => {
    const first = await store.createMacro({
      name: "Auto heal",
      roleId: "role-1",
      repeat: { type: "loop", intervalMs: 300 },
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });
    const second = await store.createMacro({
      name: "Pick up",
      roleId: "role-2",
      steps: [{ id: "step-2", type: "key", code: "Space" }]
    });

    expect(first.roleId).toBe("role-1");
    expect(await store.listMacros()).toMatchObject([{ id: first.id }, { id: second.id }]);

    const updated = await store.updateMacro(first.id, {
      name: "Auto heal 2",
      roleId: "role-3",
      repeat: { type: "once" },
      steps: [{ id: "step-3", type: "delay", ms: 50 }]
    });

    expect(updated).toMatchObject({
      name: "Auto heal 2",
      roleId: "role-3",
      repeat: { type: "once" },
      steps: [{ type: "delay", ms: 50 }]
    });

    await store.deleteMacro(second.id);
    await expect(store.getMacro(second.id)).rejects.toMatchObject({ code: "MACRO_NOT_FOUND" });
  });

  it("rejects duplicate names and invalid step timing", async () => {
    await store.createMacro({
      name: "Auto heal",
      roleId: "role-1",
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });

    await expect(
      store.createMacro({
        name: "auto heal",
        roleId: "role-1",
        steps: [{ id: "step-2", type: "key", code: "F3" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_NAME_DUPLICATE" });

    await expect(
      store.createMacro({
        name: "Bad delay",
        roleId: "role-1",
        steps: [{ id: "step-1", type: "delay", ms: 600_001 }]
      })
    ).rejects.toBeInstanceOf(MacroStoreError);
    await expect(
      store.createMacro({
        name: "Bad delay",
        roleId: "role-1",
        steps: [{ id: "step-1", type: "delay", ms: 600_001 }]
      })
    ).rejects.toMatchObject({ code: "MACRO_TIME_INVALID" });
  });

  it("requires exactly one assigned role", async () => {
    await expect(
      store.createMacro({
        name: "Unassigned",
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      } as never)
    ).rejects.toMatchObject({ code: "MACRO_ROLE_ID_INVALID" });

    await expect(
      store.createMacro({
        name: "Blank role",
        roleId: " ",
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_ROLE_ID_INVALID" });
  });

  it("rejects invalid click percentages and empty steps", async () => {
    await expect(
      store.createMacro({
        name: "Bad click",
        roleId: "role-1",
        steps: [{ id: "step-1", type: "click", xPercent: 101, yPercent: 50 }]
      })
    ).rejects.toMatchObject({ code: "MACRO_CLICK_PERCENT_INVALID" });

    await expect(
      store.createMacro({
        name: "Empty",
        roleId: "role-1",
        steps: []
      })
    ).rejects.toMatchObject({ code: "MACRO_STEPS_REQUIRED" });
  });

  it("normalizes stored macros", async () => {
    await writeFile(
      join(baseDir, "macros.json"),
      JSON.stringify({
        macros: [
          {
            id: "macro-1",
            name: "Legacy",
            roleId: " role-1 ",
            repeat: { type: "once" },
            steps: [
              { id: "", type: "key", code: "Tab", label: " Tab " },
              { id: "", type: "click", xPercent: 50.123, yPercent: 49.987 }
            ],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const macro = await store.getMacro("macro-1");

    expect(macro.roleId).toBe("role-1");
    expect(macro.steps).toMatchObject([
      { type: "key", code: "Tab", label: "Tab" },
      { type: "click", xPercent: 50.12, yPercent: 49.99 }
    ]);
    expect(macro.steps[0].id).toBeTruthy();
    expect(macro.steps[1].id).toBeTruthy();
    expect(macro.steps[0].id).not.toBe(macro.steps[1].id);
  });

  it("migrates legacy macro role assignments and writes roleId", async () => {
    const path = join(baseDir, "macros.json");
    await writeFile(
      path,
      JSON.stringify({
        macros: [
          {
            id: "macro-1",
            name: "Legacy",
            [legacyRoleIdField]: " role-1 ",
            repeat: { type: "once" },
            steps: [{ id: "step-1", type: "key", code: "F1" }],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          },
          {
            id: "macro-2",
            name: "Modern wins",
            roleId: "role-2",
            [legacyRoleIdField]: "role-old",
            repeat: { type: "once" },
            steps: [{ id: "step-2", type: "key", code: "F2" }],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    const macros = await store.listMacros();

    expect(macros).toMatchObject([
      { id: "macro-1", roleId: "role-1" },
      { id: "macro-2", roleId: "role-2" }
    ]);
    const migrated = await readFile(path, "utf8");
    expect(migrated).toContain('"roleId": "role-1"');
    expect(migrated).toContain('"roleId": "role-2"');
    expect(migrated).not.toContain(legacyRoleIdField);
  });

  it("rejects stored legacy macros without a single roleId", async () => {
    await writeFile(
      join(baseDir, "macros.json"),
      JSON.stringify({
        macros: [
          {
            id: "macro-1",
            name: "Legacy",
            roleIds: ["role-1"],
            repeat: { type: "once" },
            steps: [{ id: "step-1", type: "key", code: "F1" }],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      }),
      "utf8"
    );

    await expect(store.listMacros()).rejects.toMatchObject({ code: "MACRO_ROLE_ID_INVALID" });
  });

  it("deletes macros assigned to a deleted role", async () => {
    const deletedRoleMacro = await store.createMacro({
      name: "Role 1",
      roleId: "role-1",
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    const remainingMacro = await store.createMacro({
      name: "Role 2",
      roleId: "role-2",
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });

    await store.deleteRoleMacros("role-1");

    await expect(store.getMacro(deletedRoleMacro.id)).rejects.toMatchObject({ code: "MACRO_NOT_FOUND" });
    await expect(store.getMacro(remainingMacro.id)).resolves.toMatchObject({
      id: remainingMacro.id,
      roleId: "role-2"
    });
  });
});
