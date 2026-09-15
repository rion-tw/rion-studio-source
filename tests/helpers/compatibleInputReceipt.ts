import type { ChromiumCompatibleInputCommand } from "../../src/electron/ipc/chromiumCompatibleInputProtocol";
import type { CompatibleModifierEvidenceRecord } from "../../src/shared/generated";

export function compatibleModifierEvidenceForTest(command: ChromiumCompatibleInputCommand):
  { modifierEvidence?: CompatibleModifierEvidenceRecord } {
  const state = command.modifierState;
  if (!command.key || !state) return {};
  return { modifierEvidence: {
    coreCodesBefore: [...state.coreCodesBefore], coreCodesAfter: [...state.coreCodesAfter],
    nativePhysicalCodes: [...state.nativePhysicalCodes], physicalCodesBefore: [...state.nativePhysicalCodes],
    physicalCodesAfter: [...state.nativePhysicalCodes], disposition: "dispatch",
    eventModifierMask: command.key.modifiers, transitions: [], droppedTransitionCount: 0
  } };
}
