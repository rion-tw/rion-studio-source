export const PROCESS_CATEGORIES = ["app", "renderer", "gpu", "browserUtility"];

export function classifyProcess(entry, rootPid) {
  if (entry.pid === rootPid) return "app";
  const command = String(entry.command ?? "");
  if (/--type=gpu-process\b|(?:^|[/.\s-])WebKit[.\s-]*GPU(?:[.\s-]|$)|GPU Process/iu.test(command)) {
    return "gpu";
  }
  if (/--type=renderer\b|(?:^|[/.\s-])WebKit[.\s-]*WebContent(?:[.\s-]|$)|Web Content/iu.test(command)) {
    return "renderer";
  }
  return "browserUtility";
}

export function processCategoryTotals(tree, rootPid) {
  const totals = Object.fromEntries(PROCESS_CATEGORIES.map((category) => [category, {
    cpuPercent: 0,
    processCount: 0,
    rssBytes: 0
  }]));
  for (const entry of tree) {
    const category = classifyProcess(entry, rootPid);
    const total = totals[category];
    total.cpuPercent += finiteNonNegative(entry.cpuPercent);
    total.processCount += 1;
    total.rssBytes += finiteNonNegative(entry.rssKiB) * 1_024;
  }
  return totals;
}

export function summarizeProcessCategories(samples) {
  return Object.fromEntries(PROCESS_CATEGORIES.map((category) => {
    const resources = samples.map((sample) => sample.processCategories[category]);
    return [category, {
      medianCpuPercent: median(resources.map((entry) => entry.cpuPercent)),
      p95CpuPercent: percentile(resources.map((entry) => entry.cpuPercent), 0.95),
      peakCpuPercent: maximum(resources.map((entry) => entry.cpuPercent)),
      medianRssBytes: median(resources.map((entry) => entry.rssBytes)),
      p95RssBytes: percentile(resources.map((entry) => entry.rssBytes), 0.95),
      peakRssBytes: maximum(resources.map((entry) => entry.rssBytes)),
      medianProcessCount: median(resources.map((entry) => entry.processCount)),
      peakProcessCount: maximum(resources.map((entry) => entry.processCount))
    }];
  }));
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function maximum(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
