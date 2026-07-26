import { describe, expect, it, vi } from "vitest";

import {
  applyGraphicsSettingsUpdate,
  getGraphicsRestartState
} from "../src/renderer/src/features/settings/graphicsRestart";
import type { GraphicsDiagnostics } from "../src/shared/types";
import {
  DEFAULT_BROWSER_GRAPHICS_SETTINGS,
  LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
} from "../src/shared/browserFonts";
import { v1Case } from "./helpers/v1Parity";

function createDiagnostics(restartRequired: boolean): GraphicsDiagnostics {
  return {
    appliedSettings: LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
    appliedSwitches: [],
    collectedAt: "2026-07-14T00:00:00.000Z",
    embedded: {
      webgl: "available",
      webgl2: "available",
      webgpu: "available"
    },
    featureStatus: {},
    gpuInfoReady: true,
    hardwareAccelerationEnabled: true,
    platform: "darwin",
    restartRequired,
    savedSettings: restartRequired
      ? DEFAULT_BROWSER_GRAPHICS_SETTINGS
      : LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
    versions: {
      engine: "wkwebview",
      engineVersion: "14.6",
      shell: "tauri",
      shellVersion: "2.11"
    }
  };
}

describe("graphics restart state", () => {
  it("does not require a restart when the saved settings are already applied", () => {
    v1Case("resource-platform-fbde8261dd9a", () => {
      expect(getGraphicsRestartState(false, false)).toBe("not_required");
    });
  });

  it("allows an immediate restart when no roles are running", () => {
    expect(getGraphicsRestartState(true, false)).toBe("ready");
  });

  it("requires running roles to stop before restarting", () => {
    expect(getGraphicsRestartState(true, true)).toBe("roles_running");
  });
});

describe("graphics settings update", () => {
  it("saves and refreshes diagnostics in order", async () => {
    const calls: string[] = [];
    const diagnostics = createDiagnostics(true);

    await applyGraphicsSettingsUpdate({
      save: async () => {
        calls.push("save");
      },
      loadDiagnostics: async () => {
        calls.push("diagnostics");
        return diagnostics;
      },
      onDiagnostics: () => {
        calls.push("update");
      }
    });

    expect(calls).toEqual(["save", "diagnostics", "update"]);
  });

  it("opens the restart prompt only after saving and refreshing diagnostics", async () => {
    const calls: string[] = [];
    const diagnostics = createDiagnostics(true);

    await applyGraphicsSettingsUpdate({
      save: async () => {
        calls.push("save");
      },
      loadDiagnostics: async () => {
        calls.push("diagnostics");
        return diagnostics;
      },
      onDiagnostics: () => {
        calls.push("update");
      },
      onRestartRequired: () => {
        calls.push("restart");
      }
    });

    v1Case("resource-platform-df3d72154ebb", () => {
      expect(calls).toEqual(["save", "diagnostics", "update", "restart"]);
    });
  });

  it("does not refresh diagnostics when saving fails", async () => {
    const loadDiagnostics = vi.fn();
    const onRestartRequired = vi.fn();

    await expect(
      applyGraphicsSettingsUpdate({
        save: async () => {
          throw new Error("save failed");
        },
        loadDiagnostics,
        onDiagnostics: vi.fn(),
        onRestartRequired
      })
    ).rejects.toThrow("save failed");

    v1Case("resource-platform-b3825c9ba782", () => {
      expect(loadDiagnostics).not.toHaveBeenCalled();
      expect(onRestartRequired).not.toHaveBeenCalled();
    });
  });

  it("does not publish stale diagnostics when refreshing fails", async () => {
    const onDiagnostics = vi.fn();
    const onRestartRequired = vi.fn();

    await expect(
      applyGraphicsSettingsUpdate({
        save: async () => undefined,
        loadDiagnostics: async () => {
          throw new Error("diagnostics failed");
        },
        onDiagnostics,
        onRestartRequired
      })
    ).rejects.toThrow("diagnostics failed");

    v1Case("resource-platform-e259a84afc67", () => {
      expect(onDiagnostics).not.toHaveBeenCalled();
      expect(onRestartRequired).not.toHaveBeenCalled();
    });
  });

  it("does not open the restart prompt when diagnostics report no pending settings", async () => {
    const onRestartRequired = vi.fn();

    await applyGraphicsSettingsUpdate({
      save: async () => undefined,
      loadDiagnostics: async () => createDiagnostics(false),
      onDiagnostics: vi.fn(),
      onRestartRequired
    });

    v1Case("resource-platform-3ff0121d7980", () => {
      expect(onRestartRequired).not.toHaveBeenCalled();
    });
  });
});
