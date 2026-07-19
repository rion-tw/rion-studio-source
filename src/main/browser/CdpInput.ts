import { getMacroModifierForCode } from "../../shared/macroKeys";

export function getCdpKeyDescriptor(
  code: string,
  modifiers = 0
): Record<string, string | number> {
  const shift = (modifiers & 8) !== 0;
  const key = code.startsWith("Key") && code.length === 4
    ? shift ? code.slice(3) : code.slice(3).toLowerCase()
    : code.startsWith("Digit") && code.length === 6
      ? shift ? shiftedDigitKeys[code] ?? code.slice(5) : code.slice(5)
      : shift ? shiftedCdpKeys[code] ?? cdpKeys[code] ?? code : cdpKeys[code] ?? code;
  const windowsVirtualKeyCode = getWindowsVirtualKeyCode(code, key);
  const location = getCdpKeyLocation(code);
  return {
    code,
    key,
    ...(windowsVirtualKeyCode === undefined ? {} : { windowsVirtualKeyCode }),
    ...(location === undefined ? {} : { location })
  };
}

export function getCdpModifierMask(activeCodes: ReadonlySet<string>): number {
  let mask = 0;
  for (const code of activeCodes) {
    switch (getMacroModifierForCode(code)) {
      case "alt":
        mask |= 1;
        break;
      case "ctrl":
        mask |= 2;
        break;
      case "meta":
        mask |= 4;
        break;
      case "shift":
        mask |= 8;
        break;
    }
  }
  return mask;
}

function getWindowsVirtualKeyCode(code: string, key: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  return virtualKeyCodes[code] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
}

function getCdpKeyLocation(code: string): number | undefined {
  if (/^(?:Alt|Control|Meta|Shift)Left$/.test(code)) return 1;
  if (/^(?:Alt|Control|Meta|Shift)Right$/.test(code)) return 2;
  if (code.startsWith("Numpad")) return 3;
  return undefined;
}

const cdpKeys: Record<string, string> = {
  AltLeft: "Alt", AltRight: "Alt", ControlLeft: "Control", ControlRight: "Control",
  MetaLeft: "Meta", MetaRight: "Meta", ShiftLeft: "Shift", ShiftRight: "Shift",
  ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp",
  Backquote: "`", Backslash: "\\", Backspace: "Backspace", BracketLeft: "[", BracketRight: "]",
  Comma: ",", Enter: "Enter", Equal: "=", Escape: "Escape", Minus: "-", Period: ".",
  Quote: "'", Semicolon: ";", Slash: "/", Space: " ", Tab: "Tab",
  NumpadAdd: "+", NumpadDecimal: ".", NumpadDivide: "/", NumpadMultiply: "*", NumpadSubtract: "-"
};

const shiftedDigitKeys: Record<string, string> = {
  Digit0: ")", Digit1: "!", Digit2: "@", Digit3: "#", Digit4: "$",
  Digit5: "%", Digit6: "^", Digit7: "&", Digit8: "*", Digit9: "("
};

const shiftedCdpKeys: Record<string, string> = {
  Backquote: "~", Backslash: "|", BracketLeft: "{", BracketRight: "}",
  Comma: "<", Equal: "+", Minus: "_", Period: ">", Quote: '"',
  Semicolon: ":", Slash: "?"
};

const virtualKeyCodes: Record<string, number> = {
  AltLeft: 18, AltRight: 18, ControlLeft: 17, ControlRight: 17,
  MetaLeft: 91, MetaRight: 92, ShiftLeft: 16, ShiftRight: 16,
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Semicolon: 186,
  Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110,
  NumpadDivide: 111
};
