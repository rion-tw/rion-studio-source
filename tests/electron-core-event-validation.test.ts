import { describe, expect, it } from "vitest";

import { parseCoreEvents } from "../src/electron/core/coreEventValidation";

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
});
