import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MacroStore } from "../src/main/macros/MacroStore";
import { PortableDataManager } from "../src/main/portable/PortableDataManager";
import { RoleStore } from "../src/main/roles/RoleStore";
import { LaunchWorkspaceStore } from "../src/main/workspaces/LaunchWorkspaceStore";
import { DEFAULT_BROWSER_NETWORK_SETTINGS } from "../src/shared/browserFonts";
import type { RionPortableDataV1 } from "../src/shared/types";
import { getDefaultWorkspaceRects } from "../src/shared/workspaceLayout";

describe("PortableDataManager", () => {
  let baseDir: string;
  let roleStore: RoleStore;
  let workspaceStore: LaunchWorkspaceStore;
  let macroStore: MacroStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-portable-test-"));
    roleStore = new RoleStore(baseDir);
    workspaceStore = new LaunchWorkspaceStore(baseDir);
    macroStore = new MacroStore(baseDir);
  });

  it("exports portable JSON without browser session or auth metadata", async () => {
    const exportPath = join(baseDir, "rion-export.json");
    const role = await roleStore.createRole({
      name: "Main",
      launchUrl: "https://example.com/play",
      notes: "Carry me"
    });
    await roleStore.updateAuthState(role.id, "authenticated", "2026-07-10T01:00:00.000Z");
    await workspaceStore.createWorkspace({
      name: "Party",
      browserZoomPercent: 75,
      targetDisplayId: 42,
      slots: [
        {
          id: "slot-1",
          roleId: role.id,
          rect: { x: 0, y: 0, width: 0.5, height: 1 }
        }
      ]
    });
    await macroStore.createMacro({
      name: "Auto heal",
      roleIds: [role.id],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });

    const manager = createManager({
      exportPath,
      macroStore,
      roleStore,
      workspaceStore
    });

    const result = await manager.exportData({
      preferences: {
        gameBrowserSettings: {
          fonts: {
            families: {
              fixed: "Courier New",
              math: "Noto Sans Math",
              standard: "Arial"
            },
            mode: "custom"
          },
          graphics: { mode: "high_performance" },
          launchMode: "external",
          network: DEFAULT_BROWSER_NETWORK_SETTINGS,
          workspace: { background: "black", gap: 1 }
        },
        language: "zh-TW",
        roleDefaults: {
          windowWidth: 1920,
          windowHeight: 1080,
          launchPreset: "balanced"
        },
        themeMode: "dark"
      }
    });
    const parsed = JSON.parse(await readFile(exportPath, "utf8")) as RionPortableDataV1;

    expect(result).toMatchObject({ roleCount: 1, workspaceCount: 1, macroCount: 1 });
    expect(parsed).toMatchObject({
      app: "Rion Studio",
      schemaVersion: 1,
      appVersion: "1.2.3",
      preferences: {
        gameBrowserSettings: {
          fonts: {
            families: {
              fixed: "Courier New",
              math: "Noto Sans Math",
              standard: "Arial"
            },
            mode: "custom"
          },
          workspace: { background: "black", gap: 1 }
        },
        language: "zh-TW",
        roleDefaults: {
          windowWidth: 1920,
          windowHeight: 1080,
          launchPreset: "balanced"
        },
        themeMode: "dark"
      }
    });
    expect(parsed.roles[0]).toMatchObject({
      id: role.id,
      name: "Main",
      launchUrl: "https://example.com/play"
    });
    expect(parsed.roles[0]).not.toHaveProperty("authState");
    expect(parsed.roles[0]).not.toHaveProperty("lastAuthCheckAt");
    expect(parsed.roles[0]).not.toHaveProperty("lastSuccessfulLoginAt");
    expect(parsed.roles[0]).not.toHaveProperty("browserUserDataDir");
    expect(parsed.launchWorkspaces[0]).toMatchObject({ browserZoomPercent: 75 });
    expect(parsed.launchWorkspaces[0]).not.toHaveProperty("targetDisplayId");
  });

  it("previews and applies an import with remapped role references", async () => {
    const importPath = join(baseDir, "incoming.json");
    const existingRole = await roleStore.createRole({ name: "Main" });
    await workspaceStore.createWorkspace({ name: "Party" });
    await macroStore.createMacro({
      name: "Auto heal",
      roleIds: [existingRole.id],
      steps: [{ id: "step-existing", type: "key", code: "F1" }]
    });
    await writeFile(importPath, `${JSON.stringify(createPortableFixture(), null, 2)}\n`, "utf8");

    const manager = createManager({
      importPath,
      importId: "import-1",
      macroStore,
      roleStore,
      workspaceStore
    });

    const preview = await manager.previewImport();

    expect(preview).toMatchObject({
      importId: "import-1",
      roleCount: 1,
      workspaceCount: 1,
      macroCount: 1,
      preferences: {
        gameBrowserSettings: {
          fonts: {
            families: {
              standard: "Missing But Valid Font"
            },
            mode: "custom"
          },
          workspace: { background: "black", gap: 16 }
        },
        language: "ja",
        roleDefaults: {
          windowWidth: 1280,
          windowHeight: 720,
          launchPreset: "balanced"
        },
        themeMode: "light"
      }
    });
    expect(preview?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ROLE_NAME_RENAMED", replacementName: "Main (Imported)" }),
        expect.objectContaining({ code: "WORKSPACE_NAME_RENAMED", replacementName: "Party (Imported)" }),
        expect.objectContaining({ code: "WORKSPACE_ROLE_MISSING", count: 1 }),
        expect.objectContaining({ code: "MACRO_ROLE_MISSING", count: 1 }),
        expect.objectContaining({ code: "MACRO_SKIPPED_NO_ROLES", itemName: "Orphan" })
      ])
    );
    expect(preview?.warnings.some((warning) => warning.code === "MACRO_NAME_RENAMED")).toBe(false);

    const result = await manager.applyImport("import-1");

    expect(result).toMatchObject({
      roleCount: 1,
      workspaceCount: 1,
      macroCount: 1,
      preferences: {
        gameBrowserSettings: {
          fonts: {
            families: {
              standard: "Missing But Valid Font"
            },
            mode: "custom"
          },
          workspace: { background: "black", gap: 16 }
        },
        roleDefaults: {
          windowWidth: 1280,
          windowHeight: 720,
          launchPreset: "balanced"
        }
      }
    });
    const importedRole = (await roleStore.listRoles()).find((role) => role.name === "Main (Imported)");
    expect(importedRole).toMatchObject({
      authState: "login_required",
      launchUrl: "https://example.org/play"
    });

    const importedWorkspace = (await workspaceStore.listWorkspaces()).find(
      (workspace) => workspace.name === "Party (Imported)"
    );
    expect(importedWorkspace?.slots[0]).toMatchObject({ roleId: importedRole?.id });
    expect(importedWorkspace?.slots[1]).not.toHaveProperty("roleId");

    const macros = await macroStore.listMacros();
    const importedMacro = macros.find((macro) => macro.name === "Auto heal" && macro.roleIds[0] === importedRole?.id);
    expect(importedMacro?.roleIds).toEqual([importedRole?.id]);
    expect(macros.filter((macro) => macro.name === "Auto heal")).toHaveLength(2);
    expect(macros.some((macro) => macro.name === "Orphan")).toBe(false);
  });

  it("rejects invalid portable JSON", async () => {
    const importPath = join(baseDir, "invalid.json");
    await writeFile(importPath, JSON.stringify({ app: "Rion Studio", schemaVersion: 999 }), "utf8");
    const manager = createManager({
      importPath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(manager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
  });

  it("accepts eight-grid portable workspaces and rejects a ninth slot", async () => {
    const importPath = join(baseDir, "eight-grid.json");
    const fixture = createPortableFixture();
    fixture.launchWorkspaces[0] = {
      ...fixture.launchWorkspaces[0],
      template: "eight_grid",
      browserZoomPercent: 75,
      slots: getDefaultWorkspaceRects("eight_grid").map((rect, index) => ({
        id: `slot-${index + 1}`,
        ...(index === 0 ? { roleId: "old-role" } : {}),
        rect
      }))
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(manager.previewImport()).resolves.toMatchObject({ workspaceCount: 1 });

    fixture.launchWorkspaces[0].slots.push({
      id: "slot-9",
      rect: { x: 0, y: 0, width: 0.5, height: 0.5 }
    });
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const invalidManager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(invalidManager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
  });

  it("repairs legacy rounded thirds while importing portable workspaces", async () => {
    const importPath = join(baseDir, "legacy-thirds.json");
    const fixture = createPortableFixture();
    fixture.launchWorkspaces[0] = {
      ...fixture.launchWorkspaces[0],
      template: "three_columns",
      browserZoomPercent: 90,
      slots: [
        { id: "slot-1", roleId: "old-role", rect: { x: 0, y: 0, width: 0.3333, height: 1 } },
        { id: "slot-2", rect: { x: 0.3333, y: 0, width: 0.3333, height: 1 } },
        { id: "slot-3", rect: { x: 0.6667, y: 0, width: 0.3333, height: 1 } }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();
    await manager.applyImport(preview!.importId);

    const importedWorkspace = (await workspaceStore.listWorkspaces()).find(
      (candidate) => candidate.template === "three_columns"
    );
    expect(importedWorkspace?.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 0.3333, height: 1 },
      { x: 0.3333, y: 0, width: 0.3334, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ]);
  });

  it("clears reserved and overlapping shortcuts before applying an import", async () => {
    const importPath = join(baseDir, "shortcut-conflicts.json");
    const fixture = createPortableFixture();
    fixture.macros[0].trigger = { code: "F2", ctrl: false, alt: false, shift: false, meta: false };
    fixture.macros.push(
      {
        id: "conflicting-macro",
        name: "Conflict",
        roleIds: ["old-role"],
        trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
        repeat: { type: "once" },
        steps: [{ id: "step-3", type: "key", code: "F3" }]
      },
      {
        id: "reserved-macro",
        name: "Reserved",
        roleIds: ["old-role"],
        trigger: { code: "KeyM", ctrl: true, alt: false, shift: true, meta: false },
        repeat: { type: "once" },
        steps: [{ id: "step-4", type: "key", code: "F4" }]
      }
    );
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MACRO_SHORTCUT_CLEARED_CONFLICT", itemName: "Conflict" }),
        expect.objectContaining({ code: "MACRO_SHORTCUT_CLEARED_RESERVED", itemName: "Reserved" })
      ])
    );

    await manager.applyImport(preview!.importId);
    const macros = await macroStore.listMacros();
    expect(macros.find((macro) => macro.name === "Auto heal")?.trigger).toMatchObject({ code: "F2" });
    expect(macros.find((macro) => macro.name === "Conflict")?.trigger).toBeUndefined();
    expect(macros.find((macro) => macro.name === "Reserved")?.trigger).toBeUndefined();
  });

  it("accepts missing role defaults and ignores invalid role defaults in portable preferences", async () => {
    const legacyImportPath = join(baseDir, "legacy-preferences.json");
    const legacyFixture = createPortableFixture();
    legacyFixture.preferences = {
      language: "en",
      themeMode: "system"
    };
    await writeFile(legacyImportPath, `${JSON.stringify(legacyFixture, null, 2)}\n`, "utf8");

    const legacyManager = createManager({
      importPath: legacyImportPath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(legacyManager.previewImport()).resolves.toMatchObject({
      preferences: {
        language: "en",
        themeMode: "system"
      }
    });

    const invalidImportPath = join(baseDir, "invalid-role-defaults.json");
    const invalidFixture = createPortableFixture();
    invalidFixture.preferences = {
      language: "zh-TW",
      roleDefaults: {
        windowWidth: 100,
        windowHeight: 1080,
        launchPreset: "balanced"
      }
    };
    await writeFile(invalidImportPath, `${JSON.stringify(invalidFixture, null, 2)}\n`, "utf8");

    const invalidManager = createManager({
      importPath: invalidImportPath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(invalidManager.previewImport()).resolves.toMatchObject({
      preferences: {
        language: "zh-TW"
      }
    });
    await expect(invalidManager.previewImport()).resolves.not.toMatchObject({
      preferences: {
        roleDefaults: expect.anything()
      }
    });
  });

  it("normalizes invalid portable browser font settings without blocking import", async () => {
    const importPath = join(baseDir, "invalid-browser-fonts.json");
    const fixture = createPortableFixture();
    fixture.preferences = {
      gameBrowserSettings: {
        fonts: {
          families: {
            fixed: "Bad\u0000Font",
            math: "Noto Sans Math",
            standard: "  Missing   But   Valid  Font  "
          },
          mode: "custom"
        },
        graphics: { mode: "automatic" },
        launchMode: "auto",
        network: DEFAULT_BROWSER_NETWORK_SETTINGS,
        workspace: { background: "black", gap: 16 }
      }
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({
      importPath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(manager.previewImport()).resolves.toMatchObject({
      preferences: {
        gameBrowserSettings: {
          fonts: {
            families: {
              math: "Noto Sans Math",
              standard: "Missing But Valid Font"
            },
            mode: "custom"
          }
        }
      }
    });
  });
});

function createManager({
  exportPath,
  importId = "import-id",
  importPath,
  macroStore,
  roleStore,
  workspaceStore
}: {
  exportPath?: string;
  importId?: string;
  importPath?: string;
  macroStore: MacroStore;
  roleStore: RoleStore;
  workspaceStore: LaunchWorkspaceStore;
}): PortableDataManager {
  return new PortableDataManager({
    createImportId: () => importId,
    getAppVersion: () => "1.2.3",
    macroStore,
    now: () => new Date("2026-07-13T10:00:00.000Z"),
    roleStore,
    showOpenDialog: vi.fn(async () => ({
      canceled: !importPath,
      filePaths: importPath ? [importPath] : []
    })),
    showSaveDialog: vi.fn(async () => ({
      canceled: !exportPath,
      ...(exportPath ? { filePath: exportPath } : {})
    })),
    workspaceStore
  });
}

function createPortableFixture(): RionPortableDataV1 {
  return {
    app: "Rion Studio",
    schemaVersion: 1,
    exportedAt: "2026-07-13T09:00:00.000Z",
    appVersion: "1.0.0",
    preferences: {
      gameBrowserSettings: {
        fonts: {
          families: {
            standard: "Missing But Valid Font"
          },
          mode: "custom"
        },
        graphics: { mode: "automatic" },
        launchMode: "auto",
        network: DEFAULT_BROWSER_NETWORK_SETTINGS,
        workspace: { background: "black", gap: 16 }
      },
      language: "ja",
      roleDefaults: {
        windowWidth: 1280,
        windowHeight: 720,
        launchPreset: "balanced"
      },
      themeMode: "light"
    },
    roles: [
      {
        id: "old-role",
        name: "Main",
        launchUrl: "https://example.org/play",
        windowWidth: 1280,
        windowHeight: 720,
        notes: "Imported",
        launchPreset: "balanced"
      }
    ],
    launchWorkspaces: [
      {
        id: "old-workspace",
        name: "Party",
        template: "two_columns",
        browserZoomPercent: 100,
        slots: [
          {
            id: "slot-1",
            roleId: "old-role",
            rect: { x: 0, y: 0, width: 0.5, height: 1 }
          },
          {
            id: "slot-2",
            roleId: "missing-role",
            rect: { x: 0.5, y: 0, width: 0.5, height: 1 }
          }
        ]
      }
    ],
    macros: [
      {
        id: "old-macro",
        name: "Auto heal",
        roleIds: ["old-role", "missing-role"],
        repeat: { type: "once" },
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      },
      {
        id: "orphan-macro",
        name: "Orphan",
        roleIds: ["missing-role"],
        repeat: { type: "once" },
        steps: [{ id: "step-2", type: "delay", ms: 100 }]
      }
    ]
  };
}
