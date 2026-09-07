import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveDesktopE2eFocusedPhases } from "../scripts/desktopE2eFocusedPhases.mjs";
import { resolveDesktopE2eProfile } from "../scripts/desktopE2eManifest.mjs";
import { withChromiumMacroCutoverNativePrerequisites } from
  "../scripts/desktopE2eChromiumMacroCutoverEvidence.mjs";

const seed = "chromium-tabs-visible-seed";
const restart = "chromium-tabs-visible-restart";
const hardware = "chromium-native-window-display-extended";
const dependencies = new Map([[restart, [seed]], [hardware, [restart]]]);
const manifest = JSON.parse(readFileSync("docs/e2e-coverage.json", "utf8"));

describe("focused desktop E2E prerequisites", () => {
  it.each([
    { platform: "darwin", profile: "chromium-macos-appkit-hardware-extended" },
    { platform: "win32", profile: "chromium-windows-hardware-extended" }
  ])("includes seed before restart and hardware on $platform", ({ platform, profile }) => {
    const configuredPhases = resolveDesktopE2eProfile(manifest, profile).phases;
    const selectedPhases = resolveDesktopE2eFocusedPhases({
      configuredPhases, dependencies, phase: hardware
    });
    expect(withChromiumMacroCutoverNativePrerequisites({ platform, selectedPhases }))
      .toEqual([seed, restart, hardware]);
    expect(resolveDesktopE2eFocusedPhases({ configuredPhases, dependencies, phase: restart }))
      .toEqual([seed, restart]);
  });

  it("runs each shared prerequisite exactly once in dependency order", () => {
    const configuredPhases = ["seed", "a", "b", "final"];
    const graph = new Map([
      ["a", ["seed"]], ["b", ["seed", "a"]], ["final", ["a", "b", "seed"]]
    ]);
    expect(resolveDesktopE2eFocusedPhases({
      configuredPhases, dependencies: graph, phase: "final"
    })).toEqual(configuredPhases);
    expect(graph.get("final")).toEqual(["a", "b", "seed"]);
  });

  it("rejects an unavailable transitive seed before launching an app", () => {
    expect(() => resolveDesktopE2eFocusedPhases({
      configuredPhases: [restart, hardware], dependencies, phase: hardware
    })).toThrow(`prerequisite ${seed} is not part of the selected profile`);
  });

  it("rejects cycles instead of returning an incomplete plan", () => {
    expect(() => resolveDesktopE2eFocusedPhases({
      configuredPhases: [seed, restart],
      dependencies: new Map([[restart, [seed]], [seed, [restart]]]), phase: restart
    })).toThrow(`prerequisite cycle at ${restart}`);
  });

  it("runs a phase with no prerequisites exactly once", () => {
    expect(resolveDesktopE2eFocusedPhases({
      configuredPhases: [seed, restart], dependencies, phase: seed
    })).toEqual([seed]);
  });
});
