import { describe, expect, it, vi } from "vitest";

import {
  ChromeProfileImportError,
  ChromeProfileImportManager
} from "../src/main/browser/ChromeProfileImportManager";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Aron",
  launchUrl: "https://example.test/play",
  notes: "Imported from a local Chrome profile.",
  browserSessionSource: "chrome-profile",
  createdAt: "2026-07-22T00:00:00Z",
  updatedAt: "2026-07-22T00:00:00Z"
};

describe("ChromeProfileImportManager", () => {
  it("uses the Rust-discovered default path and delegates preview ownership", async () => {
    const preview = {
      importId: "import-1",
      sourceLabel: "Chrome",
      profiles: [{ id: "Default", directoryName: "Default", name: "Aron" }],
      warnings: [{ code: "passwords_excluded" as const }]
    };
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "chromeProfileDefaultPath"
        ? { path: "/Users/aron/Library/Application Support/Google/Chrome" }
        : preview
    );
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ["/tmp/Chrome"]
    }));
    const manager = new ChromeProfileImportManager({
      core: { invoke } as never,
      showOpenDialog
    });

    await expect(manager.previewImport()).resolves.toEqual(preview);
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: "/Users/aron/Library/Application Support/Google/Chrome"
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, {
      type: "chromeProfilePreview",
      sourceUserDataDir: "/tmp/Chrome"
    });
  });

  it("executes only Electron effects between Rust prepare, commit, and finalize", async () => {
    const commands: string[] = [];
    const invoke = vi.fn(async (command: { type: string }) => {
      commands.push(command.type);
      if (command.type === "chromeProfilePrepare") {
        return {
          overwrittenRoleIds: ["role-1"],
          profiles: [{ id: "Default", directoryName: "Default", name: "Aron" }]
        };
      }
      if (command.type === "chromeProfileCommit") {
        return {
          roles: [role],
          sessions: [{
            profileId: "Default",
            profileName: "Aron",
            browserUserDataDir: "/tmp/roles/role-1/browser",
            role
          }]
        };
      }
      return { finalized: true };
    });
    const stopRoles = vi.fn(async () => undefined);
    const prepareImportedSession = vi.fn(async () => undefined);
    const progress = vi.fn();
    const manager = new ChromeProfileImportManager({
      core: { invoke } as never,
      prepareImportedSession,
      showOpenDialog: vi.fn(),
      stopRoles
    });

    await expect(manager.applyImport({
      importId: "import-1",
      profileIds: ["Default"],
      gameId: "game-1",
      consentAccepted: true
    }, progress)).resolves.toEqual({ roles: [role] });

    expect(commands).toEqual([
      "chromeProfilePrepare",
      "chromeProfileCommit",
      "chromeProfileFinalize"
    ]);
    expect(stopRoles).toHaveBeenCalledWith(["role-1"]);
    expect(prepareImportedSession).toHaveBeenCalledWith(role, "/tmp/roles/role-1/browser");
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "completed" }));
  });

  it("asks Rust to roll back when Electron session injection fails", async () => {
    const commands: string[] = [];
    const invoke = vi.fn(async (command: { type: string }) => {
      commands.push(command.type);
      if (command.type === "chromeProfilePrepare") {
        return {
          overwrittenRoleIds: [],
          profiles: [{ id: "Default", directoryName: "Default", name: "Aron" }]
        };
      }
      if (command.type === "chromeProfileCommit") {
        return {
          roles: [role],
          sessions: [{
            profileId: "Default",
            profileName: "Aron",
            browserUserDataDir: "/tmp/browser",
            role
          }]
        };
      }
      return { rolledBack: true };
    });
    const manager = new ChromeProfileImportManager({
      core: { invoke } as never,
      prepareImportedSession: async () => { throw new Error("cookie import failed"); },
      showOpenDialog: vi.fn()
    });

    await expect(manager.applyImport({
      importId: "import-1",
      profileIds: ["Default"],
      gameId: "game-1",
      consentAccepted: true
    })).rejects.toThrow("cookie import failed");
    expect(commands).toEqual([
      "chromeProfilePrepare",
      "chromeProfileCommit",
      "chromeProfileRollback"
    ]);
  });

  it("delegates discard to Rust", async () => {
    const invoke = vi.fn(async () => ({ discarded: true }));
    const manager = new ChromeProfileImportManager({
      core: { invoke } as never,
      showOpenDialog: vi.fn()
    });
    await manager.discardImport("import-1");
    expect(invoke).toHaveBeenCalledWith({ type: "chromeProfileDiscard", importId: "import-1" });
  });

  it("preserves explicit close errors and maps native close failures", async () => {
    const unavailable = new ChromeProfileImportManager({
      core: { invoke: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });
    await expect(unavailable.closeChrome()).rejects.toMatchObject({
      code: "CHROME_CLOSE_UNAVAILABLE"
    });

    const explicit = new ChromeProfileImportError("CHROME_RUNNING", "still running");
    const manager = new ChromeProfileImportManager({
      closeChrome: async () => { throw explicit; },
      core: { invoke: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });
    await expect(manager.closeChrome()).rejects.toBe(explicit);
  });
});
