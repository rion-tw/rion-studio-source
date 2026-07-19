import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MacroStore, MacroStoreError } from "../src/main/macros/MacroStore";
import { MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";

const legacyRoleIdField = "profile" + "Id";

describe("MacroStore", () => {
  let baseDir: string;
  let store: MacroStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-macro-test-"));
    store = new MacroStore(baseDir);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns isolated macro copies from the in-memory cache", async () => {
    const macro = await store.createMacro({
      name: "Buff",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    const listed = await store.listMacros();
    listed[0].roleIds.push("role-2");
    listed[0].steps[0].id = "mutated";

    await expect(store.getMacro(macro.id)).resolves.toMatchObject({
      roleIds: ["role-1"],
      steps: [expect.objectContaining({ id: "step-1" })]
    });
  });

  it("creates, updates, lists, and deletes macros with multiple assigned roles", async () => {
    const first = await store.createMacro({
      name: "Auto heal",
      roleIds: ["role-1", "role-2"],
      repeat: { type: "loop", intervalMs: 300 },
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });
    const second = await store.createMacro({
      name: "Pick up",
      roleIds: ["role-3"],
      steps: [{ id: "step-2", type: "key", code: "Space" }]
    });

    expect(first.roleIds).toEqual(["role-1", "role-2"]);
    expect(first.enabled).toBe(true);
    expect(await store.listMacros()).toMatchObject([{ id: first.id }, { id: second.id }]);

    const updated = await store.updateMacro(first.id, {
      name: "Auto heal 2",
      roleIds: ["role-4", "role-5"],
      repeat: { type: "once" },
      steps: [{ id: "step-3", type: "delay", ms: 50 }]
    });

    expect(updated).toMatchObject({
      name: "Auto heal 2",
      roleIds: ["role-4", "role-5"],
      repeat: { type: "once" },
      steps: [{ type: "delay", ms: 50 }]
    });

    await store.deleteMacro(second.id);
    await expect(store.getMacro(second.id)).rejects.toMatchObject({ code: "MACRO_NOT_FOUND" });
  });

  it("persists enabled state and defaults legacy records to enabled", async () => {
    const macro = await store.createMacro({
      enabled: false,
      name: "Paused",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });
    expect(macro.enabled).toBe(false);
    await expect(store.updateMacro(macro.id, { enabled: true })).resolves.toMatchObject({ enabled: true });

    const legacyDir = await mkdtemp(join(tmpdir(), "rion-macro-legacy-enabled-"));
    await writeFile(join(legacyDir, "macros.json"), JSON.stringify({
      macros: [{
        id: "legacy",
        name: "Legacy",
        roleIds: ["role-1"],
        repeat: { type: "once" },
        steps: [{ id: "step-1", type: "key", code: "F2" }],
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }]
    }), "utf8");

    await expect(new MacroStore(legacyDir).getMacro("legacy")).resolves.toMatchObject({
      enabled: true,
      activationMode: "toggle",
      steps: [{ action: "tap" }]
    });
    expect(JSON.parse(await readFile(join(legacyDir, "macros.json"), "utf8"))).toMatchObject({
      macros: [{ enabled: true, activationMode: "toggle", steps: [{ action: "tap" }] }]
    });
  });

  it("validates while-held activation and persists hold key actions", async () => {
    await expect(store.createMacro({
      activationMode: "while_held",
      name: "Missing shortcut",
      roleIds: ["role-1"],
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    })).rejects.toMatchObject({ code: "MACRO_WHILE_HELD_TRIGGER_REQUIRED" });

    await expect(store.createMacro({
      activationMode: "while_held",
      name: "Hold movement",
      roleIds: ["role-1"],
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    })).resolves.toMatchObject({
      activationMode: "while_held",
      steps: [{ action: "hold_until_stop" }]
    });
  });

  it("normalizes key modifiers and rejects ambiguous combinations", async () => {
    await expect(store.createMacro({
      name: "Combo",
      roleIds: ["role-1"],
      steps: [{
        id: "combo",
        type: "key",
        code: "KeyK",
        modifiers: ["shift", "ctrl", "shift"]
      }]
    })).resolves.toMatchObject({
      steps: [{ code: "KeyK", modifiers: ["ctrl", "shift"] }]
    });

    await expect(store.createMacro({
      name: "Primary conflict",
      roleIds: ["role-1"],
      steps: [{
        id: "combo",
        type: "key",
        code: "KeyK",
        modifiers: ["primary", "ctrl"]
      }]
    })).rejects.toMatchObject({ code: "MACRO_KEY_PRIMARY_CONFLICT" });

    await expect(store.createMacro({
      name: "Modifier main key",
      roleIds: ["role-1"],
      steps: [{
        id: "combo",
        type: "key",
        code: "ControlLeft",
        modifiers: ["shift"]
      }]
    })).rejects.toMatchObject({ code: "MACRO_KEY_COMBINATION_INVALID" });

    await expect(store.createMacro({
      name: "Unknown modifier",
      roleIds: ["role-1"],
      steps: [{
        id: "combo",
        type: "key",
        code: "KeyK",
        modifiers: ["hyper" as never]
      }]
    })).rejects.toMatchObject({ code: "MACRO_KEY_MODIFIERS_INVALID" });
  });

  it("does not allow a called macro to hold a key until stopped", async () => {
    const child = await store.createMacro({
      name: "Held child",
      roleIds: ["role-1"],
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    });

    await expect(store.createMacro({
      name: "Parent",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: child.id }]
    })).rejects.toMatchObject({ code: "MACRO_STEP_TARGET_HOLDS_KEY" });
  });

  it("allows duplicate names and validates the 24-hour timing boundary", async () => {
    const first = await store.createMacro({
      name: "Auto heal",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });

    const duplicate = await store.createMacro({
      name: "auto heal",
      roleIds: ["role-1"],
      steps: [{ id: "step-2", type: "key", code: "F3" }]
    });
    const updated = await store.updateMacro(duplicate.id, { name: first.name });

    expect(duplicate.name).toBe("auto heal");
    expect(updated.name).toBe("Auto heal");
    const duplicates = (await store.listMacros()).filter((macro) => macro.name.toLocaleLowerCase() === "auto heal");
    expect(duplicates).toHaveLength(2);

    await expect(
      store.createMacro({
        name: "Daily loop",
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS },
        steps: [{ id: "step-1", type: "delay", ms: MACRO_DELAY_MAX_MS }]
      })
    ).resolves.toMatchObject({
      repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS },
      steps: [{ type: "delay", ms: MACRO_DELAY_MAX_MS }]
    });

    await expect(
      store.createMacro({
        name: "Bad delay",
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "delay", ms: MACRO_DELAY_MAX_MS + 1 }]
      })
    ).rejects.toBeInstanceOf(MacroStoreError);
    await expect(
      store.createMacro({
        name: "Bad delay",
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "delay", ms: MACRO_DELAY_MAX_MS + 1 }]
      })
    ).rejects.toMatchObject({ code: "MACRO_TIME_INVALID" });
    await expect(
      store.createMacro({
        name: "Bad loop",
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS + 1 },
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_TIME_INVALID" });
  });

  it("requires a valid role array while allowing an unassigned macro", async () => {
    await expect(
      store.createMacro({
        name: "Unassigned",
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      } as never)
    ).rejects.toMatchObject({ code: "MACRO_ROLE_ID_INVALID" });

    await expect(
      store.createMacro({
        name: "Blank role",
        roleIds: [" "],
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_ROLE_ID_INVALID" });

    await expect(store.createMacro({
      name: "Empty roles",
      roleIds: [],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    })).resolves.toMatchObject({ roleIds: [] });
  });

  it("deduplicates and trims assigned roles", async () => {
    const macro = await store.createMacro({
      name: "Shared",
      roleIds: [" role-1 ", "role-2", "role-1"],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });

    expect(macro.roleIds).toEqual(["role-1", "role-2"]);
  });

  it("rejects invalid click percentages and empty steps", async () => {
    await expect(
      store.createMacro({
        name: "Bad click",
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "click", xPercent: 101, yPercent: 50 }]
      })
    ).rejects.toMatchObject({ code: "MACRO_CLICK_PERCENT_INVALID" });

    await expect(
      store.createMacro({
        name: "Empty",
        roleIds: ["role-1"],
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
            roleIds: [" role-1 ", "role-2"],
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

    expect(macro.roleIds).toEqual(["role-1", "role-2"]);
    expect(macro.steps).toMatchObject([
      { type: "key", code: "Tab", label: "Tab" },
      { type: "click", xPercent: 50.12, yPercent: 49.99 }
    ]);
    expect(macro.steps[0].id).toBeTruthy();
    expect(macro.steps[1].id).toBeTruthy();
    expect(macro.steps[0].id).not.toBe(macro.steps[1].id);
  });

  it("migrates legacy macro role assignments and writes roleIds", async () => {
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
      { id: "macro-1", roleIds: ["role-1"] },
      { id: "macro-2", roleIds: ["role-2"] }
    ]);
    const migrated = await readFile(path, "utf8");
    expect(migrated).toContain('"roleIds": [');
    expect(migrated).toContain('"role-1"');
    expect(migrated).toContain('"role-2"');
    expect(migrated).not.toContain('"roleId"');
    expect(migrated).not.toContain(legacyRoleIdField);
  });

  it("accepts stored macros with roleIds", async () => {
    await writeFile(
      join(baseDir, "macros.json"),
      JSON.stringify({
        macros: [
          {
            id: "macro-1",
            name: "Modern",
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

    await expect(store.listMacros()).resolves.toMatchObject([{ id: "macro-1", roleIds: ["role-1"] }]);
  });

  it("clears deleted role assignments while preserving macros and their dependents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T01:00:00.000Z"));
    const deletedRoleOnlyMacro = await store.createMacro({
      name: "Role 1",
      roleIds: ["role-1"],
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    const remainingMacro = await store.createMacro({
      name: "Role 2",
      roleIds: ["role-1", "role-2"],
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    const parentMacro = await store.createMacro({
      name: "Parent",
      roleIds: ["role-2"],
      steps: [{ id: "call-child", type: "macro", macroId: deletedRoleOnlyMacro.id }]
    });

    vi.setSystemTime(new Date("2026-07-19T02:00:00.000Z"));
    await store.clearRoleAssignment("role-1");

    await expect(store.getMacro(deletedRoleOnlyMacro.id)).resolves.toMatchObject({
      id: deletedRoleOnlyMacro.id,
      roleIds: [],
      updatedAt: "2026-07-19T02:00:00.000Z"
    });
    await expect(store.getMacro(remainingMacro.id)).resolves.toMatchObject({
      id: remainingMacro.id,
      roleIds: ["role-2"],
      updatedAt: "2026-07-19T02:00:00.000Z"
    });
    await expect(store.getMacro(parentMacro.id)).resolves.toMatchObject({
      id: parentMacro.id,
      roleIds: ["role-2"],
      updatedAt: "2026-07-19T01:00:00.000Z"
    });
    await expect(new MacroStore(baseDir).listMacros()).resolves.toHaveLength(3);
  });

  it("serializes concurrent role cleanup without losing either mutation", async () => {
    const macro = await store.createMacro({
      name: "Shared",
      roleIds: ["role-1", "role-2", "role-3"],
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });

    await expect(
      Promise.all([store.clearRoleAssignment("role-1"), store.clearRoleAssignment("role-2")])
    ).resolves.toEqual([undefined, undefined]);
    await expect(store.getMacro(macro.id)).resolves.toMatchObject({ roleIds: ["role-3"] });
  });

  it("accepts and preserves zero loop waits", async () => {
    await expect(
      store.createMacro({
        name: "Immediate loop",
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: 0 },
        steps: [{ id: "step-1", type: "delay", ms: 0 }]
      })
    ).resolves.toMatchObject({ repeat: { type: "loop", intervalMs: 0 } });

    await writeFile(
      join(baseDir, "macros.json"),
      JSON.stringify({
        macros: [{
          id: "legacy-loop",
          name: "Legacy loop",
          roleIds: ["role-1"],
          repeat: { type: "loop", intervalMs: 0 },
          steps: [{ id: "step-1", type: "delay", ms: 0 }],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z"
        }]
      }),
      "utf8"
    );

    const reloadedStore = new MacroStore(baseDir);
    await expect(reloadedStore.getMacro("legacy-loop")).resolves.toMatchObject({
      repeat: { type: "loop", intervalMs: 0 }
    });
  });

  it("rejects reserved and overlapping shortcuts while allowing separate roles", async () => {
    const trigger = { code: "F2", ctrl: false, alt: false, shift: false, meta: false };
    await expect(
      store.createMacro({
        name: "Reserved",
        roleIds: ["role-1"],
        trigger: { code: "KeyM", ctrl: true, alt: false, shift: true, meta: false },
        steps: [{ id: "step-1", type: "key", code: "F1" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_TRIGGER_RESERVED" });

    await store.createMacro({
      name: "First",
      roleIds: ["role-1"],
      trigger,
      steps: [{ id: "step-1", type: "key", code: "F1" }]
    });
    await expect(
      store.createMacro({
        name: "Conflict",
        roleIds: ["role-1", "role-2"],
        trigger,
        steps: [{ id: "step-2", type: "key", code: "F1" }]
      })
    ).rejects.toMatchObject({ code: "MACRO_TRIGGER_CONFLICT" });
    await expect(
      store.createMacro({
        name: "Separate role",
        roleIds: ["role-2"],
        trigger,
        steps: [{ id: "step-3", type: "key", code: "F1" }]
      })
    ).resolves.toMatchObject({ trigger });
  });

  it("stores macro steps by id and preserves references when the target is renamed", async () => {
    const target = await store.createMacro({
      name: "Target",
      roleIds: ["role-2"],
      steps: [{ id: "target-key", type: "key", code: "F2" }]
    });
    const parent = await store.createMacro({
      name: "Parent",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });

    await store.updateMacro(target.id, { name: "Renamed target" });

    await expect(store.getMacro(parent.id)).resolves.toMatchObject({
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });
  });

  it("allows calling a looping macro", async () => {
    const repeating = await store.createMacro({
      name: "Repeating",
      roleIds: ["role-2"],
      repeat: { type: "loop", intervalMs: 100 },
      steps: [{ id: "wait", type: "delay", ms: 1 }]
    });

    await expect(store.createMacro({
      name: "Calls repeating",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: repeating.id }]
    })).resolves.toMatchObject({
      steps: [{ id: "call", type: "macro", macroId: repeating.id }]
    });
  });

  it("rejects missing, direct-cycle, and indirect-cycle macro dependencies", async () => {
    await expect(store.createMacro({
      name: "Missing target",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: "missing" }]
    })).rejects.toMatchObject({ code: "MACRO_STEP_TARGET_NOT_FOUND" });

    const first = await store.createMacro({
      name: "First",
      roleIds: ["role-1"],
      steps: [{ id: "key", type: "key", code: "F1" }]
    });
    await expect(store.updateMacro(first.id, {
      steps: [{ id: "self", type: "macro", macroId: first.id }]
    })).rejects.toMatchObject({ code: "MACRO_DEPENDENCY_CYCLE" });

    const second = await store.createMacro({
      name: "Second",
      roleIds: ["role-2"],
      steps: [{ id: "call-first", type: "macro", macroId: first.id }]
    });
    await expect(store.updateMacro(first.id, {
      steps: [{ id: "call-second", type: "macro", macroId: second.id }]
    })).rejects.toMatchObject({ code: "MACRO_DEPENDENCY_CYCLE" });
  });

  it("allows a referenced target to become a looping macro", async () => {
    const target = await store.createMacro({
      name: "Target",
      roleIds: ["role-2"],
      steps: [{ id: "key", type: "key", code: "F2" }]
    });
    await store.createMacro({
      name: "Parent",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });

    await expect(store.updateMacro(target.id, {
      repeat: { type: "loop", intervalMs: 100 }
    })).resolves.toMatchObject({ repeat: { type: "loop", intervalMs: 100 } });
  });

  it("prevents a referenced target from adding a held key", async () => {
    const target = await store.createMacro({
      name: "Target",
      roleIds: ["role-2"],
      steps: [{ id: "key", type: "key", code: "F2" }]
    });
    await store.createMacro({
      name: "Parent",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });

    await expect(store.updateMacro(target.id, {
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    })).rejects.toMatchObject({ code: "MACRO_STEP_TARGET_HOLDS_KEY" });
  });

  it("blocks deleting a referenced macro and reports every direct referrer", async () => {
    const target = await store.createMacro({
      name: "Target",
      roleIds: ["role-3"],
      steps: [{ id: "key", type: "key", code: "F3" }]
    });
    await store.createMacro({
      name: "Parent one",
      roleIds: ["role-1"],
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });
    await store.createMacro({
      name: "Parent two",
      roleIds: ["role-2"],
      steps: [{ id: "call", type: "macro", macroId: target.id }]
    });

    await expect(store.deleteMacro(target.id)).rejects.toMatchObject({
      code: "MACRO_IN_USE",
      details: { relatedNames: ["Parent one", "Parent two"] }
    });
  });

  it("bulk-deletes a complete dependency closure atomically and skips incomplete chains", async () => {
    const child = await store.createMacro({
      name: "Child",
      roleIds: ["role-3"],
      steps: [{ id: "key", type: "key", code: "F3" }]
    });
    const parent = await store.createMacro({
      name: "Parent",
      roleIds: ["role-2"],
      steps: [{ id: "call-child", type: "macro", macroId: child.id }]
    });
    const root = await store.createMacro({
      name: "Root",
      roleIds: ["role-1"],
      steps: [{ id: "call-parent", type: "macro", macroId: parent.id }]
    });

    await expect(store.deleteMacros([parent.id, child.id])).resolves.toEqual({
      deletedIds: [],
      skipped: [
        { id: parent.id, reason: "in_use", relatedNames: ["Root"] },
        { id: child.id, reason: "in_use", relatedNames: ["Parent"] }
      ]
    });
    await expect(store.deleteMacros([root.id, parent.id, child.id])).resolves.toEqual({
      deletedIds: [root.id, parent.id, child.id],
      skipped: []
    });
    await expect(store.listMacros()).resolves.toEqual([]);
  });
});
