import { describe, expect, it } from "vitest";

import { detachTerminatedWebDriverSession } from "./session";

describe("desktop E2E WebDriver session lifecycle", () => {
  it("detaches a session only after the application process has terminalized", () => {
    const session = { sessionId: "session-1", retainedEvidence: true };
    const registry = new Map([["browser", session]]);

    detachTerminatedWebDriverSession(registry);

    expect(session.sessionId).toBeUndefined();
    expect(session.retainedEvidence).toBe(true);
  });

  it("fails closed when the runner browser object is unavailable", () => {
    expect(() => detachTerminatedWebDriverSession(new Map())).toThrow(
      "WDIO browser session is unavailable"
    );
  });
});
