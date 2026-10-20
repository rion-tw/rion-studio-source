import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  aggregateDesktopE2eJourneyVerdicts,
  resolveDesktopE2eProfile
} from "./desktopE2eManifest.mjs";

/**
 * Verifies one sharded desktop E2E profile as a whole: exactly one passing
 * report per shard from the same commit, every profile phase run once, and
 * every profile journey PASS across the union, which is the check an unsharded
 * run performs at its end. A rerun shard's newer passing report replaces its
 * earlier failed attempt.
 */
export function verifyDesktopE2eShardReports({ manifest, profile, reports }) {
  const candidates = reports.filter(report => report.profile === profile && report.shard);
  if (candidates.length === 0) throw new Error(`No sharded desktop E2E reports for ${profile}.`);
  const counts = new Set(candidates.map(report => report.shard.count));
  if (counts.size !== 1) throw new Error(`${profile} reports disagree on the shard count.`);
  const [count] = counts;
  const commits = new Set(candidates.map(report => report.commit));
  if (commits.size !== 1) throw new Error(`${profile} shard reports come from different commits.`);
  const selected = [];
  for (let index = 1; index <= count; index += 1) {
    const passing = candidates.filter(report => report.shard.index === index && !report.failure);
    if (passing.length === 0) throw new Error(`${profile} shard ${index}/${count} has no passing report.`);
    if (passing.length > 1) throw new Error(`${profile} shard ${index}/${count} has more than one passing report.`);
    selected.push(passing[0]);
  }
  const phaseResults = selected.flatMap(report => report.phases);
  const ran = phaseResults.map(result => result.phase);
  const repeated = ran.filter((phase, index) => ran.indexOf(phase) !== index);
  if (repeated.length > 0) throw new Error(`${profile} shards repeated phases: ${repeated.join(", ")}`);
  const missing = resolveDesktopE2eProfile(manifest, profile).phases.filter(phase => !ran.includes(phase));
  if (missing.length > 0) throw new Error(`${profile} shards did not run: ${missing.join(", ")}`);
  const incomplete = aggregateDesktopE2eJourneyVerdicts(manifest, profile, phaseResults)
    .filter(journey => journey.status !== "PASS");
  if (incomplete.length > 0) {
    throw new Error(`Desktop E2E profile ${profile} has incomplete journey evidence: ${incomplete
      .map(journey => `${journey.id}=${journey.status}`).join(", ")}`);
  }
  return { commit: [...commits][0], count, phases: ran.length };
}

async function findReports(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findReports(path));
    else if (entry.name === "report.json") {
      // Only desktop E2E run reports carry a profile and phase list.
      try {
        const report = JSON.parse(await readFile(path, "utf8"));
        if (report && typeof report.profile === "string" && Array.isArray(report.phases)) found.push(report);
      } catch {
        // Not a desktop E2E report.
      }
    }
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [directory, ...profiles] = process.argv.slice(2);
  if (!directory || profiles.length === 0) {
    throw new Error("Usage: verifyDesktopE2eShardReports.mjs <artifact directory> <profile>...");
  }
  const root = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(await readFile(join(root, "docs", "e2e-coverage.json"), "utf8"));
  const reports = await findReports(resolve(directory));
  for (const profile of profiles) {
    const result = verifyDesktopE2eShardReports({ manifest, profile, reports });
    process.stdout.write(
      `Desktop E2E profile ${profile}: ${result.phases} phases passed across ${result.count} shards at ${result.commit}.\n`
    );
  }
}
