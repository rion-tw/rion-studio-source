import { describe, expect, it, vi } from "vitest";

import { PortableDataManager } from "../src/main/portable/PortableDataManager";
import type {
  PortableDataSelection,
  PortableImportPreview,
  PortableImportResult,
  RionPortableDataV6
} from "../src/shared/types";

const selection: PortableDataSelection = {
  games: true,
  roles: true,
  launchWorkspaces: true,
  macros: true,
  preferences: true
};

const portableData: RionPortableDataV6 = {
  app: "Rion Studio",
  schemaVersion: 6,
  exportedAt: "2026-07-22T00:00:00Z",
  appVersion: "2.0.0",
  games: [],
  roles: [],
  launchWorkspaces: [],
  macros: [],
  preferences: { language: "zh-TW" }
};

const preview: PortableImportPreview = {
  importId: "import-1",
  filePath: "/tmp/input.json",
  exportedAt: portableData.exportedAt,
  appVersion: portableData.appVersion,
  gameCount: 0,
  roleCount: 0,
  workspaceCount: 0,
  macroCount: 0,
  preferences: portableData.preferences,
  operations: {
    games: { create: 0, update: 0, unchanged: 0, skip: 0 },
    roles: { create: 0, update: 0, unchanged: 0, skip: 0 },
    launchWorkspaces: { create: 0, update: 0, unchanged: 0, skip: 0 },
    macros: { create: 0, update: 0, unchanged: 0, skip: 0 }
  },
  conflicts: [],
  warnings: []
};

describe("PortableDataManager", () => {
  it("delegates export construction to Rust and only writes the selected file", async () => {
    const exportResult = {
      filePath: "/tmp/output.json",
      gameCount: 0,
      roleCount: 0,
      workspaceCount: 0,
      macroCount: 0,
      preferencesIncluded: true,
      selection
    };
    const invoke = vi.fn(async () => exportResult);
    const manager = new PortableDataManager({
      core: { invoke } as never,
      now: () => new Date(2026, 6, 22),
      showOpenDialog: vi.fn(),
      showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/output.json" })
    });

    const result = await manager.exportData({ preferences: portableData.preferences, selection });

    expect(invoke).toHaveBeenCalledWith({
      type: "portableExportTo",
      path: "/tmp/output.json",
      preferences: portableData.preferences,
      selection
    });
    expect(result).toEqual(exportResult);
  });

  it("passes only the selected path to the Rust preview session", async () => {
    const invoke = vi.fn(async () => preview);
    const manager = new PortableDataManager({
      core: { invoke } as never,
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/input.json"] }),
      showSaveDialog: vi.fn()
    });

    await expect(manager.previewImport()).resolves.toEqual(preview);
    expect(invoke).toHaveBeenCalledWith({
      type: "portablePreviewFile",
      path: "/tmp/input.json"
    });
  });

  it("forwards apply selections and resolutions without keeping TypeScript pending state", async () => {
    const result: PortableImportResult = {
      gameCount: 0,
      roleCount: 0,
      workspaceCount: 0,
      macroCount: 0,
      preferencesIncluded: true,
      preferences: portableData.preferences,
      selection,
      operations: preview.operations,
      warnings: []
    };
    const invoke = vi.fn(async () => result);
    const manager = new PortableDataManager({
      core: { invoke } as never,
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    });
    const input = {
      importId: "import-1",
      selection,
      resolutions: [{ conflictId: "macro:m1", action: "skip" as const }]
    };

    await expect(manager.applyImport(input)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith({ type: "portableApply", ...input });
  });

  it("discards pending imports in Rust", async () => {
    const invoke = vi.fn(async () => ({ discarded: true }));
    const manager = new PortableDataManager({
      core: { invoke } as never,
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    });

    await manager.discardImport("import-1");
    expect(invoke).toHaveBeenCalledWith({ type: "portableDiscard", importId: "import-1" });
  });

  it("does not invoke Rust when either dialog is cancelled", async () => {
    const invoke = vi.fn();
    const manager = new PortableDataManager({
      core: { invoke } as never,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true })
    });

    await expect(manager.previewImport()).resolves.toBeNull();
    await expect(manager.exportData({ selection })).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
