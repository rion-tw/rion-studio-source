import { createHash } from "node:crypto";

import type { CoreEffectRequest } from "../../shared/generated";
import type {
  ChromeProfileImportFreshVerificationReceiptInternal,
  ChromeProfileImportHelperProcessResultInternal,
  ChromeProfileImportJournalPhaseInternal,
  ChromeProfileImportTransactionAcquireInputInternal,
  ChromeProfileImportTransactionDescriptorInternal,
  ChromeProfileImportTransactionFenceInternal,
  ChromeProfileImportTransactionReleaseInputInternal,
  ChromeProfileImportVaultEvidenceInternal
} from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import {
  encodeChromeProfileImportFreshHelperRequest,
  type ChromeProfileImportFreshHelperAuthProbe,
  type ChromeProfileImportFreshHelperKind
} from "./chromeProfileImportFreshHelper";

type SnapshotAction = Extract<CoreEffectRequest["action"], {
  type: "chromeProfileImportSnapshot";
}>;
type ApplyAction = Extract<CoreEffectRequest["action"], {
  type: "chromeProfileImportApply";
}>;
type VerifyAction = Extract<CoreEffectRequest["action"], {
  type: "chromeProfileImportVerify";
}>;
type RollbackAction = Extract<CoreEffectRequest["action"], {
  type: "chromeProfileImportRollback";
}>;
type CommitAction = Extract<CoreEffectRequest["action"], {
  type: "chromeProfileImportCommit";
}>;
type ChromeImportAction = SnapshotAction | ApplyAction | VerifyAction |
  RollbackAction | CommitAction;

export interface ChromeProfileImportCoordinatorCorePort {
  acquireChromeProfileImportTransactionInternal: (
    input: ChromeProfileImportTransactionAcquireInputInternal
  ) => Promise<ChromeProfileImportTransactionDescriptorInternal>;
  refreshChromeProfileImportTransactionInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<ChromeProfileImportTransactionDescriptorInternal>;
  readChromeProfileImportPayloadInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<Buffer>;
  writeChromeProfileImportBackupInternal: (
    fence: ChromeProfileImportTransactionFenceInternal,
    plaintextBytes: Buffer
  ) => Promise<ChromeProfileImportVaultEvidenceInternal>;
  readChromeProfileImportBackupInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<Buffer>;
  prepareChromeProfileImportFreshVerificationInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<Buffer>;
  completeChromeProfileImportFreshVerificationInternal: (
    fence: ChromeProfileImportTransactionFenceInternal,
    capabilityBytes: Buffer,
    receipt: ChromeProfileImportFreshVerificationReceiptInternal
  ) => Promise<ChromeProfileImportTransactionDescriptorInternal>;
  commitChromeProfileImportInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<ChromeProfileImportVaultEvidenceInternal>;
  verifyChromeProfileImportCommitMarkerInternal: (
    fence: ChromeProfileImportTransactionFenceInternal
  ) => Promise<ChromeProfileImportVaultEvidenceInternal>;
  releaseChromeProfileImportTransactionInternal: (
    input: ChromeProfileImportTransactionReleaseInputInternal
  ) => Promise<void>;
  launchChromeProfileImportHelperInternal: (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ) => Promise<ChromeProfileImportHelperProcessResultInternal>;
}

interface ImportLane {
  descriptor: ChromeProfileImportTransactionDescriptorInternal;
  applyExitEvidenceSha256?: string;
}

interface AppliedHelperReceipt {
  readonly inventorySha256: string;
  readonly cookieCount: number;
  readonly localStorageCount: number;
  readonly surfaceDrainEvidenceSha256: string;
  readonly authState: "authenticated" | "notAuthenticated" | "indeterminate" |
    "notApplicable";
  readonly verifierInstanceId?: string;
  readonly parentExitEvidenceSha256?: string;
  readonly chromiumPathSha256?: string;
  readonly capabilitySha256?: string;
}

const PHASES = new Set<ChromeProfileImportJournalPhaseInternal>([
  "prepared", "snapshotted", "applying", "verified", "metadataCommitted",
  "awaitingFreshVerification", "freshVerified", "committing"
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function importError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireImportNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw importError(
    "CHROME_PROFILE_IMPORT_HELPER_CANCELLED",
    "The fresh Chromium helper launch was cancelled."
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObject(
  value: unknown,
  required: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh helper returned an invalid receipt."
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(required);
  if (required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))) {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh helper receipt is not canonical."
    );
  }
  return record;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh helper returned invalid receipt bytes."
    );
  }
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseAppliedReceipt(
  result: ChromeProfileImportHelperProcessResultInternal,
  kind: ChromeProfileImportFreshHelperKind,
  descriptor: ChromeProfileImportTransactionDescriptorInternal
): AppliedHelperReceipt {
  if (!SHA256.test(result.exitEvidenceSha256) ||
    (kind !== "snapshot" && result.secretBytes.byteLength !== 0)) {
    result.secretBytes.fill(0);
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh helper process evidence is not canonical."
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJson(result.metadataBytes);
  } finally {
    result.metadataBytes.fill(0);
  }
  if (result.outcome !== "applied") {
    const error = exactObject(parsed, [
      "version", "kind", "transactionId", "roleId", "journalPhase",
      "journalRevision", "stableErrorCode"
    ]);
    if (error.version !== 1 || error.kind !== kind ||
      error.transactionId !== descriptor.transactionId ||
      error.roleId !== descriptor.roleId ||
      error.journalPhase !== descriptor.journalPhase ||
      error.journalRevision !== descriptor.journalRevision ||
      typeof error.stableErrorCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{2,127}$/u.test(error.stableErrorCode)) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
        "The failed helper receipt does not match its transaction."
      );
    }
    throw importError(
      error.stableErrorCode,
      result.outcome === "indeterminate"
        ? "The fresh Chromium helper ended with an indeterminate result."
        : "The fresh Chromium helper rejected the operation."
    );
  }
  const verifyKeys = kind === "verify"
    ? ["verifierInstanceId", "parentExitEvidenceSha256", "chromiumPathSha256",
      "capabilitySha256"]
    : [];
  const receipt = exactObject(parsed, [
    "version", "kind", "transactionId", "roleId", "journalPhase",
    "journalRevision", "inventorySha256", "cookieCount", "localStorageCount",
    "surfaceDrainEvidenceSha256", "authState", ...verifyKeys
  ]);
  const authStates = new Set([
    "authenticated", "notAuthenticated", "indeterminate", "notApplicable"
  ]);
  if (receipt.version !== 1 || receipt.kind !== kind ||
    receipt.transactionId !== descriptor.transactionId ||
    receipt.roleId !== descriptor.roleId ||
    receipt.journalPhase !== descriptor.journalPhase ||
    receipt.journalRevision !== descriptor.journalRevision ||
    typeof receipt.inventorySha256 !== "string" ||
    !SHA256.test(receipt.inventorySha256) ||
    !safeCount(receipt.cookieCount) || !safeCount(receipt.localStorageCount) ||
    typeof receipt.surfaceDrainEvidenceSha256 !== "string" ||
    !SHA256.test(receipt.surfaceDrainEvidenceSha256) ||
    typeof receipt.authState !== "string" || !authStates.has(receipt.authState)) {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh helper receipt does not match its exact journal fence."
    );
  }
  if (kind === "verify" && (
    typeof receipt.verifierInstanceId !== "string" ||
    !UUID.test(receipt.verifierInstanceId) ||
    typeof receipt.parentExitEvidenceSha256 !== "string" ||
    !SHA256.test(receipt.parentExitEvidenceSha256) ||
    typeof receipt.chromiumPathSha256 !== "string" ||
    !SHA256.test(receipt.chromiumPathSha256) ||
    typeof receipt.capabilitySha256 !== "string" ||
    !SHA256.test(receipt.capabilitySha256)
  )) {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_RECEIPT_INVALID",
      "The fresh verifier did not return exact process evidence."
    );
  }
  return receipt as unknown as AppliedHelperReceipt;
}

function effectRevision(value: bigint | number | undefined): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "bigint" || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw importError(
      "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_INVALID",
      "The Chrome-import effect has no exact journal revision."
    );
  }
  return Number(value);
}

function fence(
  descriptor: ChromeProfileImportTransactionDescriptorInternal
): ChromeProfileImportTransactionFenceInternal {
  return {
    leaseId: descriptor.leaseId,
    roleId: descriptor.roleId,
    transactionId: descriptor.transactionId,
    expectedJournalPhase: descriptor.journalPhase,
    expectedJournalRevision: descriptor.journalRevision
  };
}

export class ChromeProfileImportCoordinator {
  readonly #core: ChromeProfileImportCoordinatorCorePort;
  readonly #lanes = new Map<string, ImportLane>();

  constructor(core: ChromeProfileImportCoordinatorCorePort) {
    this.#core = core;
  }

  async execute(effect: CoreEffectRequest, signal?: AbortSignal): Promise<unknown> {
    requireImportNotAborted(signal);
    const action = effect.action;
    if (!action.type.startsWith("chromeProfileImport")) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_UNSUPPORTED",
        "The Chrome-import coordinator received an unrelated effect."
      );
    }
    this.#assertEffect(effect, action as ChromeImportAction);
    switch (action.type) {
      case "chromeProfileImportSnapshot": return this.#snapshot(action, signal);
      case "chromeProfileImportApply": return this.#apply(action, signal);
      case "chromeProfileImportVerify": return this.#verify(action, signal);
      case "chromeProfileImportRollback": return this.#rollback(action, signal);
      case "chromeProfileImportCommit": return this.#commit(action);
      default:
        throw importError(
          "CHROMIUM_PROFILE_IMPORT_EFFECT_UNSUPPORTED",
          "The Chrome-import effect is unsupported."
        );
    }
  }

  #assertEffect(effect: CoreEffectRequest, action: ChromeImportAction): void {
    const roleId = action.roleId;
    if (effect.target.kind !== "app" || typeof roleId !== "string" ||
      !UUID.test(roleId) || effect.target.handleId !== roleId ||
      effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined ||
      typeof action.transactionId !== "string" || !UUID.test(action.transactionId) ||
      typeof action.chromiumUserDataDir !== "string" ||
      typeof action.journalPhase !== "string" ||
      !PHASES.has(action.journalPhase as ChromeProfileImportJournalPhaseInternal)) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_INVALID",
        "The Chrome-import effect is missing its exact Rust-owned fence."
      );
    }
    effectRevision(action.journalRevision);
    if (action.type !== "chromeProfileImportCommit" &&
      action.type !== "chromeProfileImportVerify" &&
      typeof action.launchUrl !== "string") {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_INVALID",
        "The Chrome-import launch identity is invalid."
      );
    }
  }

  async #snapshot(action: SnapshotAction, signal?: AbortSignal): Promise<unknown> {
    const lane = await this.#lane(action, action.launchUrl, action.replaceExisting);
    try {
      const result = await this.#launch(
        "snapshot",
        lane.descriptor,
        Buffer.alloc(0),
        signal
      );
      try {
        const receipt = parseAppliedReceipt(result, "snapshot", lane.descriptor);
        if (result.secretBytes.byteLength === 0 ||
          sha256(result.secretBytes) !== receipt.inventorySha256) {
          throw importError(
            "CHROMIUM_PROFILE_IMPORT_SNAPSHOT_RECEIPT_INVALID",
            "The rollback snapshot does not match the fresh helper receipt."
          );
        }
        const evidence = await this.#core.writeChromeProfileImportBackupInternal(
          fence(lane.descriptor),
          result.secretBytes
        );
        if (evidence.transactionId !== lane.descriptor.transactionId ||
          evidence.roleId !== lane.descriptor.roleId ||
          evidence.journalPhase !== lane.descriptor.journalPhase ||
          evidence.journalRevision !== lane.descriptor.journalRevision ||
          evidence.inventorySha256 !== receipt.inventorySha256 ||
          evidence.cookieCount !== receipt.cookieCount ||
          evidence.localStorageCount !== receipt.localStorageCount) {
          throw importError(
            "CHROMIUM_PROFILE_IMPORT_SNAPSHOT_RECEIPT_INVALID",
            "Core did not acknowledge the exact encrypted rollback snapshot."
          );
        }
      } finally {
        result.secretBytes.fill(0);
      }
      return Object.freeze({ status: "applied", transactionId: action.transactionId });
    } catch (error) {
      await this.#release(lane);
      throw error;
    }
  }

  async #apply(action: ApplyAction, signal?: AbortSignal): Promise<unknown> {
    const lane = await this.#lane(action, action.launchUrl, action.replaceExisting);
    const payload = await this.#core.readChromeProfileImportPayloadInternal(
      fence(lane.descriptor)
    );
    const expectedInventorySha256 = sha256(payload);
    const result = await this.#launch("apply", lane.descriptor, payload, signal);
    let receipt: AppliedHelperReceipt;
    try {
      receipt = parseAppliedReceipt(result, "apply", lane.descriptor);
    } finally {
      result.secretBytes.fill(0);
    }
    this.#requireSourceReceipt(lane.descriptor, receipt, expectedInventorySha256);
    lane.applyExitEvidenceSha256 = result.exitEvidenceSha256;
    return Object.freeze({ status: "applied", transactionId: action.transactionId });
  }

  async #verify(action: VerifyAction, signal?: AbortSignal): Promise<unknown> {
    const existing = this.#lanes.get(action.transactionId!);
    if (!existing?.applyExitEvidenceSha256) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_PARENT_EXIT_EVIDENCE_UNAVAILABLE",
        "Fresh verification requires the exact completed apply-helper exit evidence."
      );
    }
    const lane = await this.#lane(action, undefined, undefined);
    const capability = await this.#core
      .prepareChromeProfileImportFreshVerificationInternal(fence(lane.descriptor));
    if (!Buffer.isBuffer(capability) || capability.byteLength !== 32) {
      if (Buffer.isBuffer(capability)) capability.fill(0);
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_FRESH_CAPABILITY_INVALID",
        "Core did not return the exact one-time fresh-verification capability."
      );
    }
    let payload: Buffer | null = null;
    let completionCapability: Buffer | null = null;
    let secret: Buffer | null = null;
    try {
      const capabilitySha256 = sha256(capability);
      const awaiting = await this.#core.refreshChromeProfileImportTransactionInternal({
        ...fence(lane.descriptor),
        expectedJournalPhase: "awaitingFreshVerification",
        expectedJournalRevision: lane.descriptor.journalRevision + 1
      });
      this.#requireDescriptor(
        awaiting,
        action,
        undefined,
        undefined,
        "awaitingFreshVerification",
        lane.descriptor.journalRevision + 1
      );
      this.#requireStableDescriptor(lane.descriptor, awaiting);
      lane.descriptor = awaiting;
      payload = await this.#core.readChromeProfileImportPayloadInternal(fence(awaiting));
      const expectedInventorySha256 = sha256(payload);
      completionCapability = Buffer.from(capability);
      secret = Buffer.concat([capability, payload]);
      capability.fill(0);
      payload.fill(0);
      payload = null;
      const result = await this.#launch(
        "verify",
        awaiting,
        secret,
        signal,
        lane.applyExitEvidenceSha256,
        this.#authProbe(action)
      );
      secret = null;
      let receipt: AppliedHelperReceipt;
      try {
        receipt = parseAppliedReceipt(result, "verify", awaiting);
      } finally {
        result.secretBytes.fill(0);
      }
      this.#requireSourceReceipt(awaiting, receipt, expectedInventorySha256);
      if (receipt.parentExitEvidenceSha256 !== lane.applyExitEvidenceSha256 ||
        receipt.chromiumPathSha256 !== awaiting.chromiumPathSha256 ||
        receipt.capabilitySha256 !== capabilitySha256 ||
        !receipt.verifierInstanceId) {
        throw importError(
          "CHROMIUM_PROFILE_IMPORT_FRESH_RECEIPT_INVALID",
          "The second fresh process did not return exact verification evidence."
        );
      }
      const fresh = await this.#core.completeChromeProfileImportFreshVerificationInternal(
        fence(awaiting),
        completionCapability,
        {
          verifierInstanceId: receipt.verifierInstanceId,
          parentExitEvidenceSha256: receipt.parentExitEvidenceSha256!,
          surfaceDrainEvidenceSha256: receipt.surfaceDrainEvidenceSha256,
          chromiumPathSha256: receipt.chromiumPathSha256!,
          inventorySha256: receipt.inventorySha256,
          cookieCount: receipt.cookieCount,
          localStorageCount: receipt.localStorageCount
        }
      );
      if (fresh.journalPhase !== "freshVerified" ||
        fresh.journalRevision !== awaiting.journalRevision + 1) {
        throw importError(
          "CHROMIUM_PROFILE_IMPORT_FRESH_RECEIPT_INVALID",
          "Core did not consume the exact fresh-verification capability."
        );
      }
      this.#requireStableDescriptor(awaiting, fresh);
      lane.descriptor = fresh;
      return Object.freeze({ authState: receipt.authState });
    } finally {
      capability.fill(0);
      payload?.fill(0);
      completionCapability?.fill(0);
      secret?.fill(0);
    }
  }

  async #rollback(action: RollbackAction, signal?: AbortSignal): Promise<unknown> {
    if (typeof action.replaceExisting !== "boolean") {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_INVALID",
        "Rollback is missing its exact replacement identity."
      );
    }
    const lane = await this.#lane(action, action.launchUrl, action.replaceExisting);
    const backup = await this.#core.readChromeProfileImportBackupInternal(fence(lane.descriptor));
    const expectedInventorySha256 = sha256(backup);
    const result = await this.#launch("rollback", lane.descriptor, backup, signal);
    let receipt: AppliedHelperReceipt;
    try {
      receipt = parseAppliedReceipt(result, "rollback", lane.descriptor);
    } finally {
      result.secretBytes.fill(0);
    }
    if (receipt.inventorySha256 !== expectedInventorySha256) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_ROLLBACK_RECEIPT_INVALID",
        "The rollback helper did not apply the exact encrypted backup inventory."
      );
    }
    await this.#release(lane);
    return Object.freeze({ status: "applied", transactionId: action.transactionId });
  }

  async #commit(action: CommitAction): Promise<unknown> {
    const lane = await this.#lane(action, undefined, undefined);
    const committed = await this.#core.commitChromeProfileImportInternal(
      fence(lane.descriptor)
    );
    if (committed.transactionId !== lane.descriptor.transactionId ||
      committed.roleId !== lane.descriptor.roleId ||
      committed.journalPhase !== "committing" ||
      committed.journalRevision !== lane.descriptor.journalRevision + 1 ||
      committed.cookieCount !== lane.descriptor.cookieCount ||
      committed.localStorageCount !== lane.descriptor.localStorageCount) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_COMMIT_RECEIPT_INVALID",
        "Core did not publish the exact revision-fenced commit marker."
      );
    }
    const committing = await this.#core.refreshChromeProfileImportTransactionInternal({
      ...fence(lane.descriptor),
      expectedJournalPhase: committed.journalPhase,
      expectedJournalRevision: committed.journalRevision
    });
    this.#requireDescriptor(
      committing,
      action,
      undefined,
      undefined,
      "committing",
      committed.journalRevision
    );
    this.#requireStableDescriptor(lane.descriptor, committing);
    if (committing.commitMarkerSha256 !== committed.protectedSha256) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_COMMIT_RECEIPT_INVALID",
        "The committing journal does not fence the exact authenticated marker."
      );
    }
    lane.descriptor = committing;
    const verified = await this.#core.verifyChromeProfileImportCommitMarkerInternal(
      fence(committing)
    );
    if (verified.transactionId !== committing.transactionId ||
      verified.roleId !== committing.roleId ||
      verified.journalPhase !== committing.journalPhase ||
      verified.journalRevision !== committing.journalRevision ||
      verified.protectedSha256 !== committed.protectedSha256 ||
      verified.inventorySha256 !== committed.inventorySha256 ||
      verified.cookieCount !== committed.cookieCount ||
      verified.localStorageCount !== committed.localStorageCount) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_COMMIT_RECEIPT_INVALID",
        "The authenticated commit marker readback is not exact."
      );
    }
    await this.#release(lane);
    return Object.freeze({ status: "applied", transactionId: action.transactionId });
  }

  async #lane(
    action: ChromeImportAction,
    launchUrl: string | undefined,
    replaceExisting: boolean | undefined
  ): Promise<ImportLane> {
    const roleId = action.roleId!;
    const transactionId = action.transactionId!;
    const phase = action.journalPhase as ChromeProfileImportJournalPhaseInternal;
    const revision = effectRevision(action.journalRevision);
    const existing = this.#lanes.get(transactionId);
    let descriptor: ChromeProfileImportTransactionDescriptorInternal;
    if (existing) {
      const priorDescriptor = existing.descriptor;
      descriptor = await this.#core.refreshChromeProfileImportTransactionInternal({
        leaseId: existing.descriptor.leaseId,
        roleId,
        transactionId,
        expectedJournalPhase: phase,
        expectedJournalRevision: revision
      });
      this.#requireDescriptor(descriptor, action, launchUrl, replaceExisting);
      this.#requireStableDescriptor(priorDescriptor, descriptor);
      existing.descriptor = descriptor;
      return existing;
    }
    if ([...this.#lanes.values()].some((lane) =>
      lane.descriptor.roleId === roleId ||
      lane.descriptor.rolePaths.chromiumUserDataDir === action.chromiumUserDataDir)) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_TRANSACTION_BUSY",
        "The Chrome-import role or destination is already exclusively leased."
      );
    }
    descriptor = await this.#core.acquireChromeProfileImportTransactionInternal({
      roleId,
      transactionId,
      expectedJournalPhase: phase,
      expectedJournalRevision: revision,
      ...(launchUrl === undefined ? {} : { expectedLaunchUrl: launchUrl }),
      ...(replaceExisting === undefined ? {} : { expectedReplaceExisting: replaceExisting })
    });
    this.#requireDescriptor(descriptor, action, launchUrl, replaceExisting);
    const lane = { descriptor };
    this.#lanes.set(transactionId, lane);
    return lane;
  }

  #requireDescriptor(
    descriptor: ChromeProfileImportTransactionDescriptorInternal,
    action: ChromeImportAction,
    launchUrl: string | undefined,
    replaceExisting: boolean | undefined,
    expectedPhase = action.journalPhase as ChromeProfileImportJournalPhaseInternal,
    expectedRevision = effectRevision(action.journalRevision)
  ): void {
    if (descriptor.contractVersion !== 1 || descriptor.roleId !== action.roleId ||
      descriptor.transactionId !== action.transactionId ||
      descriptor.journalPhase !== expectedPhase ||
      descriptor.journalRevision !== expectedRevision ||
      descriptor.rolePaths.chromiumUserDataDir !== action.chromiumUserDataDir ||
      (launchUrl !== undefined && descriptor.launchUrl !== launchUrl) ||
      (replaceExisting !== undefined && descriptor.replaceExisting !== replaceExisting)) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_MISMATCH",
        "The Core transaction descriptor does not match the effect fence."
      );
    }
  }

  #requireStableDescriptor(
    prior: ChromeProfileImportTransactionDescriptorInternal,
    next: ChromeProfileImportTransactionDescriptorInternal
  ): void {
    if (prior.leaseId !== next.leaseId || prior.operationId !== next.operationId ||
      prior.transactionId !== next.transactionId || prior.roleId !== next.roleId ||
      prior.launchUrl !== next.launchUrl || prior.launchOrigin !== next.launchOrigin ||
      prior.replaceExisting !== next.replaceExisting || prior.createdRole !== next.createdRole ||
      prior.chromiumPathSha256 !== next.chromiumPathSha256 ||
      prior.stagingSha256 !== next.stagingSha256 ||
      prior.stagingBytes !== next.stagingBytes || prior.cookieCount !== next.cookieCount ||
      prior.localStorageCount !== next.localStorageCount ||
      JSON.stringify(prior.rolePaths) !== JSON.stringify(next.rolePaths) ||
      JSON.stringify(prior.unsupported) !== JSON.stringify(next.unsupported) ||
      JSON.stringify(prior.warnings) !== JSON.stringify(next.warnings)) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_DESCRIPTOR_IDENTITY_CHANGED",
        "Core changed immutable Chrome-import evidence across a journal revision."
      );
    }
  }

  async #launch(
    kind: ChromeProfileImportFreshHelperKind,
    descriptor: ChromeProfileImportTransactionDescriptorInternal,
    secret: Buffer,
    signal?: AbortSignal,
    parentExitEvidenceSha256?: string,
    authProbe?: ChromeProfileImportFreshHelperAuthProbe
  ): Promise<ChromeProfileImportHelperProcessResultInternal> {
    let metadata: Buffer | null = null;
    try {
      requireImportNotAborted(signal);
      metadata = encodeChromeProfileImportFreshHelperRequest({
        version: 1,
        kind,
        descriptor,
        payloadBytes: kind === "verify" ? secret.byteLength - 32 : secret.byteLength,
        ...(parentExitEvidenceSha256 === undefined ? {} : { parentExitEvidenceSha256 }),
        ...(authProbe === undefined ? {} : { authProbe })
      });
      return await this.#core.launchChromeProfileImportHelperInternal(
        metadata,
        secret,
        signal
      );
    } finally {
      metadata?.fill(0);
      secret.fill(0);
    }
  }

  #requireSourceReceipt(
    descriptor: ChromeProfileImportTransactionDescriptorInternal,
    receipt: AppliedHelperReceipt,
    inventorySha256: string
  ): void {
    if (receipt.inventorySha256 !== inventorySha256 ||
      receipt.cookieCount !== descriptor.cookieCount ||
      receipt.localStorageCount !== descriptor.localStorageCount) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_FRESH_RECEIPT_INVALID",
        "The helper did not return the exact staged source inventory."
      );
    }
  }

  #authProbe(action: VerifyAction): ChromeProfileImportFreshHelperAuthProbe | undefined {
    const values = [action.verificationUrl, action.authenticatedPath, action.loginPath];
    if (values.every((value) => value === undefined)) return undefined;
    if (!values.every((value) => typeof value === "string")) {
      throw importError(
        "CHROMIUM_PROFILE_IMPORT_EFFECT_FENCE_INVALID",
        "The authentication probe must be complete or absent."
      );
    }
    return {
      verificationUrl: action.verificationUrl!,
      authenticatedPath: action.authenticatedPath!,
      loginPath: action.loginPath!
    };
  }

  async #release(lane: ImportLane): Promise<void> {
    await this.#core.releaseChromeProfileImportTransactionInternal({
      leaseId: lane.descriptor.leaseId,
      roleId: lane.descriptor.roleId,
      transactionId: lane.descriptor.transactionId
    });
    this.#lanes.delete(lane.descriptor.transactionId);
  }
}
