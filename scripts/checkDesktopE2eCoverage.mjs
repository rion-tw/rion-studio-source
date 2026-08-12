import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_GATES = new Set(["pull-request", "nightly", "release-candidate"]);
const KNOWN_KINDS = new Set(["native", "ui"]);
const KNOWN_OUTCOMES = new Set(["cancel", "failure", "restart", "success"]);
const KNOWN_PLATFORMS = new Set(["macos", "windows"]);
const KNOWN_PRIORITIES = new Set(["P0", "P1", "P2"]);
const KNOWN_RISKS = new Set(["external", "native", "persistence", "standard"]);
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
  const journeys = manifest.journeys ?? [];
  const wdioConfig = await readFile(resolve(root, "e2e/desktop/wdio.conf.ts"), "utf8");

  if (manifest.version !== 1) failures.push("manifest version must be 1");
  if (features.size !== (manifest.features ?? []).length) failures.push("feature names must be unique");
  if (journeys.length === 0) failures.push("manifest must contain journeys");
  for (const [priority, target] of Object.entries(manifest.targets ?? {})) {
    if (!KNOWN_PRIORITIES.has(priority) || typeof target !== "number" || target < 0 || target > 1) {
      failures.push(`invalid coverage target ${priority}`);
    }
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

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!KNOWN_GATES.has(profile.gate)) failures.push(`${profileName}: invalid gate ${profile.gate}`);
    if (!Array.isArray(profile.phases) || profile.phases.length === 0) {
      failures.push(`${profileName}: profile must list phases`);
    } else {
      if (new Set(profile.phases).size !== profile.phases.length) {
        failures.push(`${profileName}: profile phases must be unique`);
      }
      for (const phase of profile.phases) {
        const hasMapping = wdioConfig.includes(`"${phase}"`) || wdioConfig.includes(`  ${phase}:`);
        if (!hasMapping) failures.push(`${profileName}: WDIO does not map phase ${phase}`);
      }
    }
    if (!Array.isArray(profile.specs) || profile.specs.length === 0) {
      failures.push(`${profileName}: profile must list specs`);
      continue;
    }
    if (new Set(profile.specs).size !== profile.specs.length) {
      failures.push(`${profileName}: profile specs must be unique`);
    }
    for (const path of profile.specs) {
      if (await specSource(path) === null) failures.push(`${profileName}: missing spec ${path}`);
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
    if (!Array.isArray(journey.platforms) || journey.platforms.some((item) => !KNOWN_PLATFORMS.has(item))) {
      failures.push(`${label}: invalid platforms`);
    } else if (new Set(journey.platforms).size !== journey.platforms.length) {
      failures.push(`${label}: platforms must be unique`);
    }
    if (["P0", "P1"].includes(journey.priority) &&
        ![...KNOWN_PLATFORMS].every((platform) => journey.platforms.includes(platform))) {
      failures.push(`${label}: P0/P1 journeys must cover macos and windows`);
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
        const allProfileSpecs = new Set(Object.values(profiles).flatMap((profile) => profile.specs ?? []));
        let totalCount = 0;
        for (const path of allProfileSpecs) {
          const candidate = await specSource(path);
          if (candidate !== null) totalCount += occurrenceCount(candidate, marker);
        }
        if (owningCount === 0) failures.push(`${label}: spec is missing its journey marker`);
        if (owningCount > 1 || totalCount > 1) failures.push(`${label}: journey marker must appear exactly once`);
      }
      if (profiles[journey.profile] && !profiles[journey.profile].specs.includes(journey.spec)) {
        failures.push(`${label}: spec is not included by profile ${journey.profile}`);
      }
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

  return { failures, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { failures, manifest } = await validateDesktopE2eCoverage(process.cwd());
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
    console.log(`Desktop E2E coverage manifest passed (${summaries.join(", ")}).`);
  }
}
