import type {
  BrowserActionRequest,
  EmbeddedKeyEffectRecord,
  EmbeddedKeyTransitionRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "./chromiumTrustedInputCoordinator";
import {
  inverseChromiumKeyEffect,
  resolveChromiumModifierCodes,
  type ChromiumTrustedInputPlatform
} from "./chromiumTrustedInputKeySequence";

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

  constructor(code: string, message: string, quarantine: boolean, input: Readonly<{
    actionIndeterminate?: boolean;
    possiblyAppliedEdges?: readonly EmbeddedKeyEffectRecord[];
    confirmedInputNeutrality?: boolean;
  }> = {}) {
    super({ code, message });
    this.quarantine = quarantine;
    this.actionIndeterminate = input.actionIndeterminate ?? false;
    this.possiblyAppliedEdges = Object.freeze((input.possiblyAppliedEdges ?? []).map(
      edge => Object.freeze({ phase: edge.phase, code: edge.code })
    ));
    this.confirmedInputNeutrality = input.confirmedInputNeutrality ?? false;
  }
}

function sequenceFailure(
  receipt: ChromiumNativeTrustedInputReceipt,
  confirmedInputNeutrality: boolean,
  forceQuarantine = false,
  possiblyAppliedEdges: readonly EmbeddedKeyEffectRecord[] = []
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
    { actionIndeterminate, possiblyAppliedEdges, confirmedInputNeutrality }
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
  dispatch: (request: ChromiumNativeTrustedInputRequest) =>
    Promise<ChromiumNativeTrustedInputReceipt>;
}>): Promise<boolean> {
  for (const applied of [...input.edges].reverse()) {
    const inverse = inverseChromiumKeyEffect(applied);
    if (!inverse) continue;
    try {
      const receipt = await input.dispatch(nativeRequest(
        input.request,
        input.surfaceGeneration,
        inverse,
        input.physicalModifierCodes,
        "cleanup"
      ));
      if (receipt.status !== "applied") return false;
    } catch {
      return false;
    }
  }
  return true;
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
  const neutralBefore = transition.effects[0]?.activeCodesBefore.length === 0;
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
    } catch {
      const possiblyApplied = effect.phase === "rawKeyDown" ? [effect] : [];
      const compensated = await compensateEdges({
        ...input, physicalModifierCodes, edges: [...applied, ...possiblyApplied]
      });
      let rolledBack = transitionId === null;
      if (transitionId) {
        try {
          await input.core.complete(transitionId, false);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      throw new ChromiumTrustedInputSequenceFailure(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        compensated && rolledBack
          ? "The native key effect ended without an authoritative terminal receipt."
          : "The trusted key sequence ended without exact compensation and Core rollback.",
        !(compensated && rolledBack && neutralBefore),
        {
          actionIndeterminate: true,
          possiblyAppliedEdges: possiblyApplied,
          confirmedInputNeutrality: compensated && rolledBack && neutralBefore
        }
      );
    }
    if (receipt.status !== "applied") {
      const possiblyApplied = receipt.status === "indeterminate" &&
        effect.phase === "rawKeyDown" ? [effect] : [];
      const compensated = await compensateEdges({
        ...input, physicalModifierCodes, edges: [...applied, ...possiblyApplied]
      });
      let rolledBack = transitionId === null;
      if (transitionId) {
        try {
          await input.core.complete(transitionId, false);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      throw sequenceFailure(
        receipt,
        compensated && rolledBack && neutralBefore,
        action.type === "reassertHeldKeys",
        possiblyApplied
      );
    }
    applied.push(effect);
  }
  if (transitionId) {
    try {
      await input.core.complete(transitionId, true);
    } catch {
      const compensated = await compensateEdges({ ...input, physicalModifierCodes, edges: applied });
      try {
        await input.core.complete(transitionId, false);
      } catch {
        // The role is quarantined below because Core terminality is uncertain.
      }
      throw new ChromiumTrustedInputSequenceFailure(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        compensated
          ? "Chromium input was compensated, but Core completion is indeterminate."
          : "Chromium input and Core completion are indeterminate.",
        true
      );
    }
  }
  const completedAtMs = input.nowMs();
  return Object.freeze({
    hasHeldKeys: transition.hasHeldKeys,
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
