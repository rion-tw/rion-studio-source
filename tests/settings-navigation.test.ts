import { describe, expect, it } from "vitest";

import {
  readSettingsReturnTo,
  readSettingsSection,
  settingsSectionQueryValues
} from "../src/renderer/src/features/settings/settingsNavigation";

describe("settings navigation", () => {
  it("normalizes section query values", () => {
    expect(readSettingsSection("preferences")).toBe("preferences");
    expect(readSettingsSection("interface")).toBe("interface");
    expect(readSettingsSection("macros")).toBe("macros");
    expect(readSettingsSection("data")).toBe("data");
    expect(readSettingsSection("updates")).toBe("updates");
    expect(readSettingsSection("about-legal")).toBe("aboutLegal");
    expect(readSettingsSection("network")).toBe("preferences");
    expect(readSettingsSection("unknown")).toBe("preferences");
    expect(readSettingsSection(null)).toBe("preferences");
  });

  it("keeps existing deep links stable while adding preferences", () => {
    expect(settingsSectionQueryValues).toMatchObject({
      data: "data",
      interface: "interface",
      preferences: "preferences"
    });
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
