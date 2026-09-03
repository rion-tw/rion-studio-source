import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDesktopE2eProfile } from "./desktopE2eManifest.mjs";

const KNOWN_GATES = new Set(["pull-request", "nightly", "release-candidate"]);
const KNOWN_DRIVERS = new Set(["electron", "tauri"]);
const KNOWN_KINDS = new Set(["native", "ui"]);
const KNOWN_OUTCOMES = new Set(["cancel", "failure", "restart", "success"]);
const KNOWN_PLATFORMS = new Set(["macos", "windows"]);
const KNOWN_PRIORITIES = new Set(["P0", "P1", "P2"]);
const KNOWN_RISKS = new Set(["external", "native", "persistence", "standard"]);
const KNOWN_RUNTIME_TARGET_STATUSES = new Set(["active-compatibility", "planned"]);
const KNOWN_STATUSES = new Set(["automated", "planned"]);

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

export async function validateDesktopE2eCoverage(rootDirectory) {
  const root = resolve(rootDirectory);
  const manifestPath = resolve(root, "docs/e2e-coverage.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failures = [];
  const ids = new Set();
  const features = new Set(manifest.features ?? []);
  const profiles = manifest.profiles ?? {};
  const runtimeTargets = manifest.runtimeTargets ?? {};
  const stateCombinations = manifest.stateCombinations ?? [];
  const journeys = manifest.journeys ?? [];
  const phaseSpecSource = await readFile(resolve(root, "e2e/desktop/phaseSpecs.ts"), "utf8");

  if (manifest.version !== 3) failures.push("manifest version must be 3");
  if (features.size !== (manifest.features ?? []).length) failures.push("feature names must be unique");
  if (journeys.length === 0) failures.push("manifest must contain journeys");
  if (stateCombinations.length === 0) failures.push("manifest must contain state combinations");
  for (const [priority, target] of Object.entries(manifest.targets ?? {})) {
    if (!KNOWN_PRIORITIES.has(priority) || typeof target !== "number" || target < 0 || target > 1) {
      failures.push(`invalid coverage target ${priority}`);
    }
  }
  for (const [targetName, target] of Object.entries(runtimeTargets)) {
    if (!KNOWN_RUNTIME_TARGET_STATUSES.has(target.status)) {
      failures.push(`${targetName}: invalid runtime-target status ${target.status}`);
    }
    if (typeof target.cutoverRequired !== "boolean") {
      failures.push(`${targetName}: cutoverRequired must be boolean`);
    }
    if (!KNOWN_DRIVERS.has(target.driver)) {
      failures.push(`${targetName}: invalid desktop E2E driver ${target.driver}`);
    }
    if (!Array.isArray(target.platforms) || target.platforms.length === 0 ||
        target.platforms.some((platform) => !KNOWN_PLATFORMS.has(platform)) ||
        new Set(target.platforms).size !== target.platforms.length) {
      failures.push(`${targetName}: invalid runtime-target platforms`);
    }
    if (typeof target.shell !== "string" || target.shell.length === 0) {
      failures.push(`${targetName}: runtime target must name its shell`);
    }
  }
  const cutoverTargets = Object.entries(runtimeTargets)
    .filter(([, target]) => target.cutoverRequired);
  if (cutoverTargets.length !== 2 ||
      !cutoverTargets.some(([, target]) =>
        Array.isArray(target.platforms) &&
        target.platforms.length === 1 &&
        target.platforms[0] === "macos"
      ) ||
      !cutoverTargets.some(([, target]) =>
        Array.isArray(target.platforms) &&
        target.platforms.length === 1 &&
        target.platforms[0] === "windows"
      )) {
    failures.push("runtime targets must retain separate macOS AppKit and Windows Chromium cutover gates");
  }

  const sourceBySpec = new Map();
  async function specSource(path) {
    if (!sourceBySpec.has(path)) {
      try {
        sourceBySpec.set(path, await readFile(resolve(root, path), "utf8"));
      } catch {
        sourceBySpec.set(path, null);
      }
    }
    return sourceBySpec.get(path);
  }

  const resolvedProfiles = new Map();
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!KNOWN_GATES.has(profile.gate)) failures.push(`${profileName}: invalid gate ${profile.gate}`);
    const runtimeTarget = runtimeTargets[profile.runtimeTarget];
    if (!runtimeTarget) {
      failures.push(`${profileName}: unknown runtime target ${profile.runtimeTarget ?? "<missing>"}`);
    }
    if (profile.extends !== undefined && typeof profile.extends !== "string") {
      failures.push(`${profileName}: extends must name one profile`);
    } else if (typeof profile.extends === "string" && !profiles[profile.extends]) {
      failures.push(`${profileName}: unknown parent profile ${profile.extends}`);
    } else if (typeof profile.extends === "string" &&
        profiles[profile.extends]?.runtimeTarget !== profile.runtimeTarget) {
      failures.push(`${profileName}: inherited profiles must use the same runtime target`);
    }
    if (!Array.isArray(profile.phases) || profile.phases.length === 0) {
      failures.push(`${profileName}: profile must list phases`);
    } else {
      if (new Set(profile.phases).size !== profile.phases.length) {
        failures.push(`${profileName}: profile phases must be unique`);
      }
    }
    if (!Array.isArray(profile.specs) || profile.specs.length === 0) {
      failures.push(`${profileName}: profile must list specs`);
      continue;
    }
    if (new Set(profile.specs).size !== profile.specs.length) {
      failures.push(`${profileName}: profile specs must be unique`);
    }
    try {
      const resolvedProfile = resolveDesktopE2eProfile(manifest, profileName);
      resolvedProfiles.set(profileName, resolvedProfile);
      if (new Set(resolvedProfile.phases).size !== resolvedProfile.phases.length) {
        failures.push(`${profileName}: resolved profile phases must be unique`);
      }
      if (new Set(resolvedProfile.specs).size !== resolvedProfile.specs.length) {
        failures.push(`${profileName}: resolved profile specs must be unique`);
      }
      for (const phase of resolvedProfile.phases) {
        const hasMapping = phaseSpecSource.includes(`"${phase}"`) ||
          phaseSpecSource.includes(`  ${phase}:`);
        if (!hasMapping) failures.push(`${profileName}: WDIO does not map phase ${phase}`);
      }
      for (const path of resolvedProfile.specs) {
        if (await specSource(path) === null) failures.push(`${profileName}: missing spec ${path}`);
      }
    } catch (error) {
      failures.push(`${profileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const journey of journeys) {
    const label = journey.id || "<missing-id>";
    if (!journey.id || ids.has(journey.id)) failures.push(`${label}: journey id must be unique`);
    ids.add(journey.id);
    if (!features.has(journey.feature)) failures.push(`${label}: unknown feature ${journey.feature}`);
    if (!KNOWN_PRIORITIES.has(journey.priority)) failures.push(`${label}: invalid priority`);
    if (!KNOWN_STATUSES.has(journey.status)) failures.push(`${label}: invalid status`);
    if (!profiles[journey.profile]) failures.push(`${label}: unknown profile ${journey.profile}`);
    if (!KNOWN_KINDS.has(journey.kind)) failures.push(`${label}: invalid kind`);
    if (!KNOWN_RISKS.has(journey.risk)) failures.push(`${label}: invalid risk`);
    if (journey.coverageGroup !== undefined && (
      typeof journey.coverageGroup !== "string" || journey.coverageGroup.length === 0
    )) {
      failures.push(`${label}: invalid coverage group`);
    }
    if (journey.replaces !== undefined && (
      !Array.isArray(journey.replaces) ||
      journey.replaces.length === 0 ||
      journey.replaces.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(journey.replaces).size !== journey.replaces.length
    )) {
      failures.push(`${label}: replacements must be a unique non-empty journey-id list`);
    }
    if (journey.phase !== undefined) {
      failures.push(`${label}: use phases instead of legacy phase`);
    }
    const resolvedJourneyProfile = resolvedProfiles.get(journey.profile);
    if (journey.status === "automated" && ["P0", "P1"].includes(journey.priority) &&
        (!Array.isArray(journey.phases) || journey.phases.length === 0)) {
      failures.push(`${label}: automated P0/P1 journey must list evidence phases`);
    } else if (journey.phases !== undefined) {
      if (!Array.isArray(journey.phases) ||
          journey.phases.some((phase) => typeof phase !== "string" || phase.length === 0)) {
        failures.push(`${label}: invalid evidence phases`);
      } else {
        if (new Set(journey.phases).size !== journey.phases.length) {
          failures.push(`${label}: evidence phases must be unique`);
        }
        for (const phase of journey.phases) {
          if (!resolvedJourneyProfile?.phases.includes(phase)) {
            failures.push(`${label}: phase ${phase} is not included by profile ${journey.profile}`);
            continue;
          }
          const hasMapping = phaseSpecSource.includes(`"${phase}"`)
            || phaseSpecSource.includes(`  ${phase}:`);
          if (!hasMapping) failures.push(`${label}: WDIO does not map phase ${phase}`);
        }
      }
    }
    if (!Array.isArray(journey.platforms) || journey.platforms.some((item) => !KNOWN_PLATFORMS.has(item))) {
      failures.push(`${label}: invalid platforms`);
    } else if (new Set(journey.platforms).size !== journey.platforms.length) {
      failures.push(`${label}: platforms must be unique`);
    }
    const journeyRuntimeTarget = runtimeTargets[profiles[journey.profile]?.runtimeTarget];
    if (journeyRuntimeTarget &&
        journey.platforms.some((platform) => !journeyRuntimeTarget.platforms.includes(platform))) {
      failures.push(`${label}: platform is outside profile runtime target`);
    }
    if (["P0", "P1"].includes(journey.priority)) {
      const coversBothPlatforms = [...KNOWN_PLATFORMS]
        .every((platform) => journey.platforms.includes(platform));
      const isScopedCutoverMember = typeof journey.coverageGroup === "string"
        && journeyRuntimeTarget?.cutoverRequired === true
        && journey.platforms.length === journeyRuntimeTarget.platforms.length
        && journey.platforms.every((platform) => journeyRuntimeTarget.platforms.includes(platform));
      if (!coversBothPlatforms && !isScopedCutoverMember) {
        failures.push(
          `${label}: P0/P1 journeys must cover macos and windows or join a platform-complete cutover group`
        );
      }
    }
    if (!Array.isArray(journey.outcomes) || journey.outcomes.length === 0 ||
        journey.outcomes.some((item) => !KNOWN_OUTCOMES.has(item))) {
      failures.push(`${label}: invalid outcomes`);
    } else if (new Set(journey.outcomes).size !== journey.outcomes.length) {
      failures.push(`${label}: outcomes must be unique`);
    }
    if (journey.risk !== "standard" &&
        !journey.outcomes.some((item) => ["cancel", "failure", "restart"].includes(item))) {
      failures.push(`${label}: ${journey.risk} journey needs cancel, failure, or restart evidence`);
    }

    if (["P0", "P1"].includes(journey.priority) && !journey.spec) {
      failures.push(`${label}: P0/P1 journey must reference a spec`);
      continue;
    }
    if (journey.spec) {
      const source = await specSource(journey.spec);
      if (source === null) {
        failures.push(`${label}: missing spec ${journey.spec}`);
      } else if (journey.status === "automated") {
        const marker = `[journey:${journey.id}]`;
        const owningCount = occurrenceCount(source, marker);
        const allProfileSpecs = new Set(
          [...resolvedProfiles.values()].flatMap((profile) => profile.specs)
        );
        let totalCount = 0;
        for (const path of allProfileSpecs) {
          const candidate = await specSource(path);
          if (candidate !== null) totalCount += occurrenceCount(candidate, marker);
        }
        if (owningCount === 0) failures.push(`${label}: spec is missing its journey marker`);
        if (owningCount > 1 || totalCount > 1) failures.push(`${label}: journey marker must appear exactly once`);
      }
      if (resolvedJourneyProfile && !resolvedJourneyProfile.specs.includes(journey.spec)) {
        failures.push(`${label}: spec is not included by profile ${journey.profile}`);
      }
    }
  }

  const coverageGroups = new Map();
  for (const journey of journeys.filter((candidate) =>
    ["P0", "P1"].includes(candidate.priority) && typeof candidate.coverageGroup === "string"
  )) {
    const members = coverageGroups.get(journey.coverageGroup) ?? [];
    members.push(journey);
    coverageGroups.set(journey.coverageGroup, members);
  }
  for (const [group, members] of coverageGroups) {
    const groupPlatforms = new Set(members.flatMap((journey) => journey.platforms ?? []));
    const groupTargets = new Set(members.map((journey) =>
      profiles[journey.profile]?.runtimeTarget
    ));
    const sharedFields = ["feature", "kind", "priority", "risk"];
    const consistent = sharedFields.every((field) =>
      new Set(members.map((journey) => journey[field])).size === 1
    ) && new Set(members.map((journey) => JSON.stringify(journey.outcomes ?? []))).size === 1;
    if (
      members.length !== 2
      || ![...KNOWN_PLATFORMS].every((platform) => groupPlatforms.has(platform))
      || groupTargets.size !== 2
      || [...groupTargets].some((target) => runtimeTargets[target]?.cutoverRequired !== true)
      || members.some((journey) => journey.status !== "automated")
      || !consistent
    ) {
      failures.push(
        `${group}: cutover coverage group must pair equivalent automated macOS and Windows P0/P1 journeys`
      );
    }
  }

  const journeyById = new Map(journeys.map((journey) => [journey.id, journey]));
  const compatibilityJourneyIds = new Set(journeys
    .filter((journey) => {
      const targetName = profiles[journey.profile]?.runtimeTarget;
      const target = runtimeTargets[targetName];
      return journey.status === "automated" &&
        ["P0", "P1"].includes(journey.priority) &&
        target?.status === "active-compatibility" &&
        target.cutoverRequired === false;
    })
    .map((journey) => journey.id));
  const replacementsByTarget = new Map(cutoverTargets.map(([targetName]) => [
    targetName,
    new Map()
  ]));
  for (const journey of journeys) {
    if (journey.replaces === undefined || !Array.isArray(journey.replaces)) continue;
    const targetName = profiles[journey.profile]?.runtimeTarget;
    const target = runtimeTargets[targetName];
    if (!target?.cutoverRequired) {
      failures.push(`${journey.id}: only a cutover journey may replace compatibility evidence`);
      continue;
    }
    if (journey.status !== "automated") {
      failures.push(`${journey.id}: only automated cutover evidence may replace a journey`);
      continue;
    }
    const targetReplacements = replacementsByTarget.get(targetName);
    for (const sourceId of journey.replaces) {
      const source = journeyById.get(sourceId);
      if (!source || !compatibilityJourneyIds.has(sourceId)) {
        failures.push(`${journey.id}: replacement ${sourceId} is not an automated compatibility P0/P1 journey`);
        continue;
      }
      const retainsSemantics = source.priority === journey.priority &&
        source.feature === journey.feature && source.kind === journey.kind &&
        source.risk === journey.risk && Array.isArray(source.outcomes) &&
        Array.isArray(journey.outcomes) &&
        source.outcomes.every((outcome) => journey.outcomes.includes(outcome));
      if (!retainsSemantics) {
        failures.push(
          `${journey.id}: replacement ${sourceId} must retain priority, feature, ` +
          "journey kind, risk, and every source outcome"
        );
        continue;
      }
      const existing = targetReplacements?.get(sourceId);
      if (existing) {
        failures.push(
          `${targetName}: compatibility journey ${sourceId} is replaced more than once (${existing}, ${journey.id})`
        );
      } else {
        targetReplacements?.set(sourceId, journey.id);
      }
    }
  }
  const cutoverParity = Object.fromEntries(cutoverTargets.map(([targetName, target]) => {
    const replacements = replacementsByTarget.get(targetName) ?? new Map();
    const missingJourneyIds = [...compatibilityJourneyIds]
      .filter((id) => !replacements.has(id))
      .sort();
    if (target.status === "active-compatibility" && missingJourneyIds.length > 0) {
      failures.push(
        `${targetName}: cutover parity is incomplete ` +
        `(${replacements.size}/${compatibilityJourneyIds.size}; missing ${missingJourneyIds.join(", ")})`
      );
    }
    return [targetName, {
      covered: replacements.size,
      required: compatibilityJourneyIds.size,
      missingJourneyIds
    }];
  }));

  const combinationIds = new Set();
  const allProfileSpecs = new Set(
    [...resolvedProfiles.values()].flatMap((profile) => profile.specs)
  );
  for (const combination of stateCombinations) {
    const label = combination.id || "<missing-id>";
    if (!combination.id || combinationIds.has(combination.id)) {
      failures.push(`${label}: state combination id must be unique`);
    }
    combinationIds.add(combination.id);
    const profile = resolvedProfiles.get(combination.profile);
    if (!profiles[combination.profile]) failures.push(`${label}: unknown profile ${combination.profile}`);
    if (typeof combination.phase !== "string" || !profile?.phases.includes(combination.phase)) {
      failures.push(`${label}: phase is not included by profile ${combination.profile}`);
    }
    if (typeof combination.spec !== "string") {
      failures.push(`${label}: state combination must reference a spec`);
      continue;
    }
    if (profile && !profile.specs.includes(combination.spec)) {
      failures.push(`${label}: spec is not included by profile ${combination.profile}`);
    }
    if (!Array.isArray(combination.platforms) || combination.platforms.length === 0 ||
        combination.platforms.some((item) => !KNOWN_PLATFORMS.has(item))) {
      failures.push(`${label}: invalid platforms`);
    } else if (new Set(combination.platforms).size !== combination.platforms.length) {
      failures.push(`${label}: platforms must be unique`);
    }
    const combinationRuntimeTarget = runtimeTargets[profiles[combination.profile]?.runtimeTarget];
    if (combinationRuntimeTarget &&
        combination.platforms.some((platform) => !combinationRuntimeTarget.platforms.includes(platform))) {
      failures.push(`${label}: platform is outside profile runtime target`);
    }
    const dimensions = combination.dimensions;
    if (!dimensions || Array.isArray(dimensions) || typeof dimensions !== "object" ||
        Object.keys(dimensions).length < 2 ||
        Object.values(dimensions).some((value) => typeof value !== "string" || value.length === 0)) {
      failures.push(`${label}: state combination must name at least two dimensions`);
    }
    if (typeof combination.description !== "string" || combination.description.length === 0) {
      failures.push(`${label}: state combination needs a description`);
    }
    const source = await specSource(combination.spec);
    if (source === null) {
      failures.push(`${label}: missing spec ${combination.spec}`);
      continue;
    }
    const marker = `[state-combination:${combination.id}]`;
    const owningCount = occurrenceCount(source, marker);
    let totalCount = 0;
    for (const path of allProfileSpecs) {
      const candidate = await specSource(path);
      if (candidate !== null) totalCount += occurrenceCount(candidate, marker);
    }
    if (owningCount === 0) failures.push(`${label}: spec is missing its state-combination marker`);
    if (owningCount > 1 || totalCount > 1) {
      failures.push(`${label}: state-combination marker must appear exactly once`);
    }
  }

  for (const priority of ["P0", "P1"]) {
    const relevant = journeys.filter((journey) => journey.priority === priority);
    const automated = relevant.filter((journey) => journey.status === "automated");
    const ratio = relevant.length === 0 ? 0 : automated.length / relevant.length;
    const target = manifest.targets?.[priority];
    if (typeof target !== "number" || ratio < target) {
      failures.push(`${priority}: automated coverage ${(ratio * 100).toFixed(1)}% is below target ${(target * 100).toFixed(1)}%`);
    }
  }

  for (const feature of features) {
    const hasUiHappyPath = journeys.some((journey) =>
      journey.feature === feature &&
      journey.status === "automated" &&
      journey.kind === "ui" &&
      journey.outcomes.includes("success")
    );
    if (!hasUiHappyPath) failures.push(`${feature}: missing automated UI happy path`);
  }

  return { cutoverParity, failures, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { cutoverParity, failures, manifest } = await validateDesktopE2eCoverage(process.cwd());
  if (failures.length > 0) {
    console.error(`Desktop E2E coverage found ${failures.length} violation(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    const summaries = ["P0", "P1", "P2"].map((priority) => {
      const relevant = manifest.journeys.filter((journey) => journey.priority === priority);
      const automated = relevant.filter((journey) => journey.status === "automated").length;
      const ratio = relevant.length === 0 ? 0 : automated / relevant.length;
      return `${priority} ${automated}/${relevant.length} ${(ratio * 100).toFixed(1)}%`;
    });
    const parity = Object.entries(cutoverParity).map(([targetName, result]) =>
      `${targetName} ${result.covered}/${result.required}`
    );
    console.log(
      `Desktop E2E coverage manifest passed (${summaries.join(", ")}; ` +
      `cutover parity ${parity.join(", ")}).`
    );
  }
}
