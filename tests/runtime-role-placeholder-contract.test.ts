import { describe, expect, it } from "vitest";

import {
  parseRuntimeRolePlaceholderAction,
  parseRuntimeRolePlaceholderClaimReceipt,
  parseRuntimeRolePlaceholderState
} from "../src/shared/runtimeRolePlaceholder";

const state = {
  blocked: true,
  generation: 2,
  ownerGeneration: 5,
  ownerTabName: "Source",
  placeholderId: "role-placeholder:target:slot",
  roleId: "role-a",
  roleName: "Role A",
  slotId: "slot-a",
  tabId: "tab-target",
  topologyRevision: 11,
  windowGeneration: 3,
  windowId: "window-target"
} as const;

describe("runtime Role placeholder contract", () => {
  it("accepts exact state/action/receipt records", () => {
    expect(parseRuntimeRolePlaceholderState(state)).toEqual(state);
    const { blocked: _blocked, ownerTabName: _owner, roleName: _name, ...identity } = state;
    expect(parseRuntimeRolePlaceholderAction({ ...identity, type: "claim" }))
      .toEqual({ ...identity, type: "claim" });
    expect(parseRuntimeRolePlaceholderClaimReceipt({
      ...identity,
      status: "applied"
    })).toEqual({ ...identity, status: "applied" });
  });

  it("rejects extra keys and stale/malformed generations", () => {
    expect(parseRuntimeRolePlaceholderState({ ...state, extra: true })).toBeNull();
    expect(parseRuntimeRolePlaceholderAction({ type: "ready", extra: true })).toBeNull();
    expect(parseRuntimeRolePlaceholderAction({
      ...state,
      type: "claim"
    })).toBeNull();
    expect(parseRuntimeRolePlaceholderClaimReceipt({
      ...state,
      ownerGeneration: 0,
      status: "applied"
    })).toBeNull();
  });
});
