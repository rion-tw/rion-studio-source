import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MacroStore } from "../src/main/macros/MacroStore";
import { MacroSettingsStore } from "../src/main/macros/MacroSettingsStore";
import { MacroMutationBusyError } from "../src/main/macros/MacroManager";
import { GameStore } from "../src/main/games/GameStore";
import {
  PortableDataManager,
  recoverPortableImportTransaction
} from "../src/main/portable/PortableDataManager";
import { RoleStore } from "../src/main/roles/RoleStore";
import {
  LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
  LaunchWorkspaceStore
} from "../src/main/workspaces/LaunchWorkspaceStore";
import { DEFAULT_BROWSER_NETWORK_SETTINGS } from "../src/shared/browserFonts";
import { MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";
import type {
  PortableDataSelection,
  RionPortableDataV1,
  RionPortableDataV2,
  RionPortableDataV3,
  RionPortableDataV4
} from "../src/shared/types";
import { getDefaultWorkspaceRects } from "../src/shared/workspaceLayout";

const ALL_PORTABLE_DATA: PortableDataSelection = {
  games: true,
  roles: true,
  launchWorkspaces: true,
  macros: true,
  preferences: true
};

let gameStore: GameStore;

describe("PortableDataManager", () => {
  let baseDir: string;
  let roleStore: RoleStore;
  let workspaceStore: LaunchWorkspaceStore;
  let macroStore: MacroStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-portable-test-"));
    roleStore = new RoleStore(baseDir);
    gameStore = new GameStore(baseDir, roleStore);
    await gameStore.initialize();
    workspaceStore = new LaunchWorkspaceStore(baseDir);
    macroStore = new MacroStore(baseDir);
  });

  it("exports portable JSON without browser session or auth metadata", async () => {
    const exportPath = join(baseDir, "rion-export.json");
    const role = await roleStore.createRole({
      gameId: "builtin-flyff-universe",
      name: "Main",
      launchUrl: "https://example.com/play",
      notes: "Carry me"
    });
    await roleStore.updateAuthState(role.id, "authenticated", "2026-07-10T01:00:00.000Z");
    await workspaceStore.createWorkspace({
      name: "Party",
      browserZoomPercent: 75,
      resourcePolicy: {
        mode: "adaptive",
        primaryRoleId: role.id
      },
      targetDisplay: { id: 42 },
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
          windowHeight: 1080
        },
        themeMode: "dark"
      }
    });
    const parsed = JSON.parse(await readFile(exportPath, "utf8")) as RionPortableDataV4;

    expect(result).toMatchObject({
      gameCount: 2,
      roleCount: 1,
      workspaceCount: 1,
      macroCount: 1,
      preferencesIncluded: true,
      selection: ALL_PORTABLE_DATA
    });
    expect(parsed).toMatchObject({
      app: "Rion Studio",
      schemaVersion: 4,
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
          windowHeight: 1080
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
    expect(parsed.roles[0]).not.toHaveProperty("launchPreset");
    expect(parsed.preferences?.roleDefaults).not.toHaveProperty("launchPreset");
    expect(parsed).not.toHaveProperty("gameCompatibilityReports");
    expect(parsed.launchWorkspaces[0]).toMatchObject({
      browserZoomMode: "adaptive",
      browserZoomPercent: 75,
      resourcePolicy: {
        mode: "adaptive",
        primaryRoleId: role.id
      }
    });
    expect(parsed.launchWorkspaces[0]).not.toHaveProperty("targetDisplayId");
    expect(parsed.launchWorkspaces[0]).not.toHaveProperty("targetDisplay");
  });

  it("round-trips portable v4 macro dependency ids", async () => {
    const filePath = join(baseDir, "macro-flow-export.json");
    const role = await roleStore.createRole({
      gameId: "builtin-flyff-universe",
      name: "Flow role"
    });
    const child = await macroStore.createMacro({
      name: "Child flow",
      roleIds: [role.id],
      steps: [{ id: "child-key", type: "key", code: "F2" }]
    });
    const parent = await macroStore.createMacro({
      name: "Parent flow",
      roleIds: [role.id],
      steps: [{ id: "call", type: "macro", macroId: child.id }]
    });
    const manager = createManager({
      exportPath: filePath,
      importPath: filePath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await manager.exportData({ selection: ALL_PORTABLE_DATA });
    const exported = JSON.parse(await readFile(filePath, "utf8")) as RionPortableDataV4;
    expect(exported.schemaVersion).toBe(4);
    expect(exported.macros.find((macro) => macro.id === parent.id)?.steps).toEqual([
      { id: "call", type: "macro", macroId: child.id }
    ]);

    const preview = await manager.previewImport();
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });
    await expect(macroStore.getMacro(parent.id)).resolves.toMatchObject({
      steps: [{ id: "call", type: "macro", macroId: child.id }]
    });
  });

  it("round-trips macro settings as portable preferences without changing schema version", async () => {
    const filePath = join(baseDir, "macro-settings-export.json");
    const macroSettingsStore = new MacroSettingsStore(baseDir);
    const manager = createManager({
      exportPath: filePath,
      importPath: filePath,
      macroSettingsStore,
      macroStore,
      roleStore,
      workspaceStore
    });
    const selection: PortableDataSelection = {
      games: false,
      roles: false,
      launchWorkspaces: false,
      macros: false,
      preferences: true
    };

    await manager.exportData({
      preferences: {
        macroSettings: {
          startupDelayMs: 0,
          keyHoldMs: 20,
          postInputDelayMs: 10,
          defaultLoopDelayMs: MACRO_DELAY_MAX_MS
        }
      },
      selection
    });
    const exported = JSON.parse(await readFile(filePath, "utf8")) as RionPortableDataV4;
    expect(exported.schemaVersion).toBe(4);
    expect(exported.preferences?.macroSettings).toEqual({
      startupDelayMs: 0,
      keyHoldMs: 20,
      postInputDelayMs: 10,
      defaultLoopDelayMs: MACRO_DELAY_MAX_MS
    });

    await macroSettingsStore.updateSettings({
      startupDelayMs: 500,
      keyHoldMs: 50,
      postInputDelayMs: 50,
      defaultLoopDelayMs: 500
    });
    const preview = await manager.previewImport();
    const result = await manager.applyImport({ importId: preview!.importId, selection });

    expect(result.preferences?.macroSettings).toEqual(exported.preferences?.macroSettings);
    await expect(macroSettingsStore.getSettings()).resolves.toEqual(exported.preferences?.macroSettings);
  });

  it("imports portable v4 while-held activation and held key actions", async () => {
    const importPath = join(baseDir, "macro-hold-v4.json");
    const base = createPortableV2Fixture();
    const fixture: RionPortableDataV4 = {
      ...base,
      schemaVersion: 4,
      macros: [{
        id: "source-hold",
        enabled: true,
        activationMode: "while_held",
        name: "Hold movement",
        roleIds: ["old-role"],
        trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
        repeat: { type: "once" },
        steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
      }]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    await expect(macroStore.listMacros()).resolves.toMatchObject([{
      activationMode: "while_held",
      trigger: { code: "F6" },
      steps: [{ action: "hold_until_stop", code: "KeyW" }]
    }]);
  });

  it("exports selected categories and automatically includes roles required by macros", async () => {
    const exportPath = join(baseDir, "selected-export.json");
    const role = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    await workspaceStore.createWorkspace({ name: "Party" });
    await macroStore.createMacro({
      name: "Auto heal",
      roleIds: [role.id],
      steps: [{ id: "step-1", type: "key", code: "F2" }]
    });
    const manager = createManager({ exportPath, macroStore, roleStore, workspaceStore });

    const result = await manager.exportData({
      preferences: { language: "zh-TW" },
      selection: {
        games: false,
        roles: false,
        launchWorkspaces: false,
        macros: true,
        preferences: false
      }
    });
    const parsed = JSON.parse(await readFile(exportPath, "utf8")) as RionPortableDataV4;

    expect(result).toMatchObject({
      roleCount: 1,
      workspaceCount: 0,
      macroCount: 1,
      preferencesIncluded: false,
      selection: {
        games: true,
        roles: true,
        launchWorkspaces: false,
        macros: true,
        preferences: false
      }
    });
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.launchWorkspaces).toEqual([]);
    expect(parsed.macros).toHaveLength(1);
    expect(parsed).not.toHaveProperty("preferences");
  });

  it("round-trips games without requiring roles", async () => {
    const filePath = join(baseDir, "games-only.json");
    const coverImageDataUrl = "data:image/webp;base64,QQ==";
    await gameStore.createGame({
      name: "Custom web game",
      defaultLaunchUrl: "https://custom.test/play",
      coverImageDataUrl
    });
    const manager = createManager({
      exportPath: filePath,
      importId: "games-only-import",
      importPath: filePath,
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(manager.exportData({
      selection: {
        games: true,
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: false
      }
    })).resolves.toMatchObject({ gameCount: 3, roleCount: 0, selection: { games: true, roles: false } });
    const exported = JSON.parse(await readFile(filePath, "utf8")) as RionPortableDataV2;
    expect(exported.games.find((game) => game.name === "Custom web game"))
      .toMatchObject({ coverImageDataUrl });
    const preview = await manager.previewImport();
    expect(preview).toMatchObject({ gameCount: 3, roleCount: 0 });
    await expect(manager.applyImport({
      importId: preview!.importId,
      selection: {
        games: true,
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: false
      }
    })).resolves.toMatchObject({ gameCount: 3, roleCount: 0, selection: { games: true, roles: false } });
    expect((await gameStore.listGames()).filter((game) => game.source === "custom")).toHaveLength(1);
    expect((await gameStore.listGames()).find((game) => game.name === "Custom web game"))
      .toMatchObject({ coverImageDataUrl });
    expect(preview?.operations.games).toEqual({ create: 0, update: 1, unchanged: 2, skip: 0 });

    const secondPreview = await manager.previewImport();
    expect(secondPreview?.operations.games).toEqual({ create: 0, update: 0, unchanged: 3, skip: 0 });
    await manager.applyImport({
      importId: secondPreview!.importId,
      selection: {
        games: true,
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: false
      }
    });
    expect((await gameStore.listGames()).filter((game) => game.source === "custom")).toHaveLength(1);
  });

  it("rejects an invalid custom game cover in portable v2 data", async () => {
    const importPath = join(baseDir, "invalid-game-cover.json");
    const fixture: RionPortableDataV2 = {
      app: "Rion Studio",
      schemaVersion: 2,
      exportedAt: "2026-07-13T09:00:00.000Z",
      appVersion: "1.2.3",
      games: [{
        id: "bad-cover-game",
        source: "custom",
        name: "Bad cover",
        coverImageDataUrl: "data:text/plain;base64,QQ==",
        defaultLaunchUrl: "https://bad-cover.test/play",
        browserLaunchMode: "inherit"
      }],
      roles: [],
      launchWorkspaces: [],
      macros: []
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    await expect(manager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
  });

  it("imports portable v3 macro calls with a two-pass id remap", async () => {
    const importPath = join(baseDir, "macro-dependencies-v3.json");
    const base = createPortableV2Fixture();
    const fixture: RionPortableDataV3 = {
      ...base,
      schemaVersion: 3,
      macros: [
        {
          id: "source-parent",
          enabled: true,
          name: "Parent flow",
          roleIds: ["old-role"],
          repeat: { type: "once" },
          steps: [{ id: "call", type: "macro", macroId: "source-child" }]
        },
        {
          id: "source-child",
          enabled: true,
          name: "Child flow",
          roleIds: ["old-role"],
          repeat: { type: "once" },
          steps: [{ id: "key", type: "key", code: "F2" }]
        }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    await manager.applyImport({
      importId: preview!.importId,
      selection: ALL_PORTABLE_DATA
    });

    const imported = await macroStore.listMacros();
    const parent = imported.find((item) => item.name === "Parent flow")!;
    const child = imported.find((item) => item.name === "Child flow")!;
    expect(child).toMatchObject({ activationMode: "toggle", steps: [{ action: "tap" }] });
    expect(parent.id).not.toBe("source-parent");
    expect(child.id).not.toBe("source-child");
    expect(parent.steps).toEqual([{ id: "call", type: "macro", macroId: child.id }]);
  });

  it("skips portable macro dependents when their called target cannot be imported", async () => {
    const importPath = join(baseDir, "macro-dependency-skipped-v3.json");
    const base = createPortableV2Fixture();
    const fixture: RionPortableDataV3 = {
      ...base,
      schemaVersion: 3,
      macros: [
        {
          id: "source-parent",
          name: "Parent flow",
          roleIds: ["old-role"],
          repeat: { type: "once" },
          steps: [{ id: "call", type: "macro", macroId: "source-child" }]
        },
        {
          id: "source-child",
          name: "Missing child role",
          roleIds: ["missing-role"],
          repeat: { type: "once" },
          steps: [{ id: "key", type: "key", code: "F2" }]
        }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();

    expect(preview?.operations.macros.skip).toBe(2);
    expect(preview?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "MACRO_SKIPPED_MISSING_DEPENDENCY",
        itemName: "Parent flow"
      })
    ]));
  });

  it("rejects portable v3 macro dependency cycles", async () => {
    const importPath = join(baseDir, "macro-cycle-v3.json");
    const base = createPortableV2Fixture();
    const fixture: RionPortableDataV3 = {
      ...base,
      schemaVersion: 3,
      macros: [
        {
          id: "a",
          name: "A",
          roleIds: ["old-role"],
          repeat: { type: "once" },
          steps: [{ id: "call-b", type: "macro", macroId: "b" }]
        },
        {
          id: "b",
          name: "B",
          roleIds: ["old-role"],
          repeat: { type: "once" },
          steps: [{ id: "call-a", type: "macro", macroId: "a" }]
        }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    await expect(manager.previewImport()).rejects.toMatchObject({
      code: "PORTABLE_MACRO_DEPENDENCY_INVALID"
    });
  });

  it("rejects an export without any available selected content", async () => {
    const manager = createManager({
      exportPath: join(baseDir, "empty-export.json"),
      macroStore,
      roleStore,
      workspaceStore
    });

    await expect(
      manager.exportData({
        selection: {
          games: false,
          roles: false,
          launchWorkspaces: false,
          macros: false,
          preferences: false
        }
      })
    ).rejects.toMatchObject({ code: "PORTABLE_SELECTION_EMPTY" });
  });

  it("previews and applies an import with remapped role references", async () => {
    const importPath = join(baseDir, "incoming.json");
    const existingRole = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    await roleStore.updateAuthState(existingRole.id, "authenticated", "2026-07-13T08:00:00.000Z");
    await writeFile(
      join(baseDir, "roles", existingRole.id, "browser", "session-marker"),
      "keep-login",
      "utf8"
    );
    const existingWorkspace = await workspaceStore.createWorkspace({ name: "Party", targetDisplay: { id: 42 } });
    await macroStore.createMacro({
      name: "Auto heal",
      roleIds: [existingRole.id],
      steps: [{ id: "step-existing", type: "key", code: "F1" }]
    });
    const legacyFixture = createPortableFixture();
    (legacyFixture.launchWorkspaces[0] as unknown as { resourcePolicy: Record<string, unknown> }).resourcePolicy = {
      mode: "primary_priority",
      backgroundCpuThrottleRate: 2,
      primaryRoleId: "old-role"
    };
    const fixture: RionPortableDataV2 = {
      ...legacyFixture,
      schemaVersion: 2,
      games: [{
        id: "remote-builtin",
        source: "builtin",
        builtinKey: "flyff-universe",
        name: "Flyff Universe",
        defaultLaunchUrl: "https://universe.flyff.com/play",
        browserLaunchMode: "inherit"
      }],
      roles: legacyFixture.roles.map((role) => ({ ...role, gameId: "remote-builtin" }))
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

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
          windowHeight: 720
        },
        themeMode: "light"
      }
    });
    expect(preview?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "WORKSPACE_ROLE_MISSING", count: 1 }),
        expect.objectContaining({ code: "MACRO_ROLE_MISSING", count: 1 }),
        expect.objectContaining({ code: "MACRO_SKIPPED_NO_ROLES", itemName: "Orphan" })
      ])
    );
    expect(preview?.warnings.some((warning) => warning.code === "MACRO_NAME_RENAMED")).toBe(false);

    const result = await manager.applyImport({ importId: "import-1", selection: ALL_PORTABLE_DATA });

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
          windowHeight: 720
        }
      }
    });
    const importedRole = (await roleStore.listRoles()).find((role) => role.name === "Main");
    expect(importedRole).toMatchObject({
      id: existingRole.id,
      authState: "authenticated",
      lastSuccessfulLoginAt: "2026-07-13T08:00:00.000Z",
      launchUrl: "https://example.org/play"
    });
    await expect(readFile(join(baseDir, "roles", existingRole.id, "browser", "session-marker"), "utf8"))
      .resolves.toBe("keep-login");

    const importedWorkspace = (await workspaceStore.listWorkspaces()).find(
      (workspace) => workspace.name === "Party"
    );
    expect(importedWorkspace).toMatchObject({
      id: existingWorkspace.id,
      browserZoomMode: "adaptive",
      targetDisplay: { id: 42 },
      resourcePolicy: {
        mode: "adaptive",
        primaryRoleId: importedRole?.id
      }
    });
    expect(importedWorkspace?.slots[0]).toMatchObject({ roleId: importedRole?.id });
    expect(importedWorkspace?.slots[1]).not.toHaveProperty("roleId");

    const macros = await macroStore.listMacros();
    const importedMacro = macros.find((macro) => macro.name === "Auto heal" && macro.roleIds[0] === importedRole?.id);
    expect(importedMacro?.roleIds).toEqual([importedRole?.id]);
    expect(macros.filter((macro) => macro.name === "Auto heal")).toHaveLength(1);
    expect(macros.some((macro) => macro.name === "Orphan")).toBe(false);
  });

  it("maps v2 built-ins, renames custom games, and recovers missing role games", async () => {
    const importPath = join(baseDir, "v2-games.json");
    await gameStore.createGame({ name: "Shared", defaultLaunchUrl: "https://local-shared.test/play" });
    const fixture: RionPortableDataV2 = {
      app: "Rion Studio",
      schemaVersion: 2,
      exportedAt: "2026-07-13T09:00:00.000Z",
      appVersion: "1.2.3",
      games: [
        {
          id: "remote-builtin",
          source: "builtin",
          builtinKey: "flyff-universe",
          name: "Ignored imported name",
          coverImageDataUrl: "data:image/webp;base64,QQ==",
          defaultLaunchUrl: "https://override.test/play",
          loginUrl: "https://override.test/login",
          roleDefaults: { windowWidth: 1280, windowHeight: 720 },
          browserLaunchMode: "external"
        },
        {
          id: "remote-custom",
          source: "custom",
          name: "Shared",
          defaultLaunchUrl: "https://remote-shared.test/play",
          browserLaunchMode: "inherit"
        }
      ],
      roles: [
        {
          id: "remote-role",
          gameId: "remote-custom",
          name: "Remote",
          launchUrl: "https://remote-shared.test/play",
          windowWidth: 1280,
          windowHeight: 720,
          notes: ""
        },
        {
          id: "recovered-role",
          gameId: "missing-game",
          name: "Recovered",
          launchUrl: "https://recovery.test/custom/path",
          windowWidth: 1280,
          windowHeight: 720,
          notes: ""
        }
      ],
      launchWorkspaces: [{
        id: "remote-workspace",
        name: "Imported workspace",
        template: "two_columns",
        browserLaunchMode: "inherit",
        browserZoomPercent: 100,
        slots: [
          { id: "slot-1", roleId: "remote-role", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
          { id: "slot-2", roleId: "recovered-role", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
        ]
      }],
      macros: [{
        id: "remote-macro",
        name: "Imported macro",
        roleIds: ["remote-role", "recovered-role"],
        repeat: { type: "once" },
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      }]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, importId: "v2-import", macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BUILTIN_GAME_DEFAULTS_REPLACED" }),
      expect.objectContaining({ code: "ROLE_GAME_RECOVERED", itemName: "Recovered" })
    ]));
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    const games = await gameStore.listGames();
    expect(games.find((game) => game.builtinKey === "flyff-universe")).toMatchObject({
      id: "builtin-flyff-universe",
      defaultLaunchUrl: "https://override.test/play",
      loginUrl: "https://override.test/login",
      browserLaunchMode: "external"
    });
    expect(games.find((game) => game.builtinKey === "flyff-universe")?.coverImageDataUrl)
      .toBeUndefined();
    expect(games).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "custom",
        name: "Shared",
        defaultLaunchUrl: "https://remote-shared.test/play"
      }),
      expect.objectContaining({ source: "custom", name: "recovery.test · custom/path" })
    ]));

    const roles = await roleStore.listRoles();
    expect(roles).toHaveLength(2);
    expect(roles.every((role) => games.some((game) => game.id === role.gameId))).toBe(true);
    const importedRoleIds = new Set(roles.map((role) => role.id));
    expect((await workspaceStore.listWorkspaces())[0].slots.every((slot) => !slot.roleId || importedRoleIds.has(slot.roleId))).toBe(true);
    expect((await macroStore.listMacros())[0].roleIds.every((roleId) => importedRoleIds.has(roleId))).toBe(true);
  });

  it("imports a duplicate built-in identity as a safely named custom game", async () => {
    const importPath = join(baseDir, "duplicate-builtin.json");
    const fixture = createPortableV2Fixture();
    fixture.games.push({
      ...fixture.games[0],
      id: "remote-builtin-duplicate",
      defaultLaunchUrl: "https://duplicate.example/play"
    });
    fixture.roles.push({
      ...fixture.roles[0],
      id: "duplicate-role",
      gameId: "remote-builtin-duplicate",
      name: "Duplicate role"
    });
    fixture.launchWorkspaces = [];
    fixture.macros = [];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.operations.games.create).toBe(1);
    expect(preview?.warnings).toContainEqual(expect.objectContaining({
      code: "GAME_NAME_RENAMED",
      replacementName: "Flyff Universe (Imported)"
    }));
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    const importedGame = (await gameStore.listGames()).find(
      (game) => game.name === "Flyff Universe (Imported)"
    );
    expect(importedGame).toMatchObject({
      source: "custom",
      defaultLaunchUrl: "https://duplicate.example/play"
    });
    await expect(roleStore.listRoles()).resolves.toContainEqual(
      expect.objectContaining({ name: "Duplicate role", gameId: importedGame?.id })
    );
  });

  it("imports only preferences when all stored data categories are unselected", async () => {
    const importPath = join(baseDir, "preferences-only.json");
    await writeFile(importPath, `${JSON.stringify(createPortableFixture(), null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();

    const result = await manager.applyImport({
      importId: preview!.importId,
      selection: {
        games: false,
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: true
      }
    });

    expect(result).toMatchObject({
      roleCount: 0,
      workspaceCount: 0,
      macroCount: 0,
      preferencesIncluded: true,
      selection: {
        games: false,
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: true
      },
      warnings: []
    });
    expect(result.preferences).toMatchObject({ language: "ja", themeMode: "light" });
    await expect(roleStore.listRoles()).resolves.toEqual([]);
    await expect(workspaceStore.listWorkspaces()).resolves.toEqual([]);
    await expect(macroStore.listMacros()).resolves.toEqual([]);
  });

  it("rejects an empty import selection without expiring the preview", async () => {
    const importPath = join(baseDir, "empty-selection.json");
    await writeFile(importPath, `${JSON.stringify(createPortableFixture(), null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();

    await expect(
      manager.applyImport({
        importId: preview!.importId,
        selection: {
          games: false,
          roles: false,
          launchWorkspaces: false,
          macros: false,
          preferences: false
        }
      })
    ).rejects.toMatchObject({ code: "PORTABLE_SELECTION_EMPTY" });

    await expect(
      manager.applyImport({
        importId: preview!.importId,
        selection: {
          games: false,
          roles: false,
          launchWorkspaces: false,
          macros: false,
          preferences: true
        }
      })
    ).resolves.toMatchObject({ preferencesIncluded: true });
  });

  it("imports all roles required by a selected workspace but skips macros and preferences", async () => {
    const importPath = join(baseDir, "workspace-only.json");
    await writeFile(importPath, `${JSON.stringify(createPortableFixture(), null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();

    const result = await manager.applyImport({
      importId: preview!.importId,
      selection: {
        games: false,
        roles: false,
        launchWorkspaces: true,
        macros: false,
        preferences: false
      }
    });

    expect(result).toMatchObject({
      roleCount: 1,
      workspaceCount: 1,
      macroCount: 0,
      preferencesIncluded: false,
      selection: {
        games: true,
        roles: true,
        launchWorkspaces: true,
        macros: false,
        preferences: false
      }
    });
    expect(result).not.toHaveProperty("preferences");
    await expect(roleStore.listRoles()).resolves.toHaveLength(1);
    await expect(workspaceStore.listWorkspaces()).resolves.toHaveLength(1);
    await expect(macroStore.listMacros()).resolves.toEqual([]);
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

  it("rejects invalid v4 activation and key hold semantics", async () => {
    const importPath = join(baseDir, "invalid-macro-hold-v4.json");
    const base = createPortableV2Fixture();
    const baseMacro = {
      id: "invalid-hold",
      enabled: true,
      name: "Invalid hold",
      roleIds: ["old-role"],
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
      repeat: { type: "once" },
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    };
    const invalidMacros = [
      { ...baseMacro, activationMode: "invalid" },
      { ...baseMacro, steps: [{ ...baseMacro.steps[0], action: "key_down" }] },
      { ...baseMacro, activationMode: "while_held", trigger: undefined }
    ];

    for (const invalidMacro of invalidMacros) {
      await writeFile(importPath, `${JSON.stringify({
        ...base,
        schemaVersion: 4,
        macros: [invalidMacro]
      }, null, 2)}\n`, "utf8");
      const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
      await expect(manager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
    }

    await writeFile(importPath, JSON.stringify({ ...base, schemaVersion: "4" }), "utf8");
    const stringVersionManager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(stringVersionManager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
  });

  it("accepts 24-hour macro waits in portable data and rejects values above the boundary", async () => {
    const importPath = join(baseDir, "daily-macro.json");
    const fixture = createPortableFixture();
    fixture.macros[0] = {
      ...fixture.macros[0],
      repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS },
      steps: [{ id: "daily-delay", type: "delay", ms: MACRO_DELAY_MAX_MS }]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(manager.previewImport()).resolves.toMatchObject({ macroCount: 1 });

    fixture.macros[0].steps = [{ id: "too-long", type: "delay", ms: MACRO_DELAY_MAX_MS + 1 }];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const invalidDelayManager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(invalidDelayManager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });

    fixture.macros[0].steps = [{ id: "valid-delay", type: "delay", ms: MACRO_DELAY_MAX_MS }];
    fixture.macros[0].repeat = { type: "loop", intervalMs: MACRO_DELAY_MAX_MS + 1 };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const invalidLoopManager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    await expect(invalidLoopManager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
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
      browserZoomMode: "fixed",
      browserZoomPercent: 90,
      resourcePolicy: { mode: "unrestricted" },
      slots: [
        { id: "slot-1", roleId: "old-role", rect: { x: 0, y: 0, width: 0.3333, height: 1 } },
        { id: "slot-2", rect: { x: 0.3333, y: 0, width: 0.3333, height: 1 } },
        { id: "slot-3", rect: { x: 0.6667, y: 0, width: 0.3333, height: 1 } }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    const importedWorkspace = (await workspaceStore.listWorkspaces()).find(
      (candidate) => candidate.template === "three_columns"
    );
    expect(importedWorkspace?.slots.map((slot) => slot.rect)).toEqual([
      { x: 0, y: 0, width: 0.3333, height: 1 },
      { x: 0.3333, y: 0, width: 0.3334, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ]);
    expect(importedWorkspace?.resourcePolicy).toEqual({
      mode: "unrestricted"
    });
    expect(importedWorkspace?.browserZoomMode).toBe("fixed");
    expect(JSON.parse(await readFile(join(baseDir, "launch-workspaces.json"), "utf8")))
      .toMatchObject({ schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION });
  });

  it("migrates primary priority to adaptive when an imported workspace has no assigned roles", async () => {
    const importPath = join(baseDir, "empty-priority-workspace.json");
    const fixture = createPortableFixture();
    fixture.launchWorkspaces[0] = {
      ...fixture.launchWorkspaces[0],
      slots: fixture.launchWorkspaces[0].slots.map(({ roleId: _roleId, ...slot }) => slot)
    };
    (fixture.launchWorkspaces[0] as unknown as { resourcePolicy: Record<string, unknown> }).resourcePolicy = {
      mode: "primary_priority",
      backgroundCpuThrottleRate: 2
    };
    fixture.macros = [];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    const importedWorkspace = (await workspaceStore.listWorkspaces()).find(
      (workspace) => workspace.name === "Party"
    );
    expect(importedWorkspace?.resourcePolicy).toEqual({
      mode: "adaptive"
    });
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

    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });
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
        windowHeight: 1080
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

  it("accepts and strips missing or invalid portable launch presets", async () => {
    const importPath = join(baseDir, "missing-launch-preset.json");
    const fixture = createPortableFixture();
    const rawFixture = fixture as unknown as {
      preferences: { roleDefaults: Record<string, unknown> };
      roles: Array<Record<string, unknown>>;
    };
    delete rawFixture.roles[0].launchPreset;
    rawFixture.preferences.roleDefaults.launchPreset = "turbo";
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.preferences?.roleDefaults).not.toHaveProperty("launchPreset");
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });
    expect((await roleStore.listRoles()).find((role) => role.name === "Main"))
      .not.toHaveProperty("launchPreset");
  });

  it("accepts but strips an explicitly imported performance launch preset", async () => {
    const importPath = join(baseDir, "performance-launch-preset.json");
    const fixture = createPortableFixture();
    (fixture.roles[0] as unknown as Record<string, unknown>).launchPreset = "performance";
    (fixture.preferences!.roleDefaults! as unknown as Record<string, unknown>).launchPreset = "performance";
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.preferences?.roleDefaults).not.toHaveProperty("launchPreset");
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });
    expect((await roleStore.listRoles()).find((role) => role.name === "Main"))
      .not.toHaveProperty("launchPreset");
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

  it("requires a resolution when multiple existing macros have the same identity", async () => {
    const importPath = join(baseDir, "ambiguous-macro.json");
    const role = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    const first = await macroStore.createMacro({
      name: "Duplicate",
      roleIds: [role.id],
      steps: [{ id: "first", type: "key", code: "F1" }]
    });
    await macroStore.createMacro({
      name: "Duplicate",
      roleIds: [role.id],
      steps: [{ id: "second", type: "key", code: "F2" }]
    });
    const fixture = createPortableV2Fixture();
    fixture.macros = [{
      id: "incoming-duplicate",
      name: "Duplicate",
      roleIds: ["old-role"],
      repeat: { type: "once" },
      steps: [{ id: "imported", type: "key", code: "F3" }]
    }];
    fixture.launchWorkspaces = [];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    const preview = await manager.previewImport();
    expect(preview?.conflicts).toHaveLength(1);
    expect(preview?.conflicts[0].candidates).toHaveLength(2);
    await expect(manager.applyImport({
      importId: preview!.importId,
      selection: ALL_PORTABLE_DATA
    })).rejects.toMatchObject({ code: "PORTABLE_IMPORT_CONFLICT_UNRESOLVED" });

    await manager.applyImport({
      importId: preview!.importId,
      selection: ALL_PORTABLE_DATA,
      resolutions: [{ conflictId: preview!.conflicts[0].id, action: "update", targetMacroId: first.id }]
    });
    expect((await macroStore.getMacro(first.id)).steps).toEqual([
      { id: "imported", type: "key", code: "F3", action: "tap", label: undefined }
    ]);
    expect(await macroStore.listMacros()).toHaveLength(2);
  });

  it("blocks an active matched macro without consuming the preview", async () => {
    const importPath = join(baseDir, "busy-macro.json");
    const role = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Main" });
    await macroStore.createMacro({
      name: "Auto heal",
      roleIds: [role.id],
      steps: [{ id: "before", type: "key", code: "F1" }]
    });
    const fixture = createPortableV2Fixture();
    fixture.launchWorkspaces = [];
    fixture.macros = [{
      id: "incoming",
      name: "Auto heal",
      roleIds: ["old-role"],
      repeat: { type: "once" },
      steps: [{ id: "after", type: "key", code: "F2" }]
    }];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    let isBusy = true;
    const manager = new PortableDataManager({
      createImportId: () => "busy-import",
      gameStore,
      getAppVersion: () => "1.2.3",
      macroStore,
      roleStore,
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [importPath] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      withStoppedMacros: async (_macroIds, operation) => {
        if (isBusy) {
          throw new MacroMutationBusyError();
        }
        return operation();
      },
      workspaceStore
    });
    const preview = await manager.previewImport();

    await expect(manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA }))
      .rejects.toMatchObject({ code: "PORTABLE_IMPORT_BUSY" });
    isBusy = false;
    await expect(manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA }))
      .resolves.toMatchObject({ macroCount: 1 });
  });

  it("rolls back a failed multi-store commit and keeps the preview retryable", async () => {
    const importPath = join(baseDir, "transaction.json");
    await writeFile(importPath, `${JSON.stringify(createPortableFixture(), null, 2)}\n`, "utf8");
    const gamesBefore = await gameStore.listGames();
    let workspaceReplaceCalls = 0;
    const transactionalWorkspaceStore = {
      listWorkspaces: () => workspaceStore.listWorkspaces(),
      publishWorkspacesForImport: (
        workspaces: Parameters<LaunchWorkspaceStore["publishWorkspacesForImport"]>[0]
      ) =>
        workspaceStore.publishWorkspacesForImport(workspaces),
      replaceWorkspacesForImport: async (
        workspaces: Parameters<LaunchWorkspaceStore["replaceWorkspacesForImport"]>[0],
        publishCache?: boolean
      ) => {
        workspaceReplaceCalls += 1;
        if (workspaceReplaceCalls === 1) {
          expect(await gameStore.listGames()).toEqual(gamesBefore);
          expect(await roleStore.listRoles()).toEqual([]);
          throw new Error("simulated workspace write failure");
        }
        return workspaceStore.replaceWorkspacesForImport(workspaces, publishCache);
      }
    };
    const manager = new PortableDataManager({
      createImportId: () => "transaction-import",
      gameStore,
      getAppVersion: () => "1.2.3",
      macroStore,
      roleStore,
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [importPath] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      workspaceStore: transactionalWorkspaceStore
    });

    const preview = await manager.previewImport();
    await expect(manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA }))
      .rejects.toThrow("simulated workspace write failure");
    expect(await gameStore.listGames()).toEqual(gamesBefore);
    expect(await roleStore.listRoles()).toEqual([]);
    expect(await workspaceStore.listWorkspaces()).toEqual([]);
    expect(await macroStore.listMacros()).toEqual([]);
    expect(await readdir(join(baseDir, "roles"))).toEqual([]);
    await expect(access(join(baseDir, "portable-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(baseDir, "portable-import-transaction.stage"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA }))
      .resolves.toMatchObject({ roleCount: 1, workspaceCount: 1, macroCount: 1 });
  });

  it("restores an interrupted import journal before stores initialize", async () => {
    const role = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Before" });
    const workspace = await workspaceStore.createWorkspace({
      name: "Legacy recovery",
      resourcePolicy: { mode: "unrestricted" },
      slots: [{ roleId: role.id }, {}]
    });
    const createdRoleId = "12345678-1234-4123-8123-123456789abc";
    const journal = {
      createdRoleIds: [createdRoleId],
      games: await gameStore.listGames(),
      roles: await roleStore.listRoles(),
      workspaces: await workspaceStore.listWorkspaces(),
      macros: await macroStore.listMacros()
    };
    await writeFile(join(baseDir, "portable-import-transaction.json"), JSON.stringify(journal), "utf8");
    await writeFile(join(baseDir, "roles.json"), JSON.stringify({ roles: [] }), "utf8");
    await mkdir(join(baseDir, "roles", createdRoleId, "browser"), { recursive: true });

    await recoverPortableImportTransaction(baseDir);

    const recoveredStore = new RoleStore(baseDir);
    await expect(recoveredStore.getRole(role.id)).resolves.toMatchObject({ name: "Before" });
    await expect(new LaunchWorkspaceStore(baseDir).getWorkspace(workspace.id)).resolves.toMatchObject({
      resourcePolicy: { mode: "unrestricted" }
    });
    expect(JSON.parse(await readFile(join(baseDir, "launch-workspaces.json"), "utf8")))
      .toMatchObject({ schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION });
    await expect(access(join(baseDir, "roles", createdRoleId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(baseDir, "portable-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a committed import journal during startup recovery", async () => {
    const role = await roleStore.createRole({ gameId: "builtin-flyff-universe", name: "Before" });
    const workspace = await workspaceStore.createWorkspace({
      name: "Current recovery",
      resourcePolicy: { mode: "unrestricted" },
      slots: [{ roleId: role.id }, {}]
    });
    const createdRoleId = "87654321-4321-4321-8321-cba987654321";
    const targetRoles = [
      { ...role, name: "After" },
      {
        ...role,
        id: createdRoleId,
        name: "Imported",
        authState: "login_required" as const,
        lastAuthCheckAt: undefined,
        lastSuccessfulLoginAt: undefined
      }
    ];
    const games = await gameStore.listGames();
    const workspaces = await workspaceStore.listWorkspaces();
    const macros = await macroStore.listMacros();
    const journal = {
      createdRoleIds: [createdRoleId],
      games,
      roles: [role],
      workspaces,
      macros,
      phase: "committed",
      targetGames: games,
      targetRoles,
      targetWorkspaces: workspaces,
      targetMacros: macros,
      workspaceFileSchemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION
    };
    await writeFile(join(baseDir, "portable-import-transaction.json"), JSON.stringify(journal), "utf8");
    await writeFile(join(baseDir, "roles.json"), JSON.stringify({ roles: [] }), "utf8");
    await mkdir(join(baseDir, "roles", createdRoleId, "browser"), { recursive: true });
    await mkdir(join(baseDir, "portable-import-transaction.stage"), { recursive: true });

    await recoverPortableImportTransaction(baseDir);

    const recoveredStore = new RoleStore(baseDir);
    await expect(recoveredStore.listRoles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: role.id, name: "After" }),
        expect.objectContaining({ id: createdRoleId, name: "Imported" })
      ])
    );
    expect(JSON.parse(await readFile(join(baseDir, "launch-workspaces.json"), "utf8")))
      .toMatchObject({ schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION });
    await expect(new LaunchWorkspaceStore(baseDir).getWorkspace(workspace.id)).resolves.toMatchObject({
      resourcePolicy: { mode: "unrestricted" }
    });
    await expect(access(join(baseDir, "roles", createdRoleId, "browser"))).resolves.toBeUndefined();
    await expect(access(join(baseDir, "portable-import-transaction.stage"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(baseDir, "portable-import-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects roles outside a workspace layout during preview", async () => {
    const importPath = join(baseDir, "workspace-outside-layout.json");
    const fixture = createPortableFixture();
    fixture.launchWorkspaces[0] = {
      ...fixture.launchWorkspaces[0],
      template: "single",
      slots: [
        { id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { id: "slot-2", roleId: "old-role", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    };
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });

    await expect(manager.previewImport()).rejects.toMatchObject({ code: "PORTABLE_DATA_INVALID" });
  });

  it("does not overwrite local built-in settings inferred from a v1 role", async () => {
    const importPath = join(baseDir, "legacy-builtin.json");
    await gameStore.updateGame("builtin-flyff-universe", {
      defaultLaunchUrl: "https://local-override.test/play",
      browserLaunchMode: "external"
    });
    const fixture = createPortableFixture();
    fixture.roles[0].launchUrl = "https://universe.flyff.com/play";
    fixture.launchWorkspaces = [];
    fixture.macros = [];
    await writeFile(importPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const manager = createManager({ importPath, macroStore, roleStore, workspaceStore });
    const preview = await manager.previewImport();
    await manager.applyImport({ importId: preview!.importId, selection: ALL_PORTABLE_DATA });

    await expect(gameStore.getGame("builtin-flyff-universe")).resolves.toMatchObject({
      defaultLaunchUrl: "https://local-override.test/play",
      browserLaunchMode: "external"
    });
  });
});

function createManager({
  exportPath,
  importId = "import-id",
  importPath,
  macroSettingsStore,
  macroStore,
  roleStore,
  workspaceStore
}: {
  exportPath?: string;
  importId?: string;
  importPath?: string;
  macroSettingsStore?: MacroSettingsStore;
  macroStore: MacroStore;
  roleStore: RoleStore;
  workspaceStore: LaunchWorkspaceStore;
}): PortableDataManager {
  return new PortableDataManager({
    createImportId: () => importId,
    getAppVersion: () => "1.2.3",
    gameStore,
    macroStore,
    macroSettingsStore,
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
        windowHeight: 720
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
        notes: "Imported"
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

function createPortableV2Fixture(): RionPortableDataV2 {
  const legacy = createPortableFixture();
  return {
    ...legacy,
    schemaVersion: 2,
    games: [{
      id: "remote-builtin",
      source: "builtin",
      builtinKey: "flyff-universe",
      name: "Flyff Universe",
      defaultLaunchUrl: "https://universe.flyff.com/play",
      browserLaunchMode: "inherit"
    }],
    roles: legacy.roles.map((role) => ({ ...role, gameId: "remote-builtin" }))
  };
}
