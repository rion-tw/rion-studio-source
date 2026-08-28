import { expect } from "@wdio/globals";

import type { Role } from "../../../src/shared/types";
import {
  keyboardInput,
  probe,
  runtimeUiAction,
  type DesktopE2eWindowSnapshot,
  waitEvent
} from "../support/control";
import {
  fixtureCursor,
  fixtureEvents,
  waitFixtureEvent
} from "../support/fixture";
import { classifyFlyffCaretDiagnostics } from "../support/flyff-caret";
import { readTranscriptEvents } from "../support/transcript";

export async function verifyFlyffCaretDiagnostics(input: {
  live: DesktopE2eWindowSnapshot;
  role: Role;
  tab: { id: string; windowId: string };
}): Promise<void> {
  const fixtureRoleId = "macro-keyboard-a";
  const fixtureEventCursor = await fixtureCursor();
  const nativeProbe = await probe();
  const keyDown = await keyboardInput("Enter", "keyDown", false);
  const keyUp = await keyboardInput("Enter", "keyUp", false);
  expect([keyDown, keyUp]).toEqual([
    expect.objectContaining({ code: "Enter", phase: "keyDown", status: "submitted" }),
    expect.objectContaining({ code: "Enter", phase: "keyUp", status: "submitted" })
  ]);
  let keyUpCursor = fixtureEventCursor;
  for (;;) {
    const observed = await waitFixtureEvent({
      afterSequence: keyUpCursor,
      kind: "flyff-caret-keyup",
      roleId: fixtureRoleId
    });
    if (observed.isTrusted === true) break;
    keyUpCursor = observed.sequence;
  }
  if (process.platform === "win32") {
    const accelerator = await waitEvent({
      afterSequence: nativeProbe.latestSequence,
      kind: "windows-webview-accelerator-observed"
    });
    const roleWebviewLabel = input.live.native.roleWebviews?.find(
      (entry) => entry.roleId === input.role.id
    )?.webviewLabel;
    expect(roleWebviewLabel).toEqual(expect.any(String));
    expect(accelerator.details).toMatchObject({
      handled: false,
      modifiers: { alt: false, control: false, meta: false, shift: false },
      virtualKey: 0x0D,
      wasKeyDown: false,
      webviewLabel: roleWebviewLabel
    });
  }
  const events = await fixtureEvents({
    afterSequence: fixtureEventCursor,
    roleId: fixtureRoleId
  });
  const caretEvents = events.filter((event) => event.kind.startsWith("flyff-caret-"));
  expect(caretEvents.map((event) => event.kind)).toEqual([
    "flyff-caret-keydown",
    "flyff-caret-selection-before",
    "flyff-caret-selection-after",
    "flyff-caret-focus-before",
    "flyff-caret-keyup",
    "flyff-caret-focusin",
    "flyff-caret-focus-after",
    "flyff-caret-keyup"
  ]);
  expect(caretEvents.filter((event) => event.kind === "flyff-caret-keydown")).toEqual([
    expect.objectContaining({
      code: "Enter",
      defaultPrevented: false,
      isTrusted: true,
      repeat: false,
      targetId: "game-input-canvas"
    })
  ]);
  expect(caretEvents.find((event) =>
    event.kind === "flyff-caret-selection-after"
  )?.caret).toMatchObject({
    requestedEnd: 4,
    requestedStart: 4,
    selectionEnd: 4,
    selectionStart: 4,
    textEditInvocation: 1,
    valueLength: 4
  });
  expect(caretEvents.find((event) =>
    event.kind === "flyff-caret-focus-before"
  )?.caret).toMatchObject({
    activeElementId: "game-input-canvas",
    selectionEnd: 4,
    selectionStart: 4
  });
  const focusInCaret = caretEvents.find((event) =>
    event.kind === "flyff-caret-focusin"
  )?.caret;
  expect(focusInCaret).toMatchObject({
    activeElementId: "text_input",
    textEditInvocation: 1,
    valueLength: 4
  });
  if (process.platform === "darwin") {
    expect(focusInCaret).toMatchObject({
      selectionEnd: 0,
      selectionStart: 0
    });
  } else {
    expect([0, 4]).toContain(focusInCaret?.selectionStart);
    expect(focusInCaret?.selectionEnd).toBe(focusInCaret?.selectionStart);
  }
  expect(caretEvents.find((event) =>
    event.kind === "flyff-caret-focus-after"
  )?.caret).toMatchObject({
    activeElementId: "text_input",
    selectionEnd: 4,
    selectionStart: 4,
    textEditInvocation: 1,
    valueLength: 4
  });
  const syntheticKeyUps = caretEvents.filter((event) =>
    event.kind === "flyff-caret-keyup" && event.isTrusted === false
  );
  expect(syntheticKeyUps).toEqual([
    expect.objectContaining({ code: "Enter", targetId: "game-input-canvas" })
  ]);
  expect(caretEvents.find((event) =>
    event.kind === "flyff-caret-keyup" && event.isTrusted === true
  )?.caret).toMatchObject({
    activeElementId: "text_input",
    selectionEnd: 4,
    selectionStart: 4,
    textEditInvocation: 1,
    valueLength: 4
  });
  expect(events.filter((event) =>
    event.kind === "keydown" && event.code === "Enter" && event.isTrusted === true
  )).toHaveLength(1);
  expect(events.filter((event) =>
    event.kind === "keyup" && event.code === "Enter" && event.isTrusted === true
  )).toHaveLength(1);

  const nativeEvents = await readTranscriptEvents(
    nativeProbe.transcriptPath,
    nativeProbe.latestSequence
  );
  if (process.platform === "win32") {
    expect(nativeEvents.filter((event) => {
      const details = event.details as { virtualKey?: number } | null;
      return event.kind === "windows-webview-accelerator-observed"
        && details?.virtualKey === 0x0D;
    })).toHaveLength(1);
  }
  const guardedKinds = new Set([
    "macro-key-dom-observed",
    "macro-key-native-acknowledged",
    "macro-shortcut-lifecycle",
    "managed-shortcut-key-acknowledged"
  ]);
  const guardedEnterEvents = nativeEvents.filter((event) => {
    const details = event.details as { code?: string } | null;
    return guardedKinds.has(event.kind) && details?.code === "Enter";
  });
  const rsFocusHandoffs = nativeEvents.filter((event) => {
    const details = event.details as { action?: string } | null;
    return event.kind === "runtime-ui-action-submitted" && details?.action === "focusRole";
  });
  expect(classifyFlyffCaretDiagnostics({
    events: caretEvents,
    guardedInputDispatch: guardedEnterEvents.length > 0,
    rsFocusHandoff: rsFocusHandoffs.length > 0
  })).toBe("rs-input-interference");
  expect(guardedEnterEvents).toHaveLength(0);
  expect(rsFocusHandoffs).toHaveLength(0);

  const refocusCursor = await fixtureCursor();
  await runtimeUiAction(input.tab.windowId, {
    action: "clickRoleContent",
    button: "left",
    roleId: input.role.id,
    tabId: input.tab.id,
    windowGeneration: input.live.windowGeneration
  });
  await waitFixtureEvent({
    afterSequence: refocusCursor,
    kind: "click",
    roleId: fixtureRoleId
  });
}
