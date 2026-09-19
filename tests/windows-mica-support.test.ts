import { describe, expect, it } from "vitest";

import { windowsMicaSupported } from "../src/electron/main/windowsMicaSupport";

describe("Windows Mica capability", () => {
  it("accepts Windows 11 22H2 and newer", () => {
    expect(windowsMicaSupported("win32", "10.0.22621")).toBe(true);
    expect(windowsMicaSupported("win32", "10.0.26200")).toBe(true);
  });

  it("rejects builds before the Mica backdrop existed", () => {
    expect(windowsMicaSupported("win32", "10.0.22620")).toBe(false);
    expect(windowsMicaSupported("win32", "10.0.19045")).toBe(false);
  });

  it("treats an unreadable release as unsupported", () => {
    expect(windowsMicaSupported("win32", "")).toBe(false);
    expect(windowsMicaSupported("win32", "10.0")).toBe(false);
    expect(windowsMicaSupported("win32", "not-a-release")).toBe(false);
  });

  it("never requests a Windows backdrop on macOS", () => {
    expect(windowsMicaSupported("darwin", "10.0.26200")).toBe(false);
  });
});
