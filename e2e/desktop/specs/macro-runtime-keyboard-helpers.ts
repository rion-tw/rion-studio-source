import { expect } from "@wdio/globals";

import { waitEvent } from "../support/control";
import { waitFixtureEvent } from "../support/fixture";

export async function waitFixtureCode(input: {
  afterSequence: number;
  code: string;
  kind: "consumer-keydown" | "consumer-keyup" | "keydown" | "keyup";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: input.kind,
      roleId: input.roleId
    });
    if (event.code === input.code) return event;
    cursor = event.sequence;
  }
}

export async function waitMacroKeyReceipt(input: {
  afterSequence: number;
  code: string;
  kind: "macro-key-dom-observed" | "macro-key-native-acknowledged";
  phase: "keydown" | "keyup";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({ afterSequence: cursor, kind: input.kind });
    const details = event.details as {
      code?: string;
      dispatchId?: string;
      phase?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      expect(details.dispatchId).toEqual(expect.any(String));
      return event;
    }
    cursor = event.sequence;
  }
}

export async function waitShortcutLifecycle(input: {
  afterSequence: number;
  code: string;
  macroId: string;
  phase:
    | "physical-keydown-managed"
    | "chord-released"
    | "managed-replay-acknowledged"
    | "managed-keydown-acknowledged"
    | "managed-keyup-acknowledged"
    | "macro-dispatched";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({ afterSequence: cursor, kind: "macro-shortcut-lifecycle" });
    const details = event.details as {
      code?: string;
      macroId?: string;
      phase?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.macroId === input.macroId
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      return event;
    }
    cursor = event.sequence;
  }
}

export async function waitManagedShortcutReceipt(input: {
  afterSequence: number;
  code: string;
  macroId: string;
  phase: "replay" | "keyDown" | "keyUp";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({
      afterSequence: cursor,
      kind: "managed-shortcut-key-acknowledged"
    });
    const details = event.details as {
      code?: string;
      macroId?: string;
      phase?: string;
      pressId?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.macroId === input.macroId
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      expect(details.pressId).toEqual(expect.any(String));
      return event;
    }
    cursor = event.sequence;
  }
}
