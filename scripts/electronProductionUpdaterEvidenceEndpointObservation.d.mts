export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_KIND:
  "rion-production-updater-endpoint-observation";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND:
  "rion-production-updater-endpoint-observation-prebinding";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND:
  "rion-production-updater-endpoint-observation-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE:
  "endpoint-observation.json";

export type ElectronProductionUpdaterEvidenceEndpointTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";
export type ElectronProductionUpdaterEvidenceEndpointPlatform =
  | "darwin-aarch64"
  | "windows-x86_64";

export interface ElectronProductionUpdaterEvidenceEndpointChallenge {
  readonly expiresAt: string;
  readonly id: string;
  readonly issuedAt: string;
  readonly nonceSha256: string;
}

export interface ElectronProductionUpdaterEvidenceEndpointContext {
  readonly challenge: ElectronProductionUpdaterEvidenceEndpointChallenge;
  readonly evidenceAttemptId: string;
  readonly platform: ElectronProductionUpdaterEvidenceEndpointPlatform;
  readonly transitionKind: ElectronProductionUpdaterEvidenceEndpointTransition;
}

export interface ElectronProductionUpdaterEvidenceEndpointBindings {
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly manifestName: "latest.json";
  readonly requestEndpoint: string;
  readonly servedManifestSha256: string;
  readonly signatureName: string;
  readonly signatureSha256: string;
  readonly targetEmbeddedUpdaterEndpoint: string;
  readonly targetVersion: string;
  readonly updaterPublicKeySha256: string;
}

export interface ElectronProductionUpdaterEvidenceEndpointObservationBindings {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-endpoint-observation-bindings";
  readonly attemptPlanSha256: string;
  readonly context: ElectronProductionUpdaterEvidenceEndpointContext;
  readonly endpoint: ElectronProductionUpdaterEvidenceEndpointBindings;
}

export interface ElectronProductionUpdaterEvidenceEndpointRedirect {
  readonly fromHost: string;
  readonly fromScheme: "https:";
  readonly fromUrlSha256: string;
  readonly locationUrlSha256: string;
  readonly sequence: number;
  readonly status: 301 | 302 | 303 | 307 | 308;
  readonly toHost: string;
  readonly toScheme: "https:";
}

export interface ElectronProductionUpdaterEvidenceEndpointObservation
  extends ElectronProductionUpdaterEvidenceEndpointContext {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-endpoint-observation-prebinding";
  readonly attemptPlanSha256: string;
  readonly endpoint: Readonly<{
    artifactName: string;
    artifactSha256: string;
    final: Readonly<{
      host: string;
      scheme: "https:";
      status: 200;
      urlSha256: string;
    }>;
    manifestName: "latest.json";
    redirectCount: number;
    redirects: readonly ElectronProductionUpdaterEvidenceEndpointRedirect[];
    requestEndpoint: string;
    servedManifestSha256: string;
    signatureName: string;
    signatureSha256: string;
    status: 200;
    targetEmbeddedUpdaterEndpoint: string;
    updaterPublicKeySha256: string;
  }>;
  readonly observedAt: string;
}

export interface ElectronProductionUpdaterEvidenceEndpointObservationFile {
  readonly observation: ElectronProductionUpdaterEvidenceEndpointObservation;
  readonly observationIdentity: Readonly<{
    bytes: number;
    fileName: "endpoint-observation.json";
    sha256: string;
  }>;
  readonly observationPath: string;
}

export interface ElectronProductionUpdaterEvidenceEndpointObservationDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export function observeElectronProductionUpdaterEvidenceEndpoint(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceEndpointObservationBindings;
    outputPath: string;
    signal: AbortSignal;
  }>,
  dependencyOverrides?:
    ElectronProductionUpdaterEvidenceEndpointObservationDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceEndpointObservationFile>>;

export function readElectronProductionUpdaterEvidenceEndpointObservation(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceEndpointObservationBindings;
    expectedSha256?: string;
    observationPath: string;
  }>
): Promise<Readonly<ElectronProductionUpdaterEvidenceEndpointObservationFile>>;

export function readElectronProductionUpdaterEvidenceEndpointObservationBindings(
  bindingsPath: string
): Promise<Readonly<{
  bindings: ElectronProductionUpdaterEvidenceEndpointObservationBindings;
  bindingsIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  bindingsPath: string;
}>>;

export function assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
  value: unknown
): Readonly<ElectronProductionUpdaterEvidenceEndpointObservationBindings>;

export function assertElectronProductionUpdaterEvidenceEndpointObservation(
  value: unknown,
  bindings: ElectronProductionUpdaterEvidenceEndpointObservationBindings
): Readonly<ElectronProductionUpdaterEvidenceEndpointObservation>;
