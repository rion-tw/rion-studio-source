import { describe, expect, it } from "vitest";

import { readSettingsReturnTo, readSettingsSection } from "../src/renderer/src/features/settings/settingsNavigation";

describe("settings navigation", () => {
  it("normalizes section query values", () => {
    expect(readSettingsSection("preferences")).toBe("preferences");
    expect(readSettingsSection("updates")).toBe("updates");
    expect(readSettingsSection("unknown")).toBe("appearance");
    expect(readSettingsSection(null)).toBe("appearance");
  });

  it("returns to a valid application route", () => {
    expect(readSettingsReturnTo({ returnTo: "/macros?filter=running" })).toBe("/macros?filter=running");
    expect(readSettingsReturnTo({ returnTo: "/settings?section=updates" })).toBe("/roles");
    expect(readSettingsReturnTo({ returnTo: "https://example.com" })).toBe("/roles");
    expect(readSettingsReturnTo(null)).toBe("/roles");
  });
});
