import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { withChromiumMacroCutoverNativePrerequisites } from "../scripts/desktopE2eChromiumMacroCutoverEvidence.mjs";
import { resolveDesktopE2eProfile } from "../scripts/desktopE2eManifest.mjs";
import { focusedPhaseDependencies, phaseNamespaces } from "../scripts/desktopE2ePhaseTopology.mjs";
import { parseDesktopE2eShard, partitionDesktopE2ePhases } from "../scripts/desktopE2eShards.mjs";
import { verifyDesktopE2eShardReports } from "../scripts/verifyDesktopE2eShardReports.mjs";

const manifest = JSON.parse(readFileSync("docs/e2e-coverage.json", "utf8"));

function realShards(profile: string, platform: "darwin" | "win32", count: number): string[][] {
  return partitionDesktopE2ePhases({
    phases: resolveDesktopE2eProfile(manifest, profile).phases,
    dependencies: focusedPhaseDependencies,
    namespaces: phaseNamespaces,
    prerequisites: (phase: string) => withChromiumMacroCutoverNativePrerequisites({ platform, selectedPhases: [phase] }),
    count
  });
}

describe("desktop E2E shards", () => {
  it("parses only bounded 1-based shard arguments", () => {
    expect(parseDesktopE2eShard(undefined)).toBeUndefined();
    expect(parseDesktopE2eShard("2/2")).toEqual({ count: 2, index: 2 });
    for (const invalid of ["0/2", "3/2", "1", "1/9", "a/b", "1/2/3"]) {
      expect(() => parseDesktopE2eShard(invalid), invalid).toThrow();
    }
  });

  it("keeps prerequisite chains and shared namespaces on one shard in profile order", () => {
    const shards = partitionDesktopE2ePhases({
      phases: ["a-seed", "b", "a-restart", "c", "d", "e"],
      dependencies: new Map([["a-restart", ["a-seed"]]]),
      namespaces: new Map([["c", "shared"], ["e", "shared"]]),
      count: 2,
      weights: { b: 3 }
    });
    expect(shards).toEqual([["b", "d"], ["a-seed", "a-restart", "c", "e"]]);
    expect(() => partitionDesktopE2ePhases({
      phases: ["a"], dependencies: new Map([["a", ["missing"]]]), namespaces: new Map(), count: 2
    })).toThrow(/missing of a is not part of the profile/u);
  });

  it.each([
    ["chromium-macos-appkit-smoke", "darwin"],
    ["chromium-windows-smoke", "win32"]
  ] as const)("runs every %s phase exactly once with its prerequisites", (profile, platform) => {
    const phases = resolveDesktopE2eProfile(manifest, profile).phases;
    const shards = realShards(profile, platform, 2);
    expect(shards.flat().sort()).toEqual([...phases].sort());
    expect(shards.every(shard => shard.length > 0)).toBe(true);
    for (const shard of shards) {
      for (const phase of shard) {
        for (const dependency of focusedPhaseDependencies.get(phase) ?? []) expect(shard, phase).toContain(dependency);
        for (const prerequisite of withChromiumMacroCutoverNativePrerequisites({ platform, selectedPhases: [phase] })) {
          expect(shard, phase).toContain(prerequisite);
        }
        const namespace = phaseNamespaces.get(phase);
        if (namespace) {
          for (const other of phases.filter(candidate => phaseNamespaces.get(candidate) === namespace)) {
            expect(shard, `${phase} shares ${namespace}`).toContain(other);
          }
        }
      }
      expect(shard).toEqual(phases.filter(phase => shard.includes(phase)));
    }
  });
});

describe("sharded desktop E2E verification", () => {
  const profile = "chromium-windows-smoke";
  const shards = realShards(profile, "win32", 2);
  const report = (index: number, phases: string[], extra: Record<string, unknown> = {}) => ({
    commit: "c0ffee", profile, shard: { count: 2, index, phases },
    phases: phases.map(phase => ({ phase, status: "PASS" })), ...extra
  });

  it("accepts one passing report per shard and replaces a failed earlier attempt", () => {
    const failed = report(2, shards[1]!, { failure: "Error: flaky" });
    expect(verifyDesktopE2eShardReports({ manifest, profile,
      reports: [report(1, shards[0]!), failed, report(2, shards[1]!)] }))
      .toEqual({ commit: "c0ffee", count: 2, phases: shards.flat().length });
  });

  it("rejects missing shards, missing phases, failed journeys, and mixed commits", () => {
    expect(() => verifyDesktopE2eShardReports({ manifest, profile, reports: [report(1, shards[0]!)] }))
      .toThrow(/shard 2\/2 has no passing report/u);
    expect(() => verifyDesktopE2eShardReports({ manifest, profile,
      reports: [report(1, shards[0]!), report(2, shards[1]!.slice(1))] })).toThrow(/did not run/u);
    const failing = report(2, shards[1]!);
    failing.phases[0]!.status = "FAIL";
    expect(() => verifyDesktopE2eShardReports({ manifest, profile, reports: [report(1, shards[0]!), failing] }))
      .toThrow(/incomplete journey evidence/u);
    expect(() => verifyDesktopE2eShardReports({ manifest, profile,
      reports: [report(1, shards[0]!), { ...report(2, shards[1]!), commit: "other" }] })).toThrow(/different commits/u);
  });
});
