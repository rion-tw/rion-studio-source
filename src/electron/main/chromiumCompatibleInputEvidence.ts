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

/** Validate authoritative modifier snapshots separately from bounded history. */
export function compatibleInputEvidenceFailure(command: Command, receipt: Receipt):
  { reason: string; field: string; expected: unknown; received: unknown } | null {
  const reject = (reason: string, field: string, expected: unknown, received: unknown) =>
    ({ reason, field: `modifierEvidence.${field}`, expected, received });
  const evidence = receipt.modifierEvidence;
  if (!evidence) return command.action === "key" && receipt.status === "applied"
    ? reject("modifier-snapshot", "present", true, false) : null;
  const state = command.modifierState;
  if (!state || !command.key) return reject("modifier-snapshot", "command", "key with modifierState", command.action);
  for (const field of ["coreCodesBefore", "coreCodesAfter", "nativePhysicalCodes", "physicalCodesBefore", "physicalCodesAfter"] as const) {
    if (!codes(evidence[field])) return reject("modifier-snapshot", field, "unique exact modifier sides, at most 8", evidence[field]);
  }
  for (const field of ["coreCodesBefore", "coreCodesAfter", "nativePhysicalCodes"] as const) {
    if (!sameCodes(state[field], evidence[field])) return reject("modifier-snapshot", field, state[field].join(","), evidence[field].join(","));
  }
  if (!mask(evidence.eventModifierMask)) return reject("modifier-snapshot", "eventModifierMask", "null or 0..15", evidence.eventModifierMask);
  if (!Number.isSafeInteger(evidence.droppedTransitionCount) || evidence.droppedTransitionCount < 0)
    return reject("modifier-history", "droppedTransitionCount", "nonnegative safe integer", evidence.droppedTransitionCount);
  if (!Array.isArray(evidence.transitions) || evidence.transitions.length > 64)
    return reject("modifier-history", "transitions.length", "0..64", evidence.transitions?.length);
  let sequence = 0;
  for (const [index, entry] of evidence.transitions.entries()) {
    const field = `transitions[${index}]`;
    if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence <= sequence)
      return reject("modifier-history", `${field}.sequence`, `integer > ${sequence}`, entry?.sequence);
    const enums = { source: ["physical", "compatible", "focus-cleanup", "physical-reconcile"],
      phase: ["rawKeyDown", "keyUp"], disposition: ["dispatch", "adoptPhysical", "releaseOwnership", "retained"] };
    for (const key of ["source", "phase", "disposition"] as const) {
      if (!enums[key].includes(entry[key])) return reject("modifier-history", `${field}.${key}`, enums[key].join("|"), entry[key]);
    }
    if (typeof entry.code !== "string" || !isChromiumModifierCode(entry.code))
      return reject("modifier-history", `${field}.code`, "exact modifier side", entry.code);
    for (const key of ["coreCodes", "physicalCodes"] as const) {
      if (!codes(entry[key])) return reject("modifier-history", `${field}.${key}`, "unique exact modifier sides, at most 8", entry[key]);
    }
    if (!mask(entry.eventModifierMask)) return reject("modifier-history", `${field}.eventModifierMask`, "null or 0..15", entry.eventModifierMask);
    sequence = entry.sequence;
  }
  if (evidence.disposition === "dispatch") {
    const expected = command.key.modifiers | chromiumCdpModifierMask(evidence.physicalCodesBefore);
    if (evidence.eventModifierMask !== expected) return reject("modifier-snapshot", "eventModifierMask", expected, evidence.eventModifierMask);
    return receipt.status !== "applied" || receipt.eventCount === 1 ? null
      : { reason: "event-count", field: "eventCount", expected: 1, received: receipt.eventCount };
  }
  const overlap = receipt.status === "applied" && receipt.eventCount === 0 && evidence.eventModifierMask === null &&
    isChromiumModifierCode(command.key.code) && evidence.physicalCodesBefore.includes(command.key.code) &&
    evidence.physicalCodesAfter.includes(command.key.code);
  const valid = overlap && (evidence.disposition === "adoptPhysical"
    ? command.key.type === "rawKeyDown" && evidence.coreCodesAfter.includes(command.key.code)
    : evidence.disposition === "releaseOwnership" && command.key.type === "keyUp" &&
      evidence.coreCodesBefore.includes(command.key.code) && !evidence.coreCodesAfter.includes(command.key.code));
  return valid ? null : reject("modifier-disposition", "disposition", "proven exact-side overlap", evidence.disposition);
}

export function compatibleInputEventCount(command: Command, receipt?: Receipt): number {
  if (command.action === "key") return receipt?.modifierEvidence?.disposition &&
    receipt.modifierEvidence.disposition !== "dispatch" ? 0 : 1;
  return command.action === "focus" ? 0 : command.pointer?.releaseOnly ? 2 : command.pointer?.button === 2 ? 6 : 5;
}
