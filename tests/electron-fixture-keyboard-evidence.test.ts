import { describe, expect, it } from "vitest";
import { assertFixtureKeyboardReleased, type FixtureKeyboardEvidence } from "../src/electron/e2e/fixtureKeyboardEvidence";
import { createFixtureKeyboardJournal } from "../scripts/fixtureKeyboardJournal.mjs";

function evidence(release = true): FixtureKeyboardEvidence {
  const journal = createFixtureKeyboardJournal();
  const details = { code: "KeyT", isTrusted: false, modifiers: { alt: false, control: false, meta: false, shift: false } };
  journal.record("keydown", details);
  journal.record("consumer-keydown", { ...details, consumerPressedCodes: ["KeyT"] });
  if (release) {
    journal.record("keyup", details);
    journal.record("consumer-keyup", { ...details, consumerPressedCodes: [] });
  }
  return { roleId: "role", generation: 1, tabId: "tab", fixtureRoleId: "fixture", status: "captured",
    documentInstanceId: "document", frameToken: "frame",
    snapshot: { ...journal.snapshot(), fixtureRoleId: "fixture", documentToken: "token" } };
}

describe("terminal consumer acceptance", () => {
  it("accepts complete receiver state even without HTTP telemetry", () => {
    expect(() => assertFixtureKeyboardReleased(evidence(), "KeyT")).not.toThrow();
  });
  it("rejects a missing release even if transport reported applied", () => {
    expect(() => assertFixtureKeyboardReleased(evidence(false), "KeyT")).toThrow("complete KeyT lifecycle");
  });
  it.each(["duplicate", "held", "wrong-document", "truncated"])("rejects %s evidence", fault => {
    const result = evidence();
    if (fault === "duplicate") result.snapshot!.events.push(result.snapshot!.events.at(-1)!);
    if (fault === "held") result.snapshot!.events.at(-1)!.consumerPressedCodes = ["KeyT"];
    if (fault === "wrong-document") result.snapshot!.fixtureRoleId = "other";
    if (fault === "truncated") result.snapshot!.dropped = 1;
    expect(() => assertFixtureKeyboardReleased(result, "KeyT")).toThrow();
  });
});
