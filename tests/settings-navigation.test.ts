import { describe, expect, it } from "vitest";

import { readSettingsReturnTo, readSettingsSection } from "../src/renderer/src/features/settings/settingsNavigation";

describe("settings navigation", () => {
  it("normalizes section query values", () => {
    expect(readSettingsSection("interface")).toBe("interface");
    expect(readSettingsSection("macros")).toBe("macros");
    expect(readSettingsSection("data")).toBe("data");
    expect(readSettingsSection("updates")).toBe("updates");
    expect(readSettingsSection("about-legal")).toBe("aboutLegal");
    expect(readSettingsSection("unknown")).toBe("interface");
    expect(readSettingsSection(null)).toBe("interface");
  });

  it("returns to a valid application route", () => {
    expect(readSettingsReturnTo({ returnTo: "/macros?filter=running" })).toBe("/macros?filter=running");
    expect(readSettingsReturnTo({ returnTo: "/roles/role-1/edit" })).toBe("/roles");
    expect(readSettingsReturnTo({ returnTo: "/workspaces/new" })).toBe("/workspaces");
    expect(readSettingsReturnTo({ returnTo: "/settings?section=updates" })).toBe("/dashboard");
    expect(readSettingsReturnTo({ returnTo: "https://example.com" })).toBe("/dashboard");
    expect(readSettingsReturnTo(null)).toBe("/dashboard");
  });
});
