import type {
  ElectronProductionPublicationRecoveryRunIdentity
} from "./electronProductionPublicationRecovery.mjs";

export const ELECTRON_PRODUCTION_RECOVERED_CAPSULE_VERIFICATION_KIND:
  "rion-electron-production-recovered-capsule-verification";

export interface ElectronProductionRecoveredCapsuleVerification {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovered-capsule-verification";
  readonly status: "verified-store-foundation";
  readonly transactionId: string;
  readonly publisher: Readonly<ElectronProductionPublicationRecoveryRunIdentity>;
  readonly capsule: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule.capsule.json";
    sha256: string;
  }>;
  readonly manifest: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule-manifest.json";
    sha256: string;
  }>;
  readonly storeSeal: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-store-seal.json";
    sha256: string;
  }>;
  readonly foundation: Readonly<Record<
    "heldLease" | "publicationIntent" | "sourceSnapshot" | "targetSnapshot",
    Readonly<{ bytes: number; fileName: string; sha256: string }>
  >>;
}

export interface ElectronProductionRecoveredCapsuleInput {
  readonly capsulePath: string;
  readonly expectedCapsuleSha256: string;
  readonly expectedStoreSealSha256: string;
  readonly storeSealPath: string;
  readonly transactionId: string;
}

export function verifyElectronProductionRecoveredCapsule(
  input: Readonly<ElectronProductionRecoveredCapsuleInput>
): Promise<Readonly<ElectronProductionRecoveredCapsuleVerification>>;

export function materializeElectronProductionRecoveredCapsule(
  input: Readonly<ElectronProductionRecoveredCapsuleInput & {
    outputRoot: string;
  }>
): Promise<Readonly<{
  materializedRoot: string;
  verification: Readonly<ElectronProductionRecoveredCapsuleVerification>;
}>>;
