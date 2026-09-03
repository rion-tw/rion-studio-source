import type {
  CoreEffectRequest,
  EmbeddedRoleReloadNativeReceiptRecord,
  EmbeddedRoleReloadPreparationRecord,
  EmbeddedTabRoleReloadNativeReceiptRecord,
  EmbeddedTabRoleReloadPreparationReceiptRecord,
  ManagedShortcutSurfaceRetirementReceiptRecord,
  SystemRuntimeOperationStatus
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumAutomaticInputContextCoordinator,
  ChromiumAutomaticInputContextIdentity
} from "./chromiumAutomaticInputContextCoordinator";
import type { ChromiumManagedShortcutCoordinator } from
  "./chromiumManagedShortcutCoordinator";
import type { ChromiumPopupOwnerLifecyclePort } from "./chromiumPopupPorts";
import type { ChromiumRoleOverlayCoordinator } from
  "./chromiumRoleOverlayCoordinator";
import type {
  ChromiumRoleControlledReloadPreparation,
  ChromiumRoleNavigationLifecycleEvent,
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleSurfaceRegistry
} from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeSnapshot";
import type {
  ChromiumTrustedInputDocumentReplacementLease
} from "./chromiumTrustedInputCoordinator";

interface ChromiumRoleReloadTrustedInputPort {
  confirmControlledDocumentReplacementNeutral: (
    lease: ChromiumTrustedInputDocumentReplacementLease
  ) => Promise<boolean>;
  prepareControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease
  ) => Promise<void>;
  resumeControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease,
    nextDocumentInstanceId: string
  ) => Promise<boolean>;
  supersedeControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease,
    submitted: boolean
  ) => boolean;
}

type PrepareAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedPrepareTabRoleReload" }
>;
type CommitAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedCommitTabRoleReload" }
>;
type SupersedeAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedSupersedeTabRoleReload" }
>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

interface ReloadRoleRecord {
  readonly fence: PrepareAction["roles"][number];
  readonly preparation: ChromiumRoleControlledReloadPreparation;
  readonly trustedInputLease: ChromiumTrustedInputDocumentReplacementLease;
  readonly terminal: Deferred<EmbeddedRoleReloadNativeReceiptRecord>;
  finishing: boolean;
  finishedDocument: ChromiumRoleOverlayFrameIdentity | null;
  localFencesReleased: boolean;
  managedRetirementUnknown: boolean;
  managedFence: "none" | "acquired" | "released";
  navigationStable: Deferred<void> | null;
  popupFence: "none" | "acquired" | "released";
  quarantineRetired: boolean;
  readinessAttemptInFlight: boolean;
  readinessSignalPending: boolean;
  surfaceFence: "none" | "acquired" | "released";
  startSequence: number | null;
  submissionState: "notSubmitted" | "submitted" | "unknown";
  terminalReceipt: EmbeddedRoleReloadNativeReceiptRecord | null;
  trustedInputFence: "none" | "acquired" | "released";
}

interface ReloadOperationRecord {
  readonly action: PrepareAction;
  blockedBySubmittedOverlap: boolean;
  commitRetirementEvidence: string | null;
  readonly roles: Map<string, ReloadRoleRecord>;
  commitPromise: Promise<EmbeddedTabRoleReloadNativeReceiptRecord> | null;
  phase: "pending" | "applied" | "failed" | "superseded";
  preparePromise: Promise<EmbeddedTabRoleReloadPreparationReceiptRecord> | null;
  supersedeReceipt: EmbeddedTabRoleReloadSupersedeReceipt | null;
  supersedeRetirementEvidence: string | null;
  superseded: boolean;
}

interface NoMutationReloadTombstone {
  readonly action: PrepareAction;
  readonly preparePromise: Promise<EmbeddedTabRoleReloadPreparationReceiptRecord>;
  supersedeReceipt: EmbeddedTabRoleReloadSupersedeReceipt | null;
}

interface EmbeddedRoleReloadSupersedeReceipt {
  readonly failureCode?: string;
  readonly inputEpoch: number;
  readonly nativeInputResumed: boolean;
  readonly ownerGeneration: number;
  readonly restartRequired: boolean;
  readonly roleId: string;
  readonly status: SystemRuntimeOperationStatus;
  readonly submissionState: "notSubmitted" | "submitted" | "unknown";
}

export interface EmbeddedTabRoleReloadSupersedeReceipt {
  readonly failureCode?: string;
  readonly reloadOperationId: string;
  readonly roles: readonly EmbeddedRoleReloadSupersedeReceipt[];
  readonly status: SystemRuntimeOperationStatus;
  readonly tabId: string;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function reloadError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function sortedRoleIds(roles: readonly Readonly<{ roleId: string }>[]): string[] {
  return roles.map((role) => role.roleId).sort((left, right) =>
    left.localeCompare(right));
}

function exactRoleSet(
  left: readonly Readonly<{ roleId: string }>[],
  right: readonly Readonly<{ roleId: string }>[]
): boolean {
  const leftIds = sortedRoleIds(left);
  const rightIds = sortedRoleIds(right);
  return leftIds.length === rightIds.length &&
    leftIds.every((roleId, index) => roleId === rightIds[index]);
}

function retirementEvidence(
  action: CommitAction | SupersedeAction
): readonly ManagedShortcutSurfaceRetirementReceiptRecord[] {
  return action.managedShortcutRetirements;
}

function retirementEvidenceFingerprint(
  evidence: readonly ManagedShortcutSurfaceRetirementReceiptRecord[]
): string {
  return JSON.stringify(evidence);
}

function aggregateStatus(
  statuses: readonly SystemRuntimeOperationStatus[]
): SystemRuntimeOperationStatus {
  if (statuses.length === 0) return "failed";
  if (statuses.every((status) => status === statuses[0])) return statuses[0]!;
  if (statuses.includes("indeterminate")) return "indeterminate";
  if (statuses.every((status) => status === "superseded" || status === "cancelled")) {
    return "superseded";
  }
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "indeterminate")) return "indeterminate";
  return "degraded";
}

function validateEffect(
  effect: CoreEffectRequest,
  reloadOperationId: string,
  expectedHandleId?: string
): void {
  if (
    effect.parentOperationId !== reloadOperationId ||
    effect.target.kind !== "app" ||
    effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined ||
    (expectedHandleId !== undefined && effect.target.handleId !== expectedHandleId)
  ) {
    throw reloadError(
      "ELECTRON_ROLE_RELOAD_EFFECT_INVALID",
      "The controlled reload effect lost its EventBound operation identity."
    );
  }
}

/**
 * Joins Core fences to permanent WebContents lifecycle events. Native reload
 * submission is serialized per role, but Core Stop/Move/Close effects remain
 * independent and may supersede a pending reload immediately.
 */
export class ChromiumRoleReloadCoordinator {
  readonly #surfaces: ChromiumRoleSurfaceRegistry;
  readonly #managedShortcuts: ChromiumManagedShortcutCoordinator;
  readonly #trustedInput: ChromiumRoleReloadTrustedInputPort;
  readonly #inputContexts: ChromiumAutomaticInputContextCoordinator;
  readonly #overlays: ChromiumRoleOverlayCoordinator;
  readonly #popups: ChromiumPopupOwnerLifecyclePort;
  readonly #readSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly #operations = new Map<string, ReloadOperationRecord>();
  readonly #noMutationOperations = new Map<string, NoMutationReloadTombstone>();
  readonly #noMutationOrder: string[] = [];
  readonly #activeOperations = new Set<ReloadOperationRecord>();
  readonly #replayOrder: string[] = [];
  readonly #activeSubmissionByRole = new Map<string, ReloadRoleRecord>();
  readonly #nativeTailByRole = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeInputContexts: () => void;
  #disposed = false;

  constructor(input: Readonly<{
    inputContexts: ChromiumAutomaticInputContextCoordinator;
    managedShortcuts: ChromiumManagedShortcutCoordinator;
    overlays: ChromiumRoleOverlayCoordinator;
    popups: ChromiumPopupOwnerLifecyclePort;
    readSnapshot: () => ChromiumRuntimeExecutorSnapshot;
    surfaces: ChromiumRoleSurfaceRegistry;
    trustedInput: ChromiumRoleReloadTrustedInputPort;
  }>) {
    this.#managedShortcuts = input.managedShortcuts;
    this.#inputContexts = input.inputContexts;
    this.#overlays = input.overlays;
    this.#popups = input.popups;
    this.#readSnapshot = input.readSnapshot;
    this.#surfaces = input.surfaces;
    this.#trustedInput = input.trustedInput;
    this.#unsubscribe = this.#surfaces.subscribeNavigationLifecycle(
      this.#onNavigationLifecycle
    );
    this.#unsubscribeInputContexts = this.#inputContexts
      .subscribeContextObservations(this.#onInputContextObservation);
  }

  prepare(
    effect: CoreEffectRequest,
    action: PrepareAction
  ): Promise<EmbeddedTabRoleReloadPreparationReceiptRecord> {
    validateEffect(effect, action.reloadOperationId, action.tabId);
    const existing = this.#operations.get(action.reloadOperationId);
    if (existing) {
      if (JSON.stringify(existing.action) !== JSON.stringify(action)) {
        return Promise.reject(reloadError(
          "ELECTRON_ROLE_RELOAD_OPERATION_REUSED",
          "The reload operation identity was reused for another native intent."
        ));
      }
      return existing.preparePromise ?? Promise.reject(reloadError(
        "ELECTRON_ROLE_RELOAD_PREPARATION_UNAVAILABLE",
        "The exact reload preparation has no replayable receipt."
      ));
    }
    const noMutation = this.#noMutationOperations.get(action.reloadOperationId);
    if (noMutation) {
      if (JSON.stringify(noMutation.action) !== JSON.stringify(action)) {
        return Promise.reject(reloadError(
          "ELECTRON_ROLE_RELOAD_OPERATION_REUSED",
          "The reload operation identity was reused for another native intent."
        ));
      }
      return noMutation.preparePromise;
    }
    if (this.#disposed) {
      return this.#rememberNoMutationFailure(action, reloadError(
        "ELECTRON_ROLE_RELOAD_DISPOSED",
        "The controlled reload coordinator is disposed."
      ));
    }
    let nativeRoles: Map<
      string,
      ChromiumRuntimeExecutorSnapshot["roles"][number]
    >;
    try {
      nativeRoles = this.#validateTopology(action);
    } catch (error) {
      return this.#rememberNoMutationFailure(action, error);
    }
    const preparations = new Map<string, ChromiumRoleControlledReloadPreparation>();
    try {
      for (const fence of [...action.roles].sort((left, right) =>
        left.roleId.localeCompare(right.roleId))) {
        const native = nativeRoles.get(fence.roleId)!;
        preparations.set(fence.roleId, this.#surfaces.preflightControlledReload(
          fence.roleId,
          native.generation
        ));
      }
    } catch (error) {
      return this.#rememberNoMutationFailure(action, error);
    }
    const operation: ReloadOperationRecord = {
      action,
      blockedBySubmittedOverlap: false,
      commitRetirementEvidence: null,
      roles: new Map(),
      commitPromise: null,
      phase: "pending",
      preparePromise: null,
      supersedeReceipt: null,
      supersedeRetirementEvidence: null,
      superseded: false
    };
    for (const fence of [...action.roles].sort((left, right) =>
      left.roleId.localeCompare(right.roleId))) {
      const preparation = preparations.get(fence.roleId)!;
      operation.roles.set(fence.roleId, {
        fence,
        preparation,
        trustedInputLease: Object.freeze({
          documentInstanceId: preparation.documentInstanceId,
          inputEpoch: fence.inputEpoch,
          operationId: action.reloadOperationId,
          roleId: fence.roleId,
          surfaceGeneration: preparation.surfaceGeneration
        }),
        terminal: deferred(),
        finishing: false,
        finishedDocument: null,
        localFencesReleased: false,
        managedRetirementUnknown: false,
        managedFence: "none",
        navigationStable: null,
        popupFence: "none",
        quarantineRetired: false,
        readinessAttemptInFlight: false,
        readinessSignalPending: false,
        surfaceFence: "none",
        startSequence: null,
        submissionState: "notSubmitted",
        terminalReceipt: null,
        trustedInputFence: "none"
      });
    }
    this.#operations.set(action.reloadOperationId, operation);
    this.#activeOperations.add(operation);
    try {
      for (const role of operation.roles.values()) {
        this.#surfaces.acquireControlledReloadFence(
          role.preparation,
          action.reloadOperationId
        );
        role.surfaceFence = "acquired";
      }
    } catch (error) {
      this.#cleanupNotSubmitted(operation);
      operation.phase = "failed";
      this.#retireSafeOperation(operation);
      return Promise.reject(error);
    }
    this.#supersedeOlderNotSubmitted(operation);
    let promise: Promise<EmbeddedTabRoleReloadPreparationReceiptRecord>;
    if (operation.superseded) {
      this.#cleanupNotSubmitted(operation);
      operation.phase = "superseded";
      promise = Promise.resolve(this.#preparationReceipt(
        operation,
        "superseded"
      ));
    } else {
      promise = this.#prepareOperation(operation);
    }
    operation.preparePromise = promise;
    void promise.then(
      () => this.#rememberReplay(operation),
      () => this.#rememberReplay(operation)
    );
    return promise;
  }

  commit(
    effect: CoreEffectRequest,
    action: CommitAction
  ): Promise<EmbeddedTabRoleReloadNativeReceiptRecord> {
    validateEffect(effect, action.reloadOperationId, action.tabId);
    const operation = this.#operations.get(action.reloadOperationId);
    if (!operation || operation.phase !== "applied" ||
      !this.#commitMatchesPreparation(operation, action)) {
      return Promise.reject(reloadError(
        "ELECTRON_ROLE_RELOAD_PREPARATION_NOT_APPLIED",
        "The reload commit requires an exact applied native preparation."
      ));
    }
    const retirements = retirementEvidence(action);
    const retirementFingerprint = retirementEvidenceFingerprint(retirements);
    if (operation.commitRetirementEvidence !== null &&
      operation.commitRetirementEvidence !== retirementFingerprint) {
      return Promise.reject(reloadError(
        "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH",
        "The reload commit replay changed its managed-shortcut retirement evidence."
      ));
    }
    operation.commitRetirementEvidence ??= retirementFingerprint;
    if (operation.commitPromise) return operation.commitPromise;
    const roles = [...operation.roles.values()];
    if (!this.#reconcileManagedShortcutRetirements(
      operation,
      retirements,
      true
    )) {
      return Promise.reject(reloadError(
        "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH",
        "Core did not provide every exact managed-shortcut retirement receipt."
      ));
    }
    if (!roles.every((role) =>
      this.#managedShortcuts.canCommitDocumentReplacement({
        ...role.preparation,
        operationId: operation.action.reloadOperationId
      }))) {
      return Promise.reject(reloadError(
        "ELECTRON_ROLE_RELOAD_SHORTCUT_PREPARATION_STALE",
        "The Core-drained commit lost a managed-shortcut preparation fence."
      ));
    }
    for (const role of roles) {
      if (!this.#managedShortcuts.commitDocumentReplacement({
        ...role.preparation,
        operationId: operation.action.reloadOperationId
      })) {
        return Promise.reject(reloadError(
          "ELECTRON_ROLE_RELOAD_SHORTCUT_PREPARATION_STALE",
          "The Core-drained commit could not retire exact local shortcut state."
        ));
      }
    }
    const promise = Promise.all([...operation.roles.values()].map((role) =>
      this.#commitRole(operation, role)
    )).then((roles) => {
      const status = aggregateStatus(roles.map((role) => role.status));
      return Object.freeze({
        lifecycleEpoch: operation.action.lifecycleEpoch,
        reloadOperationId: operation.action.reloadOperationId,
        roles: [...roles].sort((left, right) =>
          left.roleId.localeCompare(right.roleId)),
        status,
        tabId: operation.action.tabId,
        topologyRevision: operation.action.topologyRevision,
        windowGeneration: operation.action.windowGeneration,
        windowId: operation.action.windowId,
        ...(status === "applied" ? {} : {
          failureCode: "ELECTRON_ROLE_RELOAD_NOT_APPLIED"
        })
      });
    });
    operation.commitPromise = promise;
    void promise.then(
      () => this.#rememberReplay(operation),
      () => this.#rememberReplay(operation)
    );
    return promise;
  }

  supersede(
    effect: CoreEffectRequest,
    action: SupersedeAction
  ): EmbeddedTabRoleReloadSupersedeReceipt {
    validateEffect(effect, action.reloadOperationId);
    const operation = this.#operations.get(action.reloadOperationId);
    const noMutation = this.#noMutationOperations.get(action.reloadOperationId);
    if (noMutation) {
      if (noMutation.action.tabId !== action.tabId ||
        !exactRoleSet(noMutation.action.roles,
          action.roleIds.map((roleId) => ({ roleId })))) {
        throw reloadError(
          "ELECTRON_ROLE_RELOAD_SUPERSEDE_STALE",
          "The reload cleanup does not match its no-mutation preparation."
        );
      }
      validateEffect(effect, action.reloadOperationId, noMutation.action.tabId);
      if (retirementEvidence(action).length !== 0) {
        throw reloadError(
          "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH",
          "A no-mutation reload cleanup cannot carry shortcut retirement evidence."
        );
      }
      if (noMutation.supersedeReceipt) return noMutation.supersedeReceipt;
      const receipt = Object.freeze({
        reloadOperationId: action.reloadOperationId,
        roles: [...noMutation.action.roles]
          .sort((left, right) => left.roleId.localeCompare(right.roleId))
          .map((role) => Object.freeze({
            inputEpoch: role.inputEpoch,
            nativeInputResumed: true,
            ownerGeneration: role.ownerGeneration,
            restartRequired: false,
            roleId: role.roleId,
            status: "applied" as const,
            submissionState: "notSubmitted" as const
          })),
        status: "applied" as const,
        tabId: action.tabId
      });
      noMutation.supersedeReceipt = receipt;
      this.#noMutationOrder.push(action.reloadOperationId);
      while (this.#noMutationOrder.length > 64) {
        const retired = this.#noMutationOrder.shift();
        if (retired !== undefined) this.#noMutationOperations.delete(retired);
      }
      return receipt;
    }
    if (!operation || operation.action.tabId !== action.tabId ||
      !exactRoleSet([...operation.roles.values()].map((role) => role.fence),
        action.roleIds.map((roleId) => ({ roleId })))) {
      throw reloadError(
        "ELECTRON_ROLE_RELOAD_SUPERSEDE_STALE",
        "The reload supersede effect lost its exact role set."
      );
    }
    validateEffect(effect, action.reloadOperationId, operation.action.tabId);
    const retirements = retirementEvidence(action);
    const retirementFingerprint = retirementEvidenceFingerprint(retirements);
    if (operation.supersedeRetirementEvidence !== null &&
      operation.supersedeRetirementEvidence !== retirementFingerprint) {
      throw reloadError(
        "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH",
        "The reload cleanup replay changed its managed-shortcut retirement evidence."
      );
    }
    operation.supersedeRetirementEvidence ??= retirementFingerprint;
    if (operation.supersedeReceipt) return operation.supersedeReceipt;
    operation.superseded = true;
    operation.phase = "superseded";
    this.#reconcileManagedShortcutRetirements(
      operation,
      retirements,
      false
    );
    const roles = [...operation.roles.values()].map((role) =>
      this.#supersedeRole(operation, role));
    const status = aggregateStatus(roles.map((role) => role.status));
    const receipt = Object.freeze({
      reloadOperationId: action.reloadOperationId,
      roles,
      status,
      tabId: action.tabId,
      ...(status === "applied" ? {} : {
        failureCode: "ELECTRON_ROLE_RELOAD_NATIVE_FENCE_RETAINED"
      })
    });
    operation.supersedeReceipt = receipt;
    this.#rememberReplay(operation);
    return receipt;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const operation of this.#operations.values()) {
      operation.superseded = true;
      for (const role of operation.roles.values()) {
        this.#supersedeRole(operation, role);
      }
    }
    this.#unsubscribe();
    this.#unsubscribeInputContexts();
  }

  async #prepareOperation(
    operation: ReloadOperationRecord
  ): Promise<EmbeddedTabRoleReloadPreparationReceiptRecord> {
    try {
      const preparations: Promise<void>[] = [];
      for (const role of operation.roles.values()) {
        const managed = this.#managedShortcuts.prepareDocumentReplacement({
          ...role.preparation,
          operationId: operation.action.reloadOperationId
        });
        role.managedFence = "acquired";
        preparations.push(managed.catch((error: unknown) => {
          role.managedFence = "released";
          throw error;
        }));
        const trusted = this.#trustedInput.prepareControlledDocumentReplacement(
          role.trustedInputLease
        );
        role.trustedInputFence = "acquired";
        preparations.push(trusted.catch((error: unknown) => {
          role.trustedInputFence = "released";
          throw error;
        }));
        if (this.#popups.prepareOwnerReload) {
          const popup = this.#popups.prepareOwnerReload({
            ownerKind: "role",
            ownerId: role.fence.roleId,
            nativeGeneration: role.preparation.surfaceGeneration
          }, operation.action.reloadOperationId);
          role.popupFence = "acquired";
          preparations.push(popup.catch((error: unknown) => {
            role.popupFence = "released";
            throw error;
          }));
        }
      }
      await Promise.all(preparations);
      if (operation.superseded) {
        operation.phase = "superseded";
        return this.#preparationReceipt(operation, "superseded");
      }
      this.#validateTopology(operation.action);
      operation.phase = "applied";
      return this.#preparationReceipt(operation, "applied");
    } catch (error) {
      this.#cleanupNotSubmitted(operation);
      if (operation.superseded) {
        operation.phase = "superseded";
        return this.#preparationReceipt(operation, "superseded");
      }
      operation.phase = "failed";
      this.#retireSafeOperation(operation);
      throw error;
    }
  }

  #preparationReceipt(
    operation: ReloadOperationRecord,
    status: SystemRuntimeOperationStatus
  ): EmbeddedTabRoleReloadPreparationReceiptRecord {
    const roles = [...operation.roles.values()].map((role) => Object.freeze({
      documentInstanceId: role.preparation.documentInstanceId,
      inputEpoch: role.fence.inputEpoch,
      ownerGeneration: role.fence.ownerGeneration,
      roleId: role.fence.roleId,
      surfaceGeneration: role.preparation.surfaceGeneration
    } satisfies EmbeddedRoleReloadPreparationRecord));
    return Object.freeze({
      lifecycleEpoch: operation.action.lifecycleEpoch,
      reloadOperationId: operation.action.reloadOperationId,
      roles,
      status,
      tabId: operation.action.tabId,
      topologyRevision: operation.action.topologyRevision,
      windowGeneration: operation.action.windowGeneration,
      windowId: operation.action.windowId,
      ...(status === "applied" ? {} : {
        failureCode: "ELECTRON_ROLE_RELOAD_SUPERSEDED"
      })
    });
  }

  async #commitRole(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord
  ): Promise<EmbeddedRoleReloadNativeReceiptRecord> {
    const previous = this.#nativeTailByRole.get(role.fence.roleId) ??
      Promise.resolve();
    await previous.catch(() => undefined);
    if (operation.superseded || role.terminalReceipt) {
      if (!role.terminalReceipt) this.#supersedeRole(operation, role);
      return role.terminalReceipt!;
    }
    const neutral = await this.#trustedInput
      .confirmControlledDocumentReplacementNeutral(role.trustedInputLease);
    if (!neutral || operation.superseded) {
      const released = this.#cleanupRoleNotSubmitted(operation, role);
      return this.#settleRole(operation, role, {
        failureCode: !released
          ? "ELECTRON_ROLE_RELOAD_LOCAL_FENCE_RELEASE_UNKNOWN"
          : operation.superseded
          ? "ELECTRON_ROLE_RELOAD_SUPERSEDED"
          : "ELECTRON_ROLE_RELOAD_INPUT_NOT_NEUTRAL",
        nativeInputResumed: released,
        restartRequired: !released,
        status: released
          ? operation.superseded ? "superseded" : "failed"
          : "indeterminate"
      });
    }
    const stable = deferred<void>();
    role.navigationStable = stable;
    this.#nativeTailByRole.set(role.fence.roleId, stable.promise);
    this.#activeSubmissionByRole.set(role.fence.roleId, role);
    role.submissionState = "unknown";
    try {
      this.#surfaces.submitControlledReload(
        role.preparation,
        operation.action.reloadOperationId
      );
      role.submissionState = "submitted";
    } catch {
      this.#trustedInput.supersedeControlledDocumentReplacement(
        role.trustedInputLease,
        true
      );
      return this.#settleRole(operation, role, {
        failureCode: "ELECTRON_ROLE_RELOAD_SUBMISSION_UNKNOWN",
        nativeInputResumed: false,
        restartRequired: true,
        status: "indeterminate"
      });
    }
    return role.terminal.promise;
  }

  readonly #onNavigationLifecycle = (
    event: ChromiumRoleNavigationLifecycleEvent
  ): boolean => {
    const role = this.#activeSubmissionByRole.get(event.roleId);
    if (
      !role || role.preparation.surfaceGeneration !== event.generation ||
      role.preparation.tabId !== event.tabId
    ) {
      return false;
    }
    if (event.type === "surface-retired") {
      const operation = this.#operationForRole(role);
      role.quarantineRetired = true;
      this.#settleRoleForNativeFailure(role, "cancelled",
        "ELECTRON_ROLE_RELOAD_SURFACE_RETIRED");
      this.#settleNativeStability(role);
      this.#retireSafeOperation(operation);
      return true;
    }
    if (event.type === "document-started") {
      if (role.startSequence === null &&
        event.navigationSequence === role.preparation.navigationSequence + 1 &&
        event.previousDocumentInstanceId === role.preparation.documentInstanceId) {
        role.startSequence = event.navigationSequence;
      } else if (role.startSequence !== null &&
        event.navigationSequence > role.startSequence) {
        this.#settleRoleForNativeFailure(role, "indeterminate",
          "ELECTRON_ROLE_RELOAD_NAVIGATION_OVERLAPPED");
      }
      return true;
    }
    if (event.type === "page-failed") {
      if (event.errorCode === -3) return true;
      if (role.startSequence !== null &&
        event.navigationSequence >= role.startSequence) {
        this.#settleRoleForNativeFailure(role, "failed",
          "ELECTRON_ROLE_RELOAD_NAVIGATION_FAILED");
      }
      return true;
    }
    if (role.startSequence === null) return true;
    if (event.navigationSequence > role.startSequence) {
      this.#settleRoleForNativeFailure(role, "indeterminate",
        "ELECTRON_ROLE_RELOAD_NAVIGATION_OVERLAPPED");
      return true;
    }
    if (event.navigationSequence !== role.startSequence || role.finishing) {
      return true;
    }
    role.finishing = true;
    void this.#finishRoleFromPage(role, event).catch(() => undefined);
    return true;
  };

  async #finishRoleFromPage(
    role: ReloadRoleRecord,
    event: Extract<ChromiumRoleNavigationLifecycleEvent, { type: "page-finished" }>
  ): Promise<void> {
    const operation = this.#operationForRole(role);
    try {
      const current = this.#surfaces.currentOverlayFrame(
        role.fence.roleId,
        role.preparation.surfaceGeneration
      );
      if (
        current.documentInstanceId !== event.documentInstanceId ||
        current.documentInstanceId === role.preparation.documentInstanceId ||
        operation.superseded
      ) throw reloadError("ELECTRON_ROLE_RELOAD_DOCUMENT_STALE",
        "The finished reload document lost its navigation epoch.");
      await this.#overlays.install([role.fence.roleId], () =>
        role.preparation.surfaceGeneration);
      this.#requireCurrentRole(operation, role, current);
      role.finishedDocument = current;
      this.#scheduleInputReadiness(role);
    } catch {
      this.#quarantineSubmittedRole(operation, role);
    }
  }

  readonly #onInputContextObservation = (
    context: ChromiumAutomaticInputContextIdentity
  ): void => {
    const role = this.#activeSubmissionByRole.get(context.roleId);
    if (!role || role.terminalReceipt || !role.finishedDocument ||
      role.preparation.surfaceGeneration !== context.surfaceGeneration ||
      role.finishedDocument.documentInstanceId !== context.documentInstanceId) {
      return;
    }
    this.#scheduleInputReadiness(role);
  };

  #scheduleInputReadiness(role: ReloadRoleRecord): void {
    role.readinessSignalPending = true;
    if (role.readinessAttemptInFlight || role.terminalReceipt) return;
    void this.#proveInputReadiness(role).catch(() => undefined);
  }

  async #proveInputReadiness(role: ReloadRoleRecord): Promise<void> {
    const operation = this.#operationForRole(role);
    role.readinessAttemptInFlight = true;
    try {
      while (role.readinessSignalPending && !role.terminalReceipt) {
        role.readinessSignalPending = false;
        const current = role.finishedDocument;
        if (!current) return;
        this.#requireCurrentRole(operation, role, current);
        const [refresh] = await this.#overlays.refresh([role.fence.roleId]);
        if (
          !refresh || refresh.documentInstanceId !== current.documentInstanceId ||
          refresh.frameToken !== current.frameToken ||
          refresh.inputContext.documentInstanceId !== current.frameToken
        ) {
          throw reloadError(
            "ELECTRON_ROLE_RELOAD_CHALLENGE_STALE",
            "The replacement isolated world lost its exact refresh challenge."
          );
        }
        this.#requireCurrentRole(operation, role, current);
        if (refresh.inputContext.target !== "game") continue;
        if (!this.#releasePresentationFences(
          operation,
          role,
          current.documentInstanceId
        )) {
          throw reloadError(
            "ELECTRON_ROLE_RELOAD_LOCAL_FENCE_RELEASE_UNKNOWN",
            "The replacement document could not release every exact local fence."
          );
        }
        const resumed = await this.#trustedInput.resumeControlledDocumentReplacement(
          role.trustedInputLease,
          current.documentInstanceId
        );
        if (!resumed) {
          throw reloadError(
            "ELECTRON_ROLE_RELOAD_NATIVE_RESUME_REJECTED",
            "The native input lane rejected the exact replacement epoch."
          );
        }
        role.trustedInputFence = "released";
        role.localFencesReleased = true;
        this.#settleRole(operation, role, {
          afterDocumentInstanceId: current.documentInstanceId,
          nativeInputResumed: true,
          restartRequired: false,
          status: "applied"
        });
        this.#settleNativeStability(role);
      }
    } catch {
      this.#quarantineSubmittedRole(operation, role);
    } finally {
      role.readinessAttemptInFlight = false;
      if (role.readinessSignalPending && !role.terminalReceipt) {
        this.#scheduleInputReadiness(role);
      }
    }
  }

  #quarantineSubmittedRole(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord
  ): void {
    if (role.terminalReceipt) return;
    this.#trustedInput.supersedeControlledDocumentReplacement(
      role.trustedInputLease,
      true
    );
    this.#settleRole(operation, role, {
      failureCode: operation.superseded
        ? "ELECTRON_ROLE_RELOAD_SUPERSEDED_AFTER_SUBMISSION"
        : "ELECTRON_ROLE_RELOAD_INPUT_READY_FAILED",
      nativeInputResumed: false,
      restartRequired: true,
      status: operation.superseded ? "superseded" : "indeterminate"
    });
  }

  #validateTopology(action: PrepareAction): Map<string, ChromiumRuntimeExecutorSnapshot["roles"][number]> {
    if (
      !Number.isSafeInteger(action.windowGeneration) || action.windowGeneration < 0 ||
      !Number.isSafeInteger(action.topologyRevision) || action.topologyRevision < 0 ||
      !Number.isSafeInteger(action.lifecycleEpoch) || action.lifecycleEpoch < 0 ||
      action.roles.length === 0 || new Set(sortedRoleIds(action.roles)).size !==
        action.roles.length
    ) throw reloadError("ELECTRON_ROLE_RELOAD_TOPOLOGY_STALE",
      "The controlled reload carries invalid native topology fences.");
    const snapshot = this.#readSnapshot();
    const window = snapshot.windows.find((candidate) =>
      candidate.windowId === action.windowId);
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === action.tabId);
    const roles = snapshot.roles.filter((role) => role.tabId === action.tabId);
    if (
      !window || !tab || tab.windowId !== action.windowId ||
      window.windowGeneration !== action.windowGeneration ||
      window.topologyRevision !== action.topologyRevision ||
      !exactRoleSet(roles, action.roles)
    ) throw reloadError("ELECTRON_ROLE_RELOAD_TOPOLOGY_STALE",
      "The controlled reload lost its visible native tab topology.");
    const byRole = new Map(roles.map((role) => [role.roleId, role]));
    for (const fence of action.roles) {
      const native = byRole.get(fence.roleId);
      if (!native || native.ownerGeneration !== fence.ownerGeneration ||
        !Number.isSafeInteger(fence.inputEpoch) || fence.inputEpoch < 0) {
        throw reloadError("ELECTRON_ROLE_RELOAD_ROLE_STALE",
          "A controlled reload role lost its owner or input epoch fence.");
      }
    }
    return byRole;
  }

  #commitMatchesPreparation(
    operation: ReloadOperationRecord,
    action: CommitAction
  ): boolean {
    if (
      operation.superseded || action.tabId !== operation.action.tabId ||
      action.windowId !== operation.action.windowId ||
      action.windowGeneration !== operation.action.windowGeneration ||
      action.topologyRevision !== operation.action.topologyRevision ||
      action.lifecycleEpoch !== operation.action.lifecycleEpoch ||
      !exactRoleSet(action.roles, [...operation.roles.values()].map((role) =>
        role.preparation))
    ) return false;
    return action.roles.every((prepared) => {
      const role = operation.roles.get(prepared.roleId);
      return role?.fence.ownerGeneration === prepared.ownerGeneration &&
        role.fence.inputEpoch === prepared.inputEpoch &&
        role.preparation.surfaceGeneration === prepared.surfaceGeneration &&
        role.preparation.documentInstanceId === prepared.documentInstanceId;
    });
  }

  #supersedeOlderNotSubmitted(operation: ReloadOperationRecord): void {
    for (const previous of this.#activeOperations) {
      if (previous === operation || previous.superseded) continue;
      const overlaps = [...operation.roles.keys()].some((roleId) =>
        previous.roles.has(roleId));
      if (!overlaps) continue;
      if ([...previous.roles.values()].some((role) =>
        role.submissionState !== "notSubmitted")) {
        operation.superseded = true;
        operation.blockedBySubmittedOverlap = true;
        return;
      }
      previous.superseded = true;
      previous.phase = "superseded";
      for (const role of previous.roles.values()) {
        this.#supersedeRole(previous, role);
      }
      this.#rememberReplay(previous);
    }
  }

  #supersedeRole(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord
  ): EmbeddedRoleReloadSupersedeReceipt {
    let cleanupStatus: SystemRuntimeOperationStatus;
    let nativeInputResumed: boolean;
    let restartRequired: boolean;
    let failureCode: string | undefined;
    if (role.submissionState === "notSubmitted") {
      const released = this.#cleanupRoleNotSubmitted(operation, role);
      const safeToResume = released && !operation.blockedBySubmittedOverlap &&
        !role.managedRetirementUnknown;
      cleanupStatus = safeToResume ? "applied" : "indeterminate";
      nativeInputResumed = safeToResume;
      restartRequired = !safeToResume;
      failureCode = safeToResume
        ? undefined
        : role.managedRetirementUnknown
          ? "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH"
          : operation.blockedBySubmittedOverlap
          ? "ELECTRON_ROLE_RELOAD_OLDER_SUBMISSION_QUARANTINED"
          : "ELECTRON_ROLE_RELOAD_LOCAL_FENCE_RELEASE_UNKNOWN";
      this.#settleRole(operation, role, {
        failureCode: safeToResume
          ? "ELECTRON_ROLE_RELOAD_SUPERSEDED"
          : failureCode,
        nativeInputResumed,
        restartRequired,
        status: safeToResume ? "superseded" : "indeterminate"
      });
    } else {
      this.#trustedInput.supersedeControlledDocumentReplacement(
        role.trustedInputLease,
        true
      );
      cleanupStatus = "indeterminate";
      nativeInputResumed = false;
      restartRequired = true;
      failureCode = "ELECTRON_ROLE_RELOAD_NATIVE_FENCE_RETAINED";
      this.#settleRole(operation, role, {
        failureCode,
        nativeInputResumed,
        restartRequired,
        status: "indeterminate"
      });
    }
    return Object.freeze({
      inputEpoch: role.fence.inputEpoch,
      nativeInputResumed,
      ownerGeneration: role.fence.ownerGeneration,
      restartRequired,
      roleId: role.fence.roleId,
      status: cleanupStatus,
      submissionState: role.submissionState,
      ...(failureCode === undefined ? {} : { failureCode })
    });
  }

  #cleanupNotSubmitted(operation: ReloadOperationRecord): void {
    for (const role of operation.roles.values()) {
      if (role.submissionState === "notSubmitted") {
        this.#cleanupRoleNotSubmitted(operation, role);
      }
    }
  }

  #reconcileManagedShortcutRetirements(
    operation: ReloadOperationRecord,
    receipts: readonly ManagedShortcutSurfaceRetirementReceiptRecord[],
    requireAll: boolean
  ): boolean {
    const sorted = receipts.every((receipt, index) =>
      typeof receipt?.roleId === "string" && (index === 0 ||
        receipts[index - 1]!.roleId.localeCompare(receipt.roleId) < 0));
    if (!sorted) {
      for (const role of operation.roles.values()) {
        role.managedRetirementUnknown = true;
      }
      return false;
    }
    const seen = new Set<string>();
    let exact = true;
    for (const receipt of receipts) {
      const role = operation.roles.get(receipt.roleId);
      if (!role || seen.has(receipt.roleId)) {
        exact = false;
        if (role) role.managedRetirementUnknown = true;
        else {
          for (const candidate of operation.roles.values()) {
            candidate.managedRetirementUnknown = true;
          }
        }
        continue;
      }
      seen.add(receipt.roleId);
      const reconciled = this.#managedShortcuts
        .reconcileDocumentReplacementRetirement({
          ...role.preparation,
          operationId: operation.action.reloadOperationId
        }, receipt);
      if (!reconciled) {
        role.managedRetirementUnknown = true;
        exact = false;
      }
    }
    if (requireAll) {
      for (const role of operation.roles.values()) {
        if (seen.has(role.fence.roleId)) continue;
        role.managedRetirementUnknown = true;
        exact = false;
      }
    }
    return exact;
  }

  #cleanupRoleNotSubmitted(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord
  ): boolean {
    if (role.localFencesReleased) return true;
    if (role.trustedInputFence === "acquired") {
      if (this.#trustedInput.supersedeControlledDocumentReplacement(
        role.trustedInputLease,
        false
      )) role.trustedInputFence = "released";
    }
    const presentationReleased = this.#releasePresentationFences(operation, role);
    role.localFencesReleased = presentationReleased &&
      role.trustedInputFence !== "acquired";
    return role.localFencesReleased;
  }

  #releasePresentationFences(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord,
    expectedDocumentInstanceId?: string
  ): boolean {
    if (role.managedFence === "acquired" &&
      this.#managedShortcuts.releaseDocumentReplacementFence({
        ...role.preparation,
        operationId: operation.action.reloadOperationId
      })) role.managedFence = "released";
    if (role.surfaceFence === "acquired" &&
      this.#surfaces.releaseControlledReloadFence(
        role.fence.roleId,
        role.preparation.surfaceGeneration,
        operation.action.reloadOperationId,
        expectedDocumentInstanceId
      )) role.surfaceFence = "released";
    if (role.popupFence === "acquired" &&
      this.#popups.releaseOwnerReload?.({
        ownerKind: "role",
        ownerId: role.fence.roleId,
        nativeGeneration: role.preparation.surfaceGeneration
      }, operation.action.reloadOperationId) === true) {
      role.popupFence = "released";
    }
    return role.managedFence !== "acquired" &&
      role.surfaceFence !== "acquired" && role.popupFence !== "acquired";
  }

  #settleRoleForNativeFailure(
    role: ReloadRoleRecord,
    status: SystemRuntimeOperationStatus,
    failureCode: string
  ): void {
    if (role.terminalReceipt) return;
    const operation = this.#operationForRole(role);
    this.#trustedInput.supersedeControlledDocumentReplacement(
      role.trustedInputLease,
      role.submissionState !== "notSubmitted"
    );
    this.#settleRole(operation, role, {
      failureCode,
      nativeInputResumed: role.submissionState === "notSubmitted",
      restartRequired: role.submissionState !== "notSubmitted",
      status
    });
  }

  #settleRole(
    _operation: ReloadOperationRecord,
    role: ReloadRoleRecord,
    outcome: Readonly<{
      afterDocumentInstanceId?: string;
      failureCode?: string;
      nativeInputResumed: boolean;
      restartRequired: boolean;
      status: SystemRuntimeOperationStatus;
    }>
  ): EmbeddedRoleReloadNativeReceiptRecord {
    if (role.terminalReceipt) return role.terminalReceipt;
    const receipt = Object.freeze({
      beforeDocumentInstanceId: role.preparation.documentInstanceId,
      inputEpoch: role.fence.inputEpoch,
      nativeInputResumed: outcome.nativeInputResumed,
      ownerGeneration: role.fence.ownerGeneration,
      restartRequired: outcome.restartRequired,
      roleId: role.fence.roleId,
      status: outcome.status,
      submissionState: role.submissionState,
      surfaceGeneration: role.preparation.surfaceGeneration,
      ...(outcome.afterDocumentInstanceId === undefined ? {} : {
        afterDocumentInstanceId: outcome.afterDocumentInstanceId
      }),
      ...(role.startSequence === null ? {} : {
        navigationSequence: role.startSequence
      }),
      ...(outcome.failureCode === undefined ? {} : {
        failureCode: outcome.failureCode
      })
    });
    role.terminalReceipt = receipt;
    role.terminal.resolve(receipt);
    this.#retireSafeOperation(this.#operationForRole(role));
    return receipt;
  }

  #settleNativeStability(role: ReloadRoleRecord): void {
    if (this.#activeSubmissionByRole.get(role.fence.roleId) === role) {
      this.#activeSubmissionByRole.delete(role.fence.roleId);
    }
    const stable = role.navigationStable;
    if (!stable) return;
    role.navigationStable = null;
    stable.resolve();
    if (this.#nativeTailByRole.get(role.fence.roleId) === stable.promise) {
      this.#nativeTailByRole.delete(role.fence.roleId);
    }
  }

  #retireSafeOperation(operation: ReloadOperationRecord): void {
    if (operation.phase === "pending") return;
    const roles = [...operation.roles.values()];
    const safe = operation.phase === "failed"
      ? roles.every((role) => role.localFencesReleased)
      : roles.every((role) =>
        role.terminalReceipt !== null && (
          (role.terminalReceipt.nativeInputResumed &&
            !role.terminalReceipt.restartRequired) || role.quarantineRetired
        ));
    if (!safe) return;
    this.#activeOperations.delete(operation);
    this.#rememberReplay(operation);
  }

  #rememberReplay(operation: ReloadOperationRecord): void {
    const operationId = operation.action.reloadOperationId;
    if (!this.#replayOrder.includes(operationId)) {
      this.#replayOrder.push(operationId);
    }
    while (this.#replayOrder.length > 64) {
      const index = this.#replayOrder.findIndex((candidate) => {
        const retained = this.#operations.get(candidate);
        return !retained || !this.#activeOperations.has(retained);
      });
      if (index < 0) break;
      const [retiredId] = this.#replayOrder.splice(index, 1);
      if (retiredId !== undefined) this.#operations.delete(retiredId);
    }
  }

  #rememberNoMutationFailure(
    action: PrepareAction,
    error: unknown
  ): Promise<EmbeddedTabRoleReloadPreparationReceiptRecord> {
    const promise = Promise.reject<EmbeddedTabRoleReloadPreparationReceiptRecord>(error);
    this.#noMutationOperations.set(action.reloadOperationId, {
      action,
      preparePromise: promise,
      supersedeReceipt: null
    });
    return promise;
  }

  #requireCurrentRole(
    operation: ReloadOperationRecord,
    role: ReloadRoleRecord,
    expected: ChromiumRoleOverlayFrameIdentity
  ): void {
    if (operation.superseded || role.terminalReceipt) {
      throw reloadError(
        "ELECTRON_ROLE_RELOAD_SUPERSEDED",
        "The controlled reload was superseded before input readiness."
      );
    }
    const current = this.#surfaces.currentOverlayFrame(
      role.fence.roleId,
      role.preparation.surfaceGeneration
    );
    if (
      current.frame !== expected.frame || current.frameToken !== expected.frameToken ||
      current.documentInstanceId !== expected.documentInstanceId
    ) throw reloadError("ELECTRON_ROLE_RELOAD_DOCUMENT_STALE",
      "The replacement document changed during readiness admission.");
  }

  #operationForRole(role: ReloadRoleRecord): ReloadOperationRecord {
    for (const operation of this.#operations.values()) {
      if (operation.roles.get(role.fence.roleId) === role) return operation;
    }
    throw reloadError(
      "ELECTRON_ROLE_RELOAD_OPERATION_STALE",
      "The native reload role lost its owning operation."
    );
  }
}
