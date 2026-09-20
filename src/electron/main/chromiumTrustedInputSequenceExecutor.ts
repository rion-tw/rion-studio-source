import type {
  BrowserActionRequest,
  CoreErrorPayload,
  TrustedInputSequenceFailureRecord,
  EmbeddedKeyEffectRecord,
  EmbeddedKeyTransitionRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "./chromiumTrustedInputCoordinator";
import {
  inverseChromiumKeyEffect,
  resolveChromiumModifierCodes,
  type ChromiumTrustedInputPlatform
} from "./chromiumTrustedInputKeySequence";

import { recoverChromiumKeySequence, receiptFailure } from "./chromiumTrustedInputSequenceRecovery";
import { recordTrustedInputSequenceFailure } from "./chromiumTrustedInputTerminalJournal";

export interface ChromiumEmbeddedInputCorePort {
  prepare: (input: Readonly<{
    roleId: string;
    phase: "hold" | "release" | "tap";
    code: string;
    modifierCodes: readonly string[];
    ownerId: string;
  }>) => Promise<EmbeddedKeyTransitionRecord>;
  complete: (transitionId: string, succeeded: boolean) => Promise<void>;
  reassert: (roleId: string) => Promise<EmbeddedKeyTransitionRecord>;
  clear: (roleId: string) => Promise<void>;
}

export class ChromiumTrustedInputSequenceFailure extends RionBridgeError {
  readonly quarantine: boolean;
  readonly actionIndeterminate: boolean;
  readonly possiblyAppliedEdges: readonly Readonly<{
    phase: "rawKeyDown" | "keyUp";
    code: string;
  }>[];
  readonly confirmedInputNeutrality: boolean;
  readonly confirmedReleaseCodes: readonly string[];

  constructor(code: string, message: string, quarantine: boolean, input: Readonly<{
    actionIndeterminate?: boolean;
    possiblyAppliedEdges?: readonly EmbeddedKeyEffectRecord[];
    confirmedInputNeutrality?: boolean;
    confirmedReleaseCodes?: readonly string[];
  }> = {}) {
    super({ code, message });
    this.quarantine = quarantine;
    this.actionIndeterminate = input.actionIndeterminate ?? false;
    this.possiblyAppliedEdges = Object.freeze((input.possiblyAppliedEdges ?? []).map(
      edge => Object.freeze({ phase: edge.phase, code: edge.code })
    ));
    this.confirmedInputNeutrality = input.confirmedInputNeutrality ?? false;
    this.confirmedReleaseCodes = Object.freeze([...(input.confirmedReleaseCodes ?? [])]);
  }
}

function sequenceFailure(
  receipt: ChromiumNativeTrustedInputReceipt,
  confirmedInputNeutrality: boolean,
  forceQuarantine = false,
  possiblyAppliedEdges: readonly EmbeddedKeyEffectRecord[] = [],
  confirmedReleaseCodes: readonly string[] = []
): ChromiumTrustedInputSequenceFailure {
  const actionIndeterminate = receipt.status === "indeterminate";
  const quarantine = forceQuarantine || !confirmedInputNeutrality;
  const code = receipt.status === "superseded"
    ? "BROWSER_ACTION_STALE"
    : actionIndeterminate || quarantine
      ? "SYSTEM_TRUSTED_INPUT_INDETERMINATE" : receipt.errorCode!;
  return new ChromiumTrustedInputSequenceFailure(
    code,
    receipt.errorMessage ?? "The trusted key sequence did not complete.",
    quarantine,
    { actionIndeterminate, possiblyAppliedEdges, confirmedInputNeutrality, confirmedReleaseCodes }
  );
}

function nativeRequest(
  request: BrowserActionRequest,
  surfaceGeneration: number,
  effect: EmbeddedKeyEffectRecord,
  physicalModifierCodes: readonly string[],
  intent: "normal" | "cleanup"
): ChromiumNativeTrustedInputRequest {
  return Object.freeze({
    requestId: request.requestId,
    roleId: request.roleId,
    inputEpoch: request.inputEpoch,
    intent,
    scheduledAtMs: request.scheduledAtMs,
    deadlineMs: request.deadlineMs,
    surfaceGeneration,
    expectedInputNeutralityBefore: effect.activeCodesBefore.length === 0,
    expectedInputNeutralityAfter: effect.activeCodes.length === 0,
    action: request.action,
    keyEffect: effect,
    physicalModifierCodes
  });
}

async function compensateEdges(input: Readonly<{
  request: BrowserActionRequest;
  surfaceGeneration: number;
  physicalModifierCodes: readonly string[];
  edges: readonly EmbeddedKeyEffectRecord[];
  nowMs: () => number;
  confirmedReleaseCodes: Set<string>;
  dispatch: (request: ChromiumNativeTrustedInputRequest) =>
    Promise<ChromiumNativeTrustedInputReceipt>;
}>): Promise<CoreErrorPayload | null> {
  const remaining = new Map<string, EmbeddedKeyEffectRecord>();
  const active = new Set(input.edges[0]?.activeCodesBefore ?? []);
  for (const effect of input.edges) {
    if (effect.phase === "keyUp") active.delete(effect.code);
    else active.add(effect.code);
    if (effect.phase === "keyUp") remaining.delete(effect.code);
    else if (!effect.activeCodesBefore.includes(effect.code)) remaining.set(effect.code, effect);
  }
  for (const applied of [...remaining.values()].reverse()) {
    if (input.nowMs() >= input.request.deadlineMs) return {
      code: "SYSTEM_TRUSTED_INPUT_CLEANUP_REQUIRES_RECOVERY",
      message: "The original deadline expired; the Core recovery transaction must authorize a new cleanup request."
    };
    const beforeRelease = [...active];
    active.delete(applied.code);
    const inverse = inverseChromiumKeyEffect({ ...applied,
      activeCodes: beforeRelease, activeCodesBefore: [...active] });
    if (!inverse) continue;
    try {
      const receipt = await input.dispatch(nativeRequest(
        input.request,
        input.surfaceGeneration,
        inverse,
        input.physicalModifierCodes,
        "cleanup"
      ));
      if (receipt.status !== "applied") return receiptFailure(receipt);
      input.confirmedReleaseCodes.add(inverse.code);
    } catch (cause) {
      return normalizeRionBridgeError(cause);
    }
  }
  return null;
}

export async function executeChromiumTrustedKeySequence(input: Readonly<{
  request: BrowserActionRequest;
  surfaceGeneration: number;
  platform: ChromiumTrustedInputPlatform;
  core: ChromiumEmbeddedInputCorePort;
  dispatch: (request: ChromiumNativeTrustedInputRequest) =>
    Promise<ChromiumNativeTrustedInputReceipt>;
  nowMs: () => number;
}>): Promise<Readonly<{
  receipt: ChromiumNativeTrustedInputReceipt;
  hasHeldKeys: boolean;
  activeCodes: readonly string[];
  confirmedEffects: readonly EmbeddedKeyEffectRecord[];
}>> {
  const { request } = input;
  const action = request.action;
  if (action.type !== "key" && action.type !== "reassertHeldKeys") {
    throw new Error("The Chromium key sequence executor requires a key action.");
  }
  if (action.type === "key" && !action.code) {
    throw new ChromiumTrustedInputSequenceFailure(
      "SYSTEM_TRUSTED_INPUT_CODE_REQUIRED",
      "Chromium trusted key input requires an exact DOM code.",
      false
    );
  }
  const physicalModifierCodes = action.type === "key" &&
    action.modifierOwnership === "physical-pass-through"
    ? resolveChromiumModifierCodes(action, input.platform)
    : Object.freeze([] as string[]);
  const transition = action.type === "reassertHeldKeys"
    ? await input.core.reassert(request.roleId)
    : await input.core.prepare({
        roleId: request.roleId,
        phase: action.phase,
        code: action.code!,
        modifierCodes: action.modifierOwnership === "synthetic"
          ? resolveChromiumModifierCodes(action, input.platform)
          : [],
        ownerId: action.ownerId
      });
  const transitionId = transition.transitionId ?? null;
  if (action.type === "key" && !transitionId) {
    throw new ChromiumTrustedInputSequenceFailure(
      "SYSTEM_TRUSTED_INPUT_CORE_TRANSITION_INVALID",
      "Core did not return an exact embedded-key transition identity.",
      false
    );
  }
  const applied: EmbeddedKeyEffectRecord[] = [];
  const confirmedReleaseCodes = new Set<string>();
  const neutralBefore = transition.effects[0]?.activeCodesBefore.length === 0;
  const recover = async (
    cause: CoreErrorPayload, edges: readonly EmbeddedKeyEffectRecord[],
    failedEffect: EmbeddedKeyEffectRecord | null = null
  ): Promise<TrustedInputSequenceFailureRecord> => {
    const failure = await recoverChromiumKeySequence({
      cause, transitionId, confirmedEffects: applied, failedEffect, edges,
      compensate: edges => compensateEdges({ ...input, physicalModifierCodes, edges, confirmedReleaseCodes }),
      rollback: id => input.core.complete(id, false)
    });
    recordTrustedInputSequenceFailure(request, input.surfaceGeneration, failure,
      neutralBefore && failedEffect !== null && action.type !== "reassertHeldKeys" &&
      failure.compensationSucceeded && failure.rollbackSucceeded);
    return failure;
  };
  for (const effect of transition.effects) {
    let receipt: ChromiumNativeTrustedInputReceipt;
    try {
      receipt = await input.dispatch(nativeRequest(
        request,
        input.surfaceGeneration,
        effect,
        physicalModifierCodes,
        request.intent
      ));
    } catch (cause) {
      const possiblyApplied = effect.phase === "rawKeyDown" ? [effect] : [];
      if (effect.phase === "rawKeyDown") confirmedReleaseCodes.delete(effect.code);
      const recovery = await recover(normalizeRionBridgeError(cause), [...applied, ...possiblyApplied], effect);
      const compensated = recovery.compensationSucceeded;
      const rolledBack = recovery.rollbackSucceeded;
      throw new ChromiumTrustedInputSequenceFailure(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        compensated && rolledBack
          ? "The native key effect ended without an authoritative terminal receipt."
          : "The trusted key sequence ended without exact compensation and Core rollback.",
        !(compensated && rolledBack && neutralBefore),
        {
          actionIndeterminate: true,
          possiblyAppliedEdges: [...applied, ...possiblyApplied],
          confirmedInputNeutrality: compensated && rolledBack && neutralBefore,
          confirmedReleaseCodes: [...confirmedReleaseCodes]
        }
      );
    }
    if (receipt.status !== "applied") {
      const possiblyApplied = receipt.status === "indeterminate" &&
        effect.phase === "rawKeyDown" ? [effect] : [];
      if (possiblyApplied.length) confirmedReleaseCodes.delete(effect.code);
      const recovery = await recover(receiptFailure(receipt), [...applied, ...possiblyApplied], effect);
      const compensated = recovery.compensationSucceeded;
      const rolledBack = recovery.rollbackSucceeded;
      throw sequenceFailure(
        receipt,
        compensated && rolledBack && neutralBefore,
        action.type === "reassertHeldKeys",
        [...applied, ...possiblyApplied],
        [...confirmedReleaseCodes]
      );
    }
    applied.push(effect);
    if (effect.phase === "keyUp") confirmedReleaseCodes.add(effect.code);
    else confirmedReleaseCodes.delete(effect.code);
  }
  if (transitionId) {
    try {
      await input.core.complete(transitionId, true);
    } catch (cause) {
      const recovery = await recover(normalizeRionBridgeError(cause), applied);
      const compensated = recovery.compensationSucceeded;
      throw new ChromiumTrustedInputSequenceFailure(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        compensated
          ? "Chromium input was compensated, but Core completion is indeterminate."
          : "Chromium input and Core completion are indeterminate.",
        true,
        { possiblyAppliedEdges: applied, confirmedReleaseCodes: [...confirmedReleaseCodes] }
      );
    }
  }
  const completedAtMs = input.nowMs();
  return Object.freeze({
    hasHeldKeys: transition.hasHeldKeys,
    confirmedEffects: Object.freeze(applied.map(effect => Object.freeze({ ...effect }))),
    activeCodes: Object.freeze([
      ...(transition.effects.at(-1)?.activeCodes ?? [])
    ]),
    receipt: Object.freeze({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: input.surfaceGeneration,
      status: "applied",
      completedAtMs,
      errorCode: null,
      errorMessage: null,
      confirmedInputNeutrality: !transition.hasHeldKeys
    })
  });
}
