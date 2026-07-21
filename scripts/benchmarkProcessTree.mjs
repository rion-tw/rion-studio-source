import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseArguments(process.argv.slice(2));
const rootPid = positiveInteger(options.pid, "--pid");
const warmupMs = seconds(options["warmup-seconds"] ?? "600", "--warmup-seconds");
const durationMs = seconds(options["duration-seconds"] ?? "1800", "--duration-seconds");
const intervalMs = positiveInteger(options["interval-ms"] ?? "1000", "--interval-ms");
const scenario = options.scenario?.trim();
if (!scenario) throw new Error("--scenario is required.");
const outputPath = resolve(
  options.output ?? `performance-results/${new Date().toISOString().replaceAll(":", "-")}-${scenario}.json`
);

await assertProcessExists(rootPid);
if (warmupMs > 0) {
  process.stdout.write(`Warming ${scenario} for ${(warmupMs / 60_000).toFixed(1)} minutes...\n`);
  await delay(warmupMs);
}

const samples = [];
let previousWindowsCpuTimes = new Map();
let previousWindowsSampleAt;
const startedAt = new Date().toISOString();
const deadline = Date.now() + durationMs;
while (Date.now() < deadline || samples.length === 0) {
  const processTable = await readProcessTable();
  if (process.platform === "win32") {
    const capturedAt = performance.now();
    const elapsedMs = previousWindowsSampleAt === undefined
      ? undefined
      : capturedAt - previousWindowsSampleAt;
    for (const entry of processTable) {
      const previous = previousWindowsCpuTimes.get(entry.pid);
      entry.cpuPercent = previous === undefined || !elapsedMs
        ? 0
        : Math.max(0, ((entry.cpuTime100ns - previous) / 10_000 / elapsedMs) * 100);
    }
    previousWindowsCpuTimes = new Map(
      processTable.map((entry) => [entry.pid, entry.cpuTime100ns])
    );
    previousWindowsSampleAt = capturedAt;
  }
  const tree = selectProcessTree(processTable, rootPid);
  if (tree.length === 0) throw new Error(`Process ${rootPid} exited during measurement.`);
  const root = tree.find((entry) => entry.pid === rootPid);
  const nonRenderer = tree.filter(
    (entry) => !/--type=(?:renderer|gpu-process)/u.test(entry.command)
  );
  samples.push({
    capturedAt: new Date().toISOString(),
    processCount: tree.length,
    rootCpuPercent: root?.cpuPercent ?? 0,
    rootRssBytes: (root?.rssKiB ?? 0) * 1_024,
    nonRendererCpuPercent: sum(nonRenderer.map((entry) => entry.cpuPercent)),
    nonRendererRssBytes: sum(nonRenderer.map((entry) => entry.rssKiB)) * 1_024,
    treeCpuPercent: sum(tree.map((entry) => entry.cpuPercent)),
    treeRssBytes: sum(tree.map((entry) => entry.rssKiB)) * 1_024
  });
  const remaining = deadline - Date.now();
  if (remaining > 0) await delay(Math.min(intervalMs, remaining));
}

const telemetry = options.telemetry
  ? JSON.parse(await readFile(resolve(options.telemetry), "utf8"))
  : undefined;
const summary = summarize(samples, telemetry);
const result = {
  schemaVersion: 1,
  metadata: {
    arch: process.arch,
    durationMs,
    fixture: options.fixture,
    host: hostname(),
    intervalMs,
    node: process.version,
    platform: process.platform,
    resolution: options.resolution,
    rootPid,
    scenario,
    settings: options.settings,
    startedAt,
    warmupMs
  },
  samples,
  summary,
  ...(options.baseline
    ? { comparison: compare(summary, JSON.parse(await readFile(resolve(options.baseline), "utf8")).summary) }
    : {})
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`Performance result: ${outputPath}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (result.comparison && !result.comparison.passed) process.exitCode = 2;

function summarize(samples, telemetry) {
  const firstWindow = samples.slice(0, Math.max(1, Math.ceil(samples.length * 0.1)));
  const lastWindow = samples.slice(-Math.max(1, Math.ceil(samples.length * 0.1)));
  const firstRss = median(firstWindow.map((sample) => sample.nonRendererRssBytes));
  const lastRss = median(lastWindow.map((sample) => sample.nonRendererRssBytes));
  return {
    medianNonRendererCpuPercent: median(samples.map((sample) => sample.nonRendererCpuPercent)),
    medianNonRendererRssBytes: median(samples.map((sample) => sample.nonRendererRssBytes)),
    medianRootCpuPercent: median(samples.map((sample) => sample.rootCpuPercent)),
    medianRootRssBytes: median(samples.map((sample) => sample.rootRssBytes)),
    medianTreeCpuPercent: median(samples.map((sample) => sample.treeCpuPercent)),
    medianTreeRssBytes: median(samples.map((sample) => sample.treeRssBytes)),
    nonRendererRssGrowthPercent: firstRss === 0 ? 0 : ((lastRss - firstRss) / firstRss) * 100,
    sampleCount: samples.length,
    ...(telemetry ? { runtimeTelemetry: telemetry } : {})
  };
}

function compare(current, baseline) {
  const improvement = (before, after) => before === 0 ? 0 : ((before - after) / before) * 100;
  const latencyRegression = baseline.runtimeTelemetry?.napi?.p95Ms
    ? ((current.runtimeTelemetry?.napi?.p95Ms ?? Infinity) - baseline.runtimeTelemetry.napi.p95Ms) /
      baseline.runtimeTelemetry.napi.p95Ms * 100
    : undefined;
  const gates = {
    nonRendererCpuImprovementPercent: improvement(
      baseline.medianNonRendererCpuPercent,
      current.medianNonRendererCpuPercent
    ),
    nonRendererRssImprovementPercent: improvement(
      baseline.medianNonRendererRssBytes,
      current.medianNonRendererRssBytes
    ),
    treeCpuImprovementPercent: improvement(
      baseline.medianTreeCpuPercent,
      current.medianTreeCpuPercent
    ),
    treeRssImprovementPercent: improvement(
      baseline.medianTreeRssBytes,
      current.medianTreeRssBytes
    ),
    napiP95RegressionPercent: latencyRegression,
    rssGrowthPercent: current.nonRendererRssGrowthPercent
  };
  return {
    gates,
    passed:
      gates.nonRendererCpuImprovementPercent >= 30 &&
      gates.nonRendererRssImprovementPercent >= 20 &&
      gates.treeCpuImprovementPercent >= 10 &&
      gates.treeRssImprovementPercent >= 5 &&
      (gates.napiP95RegressionPercent === undefined || gates.napiP95RegressionPercent <= 5) &&
      gates.rssGrowthPercent <= 5
  };
}

async function readProcessTable() {
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference='Stop'",
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine |",
      "ConvertTo-Json -Compress"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      maxBuffer: 16 * 1024 * 1024
    });
    const payload = JSON.parse(stdout);
    return (Array.isArray(payload) ? payload : [payload]).map((entry) => ({
      command: entry.CommandLine ?? "",
      cpuTime100ns: Number(entry.KernelModeTime ?? 0) + Number(entry.UserModeTime ?? 0),
      cpuPercent: 0,
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      rssKiB: Number(entry.WorkingSetSize ?? 0) / 1_024
    }));
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,command="], {
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match
      ? [{
          command: match[5],
          cpuPercent: Number(match[3]),
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssKiB: Number(match[4])
        }]
      : [];
  });
}

function selectProcessTree(table, rootPidValue) {
  const selected = new Set([rootPidValue]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table) {
      if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }
  return table.filter((entry) => selected.has(entry.pid));
}

async function assertProcessExists(pid) {
  if (!(await readProcessTable()).some((entry) => entry.pid === pid)) {
    throw new Error(`Process ${pid} does not exist.`);
  }
}

function parseArguments(arguments_) {
  return Object.fromEntries(arguments_.map((argument) => {
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`Arguments must use --name=value syntax: ${argument}`);
    return [match[1], match[2]];
  }));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function seconds(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be zero or greater.`);
  return parsed * 1_000;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function delay(durationMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}
