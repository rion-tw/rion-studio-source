import type { DesktopE2eManifest } from "./desktopE2eManifest.mjs";

export interface DesktopE2eShardReport {
  commit: string;
  failure?: string;
  phases: readonly Readonly<{ phase: string; status: string }>[];
  profile: string;
  shard?: Readonly<{ count: number; index: number; phases?: readonly string[] }>;
}

export function verifyDesktopE2eShardReports(input: Readonly<{
  manifest: DesktopE2eManifest;
  profile: string;
  reports: readonly DesktopE2eShardReport[];
}>): { commit: string; count: number; phases: number };
