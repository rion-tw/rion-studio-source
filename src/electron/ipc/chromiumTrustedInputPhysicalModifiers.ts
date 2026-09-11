import type { ChromiumRoleTrustedInputExpectedEvent } from
  "./chromiumRoleTrustedInputProtocol";

export const CHROMIUM_PHYSICAL_MODIFIER_CODES = Object.freeze([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"
] as const);

const MODIFIER_CODES = new Set<string>(CHROMIUM_PHYSICAL_MODIFIER_CODES);

export function validChromiumPhysicalModifierCodes(
  value: unknown
): value is readonly string[] {
  return Array.isArray(value) && value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every(code => typeof code === "string" && MODIFIER_CODES.has(code));
}

export function mergeChromiumPhysicalModifiers(
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[],
  physicalModifierCodes: readonly string[],
  projectedCode: string | null
): readonly ChromiumRoleTrustedInputExpectedEvent[] {
  const codes = physicalModifierCodes.filter(code => code !== projectedCode);
  const has = (prefix: string) => codes.some(code => code.startsWith(prefix));
  return Object.freeze(expectedEvents.map(event => Object.freeze({
    ...event,
    altKey: event.altKey || has("Alt"),
    ctrlKey: event.ctrlKey || has("Control"),
    metaKey: event.metaKey || has("Meta"),
    shiftKey: event.shiftKey || has("Shift")
  })));
}
