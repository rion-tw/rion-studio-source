import { describe, expect, it } from "vitest";

import { detachTerminatedWebDriverSession } from "./session";

describe("desktop E2E WebDriver session lifecycle", () => {
  it("detaches a session only after the application process has terminalized", () => {
    const session = { sessionId: "session-1", retainedEvidence: true };

    detachTerminatedWebDriverSession(session);

    expect(session.sessionId).toBeUndefined();
    expect(session.retainedEvidence).toBe(true);
  });
});
