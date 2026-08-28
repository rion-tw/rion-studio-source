import { describe, expect, it } from "vitest";

import {
  classifyFlyffCaretDiagnostics,
  type FlyffCaretDiagnosis,
  type FlyffCaretEvent
} from "../e2e/desktop/support/flyff-caret";

function event(
  kind: string,
  selectionStart: number,
  selectionEnd = selectionStart,
  input: { invocation?: number; requestedStart?: number } = {}
): FlyffCaretEvent {
  return {
    caret: {
      activeElementId: kind.includes("focus-before") ? "game-input-canvas" : "text_input",
      requestedEnd: input.requestedStart ?? null,
      requestedStart: input.requestedStart ?? null,
      selectionEnd,
      selectionStart,
      textEditInvocation: input.invocation ?? 1,
      valueLength: 4
    },
    kind
  };
}

function diagnose(
  events: FlyffCaretEvent[],
  overrides: { guardedInputDispatch?: boolean; rsFocusHandoff?: boolean } = {}
): FlyffCaretDiagnosis {
  return classifyFlyffCaretDiagnostics({
    events: [
      { ...event("flyff-caret-keydown", 4), isTrusted: true },
      ...events
    ],
    guardedInputDispatch: overrides.guardedInputDispatch ?? false,
    rsFocusHandoff: overrides.rsFocusHandoff ?? false
  });
}

describe("Flyff caret diagnostics", () => {
  it("classifies Flyff selection state, WebView focus resets, and repeated text editing", () => {
    expect(diagnose([
      event("flyff-caret-selection-after", 0, 0, { requestedStart: 0 })
    ])).toBe("flyff-selection-state-zero");
    expect(diagnose([
      event("flyff-caret-selection-after", 4, 4, { requestedStart: 4 }),
      event("flyff-caret-focus-before", 4),
      event("flyff-caret-focus-after", 0)
    ])).toBe("webview-focus-reset");
    expect(diagnose([
      event("flyff-caret-selection-after", 4, 4, { invocation: 1, requestedStart: 4 }),
      event("flyff-caret-focus-after", 4, 4, { invocation: 1 }),
      event("flyff-caret-selection-after", 0, 0, { invocation: 2, requestedStart: 0 })
    ])).toBe("flyff-repeat-start-text-edit");
  });

  it("classifies RS interference and a preserved end caret", () => {
    expect(diagnose([], { guardedInputDispatch: true })).toBe("rs-input-interference");
    expect(diagnose([], { rsFocusHandoff: true })).toBe("rs-input-interference");
    expect(diagnose([
      { ...event("flyff-caret-keyup", 4), isTrusted: false, targetId: "game-input-canvas" }
    ])).toBe("rs-input-interference");
    expect(classifyFlyffCaretDiagnostics({
      events: [
        { ...event("flyff-caret-keydown", 4), isTrusted: true },
        { ...event("flyff-caret-keydown", 4), isTrusted: true }
      ],
      guardedInputDispatch: false,
      rsFocusHandoff: false
    })).toBe("rs-input-interference");
    expect(diagnose([
      event("flyff-caret-selection-after", 4, 4, { requestedStart: 4 }),
      event("flyff-caret-focus-before", 4),
      event("flyff-caret-focus-after", 4),
      event("flyff-caret-keyup", 4)
    ])).toBe("preserved");
  });
});
