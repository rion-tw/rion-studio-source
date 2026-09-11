import type { EmbeddedKeyEffectRecord } from "../../shared/generated";

export type ChromiumCdpInputPlatform = "darwin" | "win32";

export interface ChromiumCdpKeyDescriptor {
  readonly type: "rawKeyDown" | "keyUp";
  readonly code: string;
  readonly key: string;
  readonly modifiers: number;
  readonly location: 0 | 1 | 2;
  readonly windowsVirtualKeyCode: number;
  readonly nativeVirtualKeyCode: number;
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

const BASE_KEYS: Readonly<Record<string, readonly [string, number, number]>> = Object.freeze({
  Backquote: ["`", 0xc0, 0x32], Backspace: ["Backspace", 0x08, 0x33],
  Tab: ["Tab", 0x09, 0x30], Escape: ["Escape", 0x1b, 0x35],
  Insert: ["Insert", 0x2d, 0x72], Home: ["Home", 0x24, 0x73],
  PageUp: ["PageUp", 0x21, 0x74], Delete: ["Delete", 0x2e, 0x75],
  End: ["End", 0x23, 0x77], PageDown: ["PageDown", 0x22, 0x79],
  ArrowLeft: ["ArrowLeft", 0x25, 0x7b], ArrowUp: ["ArrowUp", 0x26, 0x7e],
  ArrowRight: ["ArrowRight", 0x27, 0x7c], ArrowDown: ["ArrowDown", 0x28, 0x7d],
  Equal: ["=", 0xbb, 0x18], Minus: ["-", 0xbd, 0x1b],
  Space: [" ", 0x20, 0x31], Backslash: ["\\", 0xdc, 0x2a],
  Slash: ["/", 0xbf, 0x2c], Period: [".", 0xbe, 0x2f],
  Comma: [",", 0xbc, 0x2b], Semicolon: [";", 0xba, 0x29],
  Quote: ["'", 0xde, 0x27], BracketLeft: ["[", 0xdb, 0x21],
  BracketRight: ["]", 0xdd, 0x1e], Enter: ["Enter", 0x0d, 0x24],
  ControlLeft: ["Control", 0x11, 0x3b], ControlRight: ["Control", 0x11, 0x3e],
  AltLeft: ["Alt", 0x12, 0x3a], AltRight: ["Alt", 0x12, 0x3d],
  ShiftLeft: ["Shift", 0x10, 0x38], ShiftRight: ["Shift", 0x10, 0x3c],
  MetaLeft: ["Meta", 0x5b, 0x37], MetaRight: ["Meta", 0x5c, 0x36]
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

function modifierMask(codes: readonly string[]): number {
  let mask = 0;
  for (const code of codes) {
    if (code.startsWith("Alt")) mask |= 1;
    if (code.startsWith("Control")) mask |= 2;
    if (code.startsWith("Meta")) mask |= 4;
    if (code.startsWith("Shift")) mask |= 8;
  }
  return mask;
}

function baseDescriptor(code: string): readonly [string, number, number] | null {
  if (/^Key[A-Z]$/u.test(code)) {
    const letter = code.slice(3);
    return [letter.toLowerCase(), letter.charCodeAt(0), letter.charCodeAt(0) - 65];
  }
  if (/^Digit[0-9]$/u.test(code)) {
    const digit = code.slice(5);
    const macCodes = [0x1d, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1a, 0x1c, 0x19];
    return [digit, digit.charCodeAt(0), macCodes[Number(digit)]!];
  }
  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/u.exec(code);
  if (functionMatch) {
    const number = Number(functionMatch[1]);
    const macCodes = [0, 0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65,
      0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a];
    return [`F${number}`, 0x6f + number, macCodes[number] ?? 0];
  }
  return BASE_KEYS[code] ?? null;
}

export function chromiumCdpKeyDescriptor(
  effect: EmbeddedKeyEffectRecord,
  platform: ChromiumCdpInputPlatform
): ChromiumCdpKeyDescriptor {
  const base = baseDescriptor(effect.code);
  if (!base) throw new Error(`Unsupported Chromium CDP key code: ${effect.code}`);
  const modifiers = modifierMask(effect.activeCodes);
  const shifted = (modifiers & 8) !== 0;
  const key = /^Key[A-Z]$/u.test(effect.code) && shifted
    ? base[0].toUpperCase() : shifted ? SHIFTED[effect.code] ?? base[0] : base[0];
  return Object.freeze({
    type: effect.phase,
    code: effect.code,
    key,
    modifiers,
    location: effect.code.endsWith("Left") ? 1 : effect.code.endsWith("Right") ? 2 : 0,
    windowsVirtualKeyCode: base[1],
    nativeVirtualKeyCode: platform === "darwin" ? base[2] : base[1],
    autoRepeat: effect.autoRepeat
  });
}

export function chromiumCdpMouseDescriptors(input: Readonly<{
  x: number;
  y: number;
  button: "left" | "middle" | "right";
  modifierCodes: readonly string[];
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
    modifiers: modifierMask(input.modifierCodes)
  };
  return Object.freeze([
    Object.freeze({ ...common, type: "mousePressed" as const, buttons: bit }),
    Object.freeze({ ...common, type: "mouseReleased" as const, buttons: 0 })
  ]);
}
