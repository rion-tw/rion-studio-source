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
    externalRoles: [],
    featureStatus: {},
    gpuInfoReady: true,
    hardwareAccelerationEnabled: true,
    platform: "darwin",
    restartRequired,
    savedSettings: restartRequired
      ? DEFAULT_BROWSER_GRAPHICS_SETTINGS
      : LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
    versions: {
      chromium: "1",
      electron: "1",
      node: "1"
    }
  };
}

describe("graphics restart state", () => {
  it("does not require a restart when the saved settings are already applied", () => {
    expect(getGraphicsRestartState(false, false)).toBe("not_required");
  });

  it("allows an immediate restart when no roles are running", () => {
    expect(getGraphicsRestartState(true, false)).toBe("ready");
  });

  it("requires running roles to stop before restarting", () => {
    expect(getGraphicsRestartState(true, true)).toBe("roles_running");
  });
});

describe("graphics settings update", () => {
  it("saves and refreshes diagnostics without opening a per-toggle restart prompt", async () => {
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

  it("does not refresh diagnostics when saving fails", async () => {
    const loadDiagnostics = vi.fn();

    await expect(
      applyGraphicsSettingsUpdate({
        save: async () => {
          throw new Error("save failed");
        },
        loadDiagnostics,
        onDiagnostics: vi.fn()
      })
    ).rejects.toThrow("save failed");

    expect(loadDiagnostics).not.toHaveBeenCalled();
  });

  it("does not publish stale diagnostics when refreshing fails", async () => {
    const onDiagnostics = vi.fn();

    await expect(
      applyGraphicsSettingsUpdate({
        save: async () => undefined,
        loadDiagnostics: async () => {
          throw new Error("diagnostics failed");
        },
        onDiagnostics
      })
    ).rejects.toThrow("diagnostics failed");

    expect(onDiagnostics).not.toHaveBeenCalled();
  });
});
