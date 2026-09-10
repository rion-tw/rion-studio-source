export type ElectronDevOutputCategory =
  | "product-error"
  | "toolchain-regression"
  | "unclassified"
  | "extension-compatibility"
  | "macos-framework-noise"
  | "gpu-watch";

export interface ElectronDevOutputFinding {
  readonly category: ElectronDevOutputCategory;
  readonly count: number;
  readonly id: string;
  readonly recommendation: string;
  readonly samples: readonly string[];
}

export interface ElectronDevOutputDiagnosis {
  readonly exitCode: 0 | 1;
  readonly findings: readonly ElectronDevOutputFinding[];
  readonly status: "action-required" | "clean" | "notes";
}

export interface ElectronDevOutputDiagnosticsIo {
  readonly readFile: (
    source: string | number,
    encoding: "utf8"
  ) => Promise<string>;
  readonly stderr: { write: (value: string) => unknown };
  readonly stdout: { write: (value: string) => unknown };
}

export function classifyElectronDevOutput(source: string): ElectronDevOutputDiagnosis;

export function formatElectronDevOutputDiagnosis(
  diagnosis: ElectronDevOutputDiagnosis
): string;

export function runElectronDevOutputDiagnostics(
  rawArguments: readonly string[],
  io?: ElectronDevOutputDiagnosticsIo
): Promise<0 | 1 | 2>;
