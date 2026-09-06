import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateChromiumWorkspaceCutoverRuntimeEvidence } from
  "../scripts/desktopE2eChromiumWorkspaceCutoverEvidence.mjs";

function observation(platform: "macos" | "windows", roleId: string,
  generation: number, failed = false, phase = "ready") {
  const windowId = `window-${generation}`;
  const tabId = `tab-${generation}`;
  const attemptGeneration = `attempt-${generation}`;
  const hostKind = platform === "macos" ? "appkit-chromium" : "bundled-chromium";
  return {
    roleId, phase, placeholders: [],
    coreOwner: { generation, roleId, slotId: roleId, state: "running", tabId, windowId },
    coreStatus: {
      automationState: failed ? "unavailable" : "ready", hostKind,
      issueReason: failed ? "runtime-crashed" : null, overlayState: null,
      pageHealth: null, resolvedEngine: "chromium", roleId,
      runtimeMode: "embedded", state: "running"
    },
    nativeOwner: {
      appKitIdentity: platform === "macos" ? {
        launchGeneration: attemptGeneration, logicalWindowId: windowId,
        nativeGeneration: generation
      } : null,
      attemptGeneration, bounds: { x: 0, y: 40, width: 480, height: 600 },
      generation, hostKind, ownerGeneration: generation, parentNativeHostId: 1,
      roleId, tabId, topologyRevision: generation, visible: true,
      windowGeneration: generation, windowId
    }
  };
}

async function validate(platform: "macos" | "windows",
  observations: ReturnType<typeof observation>[]) {
  const directory = await mkdtemp(join(tmpdir(), "rion-recovery-evidence-"));
  try {
    await writeFile(join(directory, "electron-role-placeholder-observations.json"),
      JSON.stringify(observations));
    return await validateChromiumWorkspaceCutoverRuntimeEvidence({
      phase: "chromium-workspaces-recovery", phaseDirectory: directory, platform
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe.each(["macos", "windows"] as const)("%s recovery evidence", platform => {
  const history = () => [
    observation(platform, "healthy", 1), observation(platform, "failed", 1),
    observation(platform, "failed", 1, true),
    observation(platform, "failed", 1, true, "degraded"),
    observation(platform, "healthy", 1, false, "degraded"),
    observation(platform, "failed", 1, true, "degraded"),
    observation(platform, "healthy", 2), observation(platform, "failed", 2)
  ];
  it("accepts Core failure before the same-owner degraded projection", async () => {
    await expect(validate(platform, history())).resolves.toMatchObject({
      healthyStatusPreserved: true, failingGenerationAdvancedOnRelaunch: true
    });
  });
  it.each(["missing", "replaced-owner", "replaced-native", "not-relaunched"])(
    "rejects %s degradation or recovery evidence", async mismatch => {
      const values = history();
      for (const entry of values.filter(value => value.coreStatus.issueReason !== null)) {
        if (mismatch === "missing") entry.phase = "ready";
        if (mismatch === "replaced-owner" && entry.phase === "degraded") {
          entry.coreOwner.tabId = "other-tab";
          entry.nativeOwner.tabId = "other-tab";
        }
        if (mismatch === "replaced-native" && entry.phase === "degraded") {
          entry.nativeOwner.generation = 2;
        }
      }
      if (mismatch === "not-relaunched") values[7] = observation(platform, "failed", 1);
      await expect(validate(platform, values)).rejects.toThrow();
    }
  );
});
