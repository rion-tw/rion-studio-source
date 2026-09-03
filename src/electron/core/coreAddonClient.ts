import { randomUUID } from "node:crypto";

import type {
  CoreCommand,
  CoreCommandResult,
  CoreErrorPayload,
  CoreEffectDispatchReport,
  CoreEffectResult,
  CoreEvent,
  RoleSessionMigrationOutcome,
  RoleSessionMigrationPhase,
  RoleSessionMigrationRecord,
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import { parseCoreEvents } from "./coreEventValidation";

type MaybePromise<Value> = Value | Promise<Value>;
type Unsubscribe = () => void;
const SESSION_TRANSFER_VAULT_MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES = 65 * 1024 * 1024;

export interface RawNodeApiCoreBinding {
  invoke: (commandJson: string) => Promise<string>;
  subscribeCoreEvents: (
    listener: (eventsJson: string) => void,
    failureListener: (failureJson: string) => void
  ) => void;
  dispatchCoreEffectResults: (resultsJson: string) => Promise<string>;
  beginRoleSessionMigrationImportInternal: (inputJson: string) => Promise<string>;
  transitionRoleSessionMigrationTargetInternal: (inputJson: string) => Promise<string>;
  readRoleSessionTransferVaultInternal: (
    roleId: string,
    transferId: string
  ) => Promise<Buffer>;
  acquireChromeProfileImportTransactionInternal: (requestJson: string) => Promise<string>;
  refreshChromeProfileImportTransactionInternal: (fenceJson: string) => Promise<string>;
  readChromeProfileImportPayloadInternal: (fenceJson: string) => Promise<Buffer>;
  writeChromeProfileImportBackupInternal: (
    fenceJson: string,
    plaintextBytes: Buffer
  ) => Promise<string>;
  readChromeProfileImportBackupInternal: (fenceJson: string) => Promise<Buffer>;
  prepareChromeProfileImportFreshVerificationInternal: (
    fenceJson: string
  ) => Promise<Buffer>;
  completeChromeProfileImportFreshVerificationInternal: (
    fenceJson: string,
    capabilityBytes: Buffer,
    receiptJson: string
  ) => Promise<string>;
  commitChromeProfileImportInternal: (fenceJson: string) => Promise<string>;
  verifyChromeProfileImportCommitMarkerInternal: (fenceJson: string) => Promise<string>;
  releaseChromeProfileImportTransactionInternal: (requestJson: string) => Promise<void>;
  recoverPendingChromeProfileImportsInternal: () => Promise<string>;
  restoreWindowsChromiumHeldKeysInternal?: (inputJson: string) => Promise<string>;
  launchChromeProfileImportHelperInternal: (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    cancellationId?: string
  ) => Promise<RawChromeProfileImportHelperProcessResultInternal>;
  cancelChromeProfileImportHelperInternal?: (cancellationId: string) => boolean;
  beginRoleBrowserDataClearCommandDrain: () => void;
  waitForRoleBrowserDataClearCommandDrain: (timeoutMs: number) => Promise<boolean>;
  invalidateRuntimeRestoreSessionCleanExitInternal: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface RawChromeProfileImportHelperProcessResultInternal {
  outcome: string;
  metadataBytes: Buffer;
  secretBytes: Buffer;
  exitEvidenceSha256: string;
}

export interface ChromeProfileImportHelperProcessResultInternal {
  outcome: "applied" | "failed" | "indeterminate";
  metadataBytes: Buffer;
  secretBytes: Buffer;
  exitEvidenceSha256: string;
}

export interface RoleSessionMigrationImportBeginInputInternal {
  roleId: string;
  transferId: string;
  expectedJournalRevision: number;
}

/** Electron-main-only target report. Rust supplies every durable evidence field. */
export interface RoleSessionMigrationTargetTransitionInputInternal {
  roleId: string;
  transferId: string;
  transitionId: string;
  expectedPhase: RoleSessionMigrationPhase;
  expectedJournalRevision: number;
  nextPhase: RoleSessionMigrationPhase;
  stableErrorCode?: string;
  outcome?: RoleSessionMigrationOutcome;
  cleanFlushReceiptId?: string;
  occurredAt: string;
}

export interface ChromeProfileImportTransactionAcquireInputInternal {
  roleId: string;
  transactionId: string;
  expectedJournalPhase: ChromeProfileImportJournalPhaseInternal;
  expectedJournalRevision: number;
  expectedLaunchUrl?: string;
  expectedReplaceExisting?: boolean;
}

export interface ChromeProfileImportTransactionFenceInternal {
  leaseId: string;
  roleId: string;
  transactionId: string;
  expectedJournalPhase: ChromeProfileImportJournalPhaseInternal;
  expectedJournalRevision: number;
}

export interface ChromeProfileImportTransactionReleaseInputInternal {
  leaseId: string;
  roleId: string;
  transactionId: string;
}

export type ChromeProfileImportJournalPhaseInternal =
  | "prepared"
  | "snapshotted"
  | "applying"
  | "verified"
  | "metadataCommitted"
  | "awaitingFreshVerification"
  | "freshVerified"
  | "committing";

export interface ChromeProfileImportTransactionDescriptorInternal {
  contractVersion: 1;
  leaseId: string;
  operationId: string;
  transactionId: string;
  roleId: string;
  journalPhase: ChromeProfileImportJournalPhaseInternal;
  journalRevision: number;
  launchUrl: string;
  launchOrigin: string;
  replaceExisting: boolean;
  createdRole: boolean;
  rolePaths: {
    browserUserDataDir: string;
    systemBrowserDataDir: string;
    webview2UserDataDir: string;
    chromiumUserDataDir: string;
    webkitDataStoreKey: string;
    webkitDataStoreIdentifier: string;
  };
  chromiumPathSha256: string;
  stagingSha256: string;
  stagingBytes: number;
  cookieCount: number;
  localStorageCount: number;
  unsupported: {
    partitionedCookieCount: number;
    appBoundCookieCount: number;
    decryptFailureCount: number;
    storageReadFailureCount: number;
  };
  warnings: string[];
  commitMarkerSha256?: string;
}

export interface ChromeProfileImportFreshVerificationReceiptInternal {
  verifierInstanceId: string;
  parentExitEvidenceSha256: string;
  surfaceDrainEvidenceSha256: string;
  chromiumPathSha256: string;
  inventorySha256: string;
  cookieCount: number;
  localStorageCount: number;
}

export interface ChromeProfileImportVaultEvidenceInternal {
  transactionId: string;
  roleId: string;
  journalPhase: ChromeProfileImportJournalPhaseInternal;
  journalRevision: number;
  protectedSha256: string;
  inventorySha256: string;
  cookieCount: number;
  localStorageCount: number;
}

export interface ChromeProfileImportRecoveryResultInternal {
  recovered: number;
  pending: number;
}

export interface WindowsChromiumHeldKeyContinuityInputInternal {
  operationId: string;
  roleId: string;
  tabId: string;
  expectedOwnerGeneration: number;
  surfaceGeneration: number;
  documentInstanceId: string;
  lossReason: "blur" | "hidden";
  lossRevision: number;
}

export interface WindowsChromiumHeldKeyContinuityReceiptInternal
  extends WindowsChromiumHeldKeyContinuityInputInternal {
  inputEpoch: number;
  status: "reasserted" | "noHeldKeys" | "superseded" | "failed" | "indeterminate";
  reassertedKeyCount: number;
  requestIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RawNodeApiCoreFactory<Options> {
  createAppCore: (options: Options) => MaybePromise<RawNodeApiCoreBinding>;
}

export interface CoreAddonClientObserver {
  onEventBridgeError?: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export interface CoreEventStreamFailure {
  readonly type: "eventStreamFailure";
  readonly error: CoreErrorPayload;
  readonly drained: Promise<void>;
}

function stoppedError(): RionBridgeError {
  return new RionBridgeError({
    code: "ELECTRON_CORE_STOPPED",
    message: "The Rion Studio core is stopping or has stopped."
  });
}

function eventStreamFailedError(cause: CoreErrorPayload): RionBridgeError {
  return new RionBridgeError({
    code: "ELECTRON_CORE_EVENT_STREAM_FAILED",
    message: `The authoritative Core event stream failed; new commands are closed (${cause.code}).`
  });
}

function decodeStructuredCoreError(error: unknown): RionBridgeError | null {
  if (error instanceof RionBridgeError) return error;
  if (!(error instanceof Error) || error.message.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(error.message);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,95}$/u.test(record.code) ||
    typeof record.message !== "string" ||
    record.message.trim().length === 0
  ) {
    return null;
  }
  return new RionBridgeError({ code: record.code, message: record.message });
}

function rethrowStructuredCoreError(error: unknown): never {
  throw decodeStructuredCoreError(error) ?? error;
}

export class CoreAddonClient {
  readonly #binding: RawNodeApiCoreBinding;
  readonly #listeners = new Set<(event: CoreEvent) => void>();
  readonly #eventStreamFailureListeners = new Set<
    (failure: CoreEventStreamFailure) => void
  >();
  readonly #observer: CoreAddonClientObserver;
  #eventBridgeStarted = false;
  #eventBridgeTerminal: "open" | "shutdown" | "failed" = "open";
  #eventBridgeFailure: CoreErrorPayload | null = null;
  #shutdownPromise: Promise<void> | null = null;

  private constructor(binding: RawNodeApiCoreBinding, observer: CoreAddonClientObserver) {
    this.#binding = binding;
    this.#observer = observer;
  }

  static async create<Options>(
    factory: RawNodeApiCoreFactory<Options>,
    options: Options,
    observer: CoreAddonClientObserver = {}
  ): Promise<CoreAddonClient> {
    try {
      return new CoreAddonClient(await factory.createAppCore(options), observer);
    } catch (error) {
      rethrowStructuredCoreError(error);
    }
  }

  invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    const ingressError = this.#commandIngressError();
    if (ingressError) return Promise.reject(ingressError);
    return this.#binding.invoke(JSON.stringify(command))
      .catch(rethrowStructuredCoreError)
      .then((resultJson) => JSON.parse(resultJson) as CoreCommandResult<Command>);
  }

  /** Privileged Electron-main-only migration journal transition. */
  beginRoleSessionMigrationImportInternal(
    input: RoleSessionMigrationImportBeginInputInternal
  ): Promise<RoleSessionMigrationRecord> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.beginRoleSessionMigrationImportInternal(JSON.stringify(input))
      .catch(rethrowStructuredCoreError)
      .then(parseRoleSessionMigrationRecord);
  }

  /** Privileged Electron-main-only migration journal transition. */
  transitionRoleSessionMigrationTargetInternal(
    input: RoleSessionMigrationTargetTransitionInputInternal
  ): Promise<RoleSessionMigrationRecord> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.transitionRoleSessionMigrationTargetInternal(JSON.stringify(input))
      .catch(rethrowStructuredCoreError)
      .then(parseRoleSessionMigrationRecord);
  }

  dispatchCoreEffectResults(
    results: CoreEffectResult[]
  ): Promise<CoreEffectDispatchReport> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.dispatchCoreEffectResults(JSON.stringify(results))
      .then(parseEffectDispatchReport);
  }

  /** Privileged Electron-main-only Windows hidden-role continuity boundary. */
  restoreWindowsChromiumHeldKeysInternal(
    input: WindowsChromiumHeldKeyContinuityInputInternal
  ): Promise<WindowsChromiumHeldKeyContinuityReceiptInternal> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    const restore = this.#binding.restoreWindowsChromiumHeldKeysInternal;
    if (!restore) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_WINDOWS_HELD_CONTINUITY_NATIVE_MISSING",
        message: "The native Windows held-key continuity boundary is unavailable."
      }));
    }
    return restore.call(this.#binding, JSON.stringify(input))
      .then((value) => parseWindowsHeldKeyContinuityReceipt(value, input));
  }

  readRoleSessionTransferVaultInternal(
    roleId: string,
    transferId: string
  ): Promise<Buffer> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.readRoleSessionTransferVaultInternal(roleId, transferId)
      .then((envelopeBytes) => {
        if (!isBoundedSessionTransferEnvelope(envelopeBytes)) {
          throw sessionTransferVaultEnvelopeError();
        }
        return envelopeBytes;
      });
  }

  acquireChromeProfileImportTransactionInternal(
    input: ChromeProfileImportTransactionAcquireInputInternal
  ): Promise<ChromeProfileImportTransactionDescriptorInternal> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.acquireChromeProfileImportTransactionInternal(JSON.stringify(input))
      .then(parseChromeProfileImportTransactionDescriptor);
  }

  refreshChromeProfileImportTransactionInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<ChromeProfileImportTransactionDescriptorInternal> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.refreshChromeProfileImportTransactionInternal(JSON.stringify(fence))
      .then(parseChromeProfileImportTransactionDescriptor);
  }

  /** Caller must overwrite the returned Buffer after parsing/applying it. */
  readChromeProfileImportPayloadInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<Buffer> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.readChromeProfileImportPayloadInternal(JSON.stringify(fence))
      .then(validateChromeProfileImportPlaintext);
  }

  /** Consumes and overwrites `plaintextBytes` before crossing the native boundary. */
  writeChromeProfileImportBackupInternal(
    fence: ChromeProfileImportTransactionFenceInternal,
    plaintextBytes: Buffer
  ): Promise<ChromeProfileImportVaultEvidenceInternal> {
    if (this.#shutdownPromise) {
      plaintextBytes.fill(0);
      return Promise.reject(stoppedError());
    }
    if (plaintextBytes.byteLength === 0
      || plaintextBytes.byteLength > CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES) {
      plaintextBytes.fill(0);
      return Promise.reject(chromeProfileImportPlaintextError());
    }
    const ownedBytes = Buffer.from(plaintextBytes);
    plaintextBytes.fill(0);
    return this.#binding.writeChromeProfileImportBackupInternal(
      JSON.stringify(fence),
      ownedBytes
    ).then(parseChromeProfileImportVaultEvidence)
      .finally(() => ownedBytes.fill(0));
  }

  /** Caller must overwrite the returned Buffer immediately after rollback. */
  readChromeProfileImportBackupInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<Buffer> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.readChromeProfileImportBackupInternal(JSON.stringify(fence))
      .then(validateChromeProfileImportPlaintext);
  }

  /** Caller must pass this only through the inherited verifier pipe, then overwrite it. */
  prepareChromeProfileImportFreshVerificationInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<Buffer> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.prepareChromeProfileImportFreshVerificationInternal(
      JSON.stringify(fence)
    ).then((capability) => {
      if (!Buffer.isBuffer(capability) || capability.byteLength !== 32) {
        if (Buffer.isBuffer(capability)) capability.fill(0);
        throw new Error("The Chrome profile import fresh-verification capability is invalid.");
      }
      return capability;
    });
  }

  /** Consumes and overwrites `capabilityBytes` before crossing the native boundary. */
  completeChromeProfileImportFreshVerificationInternal(
    fence: ChromeProfileImportTransactionFenceInternal,
    capabilityBytes: Buffer,
    receipt: ChromeProfileImportFreshVerificationReceiptInternal
  ): Promise<ChromeProfileImportTransactionDescriptorInternal> {
    if (this.#shutdownPromise) {
      capabilityBytes.fill(0);
      return Promise.reject(stoppedError());
    }
    if (!Buffer.isBuffer(capabilityBytes) || capabilityBytes.byteLength !== 32) {
      if (Buffer.isBuffer(capabilityBytes)) capabilityBytes.fill(0);
      return Promise.reject(
        new Error("The Chrome profile import fresh-verification capability is invalid.")
      );
    }
    const ownedCapability = Buffer.from(capabilityBytes);
    capabilityBytes.fill(0);
    return this.#binding.completeChromeProfileImportFreshVerificationInternal(
      JSON.stringify(fence),
      ownedCapability,
      JSON.stringify(receipt)
    ).then(parseChromeProfileImportTransactionDescriptor)
      .finally(() => ownedCapability.fill(0));
  }

  commitChromeProfileImportInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<ChromeProfileImportVaultEvidenceInternal> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.commitChromeProfileImportInternal(JSON.stringify(fence))
      .then(parseChromeProfileImportVaultEvidence);
  }

  verifyChromeProfileImportCommitMarkerInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ): Promise<ChromeProfileImportVaultEvidenceInternal> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.verifyChromeProfileImportCommitMarkerInternal(JSON.stringify(fence))
      .then(parseChromeProfileImportVaultEvidence);
  }

  releaseChromeProfileImportTransactionInternal(
    input: ChromeProfileImportTransactionReleaseInputInternal
  ): Promise<void> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.releaseChromeProfileImportTransactionInternal(JSON.stringify(input));
  }

  recoverPendingChromeProfileImportsInternal(): Promise<
    ChromeProfileImportRecoveryResultInternal
  > {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    return this.#binding.recoverPendingChromeProfileImportsInternal()
      .catch(rethrowStructuredCoreError)
      .then(parseChromeProfileImportRecoveryResult);
  }

  /**
   * Consumes `secretBytes`. The native launcher sends both buffers over bounded
   * anonymous inherited pipes and resolves only after the helper process and
   * both pipe endpoints have closed exactly.
   */
  launchChromeProfileImportHelperInternal(
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ): Promise<ChromeProfileImportHelperProcessResultInternal> {
    if (this.#shutdownPromise) {
      secretBytes.fill(0);
      return Promise.reject(stoppedError());
    }
    if (
      !Buffer.isBuffer(metadataBytes) ||
      metadataBytes.byteLength === 0 ||
      metadataBytes.byteLength > 1024 * 1024 ||
      !Buffer.isBuffer(secretBytes) ||
      secretBytes.byteLength > CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES + 32
    ) {
      if (Buffer.isBuffer(secretBytes)) secretBytes.fill(0);
      return Promise.reject(chromeProfileImportHelperMessageError());
    }
    const ownedMetadata = Buffer.from(metadataBytes);
    const ownedSecret = Buffer.from(secretBytes);
    secretBytes.fill(0);
    if (signal?.aborted) {
      ownedMetadata.fill(0);
      ownedSecret.fill(0);
      return Promise.reject(chromeProfileImportHelperCancelledError());
    }
    const cancellationId = signal ? randomUUID() : undefined;
    const cancel = signal
      ? this.#binding.cancelChromeProfileImportHelperInternal
      : undefined;
    if (signal && typeof cancel !== "function") {
      ownedMetadata.fill(0);
      ownedSecret.fill(0);
      return Promise.reject(chromeProfileImportHelperCancellationUnavailableError());
    }
    const onAbort = cancellationId && cancel
      ? () => {
        try {
          cancel.call(this.#binding, cancellationId);
        } catch {
          // The launch promise remains authoritative: native cancellation must
          // still close the exact process and pipe endpoints before settling.
        }
      }
      : undefined;
    if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
    let launch: Promise<RawChromeProfileImportHelperProcessResultInternal>;
    try {
      launch = this.#binding.launchChromeProfileImportHelperInternal(
        ownedMetadata,
        ownedSecret,
        cancellationId
      );
    } catch (error) {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      ownedMetadata.fill(0);
      ownedSecret.fill(0);
      return Promise.reject(error);
    }
    return launch.then((value) => {
      if (signal?.aborted) {
        if (Buffer.isBuffer(value?.metadataBytes)) value.metadataBytes.fill(0);
        if (Buffer.isBuffer(value?.secretBytes)) value.secretBytes.fill(0);
        throw chromeProfileImportHelperCancelledError();
      }
      return validateChromeProfileImportHelperProcessResult(value);
    })
      .finally(() => {
        if (onAbort) signal!.removeEventListener("abort", onAbort);
        ownedMetadata.fill(0);
        ownedSecret.fill(0);
      });
  }

  subscribeCoreEvents(listener: (event: CoreEvent) => void): Unsubscribe {
    if (this.#shutdownPromise) throw stoppedError();
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
    this.#listeners.add(listener);
    return unsubscribe;
  }

  /**
   * Subscribes to the local terminal-health channel for the one raw Core event
   * stream. A failure is fanned out once and is never synthesized for an
   * observed Core Shutdown event.
   */
  subscribeCoreEventStreamFailures(
    listener: (failure: CoreEventStreamFailure) => void
  ): Unsubscribe {
    if (this.#shutdownPromise) throw stoppedError();
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.#eventStreamFailureListeners.delete(listener);
    };
    this.#eventStreamFailureListeners.add(listener);
    return unsubscribe;
  }

  /**
   * Connects the one raw N-API event stream only after startup migration and
   * runtime registration have completed and at least one local consumer is
   * ready. Repeated calls retain the same stream.
   */
  startCoreEventBridge(): void {
    if (this.#shutdownPromise) throw stoppedError();
    if (this.#eventBridgeStarted) return;
    if (this.#listeners.size === 0) {
      throw new RionBridgeError({
        code: "ELECTRON_CORE_EVENT_CONSUMER_MISSING",
        message: "A local Core event consumer must be ready before the native stream starts."
      });
    }
    this.#eventBridgeStarted = true;
    try {
      this.#binding.subscribeCoreEvents(
        (eventsJson) => this.#receiveEvents(eventsJson),
        (failureJson) => this.#receiveNativeEventStreamFailure(failureJson)
      );
    } catch (error) {
      this.#failEventStream(error, "ELECTRON_CORE_EVENT_STREAM_START_FAILED");
      throw error;
    }
  }

  /** Synchronously fences new role-browser-data clear commands in Rust Core. */
  beginRoleBrowserDataClearCommandDrain(): void {
    if (this.#shutdownPromise) throw stoppedError();
    try {
      this.#binding.beginRoleBrowserDataClearCommandDrain();
    } catch (error) {
      rethrowStructuredCoreError(error);
    }
  }

  /**
   * Waits for every clear command admitted before the synchronous fence to
   * terminalize and release its filesystem ownership. False is indeterminate,
   * never success.
   */
  waitForRoleBrowserDataClearCommandDrain(timeoutMs: number): Promise<boolean> {
    if (this.#shutdownPromise) return Promise.reject(stoppedError());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0xffff_ffff) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_ROLE_BROWSER_DATA_CLEAR_DRAIN_TIMEOUT_INVALID",
        message: "The role browser-data clear drain timeout must be a positive u32 value."
      }));
    }
    return this.#binding.waitForRoleBrowserDataClearCommandDrain(timeoutMs)
      .catch(rethrowStructuredCoreError)
      .then((drained) => {
        if (typeof drained !== "boolean") {
          throw new RionBridgeError({
            code: "ELECTRON_ROLE_BROWSER_DATA_CLEAR_DRAIN_RESULT_INVALID",
            message: "The native role browser-data clear drain result is invalid."
          });
        }
        return drained;
      });
  }

  /** Cleanup lane: replays an unclean marker even after general command fencing. */
  invalidateRuntimeRestoreSessionCleanExitInternal(): Promise<void> {
    return this.#invalidateRuntimeRestoreSessionCleanExit();
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = this.#binding.shutdown()
      .catch(rethrowStructuredCoreError)
      .finally(() => {
        this.#listeners.clear();
        this.#eventStreamFailureListeners.clear();
      });
    return this.#shutdownPromise;
  }

  #receiveEvents(eventsJson: string): void {
    if (this.#eventBridgeTerminal !== "open") return;
    let events: CoreEvent[];
    try {
      events = parseCoreEvents(eventsJson);
    } catch (error) {
      this.#failEventStream(error, "ELECTRON_CORE_EVENT_INVALID");
      return;
    }
    for (const event of events) {
      if (this.#eventBridgeTerminal !== "open") return;
      let listenerFailed = false;
      let listenerFailure: unknown;
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch (error) {
          if (!listenerFailed) listenerFailure = error;
          listenerFailed = true;
        }
      }
      if (listenerFailed) {
        this.#failEventStream(
          listenerFailure,
          "ELECTRON_CORE_EVENT_LISTENER_FAILED"
        );
        return;
      }
      if (event.type === "shutdown") {
        this.#eventBridgeTerminal = "shutdown";
        return;
      }
    }
  }

  #receiveNativeEventStreamFailure(failureJson: string): void {
    if (this.#eventBridgeTerminal !== "open") return;
    try {
      this.#failEventStream(
        parseNativeEventStreamFailure(failureJson),
        "ELECTRON_CORE_EVENT_STREAM_FAILED"
      );
    } catch (error) {
      this.#failEventStream(error, "ELECTRON_CORE_EVENT_STREAM_FAILURE_INVALID");
    }
  }

  #failEventStream(error: unknown, fallbackCode: string): void {
    if (this.#eventBridgeTerminal !== "open") return;
    this.#eventBridgeTerminal = "failed";
    const normalized = normalizeRionBridgeError(error, fallbackCode);
    this.#eventBridgeFailure = Object.freeze({ ...normalized });
    const drained = this.#invalidateRuntimeRestoreSessionCleanExit()
      .catch((error: unknown) => {
        this.#reportEventBridgeError(normalizeRionBridgeError(
          error,
          "ELECTRON_RUNTIME_RESTORE_UNCLEAN_INVALIDATION_FAILED"
        ));
        throw error;
      });
    void drained.catch(() => undefined);
    const failure = Object.freeze({
      type: "eventStreamFailure" as const,
      error: this.#eventBridgeFailure,
      drained
    });
    this.#reportEventBridgeError(failure.error);
    for (const listener of [...this.#eventStreamFailureListeners]) {
      try {
        listener(failure);
      } catch (listenerError) {
        this.#reportEventBridgeError(normalizeRionBridgeError(
          listenerError,
          "ELECTRON_CORE_EVENT_FAILURE_LISTENER_FAILED"
        ));
      }
    }
  }

  #invalidateRuntimeRestoreSessionCleanExit(): Promise<void> {
    let invalidation: Promise<void>;
    try {
      invalidation = this.#binding.invalidateRuntimeRestoreSessionCleanExitInternal();
    } catch (error) {
      invalidation = Promise.reject(decodeStructuredCoreError(error) ?? error);
    }
    return invalidation.catch((error: unknown) => {
      throw decodeStructuredCoreError(error) ?? error;
    });
  }

  #reportEventBridgeError(
    error: ReturnType<typeof normalizeRionBridgeError>
  ): void {
    try {
      this.#observer.onEventBridgeError?.(error);
    } catch {
      // Observer failure cannot suppress or recursively replace stream terminality.
    }
  }

  #commandIngressError(): RionBridgeError | null {
    if (this.#shutdownPromise || this.#eventBridgeTerminal === "shutdown") {
      return stoppedError();
    }
    return this.#eventBridgeFailure
      ? eventStreamFailedError(this.#eventBridgeFailure)
      : null;
  }
}

function isBoundedSessionTransferEnvelope(value: unknown): value is Buffer {
  return Buffer.isBuffer(value)
    && value.byteLength > 0
    && value.byteLength <= SESSION_TRANSFER_VAULT_MAX_ENVELOPE_BYTES;
}

function isBoundedChromeProfileImportPlaintext(value: unknown): value is Buffer {
  return Buffer.isBuffer(value)
    && value.byteLength > 0
    && value.byteLength <= CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES;
}

function validateChromeProfileImportPlaintext(value: unknown): Buffer {
  if (!isBoundedChromeProfileImportPlaintext(value)) {
    if (Buffer.isBuffer(value)) value.fill(0);
    throw chromeProfileImportPlaintextError();
  }
  return value;
}

function chromeProfileImportPlaintextError(): Error {
  return new Error("The Chrome profile import plaintext bytes are invalid.");
}

function chromeProfileImportHelperMessageError(): Error {
  return new Error("The fresh Chrome profile import helper message is invalid.");
}

function chromeProfileImportHelperCancelledError(): RionBridgeError {
  return new RionBridgeError({
    code: "CHROME_PROFILE_IMPORT_HELPER_CANCELLED",
    message: "The fresh Chromium helper launch was cancelled."
  });
}

function chromeProfileImportHelperCancellationUnavailableError(): RionBridgeError {
  return new RionBridgeError({
    code: "CHROME_PROFILE_IMPORT_HELPER_CANCELLATION_UNAVAILABLE",
    message: "The native helper launcher does not expose exact cancellation."
  });
}

function validateChromeProfileImportHelperProcessResult(
  value: RawChromeProfileImportHelperProcessResultInternal
): ChromeProfileImportHelperProcessResultInternal {
  const shapeIsValid = isRecord(value) && hasExactKeys(value, [
    "outcome", "metadataBytes", "secretBytes", "exitEvidenceSha256"
  ]);
  const outcomeIsValid = new Set(["applied", "failed", "indeterminate"])
    .has(value?.outcome);
  const metadataIsValid = Buffer.isBuffer(value?.metadataBytes) &&
    value.metadataBytes.byteLength > 0 &&
    value.metadataBytes.byteLength <= 1024 * 1024;
  const secretIsValid = Buffer.isBuffer(value?.secretBytes) &&
    value.secretBytes.byteLength <= CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES + 32;
  if (
    !shapeIsValid ||
    !outcomeIsValid ||
    !metadataIsValid ||
    !secretIsValid ||
    typeof value.exitEvidenceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.exitEvidenceSha256)
  ) {
    if (Buffer.isBuffer(value?.secretBytes)) value.secretBytes.fill(0);
    throw chromeProfileImportHelperMessageError();
  }
  return value as ChromeProfileImportHelperProcessResultInternal;
}

function sessionTransferVaultEnvelopeError(): Error {
  return new Error("The session-transfer vault envelope bytes are invalid.");
}

function parseNativeEventStreamFailure(failureJson: string): CoreErrorPayload {
  const value = parseJsonRecord(failureJson, "native Core event stream failure");
  if (!hasExactKeys(value, ["code", "message"]) ||
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,95}$/u.test(value.code) ||
    typeof value.message !== "string" || value.message.trim().length === 0) {
    throw new Error("The native Core event stream failure is invalid.");
  }
  return { code: value.code, message: value.message };
}

function parseEffectDispatchReport(reportJson: string): CoreEffectDispatchReport {
  const value: unknown = JSON.parse(reportJson);
  const keys = ["accepted", "duplicate", "late", "unknown", "operationMismatch"] as const;
  if (typeof value !== "object" || value === null || keys.some((key) =>
    !Array.isArray((value as Record<string, unknown>)[key]) ||
    ((value as Record<string, unknown>)[key] as unknown[]).some((item) => typeof item !== "string")
  )) {
    throw new Error("The Core effect dispatch report is invalid.");
  }
  return value as CoreEffectDispatchReport;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ROLE_SESSION_MIGRATION_PHASES = new Set<RoleSessionMigrationRecord["phase"]>([
  "v22Ready", "exported", "importing", "verifying", "v23Ready", "failed",
  "indeterminate"
]);
const ROLE_SESSION_MIGRATION_OUTCOMES = new Set<NonNullable<
  RoleSessionMigrationRecord["outcome"]
>>(["verified", "explicitReset", "failed", "indeterminate"]);
const CHROME_IMPORT_PHASES = new Set<ChromeProfileImportJournalPhaseInternal>([
  "prepared",
  "snapshotted",
  "applying",
  "verified",
  "metadataCommitted",
  "awaitingFreshVerification",
  "freshVerified",
  "committing"
]);

function parseRoleSessionMigrationRecord(
  recordJson: string
): RoleSessionMigrationRecord {
  const value = parseJsonRecord(recordJson, "role session migration record");
  if (!hasExactKeys(value, [
    "roleId", "transferId", "phase", "journalRevision", "platform",
    "sourceEngine", "targetEngine", "sourceRevision", "startedAt",
    "phaseChangedAt", "updatedAt"
  ], [
    "targetRevision", "envelopeSha256", "inventorySha256", "cookieCount",
    "localStorageOriginCount", "localStorageEntryCount", "stableErrorCode",
    "outcome", "outcomeAt", "firstVerifiedLaunchAt", "cleanFlushReceiptId",
    "resetReceiptId"
  ])) {
    throw roleSessionMigrationRecordError();
  }
  const requiredStrings = [
    "roleId", "transferId", "phase", "platform", "sourceEngine",
    "targetEngine", "startedAt", "phaseChangedAt", "updatedAt"
  ] as const;
  if (requiredStrings.some((key) =>
    typeof value[key] !== "string" || (value[key] as string).length === 0
  )) {
    throw roleSessionMigrationRecordError();
  }
  const sourceMatchesPlatform = value.platform === "macos"
    ? value.sourceEngine === "wkwebview"
    : value.platform === "windows" && value.sourceEngine === "webview2";
  if (!CANONICAL_UUID.test(value.roleId as string)
    || !CANONICAL_UUID.test(value.transferId as string)
    || !ROLE_SESSION_MIGRATION_PHASES.has(
      value.phase as RoleSessionMigrationRecord["phase"]
    )
    || !sourceMatchesPlatform
    || value.targetEngine !== "chromium"
    || !isPositiveSafeInteger(value.journalRevision)
    || !isNonnegativeSafeInteger(value.sourceRevision)
    || (value.targetRevision !== undefined
      && !isNonnegativeSafeInteger(value.targetRevision))) {
    throw roleSessionMigrationRecordError();
  }
  for (const key of ["envelopeSha256", "inventorySha256"] as const) {
    if (value[key] !== undefined
      && (typeof value[key] !== "string" || !LOWERCASE_SHA256.test(value[key]))) {
      throw roleSessionMigrationRecordError();
    }
  }
  const countKeys = [
    "cookieCount", "localStorageOriginCount", "localStorageEntryCount"
  ] as const;
  const countPresence = countKeys.map((key) => value[key] !== undefined);
  if ((!countPresence.every(Boolean) && countPresence.some(Boolean))
    || countKeys.some((key) =>
      value[key] !== undefined && !isNonnegativeSafeInteger(value[key])
    )) {
    throw roleSessionMigrationRecordError();
  }
  if (value.outcome !== undefined
    && !ROLE_SESSION_MIGRATION_OUTCOMES.has(
      value.outcome as NonNullable<RoleSessionMigrationRecord["outcome"]>
    )) {
    throw roleSessionMigrationRecordError();
  }
  for (const key of [
    "stableErrorCode", "outcomeAt", "firstVerifiedLaunchAt",
    "cleanFlushReceiptId", "resetReceiptId"
  ] as const) {
    if (value[key] !== undefined
      && (typeof value[key] !== "string" || value[key].length === 0)) {
      throw roleSessionMigrationRecordError();
    }
  }
  return value as unknown as RoleSessionMigrationRecord;
}

function roleSessionMigrationRecordError(): Error {
  return new Error("The role session migration record is invalid.");
}

function parseChromeProfileImportTransactionDescriptor(
  descriptorJson: string
): ChromeProfileImportTransactionDescriptorInternal {
  const value = parseJsonRecord(descriptorJson, "Chrome profile import transaction descriptor");
  if (!hasExactKeys(value, [
    "contractVersion", "leaseId", "operationId", "transactionId", "roleId",
    "journalPhase", "journalRevision", "launchUrl", "launchOrigin",
    "replaceExisting", "createdRole", "rolePaths", "chromiumPathSha256",
    "stagingSha256", "stagingBytes", "cookieCount", "localStorageCount",
    "unsupported", "warnings"
  ], ["commitMarkerSha256"])) {
    throw chromeImportContractError("descriptor");
  }
  for (const key of [
    "leaseId",
    "operationId",
    "transactionId",
    "roleId",
    "journalPhase",
    "launchUrl",
    "launchOrigin",
    "chromiumPathSha256",
    "stagingSha256"
  ] as const) {
    if (typeof value[key] !== "string") throw chromeImportContractError("descriptor");
  }
  if (value.contractVersion !== 1
    || !CANONICAL_UUID.test(value.leaseId as string)
    || !CANONICAL_UUID.test(value.transactionId as string)
    || !CANONICAL_UUID.test(value.roleId as string)
    || !CHROME_IMPORT_PHASES.has(value.journalPhase as ChromeProfileImportJournalPhaseInternal)
    || !LOWERCASE_SHA256.test(value.chromiumPathSha256 as string)
    || !LOWERCASE_SHA256.test(value.stagingSha256 as string)
    || typeof value.replaceExisting !== "boolean"
    || typeof value.createdRole !== "boolean"
    || !isPositiveSafeInteger(value.journalRevision)
    || !isPositiveSafeInteger(value.stagingBytes)
    || (value.stagingBytes as number) > CHROME_PROFILE_IMPORT_MAX_PROTECTED_BYTES
    || !isNonnegativeSafeInteger(value.cookieCount)
    || !isNonnegativeSafeInteger(value.localStorageCount)) {
    throw chromeImportContractError("descriptor");
  }
  const rolePaths = value.rolePaths;
  if (!isRecord(rolePaths)) throw chromeImportContractError("descriptor");
  const rolePathKeys = [
    "browserUserDataDir",
    "systemBrowserDataDir",
    "webview2UserDataDir",
    "chromiumUserDataDir",
    "webkitDataStoreKey",
    "webkitDataStoreIdentifier"
  ] as const;
  if (!hasExactKeys(rolePaths, rolePathKeys)) {
    throw chromeImportContractError("descriptor");
  }
  for (const key of rolePathKeys) {
    if (typeof rolePaths[key] !== "string" || rolePaths[key].length === 0) {
      throw chromeImportContractError("descriptor");
    }
  }
  if (!isRecord(value.unsupported)) throw chromeImportContractError("descriptor");
  const unsupportedKeys = [
    "partitionedCookieCount",
    "appBoundCookieCount",
    "decryptFailureCount",
    "storageReadFailureCount"
  ] as const;
  if (!hasExactKeys(value.unsupported, unsupportedKeys)) {
    throw chromeImportContractError("descriptor");
  }
  for (const key of unsupportedKeys) {
    if (!isNonnegativeSafeInteger(value.unsupported[key])) {
      throw chromeImportContractError("descriptor");
    }
  }
  if (!Array.isArray(value.warnings)
    || value.warnings.some((warning) => typeof warning !== "string")) {
    throw chromeImportContractError("descriptor");
  }
  if (value.commitMarkerSha256 !== undefined
    && (typeof value.commitMarkerSha256 !== "string"
      || !LOWERCASE_SHA256.test(value.commitMarkerSha256))) {
    throw chromeImportContractError("descriptor");
  }
  return value as unknown as ChromeProfileImportTransactionDescriptorInternal;
}

function parseChromeProfileImportVaultEvidence(
  evidenceJson: string
): ChromeProfileImportVaultEvidenceInternal {
  const value = parseJsonRecord(evidenceJson, "Chrome profile import vault evidence");
  if (!hasExactKeys(value, [
    "transactionId", "roleId", "journalPhase", "journalRevision",
    "protectedSha256", "inventorySha256", "cookieCount", "localStorageCount"
  ])) {
    throw chromeImportContractError("vault evidence");
  }
  for (const key of [
    "transactionId",
    "roleId",
    "journalPhase",
    "protectedSha256",
    "inventorySha256"
  ] as const) {
    if (typeof value[key] !== "string") throw chromeImportContractError("vault evidence");
  }
  if (!CANONICAL_UUID.test(value.transactionId as string)
    || !CANONICAL_UUID.test(value.roleId as string)
    || !CHROME_IMPORT_PHASES.has(value.journalPhase as ChromeProfileImportJournalPhaseInternal)
    || !LOWERCASE_SHA256.test(value.protectedSha256 as string)
    || !LOWERCASE_SHA256.test(value.inventorySha256 as string)
    || !isPositiveSafeInteger(value.journalRevision)
    || !isNonnegativeSafeInteger(value.cookieCount)
    || !isNonnegativeSafeInteger(value.localStorageCount)) {
    throw chromeImportContractError("vault evidence");
  }
  return value as unknown as ChromeProfileImportVaultEvidenceInternal;
}

function parseChromeProfileImportRecoveryResult(
  resultJson: string
): ChromeProfileImportRecoveryResultInternal {
  const value = parseJsonRecord(resultJson, "Chrome profile import recovery result");
  if (!hasExactKeys(value, ["recovered", "pending"])
    || !isNonnegativeSafeInteger(value.recovered)
    || !isNonnegativeSafeInteger(value.pending)) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROME_PROFILE_IMPORT_RECOVERY_INVALID",
      message: "Core returned an invalid Chrome profile import recovery result."
    });
  }
  return value as unknown as ChromeProfileImportRecoveryResultInternal;
}

function parseJsonRecord(valueJson: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    throw new Error(`The ${label} is invalid.`);
  }
  if (!isRecord(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseWindowsHeldKeyContinuityReceipt(
  receiptJson: string,
  expected: WindowsChromiumHeldKeyContinuityInputInternal
): WindowsChromiumHeldKeyContinuityReceiptInternal {
  const value = parseJsonRecord(receiptJson, "Windows held-key continuity receipt");
  if (!hasExactKeys(value, [
    "operationId", "roleId", "tabId", "expectedOwnerGeneration",
    "surfaceGeneration", "documentInstanceId", "lossReason", "lossRevision",
    "inputEpoch", "status", "reassertedKeyCount", "requestIds", "errorCode",
    "errorMessage"
  ])) {
    throw new Error("The Windows held-key continuity receipt is invalid.");
  }
  const status = value.status;
  const terminalStatuses = new Set([
    "reasserted", "noHeldKeys", "superseded", "failed", "indeterminate"
  ]);
  const exactIdentity = value.operationId === expected.operationId &&
    value.roleId === expected.roleId && value.tabId === expected.tabId &&
    value.expectedOwnerGeneration === expected.expectedOwnerGeneration &&
    value.surfaceGeneration === expected.surfaceGeneration &&
    value.documentInstanceId === expected.documentInstanceId &&
    value.lossReason === expected.lossReason &&
    value.lossRevision === expected.lossRevision;
  const requestIds = value.requestIds;
  const requestIdsValid = Array.isArray(requestIds) &&
    requestIds.every((requestId) =>
      typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256
    );
  const succeeded = status === "reasserted" || status === "noHeldKeys" ||
    status === "superseded";
  const errorValid = succeeded
    ? value.errorCode === null && value.errorMessage === null
    : typeof value.errorCode === "string" && value.errorCode.length > 0 &&
      typeof value.errorMessage === "string" && value.errorMessage.length > 0;
  if (!exactIdentity || typeof status !== "string" || !terminalStatuses.has(status) ||
    !isNonnegativeSafeInteger(value.inputEpoch) ||
    !isNonnegativeSafeInteger(value.reassertedKeyCount) || !requestIdsValid ||
    (status === "reasserted" && value.reassertedKeyCount !== requestIds.length) ||
    (status !== "reasserted" && value.reassertedKeyCount !== 0) || !errorValid) {
    throw new Error("The Windows held-key continuity receipt is invalid.");
  }
  return value as unknown as WindowsChromiumHeldKeyContinuityReceiptInternal;
}

function chromeImportContractError(kind: string): Error {
  return new Error(`The Chrome profile import ${kind} is invalid.`);
}
