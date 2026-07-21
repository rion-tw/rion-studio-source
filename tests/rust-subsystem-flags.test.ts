import { describe, expect, it } from "vitest";

import { isRustSubsystemEnabled } from "../src/main/core/subsystemFlags";

describe("Rust subsystem fallback flags", () => {
  it("enables Rust subsystems by default", () => {
    expect(isRustSubsystemEnabled("external-chrome", {})).toBe(true);
  });

  it("can fall back one subsystem without changing SQLite ownership", () => {
    const environment = {
      RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS: "cdn, external-chrome"
    };
    expect(isRustSubsystemEnabled("cdn", environment)).toBe(false);
    expect(isRustSubsystemEnabled("external-chrome", environment)).toBe(false);
    expect(isRustSubsystemEnabled("macro-timing", environment)).toBe(true);
  });

  it("supports a one-release emergency fallback for every optional subsystem", () => {
    expect(isRustSubsystemEnabled("pressure", {
      RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS: "all"
    })).toBe(false);
  });
});
