import type { BrowserAction, EmbeddedKeyEffectRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export type ChromiumTrustedInputPlatform = "darwin" | "win32";

export const CHROMIUM_MODIFIER_CODES = Object.freeze([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"
] as const);

const MODIFIER_CODE_SET = new Set<string>(CHROMIUM_MODIFIER_CODES);

function invalid(message: string): never {
  throw new RionBridgeError({ code: "ELECTRON_CHROMIUM_INPUT_INVALID", message });
}

export function isChromiumModifierCode(code: string): boolean {
  return MODIFIER_CODE_SET.has(code);
}

export function resolveChromiumModifierCodes(
  action: Extract<BrowserAction, { type: "key" }>,
  platform: ChromiumTrustedInputPlatform
): readonly string[] {
  const exact = action.exactModifierCodes;
  const codes = exact ?? action.modifiers.map((modifier) => {
    if (modifier === "primary") return platform === "darwin" ? "MetaLeft" : "ControlLeft";
    if (modifier === "ctrl") return "ControlLeft";
    if (modifier === "alt") return "AltLeft";
    if (modifier === "shift") return "ShiftLeft";
    return "MetaLeft";
  });
  if (codes.length > 8 || codes.some((code) => !isChromiumModifierCode(code)) ||
    new Set(codes).size !== codes.length) {
    invalid("Core supplied invalid exact modifier codes.");
  }
  return Object.freeze([...codes]);
}

export function activeChromiumModifierCodes(
  effect: EmbeddedKeyEffectRecord,
  physicalModifierCodes: readonly string[]
): readonly string[] {
  const active = [...effect.activeCodes.filter(isChromiumModifierCode), ...physicalModifierCodes];
  return Object.freeze([...new Set(active)]);
}

export function inverseChromiumKeyEffect(
  effect: EmbeddedKeyEffectRecord
): EmbeddedKeyEffectRecord | null {
  if (effect.autoRepeat && effect.activeCodesBefore.join("\n") === effect.activeCodes.join("\n")) {
    return null;
  }
  return Object.freeze({
    phase: effect.phase === "rawKeyDown" ? "keyUp" : "rawKeyDown",
    code: effect.code,
    activeCodesBefore: [...effect.activeCodes],
    activeCodes: [...effect.activeCodesBefore],
    autoRepeat: false,
    suppressShortcut: effect.suppressShortcut
  });
}
