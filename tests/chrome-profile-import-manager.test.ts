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
      core: { invoke, subscribe: vi.fn() } as never,
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

  it("sends one high-level Rust intent and forwards Rust-owned progress", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const subscribe = vi.fn((next: (events: never[]) => void) => {
      listener = next;
      return () => undefined;
    });
    const invoke = vi.fn(async () => {
      listener?.([{
        type: "chromeProfileImportProgress",
        progress: {
          completedProfileCount: 1,
          currentProfileId: "Default",
          currentProfileName: "Aron",
          importId: "import-1",
          phase: "completed",
          totalProfileCount: 1
        }
      }] as never[]);
      return { roles: [role] };
    });
    const progress = vi.fn();
    const manager = new ChromeProfileImportManager({
      core: { invoke, subscribe } as never,
      showOpenDialog: vi.fn(),
    });

    await expect(manager.applyImport({
      importId: "import-1",
      profileIds: ["Default"],
      gameId: "game-1",
      consentAccepted: true
    }, progress)).resolves.toEqual({ roles: [role] });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      type: "chromeProfileApply",
      importId: "import-1",
      profileIds: ["Default"],
      gameId: "game-1",
      consentAccepted: true
    });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "completed" }));
  });

  it("does not retain progress listeners after a Rust operation failure", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("cookie import failed");
    });
    const manager = new ChromeProfileImportManager({
      core: { invoke, subscribe: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });

    await expect(manager.applyImport({
      importId: "import-1",
      profileIds: ["Default"],
      gameId: "game-1",
      consentAccepted: true
    })).rejects.toThrow("cookie import failed");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("delegates discard to Rust", async () => {
    const invoke = vi.fn(async () => ({ discarded: true }));
    const manager = new ChromeProfileImportManager({
      core: { invoke, subscribe: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });
    await manager.discardImport("import-1");
    expect(invoke).toHaveBeenCalledWith({ type: "chromeProfileDiscard", importId: "import-1" });
  });

  it("preserves explicit close errors and maps native close failures", async () => {
    const unavailable = new ChromeProfileImportManager({
      core: { invoke: vi.fn(), subscribe: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });
    await expect(unavailable.closeChrome()).rejects.toMatchObject({
      code: "CHROME_CLOSE_UNAVAILABLE"
    });

    const explicit = new ChromeProfileImportError("CHROME_RUNNING", "still running");
    const manager = new ChromeProfileImportManager({
      closeChrome: async () => { throw explicit; },
      core: { invoke: vi.fn(), subscribe: vi.fn() } as never,
      showOpenDialog: vi.fn()
    });
    await expect(manager.closeChrome()).rejects.toBe(explicit);
  });
});
