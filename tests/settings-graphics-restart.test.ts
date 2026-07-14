import { describe, expect, it, vi } from "vitest";

import {
  applyGraphicsModeUpdate,
  getGraphicsRestartState
} from "../src/renderer/src/features/settings/graphicsRestart";
import type { GraphicsDiagnostics } from "../src/shared/types";

function createDiagnostics(restartRequired: boolean): GraphicsDiagnostics {
  return {
    appliedMode: "automatic",
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
    savedMode: restartRequired ? "high_performance" : "automatic",
    versions: {
      chromium: "1",
      electron: "1",
      node: "1"
    }
  };
}

describe("graphics restart state", () => {
  it("does not require a restart when the saved mode is already applied", () => {
    expect(getGraphicsRestartState(false, false)).toBe("not_required");
  });

  it("allows an immediate restart when no roles are running", () => {
    expect(getGraphicsRestartState(true, false)).toBe("ready");
  });

  it("requires running roles to stop before restarting", () => {
    expect(getGraphicsRestartState(true, true)).toBe("roles_running");
  });
});

describe("graphics mode update", () => {
  it("opens the restart prompt only after saving and refreshing diagnostics", async () => {
    const calls: string[] = [];
    const diagnostics = createDiagnostics(true);

    await applyGraphicsModeUpdate({
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

    expect(calls).toEqual(["save", "diagnostics", "update", "restart"]);
  });

  it("does not open the restart prompt when saving fails", async () => {
    const loadDiagnostics = vi.fn();
    const onRestartRequired = vi.fn();

    await expect(
      applyGraphicsModeUpdate({
        save: async () => {
          throw new Error("save failed");
        },
        loadDiagnostics,
        onDiagnostics: vi.fn(),
        onRestartRequired
      })
    ).rejects.toThrow("save failed");

    expect(loadDiagnostics).not.toHaveBeenCalled();
    expect(onRestartRequired).not.toHaveBeenCalled();
  });

  it("does not open the restart prompt when diagnostics fail", async () => {
    const onRestartRequired = vi.fn();

    await expect(
      applyGraphicsModeUpdate({
        save: async () => undefined,
        loadDiagnostics: async () => {
          throw new Error("diagnostics failed");
        },
        onDiagnostics: vi.fn(),
        onRestartRequired
      })
    ).rejects.toThrow("diagnostics failed");

    expect(onRestartRequired).not.toHaveBeenCalled();
  });

  it("does not open the restart prompt when diagnostics report no pending mode", async () => {
    const onRestartRequired = vi.fn();

    await applyGraphicsModeUpdate({
      save: async () => undefined,
      loadDiagnostics: async () => createDiagnostics(false),
      onDiagnostics: vi.fn(),
      onRestartRequired
    });

    expect(onRestartRequired).not.toHaveBeenCalled();
  });
});
