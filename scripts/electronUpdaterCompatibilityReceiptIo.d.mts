export interface ElectronUpdaterStableFile {
  readonly bytes: number;
  readonly sha256: string;
  readonly source: Buffer;
}

export function readCanonicalJsonFile(
  filePath: string,
  maximumBytes: number,
  label: string
): Promise<Readonly<ElectronUpdaterStableFile & { value: unknown }>>;

export function readStableFile(
  filePath: string,
  maximumBytes: number,
  label: string
): Promise<Readonly<ElectronUpdaterStableFile>>;

export function canonicalRegularFilePath(
  filePath: string,
  maximumBytes: number,
  label: string
): Promise<string>;

export function requiredRealDirectory(value: unknown, label: string): Promise<string>;

export function resolveAbsentSiblingRoot(
  value: unknown,
  childOutputRoot: string
): Promise<Readonly<{ parent: string; root: string }>>;

export function resolveCreateNewFile(
  value: unknown,
  expectedName: string,
  label: string
): Promise<string>;

export function writeExclusive(filePath: string, source: Uint8Array): Promise<void>;

export function publicIdentity(
  filePath: string,
  identity: Readonly<{ bytes: number; sha256: string }>
): Readonly<{ bytes: number; fileName: string; sha256: string }>;

export function assertDirectChild(
  filePath: string,
  directory: string,
  label: string
): Promise<void>;

export function assertPathOutsideRoot(
  filePath: string,
  root: string,
  label: string
): void;

export function assertStableReread(
  before: Readonly<{ bytes: number; sha256: string }>,
  after: Readonly<{ bytes: number; sha256: string }>,
  label: string
): void;

export function assertExactKeys(value: unknown, expected: readonly string[], label: string): void;
export function assertEqual(actual: unknown, expected: unknown, label: string): void;
export function requiredAbsolutePath(value: unknown, label: string): string;
export function requiredDigest(value: unknown, label: string): string;
export function requiredCommitSha(value: unknown, label: string): string;
export function requiredPositiveInteger(value: unknown, label: string): number;
export function requiredSemanticVersion(value: unknown, label: string): string;
export function compareSemanticVersions(leftValue: unknown, rightValue: unknown): -1 | 0 | 1;
export function assertSemanticVersionIsNewer(
  target: unknown,
  source: unknown,
  label: string
): void;
export function requiredRfc3339(value: unknown, label: string): string;
