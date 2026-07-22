import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import {
  aggregatePerformanceSummaries,
  comparePerformanceSummaries
} from "./performanceGates.mjs";

const options = parseArguments(process.argv.slice(2));
const baselinePaths = paths(options.baseline, "--baseline");
const candidatePaths = paths(options.candidate, "--candidate");
const baselineRuns = await readRuns(baselinePaths);
const candidateRuns = await readRuns(candidatePaths);
const metadata = assertComparableRuns([...baselineRuns, ...candidateRuns]);
const baseline = aggregatePerformanceSummaries(baselineRuns.map((run) => run.summary));
const candidate = aggregatePerformanceSummaries(candidateRuns.map((run) => run.summary));
const comparison = comparePerformanceSummaries(candidate, baseline);
const outputPath = resolve(options.output ??
  `performance-results/${new Date().toISOString().replaceAll(":", "-")}-${metadata.scenario}-comparison.json`);
const report = {
  schemaVersion: 1,
  metadata,
  baseline,
  candidate,
  comparison,
  sources: { baseline: baselinePaths, candidate: candidatePaths }
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Performance comparison: ${outputPath}\n`);
process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
if (!comparison.passed) process.exitCode = 2;

async function readRuns(runPaths) {
  return Promise.all(runPaths.map(async (path) =>
    JSON.parse(await readFile(resolve(path), "utf8"))
  ));
}

function assertComparableRuns(runs) {
  const fields = [
    "arch", "durationMs", "fixture", "host", "intervalMs", "platform",
    "resolution", "scenario", "settings", "warmupMs"
  ];
  const expected = Object.fromEntries(fields.map((field) => [field, runs[0]?.metadata?.[field]]));
  for (const run of runs) {
    for (const field of fields) {
      if (run?.metadata?.[field] !== expected[field]) {
        throw new Error(`Performance run metadata differs for ${field}.`);
      }
    }
    if (!run.summary) throw new Error("Performance run is missing its summary.");
  }
  if (expected.warmupMs !== 600_000 || expected.durationMs !== 1_800_000) {
    throw new Error("Release comparisons require a 10 minute warmup and 30 minute measurement.");
  }
  return expected;
}

function parseArguments(arguments_) {
  return Object.fromEntries(arguments_.map((argument) => {
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`Arguments must use --name=value syntax: ${argument}`);
    return [match[1], match[2]];
  }));
}

function paths(raw, name) {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (values.length !== 3) throw new Error(`${name} requires exactly three comma-separated files.`);
  return values;
}
