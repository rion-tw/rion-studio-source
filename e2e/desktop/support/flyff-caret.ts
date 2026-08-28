export interface FlyffCaretEvent {
  caret?: {
    activeElementId: string | null;
    requestedEnd: number | null;
    requestedStart: number | null;
    selectionEnd: number | null;
    selectionStart: number | null;
    textEditInvocation: number;
    valueLength: number;
  };
  isTrusted?: boolean;
  kind: string;
  targetId?: string;
}

export type FlyffCaretDiagnosis =
  | "flyff-repeat-start-text-edit"
  | "flyff-selection-state-zero"
  | "indeterminate"
  | "preserved"
  | "rs-input-interference"
  | "webview-focus-reset";

export function classifyFlyffCaretDiagnostics(input: {
  events: FlyffCaretEvent[];
  guardedInputDispatch: boolean;
  rsFocusHandoff: boolean;
}): FlyffCaretDiagnosis {
  const trustedEnterKeyDowns = input.events.filter((event) =>
    event.kind === "flyff-caret-keydown" && event.isTrusted === true
  );
  const syntheticEnterKeyUps = input.events.filter((event) =>
    event.kind === "flyff-caret-keyup" && event.isTrusted === false
  );
  if (
    trustedEnterKeyDowns.length > 1
    || syntheticEnterKeyUps.length > 0
    || input.guardedInputDispatch
    || input.rsFocusHandoff
  ) {
    return "rs-input-interference";
  }
  if (trustedEnterKeyDowns.length !== 1) return "indeterminate";

  const selectionEvents = input.events.filter((event) =>
    event.kind === "flyff-caret-selection-after" && event.caret
  );
  const zeroSelection = (event: FlyffCaretEvent | undefined) =>
    event?.caret?.selectionStart === 0 && event.caret.selectionEnd === 0;
  const requestedZero = (event: FlyffCaretEvent | undefined) =>
    event?.caret?.requestedStart === 0 && event.caret.requestedEnd === 0;
  const invocations = new Set(selectionEvents.map((event) =>
    event.caret?.textEditInvocation ?? 0
  ));
  const finalSelection = selectionEvents.at(-1);
  if (invocations.size > 1 && zeroSelection(finalSelection)) {
    return "flyff-repeat-start-text-edit";
  }
  const firstSelection = selectionEvents[0];
  if (zeroSelection(firstSelection) && requestedZero(firstSelection)) {
    return "flyff-selection-state-zero";
  }

  const focusBeforeEvents = input.events.filter((event) =>
    event.kind === "flyff-caret-focus-before" && event.caret
  );
  const focusAfterEvents = input.events.filter((event) =>
    event.kind === "flyff-caret-focus-after" && event.caret
  );
  for (const before of focusBeforeEvents) {
    const invocation = before.caret?.textEditInvocation;
    const after = focusAfterEvents.find((candidate) =>
      candidate.caret?.textEditInvocation === invocation
    );
    if (
      !(before.caret?.selectionStart === 0 && before.caret?.selectionEnd === 0)
      && zeroSelection(after)
    ) {
      return "webview-focus-reset";
    }
  }

  const finalCaret = [...input.events].reverse().find((event) =>
    event.kind === "flyff-caret-keyup"
  )?.caret ?? focusAfterEvents.at(-1)?.caret;
  if (
    finalCaret
    && finalCaret.valueLength > 0
    && finalCaret.selectionStart === finalCaret.valueLength
    && finalCaret.selectionEnd === finalCaret.valueLength
  ) {
    return "preserved";
  }
  return "indeterminate";
}
