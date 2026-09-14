import { describe, expect, it } from "vitest";

import { parseCoreEvents } from "../src/electron/core/coreEventValidation";
import type { LogSource } from "../src/shared/generated";

const LOG_SOURCES = [
  "main",
  "preload",
  "renderer",
  "ipc",
  "browser",
  "extension",
  "macro",
  "persistence",
  "update"
] as const satisfies readonly LogSource[];
const LOG_SOURCES_ARE_EXHAUSTIVE: Exclude<LogSource, typeof LOG_SOURCES[number]> extends never
  ? true
  : never = true;

const extensionPackage = {
  id: "a".repeat(32),
  name: "Fixture",
  version: "1.0",
  permissions: ["storage"],
  sha256: "0".repeat(64),
  directory: "/managed/extensions/fixture",
  enabledRoleIds: ["role-a"],
  applyToAllRoles: false,
  removed: false
};

function extensionsChanged(packageRecord: Record<string, unknown>): string {
  return JSON.stringify([{
    type: "extensionsChanged",
    snapshot: {
      revision: 4,
      installed: [packageRecord],
      roles: []
    }
  }]);
}

describe("Core extension event validation", () => {
  it("accepts captured entries from every shared log source", () => {
    expect(LOG_SOURCES_ARE_EXHAUSTIVE).toBe(true);
    for (const source of LOG_SOURCES) {
      expect(() => parseCoreEvents(JSON.stringify([{
        type: "logEntriesCaptured",
        entries: [{
          id: `log-${source}`,
          timestamp: "2026-09-13T20:02:16.042Z",
          level: "debug",
          source,
          event: "diagnostic",
          message: "captured",
          sessionId: "session-1"
        }]
      }]))).not.toThrow();
    }
  });

  it("accepts backward-compatible display metadata", () => {
    const parsed = parseCoreEvents(extensionsChanged({
      ...extensionPackage,
      description: "A fixture extension.",
      iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      sizeBytes: 2_048
    }));

    expect(parsed).toHaveLength(1);
  });

  it("accepts legacy package records without display metadata", () => {
    expect(() => parseCoreEvents(extensionsChanged(extensionPackage))).not.toThrow();
  });

  it("rejects invalid metadata and unknown package fields", () => {
    expect(() => parseCoreEvents(extensionsChanged({ ...extensionPackage, sizeBytes: -1 })))
      .toThrow("The Core event batch is invalid.");
    expect(() => parseCoreEvents(extensionsChanged({ ...extensionPackage, unexpected: true })))
      .toThrow("The Core event batch is invalid.");
  });

  it("accepts classified permissions without conflating absent and empty metadata", () => {
    for (const requiredApiPermissions of [[], ["storage"]]) {
      expect(() => parseCoreEvents(extensionsChanged({ ...extensionPackage, requiredApiPermissions })))
        .not.toThrow();
    }
    for (const requiredApiPermissions of [null, "storage", [1]]) {
      expect(() => parseCoreEvents(extensionsChanged({ ...extensionPackage, requiredApiPermissions })))
        .toThrow("The Core event batch is invalid.");
    }
  });
});

describe("Core browser-action event validation", () => {
  const neutralizeInput = {
    type: "browserActions",
    actions: [{
      requestId: "recovery-request",
      roleId: "role-a",
      origin: "macro",
      inputEpoch: 4,
      intent: "cleanup",
      scheduledAtMs: 100,
      deadlineMs: 10_000,
      action: { type: "neutralizeInput" }
    }]
  };

  it("accepts the Core-issued neutralization recovery action", () => {
    expect(parseCoreEvents(JSON.stringify([neutralizeInput]))).toEqual([neutralizeInput]);
  });

  it("rejects unknown neutralization fields with bounded action diagnostics", () => {
    const malformed = {
      ...neutralizeInput,
      actions: [{
        ...neutralizeInput.actions[0],
        action: { type: "neutralizeInput", unexpected: true }
      }]
    };
    expect(() => parseCoreEvents(JSON.stringify([malformed]))).toThrow(
      "The Core event batch is invalid. eventIndex=0 eventType=browserActions " +
      "actionType=neutralizeInput"
    );
  });
});
