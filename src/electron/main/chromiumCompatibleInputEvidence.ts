import type { ChromiumCompatibleInputCommand as Command, ChromiumCompatibleInputReceipt as Receipt } from "../ipc/chromiumCompatibleInputProtocol";
import { isChromiumModifierCode } from "./chromiumTrustedInputKeySequence";
import { chromiumCdpModifierMask } from "./chromiumCdpInputDescriptors";

function codes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length &&
    value.every(code => typeof code === "string" && isChromiumModifierCode(code));
}

const sameCodes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(code => b.includes(code));
const mask = (value: unknown) => value === null ||
  (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 15);

/** Validate the reason for zero events, not merely a claimed successful count. */
export function validCompatibleInputEvidence(command: Command, receipt: Receipt): boolean {
  const evidence = receipt.modifierEvidence;
  if (!evidence) return command.action !== "key" || receipt.status !== "applied";
  const state = command.modifierState;
  if (!state || !command.key ||
      ![evidence.coreCodesBefore, evidence.coreCodesAfter, evidence.nativePhysicalCodes,
        evidence.physicalCodesBefore, evidence.physicalCodesAfter].every(codes) ||
      !sameCodes(state.coreCodesBefore, evidence.coreCodesBefore) ||
      !sameCodes(state.coreCodesAfter, evidence.coreCodesAfter) ||
      !sameCodes(state.nativePhysicalCodes, evidence.nativePhysicalCodes) ||
      !mask(evidence.eventModifierMask) ||
      !Number.isSafeInteger(evidence.droppedTransitionCount) || evidence.droppedTransitionCount < 0 ||
      !Array.isArray(evidence.transitions) || evidence.transitions.length > 64) return false;
  let sequence = 0;
  for (const entry of evidence.transitions) {
    if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence <= sequence ||
        !["physical", "compatible", "focus-cleanup", "physical-reconcile"].includes(entry.source) ||
        typeof entry.code !== "string" || !isChromiumModifierCode(entry.code) ||
        !["rawKeyDown", "keyUp"].includes(entry.phase) ||
        !["dispatch", "adoptPhysical", "releaseOwnership", "retained"].includes(entry.disposition) ||
        !codes(entry.coreCodes) || !codes(entry.physicalCodes) || !mask(entry.eventModifierMask)) return false;
    sequence = entry.sequence;
  }
  if (evidence.disposition === "dispatch") {
    return evidence.eventModifierMask === (command.key.modifiers | chromiumCdpModifierMask(evidence.physicalCodesBefore)) &&
      (receipt.status !== "applied" || receipt.eventCount === 1);
  }
  if (receipt.status !== "applied" || receipt.eventCount !== 0 || evidence.eventModifierMask !== null ||
      !isChromiumModifierCode(command.key.code) ||
      !evidence.physicalCodesBefore.includes(command.key.code) ||
      !evidence.physicalCodesAfter.includes(command.key.code)) return false;
  return evidence.disposition === "adoptPhysical"
    ? command.key.type === "rawKeyDown" && evidence.coreCodesAfter.includes(command.key.code)
    : evidence.disposition === "releaseOwnership" && command.key.type === "keyUp" &&
      evidence.coreCodesBefore.includes(command.key.code) && !evidence.coreCodesAfter.includes(command.key.code);
}

export function compatibleInputEventCount(command: Command, receipt?: Receipt): number {
  if (command.action === "key") return receipt?.modifierEvidence?.disposition &&
    receipt.modifierEvidence.disposition !== "dispatch" ? 0 : 1;
  return command.action === "focus" ? 0 : command.pointer?.releaseOnly ? 2 : command.pointer?.button === 2 ? 6 : 5;
}
