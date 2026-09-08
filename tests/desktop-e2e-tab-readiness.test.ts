import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop E2E restored tab readiness", () => {
  it("preserves exact fixture evidence when an event deadline aborts", async () => {
    const source = await readFile(
      new URL("../e2e/desktop/support/fixture.ts", import.meta.url),
      "utf8"
    );
    const wait = source.slice(
      source.indexOf("export async function waitFixtureEvent("),
      source.indexOf("export async function fixtureEvents(")
    );

    expect(wait).toContain("events: events.slice(-24)");
    expect(wait).toContain("roleState: input.roleId ? state[input.roleId] ?? null : null");
    expect(wait).toContain("Fixture event wait aborted");
    expect(wait).toContain("{ cause: error }");
    expect(wait).not.toContain("return ((await response.json()) as { event: FixtureEvent }).event;\n  } catch");
  });

});
