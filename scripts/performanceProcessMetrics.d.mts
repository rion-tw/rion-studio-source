export type ProcessCategory = "app" | "renderer" | "gpu" | "browserUtility";

export interface ProcessEntry {
  command: string;
  cpuPercent?: number;
  pid: number;
  rssKiB?: number;
}

export interface ProcessCategorySample {
  cpuPercent: number;
  processCount: number;
  rssBytes: number;
}

export interface ProcessCategorySummary {
  medianCpuPercent: number;
  p95CpuPercent: number;
  peakCpuPercent: number;
  medianRssBytes: number;
  p95RssBytes: number;
  peakRssBytes: number;
  medianProcessCount: number;
  peakProcessCount: number;
}

export function classifyProcess(entry: ProcessEntry, rootPid: number): ProcessCategory;
export function processCategoryTotals(
  tree: ProcessEntry[],
  rootPid: number
): Record<ProcessCategory, ProcessCategorySample>;
export function summarizeProcessCategories(
  samples: Array<{ processCategories: Record<ProcessCategory, ProcessCategorySample> }>
): Record<ProcessCategory, ProcessCategorySummary>;
export function percentile(values: number[], fraction: number): number;
