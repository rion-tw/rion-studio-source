/* global KeyboardEvent, MouseEvent, addEventListener, location */

const { ipcRenderer } = require("electron");

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((candidate) => candidate.startsWith(prefix));
  return value?.slice(prefix.length) ?? null;
}

const channel = argument("rion-windows-input-probe-channel");
const roleId = argument("rion-windows-input-probe-role");
const surfaceGeneration = Number(
  argument("rion-windows-input-probe-generation")
);
const frameToken = argument("rion-windows-input-probe-frame-token");

if (
  !channel ||
  !roleId ||
  !frameToken ||
  !Number.isSafeInteger(surfaceGeneration) ||
  surfaceGeneration < 1
) {
  throw new Error("The private Windows input-probe identity is invalid.");
}

const armChannel = `${channel}:arm`;
let pending = null;

function identity(kind) {
  return {
    kind,
    roleId,
    surfaceGeneration,
    frameToken,
    documentUrl: location.href
  };
}

function validExpectedEvent(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (!["keydown", "keyup", "mousedown", "mouseup", "click"].includes(
    candidate.type
  )) {
    return false;
  }
  if (candidate.type.startsWith("key")) {
    return typeof candidate.code === "string" && candidate.code.length > 0;
  }
  return Number.isSafeInteger(candidate.button) && candidate.button >= 0 &&
    candidate.button <= 2 &&
    ((candidate.clientX === null && candidate.clientY === null) ||
      (Number.isFinite(candidate.clientX) && candidate.clientX >= 0 &&
        Number.isFinite(candidate.clientY) && candidate.clientY >= 0));
}

ipcRenderer.on(armChannel, (_event, candidate) => {
  if (
    pending !== null ||
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.inputSequence !== "string" ||
    candidate.inputSequence.length === 0 ||
    candidate.inputSequence.length > 128 ||
    !Array.isArray(candidate.expectedEvents) ||
    candidate.expectedEvents.length === 0 ||
    candidate.expectedEvents.length > 4 ||
    !candidate.expectedEvents.every(validExpectedEvent)
  ) {
    ipcRenderer.send(channel, {
      ...identity("arm-rejected"),
      inputSequence: candidate?.inputSequence ?? null
    });
    return;
  }
  pending = {
    inputSequence: candidate.inputSequence,
    expectedEvents: candidate.expectedEvents.map((expected) => ({ ...expected })),
    nextIndex: 0
  };
  ipcRenderer.send(channel, {
    ...identity("armed"),
    inputSequence: pending.inputSequence,
    expectedEventCount: pending.expectedEvents.length
  });
});

function captureInput(event) {
  if (!pending) return;
  const expected = pending.expectedEvents[pending.nextIndex];
  const keyboard = event instanceof KeyboardEvent;
  const mouse = event instanceof MouseEvent;
  const matches = event.type === expected.type &&
    (keyboard
      ? event.code === expected.code
      : mouse && event.button === expected.button &&
        (expected.clientX === null || event.clientX === expected.clientX) &&
        (expected.clientY === null || event.clientY === expected.clientY));
  const receipt = {
    ...identity("input"),
    inputSequence: pending.inputSequence,
    observedIndex: pending.nextIndex,
    matches,
    type: event.type,
    isTrusted: event.isTrusted,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    ...(keyboard
      ? { code: event.code, key: event.key, repeat: event.repeat }
      : {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY
        })
  };
  if (!matches || !event.isTrusted) {
    pending = null;
  } else {
    pending.nextIndex += 1;
    if (pending.nextIndex === pending.expectedEvents.length) pending = null;
  }
  ipcRenderer.send(channel, receipt);
}

for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click"]) {
  addEventListener(type, captureInput, { capture: true });
}

ipcRenderer.send(channel, identity("ready"));
