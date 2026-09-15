import { describe, expect, it } from "vitest";
import { createFixtureKeyboardJournal } from "../scripts/fixtureKeyboardJournal.mjs";

describe("fixture document keyboard journal", () => {
  const details = { code: "KeyT", isTrusted: false,
    modifiers: { alt: false, control: false, meta: false, shift: false } };
  it("retains synchronous receiver evidence without waiting for HTTP", () => {
    const journal = createFixtureKeyboardJournal();
    journal.record("consumer-keydown", { ...details, consumerPressedCodes: ["KeyT"] });
    const held = journal.snapshot();
    journal.record("consumer-keyup", { ...details, consumerPressedCodes: [] });
    expect(held.events.at(-1)?.consumerPressedCodes).toEqual(["KeyT"]);
    expect(journal.snapshot().events).toEqual([
      { ...details, kind: "consumer-keydown", consumerPressedCodes: ["KeyT"], sequence: 1 },
      { ...details, kind: "consumer-keyup", consumerPressedCodes: [], sequence: 2 }
    ]);
  });
  it("bounds evidence and explicitly reports truncation", () => {
    const journal = createFixtureKeyboardJournal();
    for (let n = 0; n < 257; n++) journal.record("keydown", details);
    expect(journal.snapshot()).toMatchObject({ dropped: 1 });
    expect(journal.snapshot().events).toHaveLength(256);
    expect(journal.snapshot().events[0]?.sequence).toBe(2);
  });
});
