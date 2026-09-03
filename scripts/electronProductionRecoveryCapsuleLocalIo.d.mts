import type { BigIntStats } from "node:fs";

export function resolveCreateNewMaterializationRoot(value: string): Promise<Readonly<{
  parentIdentity: BigIntStats;
  parentPath: string;
  path: string;
}>>;
export function captureCreatedDirectoryIdentity(
  directoryPath: string,
  label: string
): Promise<BigIntStats>;
export function assertDirectoryNodeIdentity(
  directoryPath: string,
  expected: BigIntStats | undefined,
  label: string
): Promise<void>;
export function removeMaterializationRootIfSame(
  outputRoot: string,
  expected: BigIntStats
): Promise<void>;
export function materializedPath(outputRoot: string, relativePath: string): string;
export function assertSafeRelativePath(value: unknown): void;
export function assertSafeSegment(value: unknown): void;
export function assertSameMetadata(
  expected: BigIntStats,
  actual: BigIntStats,
  label: string
): void;
export function assertPathMissing(filePath: string, label: string): Promise<void>;
