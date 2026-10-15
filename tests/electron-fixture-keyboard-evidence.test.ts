import { describe, expect, it } from "vitest";
import { assertFixtureKeyboardReleased, type FixtureKeyboardEvidence } from "../src/electron/e2e/fixtureKeyboardEvidence";
import { createFixtureKeyboardJournal } from "../scripts/fixtureKeyboardJournal.mjs";

function evidence(release = true): FixtureKeyboardEvidence {
  const journal = createFixtureKeyboardJournal();
  const details = { code: "KeyT", keyCode: 84, which: 84, isTrusted: false, modifiers: { alt: false, control: false, meta: false, shift: false } };
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

function releaseModifiers(changes: Partial<{ alt: boolean; control: boolean; meta: boolean; shift: boolean }>) {
  const result = evidence();
  for (const event of result.snapshot!.events.filter(event => event.kind.endsWith("keyup"))) {
    event.modifiers = { ...event.modifiers, ...changes };
  }
  return result;
}

describe("terminal consumer acceptance", () => {
  it("accepts complete receiver state even without HTTP telemetry", () => {
    expect(() => assertFixtureKeyboardReleased(evidence(), "KeyT")).not.toThrow();
  });
  it("rejects a missing release even if transport reported applied", () => {
    expect(() => assertFixtureKeyboardReleased(evidence(false), "KeyT")).toThrow("complete KeyT lifecycle");
  });
  it.each([
    { platform: "windows", modifiers: { control: true } },
    { platform: "macos", modifiers: { meta: true } }
  ] as const)("accepts only the exact $platform native quit modifier interleaving", context => {
    expect(() => assertFixtureKeyboardReleased(releaseModifiers(context.modifiers), "KeyT",
      { kind: "native-quit", platform: context.platform })).not.toThrow();
    expect(() => assertFixtureKeyboardReleased(evidence(), "KeyT",
      { kind: "native-quit", platform: context.platform })).not.toThrow();
  });
  it.each([{ control: true }, { meta: true }])("keeps ordinary terminal cleanup strict for %j", modifiers => {
    expect(() => assertFixtureKeyboardReleased(releaseModifiers(modifiers), "KeyT")).toThrow();
  });
  it.each([
    { platform: "windows", modifiers: { meta: true } },
    { platform: "windows", modifiers: { control: true, shift: true } },
    { platform: "windows", modifiers: { control: true, alt: true } },
    { platform: "windows", modifiers: { control: true, meta: true } },
    { platform: "macos", modifiers: { control: true } },
    { platform: "macos", modifiers: { meta: true, shift: true } },
    { platform: "macos", modifiers: { meta: true, alt: true } },
    { platform: "macos", modifiers: { meta: true, control: true } }
  ] as const)("rejects foreign/additional modifiers for $platform %j", context => {
    expect(() => assertFixtureKeyboardReleased(releaseModifiers(context.modifiers), "KeyT",
      { kind: "native-quit", platform: context.platform })).toThrow();
  });
  it("rejects quit modifiers on keydown and disagreeing keyup receiver flags", () => {
    const context = { kind: "native-quit", platform: "windows" } as const;
    const modifiedDown = releaseModifiers({ control: true });
    modifiedDown.snapshot!.events[0]!.modifiers.control = true;
    expect(() => assertFixtureKeyboardReleased(modifiedDown, "KeyT", context)).toThrow();
    const mismatchedRelease = releaseModifiers({ control: true });
    mismatchedRelease.snapshot!.events.at(-1)!.modifiers.control = false;
    expect(() => assertFixtureKeyboardReleased(mismatchedRelease, "KeyT", context)).toThrow();
    expect(() => assertFixtureKeyboardReleased(evidence(false), "KeyT", context)).toThrow();
  });
  it.each(["duplicate", "held", "wrong-document", "truncated", "zero-legacy-code"])("rejects %s evidence", fault => {
    const result = evidence();
    if (fault === "zero-legacy-code") result.snapshot!.events.at(-1)!.keyCode = 0;
    if (fault === "duplicate") result.snapshot!.events.push(result.snapshot!.events.at(-1)!);
    if (fault === "held") result.snapshot!.events.at(-1)!.consumerPressedCodes = ["KeyT"];
    if (fault === "wrong-document") result.snapshot!.fixtureRoleId = "other";
    if (fault === "truncated") result.snapshot!.dropped = 1;
    for (const context of [undefined, { kind: "native-quit", platform: "windows" },
      { kind: "native-quit", platform: "macos" }] as const) {
      expect(() => assertFixtureKeyboardReleased(result, "KeyT", context)).toThrow();
    }
  });
});
