import type { KeyboardInputEvent, MouseInputEvent } from "electron";

interface InputContents {
  sendInputEvent: (event: KeyboardInputEvent | MouseInputEvent) => void;
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  Backquote: "`", Backspace: "Backspace", Tab: "Tab", Escape: "Escape",
  Insert: "Insert", Home: "Home", PageUp: "PageUp", Delete: "Delete",
  End: "End", PageDown: "PageDown", ArrowLeft: "Left", ArrowUp: "Up",
  ArrowRight: "Right", ArrowDown: "Down", Equal: "=", Minus: "-",
  Space: "Space", Backslash: "\\", Slash: "/", Period: ".", Comma: ",",
  Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Enter: "Return",
  ControlLeft: "Control", ControlRight: "Control", AltLeft: "Alt", AltRight: "Alt",
  ShiftLeft: "Shift", ShiftRight: "Shift", MetaLeft: "Meta", MetaRight: "Meta"
});

/** Engine submission only. The owner must still validate identity and DOM ACKs. */
export function sendChromiumKey(contents: InputContents, request: {
  eventType: "rawKeyDown" | "keyUp"; code: string;
  ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; repeat: boolean;
}) {
  const keyCode = /^Key[A-Z]$/u.test(request.code) ? request.code.slice(3)
    : /^Digit[0-9]$/u.test(request.code) ? request.code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(request.code) ? request.code
        : Object.hasOwn(KEY_NAMES, request.code) ? KEY_NAMES[request.code] : undefined;
  if (!keyCode || !["rawKeyDown", "keyUp"].includes(request.eventType) ||
      (request.eventType === "keyUp" && request.repeat) ||
      ![request.ctrl, request.alt, request.shift, request.meta].every(value => typeof value === "boolean")) {
    throw new Error("Chromium key submission requires an exact supported code and modifiers.");
  }
  const modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = [];
  if (request.ctrl) modifiers.push("control");
  if (request.alt) modifiers.push("alt");
  if (request.shift) modifiers.push("shift");
  if (request.meta) modifiers.push("meta");
  if (request.code.endsWith("Left")) modifiers.push("left");
  if (request.code.endsWith("Right")) modifiers.push("right");
  if (request.repeat) modifiers.push("isautorepeat");
  contents.sendInputEvent({ type: request.eventType, keyCode, modifiers });
  return Object.freeze({
    submissionApi: "webContents.sendInputEvent" as const,
    eventType: request.eventType, code: request.code,
    ctrl: request.ctrl, alt: request.alt, shift: request.shift, meta: request.meta,
    repeat: request.repeat, dispatchedEventCount: 1 as const
  });
}

export function sendChromiumClick(contents: InputContents, request: {
  clientX: number; clientY: number; zoomFactor: number; button: 0 | 1 | 2;
  ctrl: boolean; alt: boolean; shift: boolean; meta: boolean;
}, viewport: { width: number; height: number }) {
  if (![request.clientX, request.clientY].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(request.zoomFactor) || request.zoomFactor < 0.25 || request.zoomFactor > 5 ||
      ![0, 1, 2].includes(request.button) ||
      ![request.ctrl, request.alt, request.shift, request.meta]
        .every(value => typeof value === "boolean") ||
      ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Chromium pointer submission requires valid CSS coordinates, zoom and viewport.");
  }
  // Electron input uses view-local DIP. Display DPI and native parent offsets
  // must not be applied here; Chromium divides the delivered point by zoom.
  const inputX = Math.round(request.clientX * request.zoomFactor);
  const inputY = Math.round(request.clientY * request.zoomFactor);
  if (!Number.isSafeInteger(inputX) || !Number.isSafeInteger(inputY) ||
      inputX >= viewport.width || inputY >= viewport.height) {
    throw new Error("Chromium pointer submission falls outside the exact view viewport.");
  }
  const button = (["left", "middle", "right"] as const)[request.button];
  const modifiers: NonNullable<MouseInputEvent["modifiers"]> = [];
  if (request.ctrl) modifiers.push("control");
  if (request.alt) modifiers.push("alt");
  if (request.shift) modifiers.push("shift");
  if (request.meta) modifiers.push("meta");
  contents.sendInputEvent({ type: "mouseDown", x: inputX, y: inputY, button,
    clickCount: 1, modifiers: [...modifiers, `${button}buttondown`] });
  contents.sendInputEvent({ type: "mouseUp", x: inputX, y: inputY, button,
    clickCount: 1, modifiers });
  return Object.freeze({
    submissionApi: "webContents.sendInputEvent" as const,
    clientX: request.clientX, clientY: request.clientY, zoomFactor: request.zoomFactor,
    button: request.button, inputX, inputY, ctrl: request.ctrl, alt: request.alt,
    shift: request.shift, meta: request.meta,
    // MouseEvent client coordinates expose integral CSS pixels.
    expectedDomClientX: Math.floor(inputX / request.zoomFactor),
    expectedDomClientY: Math.floor(inputY / request.zoomFactor),
    dispatchedEventCount: 2 as const
  });
}
