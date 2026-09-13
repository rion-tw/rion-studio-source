import type { EmbeddedKeyEffectRecord } from "../../shared/generated";

export type ChromiumCdpInputPlatform = "darwin" | "win32";

export interface ChromiumCdpKeyDescriptor {
  readonly type: "rawKeyDown" | "keyUp";
  readonly code: string;
  readonly key: string;
  readonly modifiers: number;
  readonly location: 0 | 1 | 2;
  readonly windowsVirtualKeyCode: number;
  readonly autoRepeat: boolean;
}

export interface ChromiumCdpMouseDescriptor {
  readonly type: "mousePressed" | "mouseReleased";
  readonly x: number;
  readonly y: number;
  readonly button: "left" | "middle" | "right";
  readonly buttons: number;
  readonly clickCount: 1;
  readonly modifiers: number;
}

const BASE_KEYS: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  Backquote: ["`", 0xc0], Backspace: ["Backspace", 0x08],
  Tab: ["Tab", 0x09], Escape: ["Escape", 0x1b],
  Insert: ["Insert", 0x2d], Home: ["Home", 0x24],
  PageUp: ["PageUp", 0x21], Delete: ["Delete", 0x2e],
  End: ["End", 0x23], PageDown: ["PageDown", 0x22],
  ArrowLeft: ["ArrowLeft", 0x25], ArrowUp: ["ArrowUp", 0x26],
  ArrowRight: ["ArrowRight", 0x27], ArrowDown: ["ArrowDown", 0x28],
  Equal: ["=", 0xbb], Minus: ["-", 0xbd],
  Space: [" ", 0x20], Backslash: ["\\", 0xdc],
  Slash: ["/", 0xbf], Period: [".", 0xbe],
  Comma: [",", 0xbc], Semicolon: [";", 0xba],
  Quote: ["'", 0xde], BracketLeft: ["[", 0xdb],
  BracketRight: ["]", 0xdd], Enter: ["Enter", 0x0d],
  ControlLeft: ["Control", 0x11], ControlRight: ["Control", 0x11],
  AltLeft: ["Alt", 0x12], AltRight: ["Alt", 0x12],
  ShiftLeft: ["Shift", 0x10], ShiftRight: ["Shift", 0x10],
  MetaLeft: ["Meta", 0x5b], MetaRight: ["Meta", 0x5c]
});

const SHIFTED: Readonly<Record<string, string>> = Object.freeze({
  Backquote: "~", Digit1: "!", Digit2: "@", Digit3: "#", Digit4: "$",
  Digit5: "%", Digit6: "^", Digit7: "&", Digit8: "*", Digit9: "(",
  Digit0: ")", Equal: "+", Minus: "_", Backslash: "|", Slash: "?",
  Period: ">", Comma: "<", Semicolon: ":", Quote: "\"",
  BracketLeft: "{", BracketRight: "}"
});
const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"
]);

export function chromiumCdpModifierMask(codes: readonly string[]): number {
  let mask = 0;
  for (const code of codes) {
    if (code.startsWith("Alt")) mask |= 1;
    if (code.startsWith("Control")) mask |= 2;
    if (code.startsWith("Meta")) mask |= 4;
    if (code.startsWith("Shift")) mask |= 8;
  }
  return mask;
}

function baseDescriptor(code: string): readonly [string, number] | null {
  if (/^Key[A-Z]$/u.test(code)) {
    const letter = code.slice(3);
    return [letter.toLowerCase(), letter.charCodeAt(0)];
  }
  if (/^Digit[0-9]$/u.test(code)) {
    const digit = code.slice(5);
    return [digit, digit.charCodeAt(0)];
  }
  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/u.exec(code);
  if (functionMatch) {
    const number = Number(functionMatch[1]);
    return [`F${number}`, 0x6f + number];
  }
  return BASE_KEYS[code] ?? null;
}

export function chromiumCdpKeyDescriptor(
  effect: EmbeddedKeyEffectRecord,
  platform: ChromiumCdpInputPlatform
): ChromiumCdpKeyDescriptor {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("CDP input requires a supported desktop platform.");
  }
  const base = baseDescriptor(effect.code);
  if (!base) throw new Error(`Unsupported Chromium CDP key code: ${effect.code}`);
  const modifiers = chromiumCdpModifierMask(effect.activeCodes);
  const shifted = (modifiers & 8) !== 0;
  const key = /^Key[A-Z]$/u.test(effect.code) && shifted
    ? base[0].toUpperCase() : shifted ? SHIFTED[effect.code] ?? base[0] : base[0];
  return Object.freeze({
    type: effect.phase,
    code: effect.code,
    key,
    modifiers,
    location: MODIFIER_CODES.has(effect.code)
      ? effect.code.endsWith("Left") ? 1 : 2 : 0,
    windowsVirtualKeyCode: base[1],
    // A native key code lets Chromium redispatch unhandled input to OS menus.
    // Omit it: explicit DOM identity must remain confined to this Role page.
    autoRepeat: effect.autoRepeat
  });
}

export function chromiumCdpMouseDescriptors(input: Readonly<{
  x: number;
  y: number;
  button: "left" | "middle" | "right";
  modifierCodes: readonly string[];
  releaseOnly?: boolean;
}>): readonly ChromiumCdpMouseDescriptor[] {
  if (![input.x, input.y].every((value) => Number.isFinite(value) && value >= 0) ||
    input.modifierCodes.some((code) => !MODIFIER_CODES.has(code))) {
    throw new Error("CDP mouse input requires CSS viewport coordinates and known modifiers.");
  }
  const bit = input.button === "left" ? 1 : input.button === "right" ? 2 : 4;
  const common = {
    x: input.x,
    y: input.y,
    button: input.button,
    clickCount: 1 as const,
    modifiers: chromiumCdpModifierMask(input.modifierCodes)
  };
  return Object.freeze([
    ...(input.releaseOnly
      ? []
      : [Object.freeze({ ...common, type: "mousePressed" as const, buttons: bit })]),
    Object.freeze({ ...common, type: "mouseReleased" as const, buttons: 0 })
  ]);
}
