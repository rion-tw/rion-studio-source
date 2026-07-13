import { describe, expect, it } from "vitest";

import { readSettingsReturnTo, readSettingsSection } from "../src/renderer/src/features/settings/settingsNavigation";

describe("settings navigation", () => {
  it("normalizes section query values", () => {
    expect(readSettingsSection("interface")).toBe("interface");
    expect(readSettingsSection("game")).toBe("game");
    expect(readSettingsSection("data")).toBe("data");
    expect(readSettingsSection("updates")).toBe("updates");
    expect(readSettingsSection("unknown")).toBe("interface");
    expect(readSettingsSection(null)).toBe("interface");
  });

  it("normalizes legacy section query values", () => {
    expect(readSettingsSection("appearance")).toBe("interface");
    expect(readSettingsSection("preferences")).toBe("interface");
    expect(readSettingsSection("role-defaults")).toBe("game");
    expect(readSettingsSection("portability")).toBe("data");
  });

  it("returns to a valid application route", () => {
    expect(readSettingsReturnTo({ returnTo: "/macros?filter=running" })).toBe("/macros?filter=running");
    expect(readSettingsReturnTo({ returnTo: "/settings?section=updates" })).toBe("/dashboard");
    expect(readSettingsReturnTo({ returnTo: "https://example.com" })).toBe("/dashboard");
    expect(readSettingsReturnTo(null)).toBe("/dashboard");
  });
});
