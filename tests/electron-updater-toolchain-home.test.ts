import { describe, expect, it } from "vitest";
import { macosUpdaterProbeToolchainHomes } from "../scripts/runElectronUpdaterTransactionProbe.mjs";
import { createUpdaterProbeRuntimeEnvironment } from "../scripts/runtimeEnvironmentPolicy.mjs";

describe("macOS updater probe build homes", () => {
  it("keeps offline caches while the application home remains isolated", () => {
    const source = { HOME: "/Users/runner", PATH: "/usr/bin", TAURI_SIGNING_PRIVATE_KEY: "fixture-secret" };
    const environment = createUpdaterProbeRuntimeEnvironment({
      ...source,
      ...macosUpdaterProbeToolchainHomes(source, "/Users/fallback"),
      HOME: "/fixtures/runtime-home",
      CFFIXED_USER_HOME: "/fixtures/runtime-home"
    });
    expect(environment.HOME).toBe("/fixtures/runtime-home");
    expect(environment.CFFIXED_USER_HOME).toBe("/fixtures/runtime-home");
    expect(environment.CARGO_HOME).toBe("/Users/runner/.cargo");
    expect(environment.RUSTUP_HOME).toBe("/Users/runner/.rustup");
    expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(source.HOME).toBe("/Users/runner");
  });

  it("preserves explicit toolchain homes and resolves absent HOME before isolation", () => {
    expect(macosUpdaterProbeToolchainHomes({ CARGO_HOME: "/cache/cargo", RUSTUP_HOME: "/cache/rustup" }, "/Users/runner"))
      .toEqual({ CARGO_HOME: "/cache/cargo", RUSTUP_HOME: "/cache/rustup" });
    expect(macosUpdaterProbeToolchainHomes({}, "/Users/runner"))
      .toEqual({ CARGO_HOME: "/Users/runner/.cargo", RUSTUP_HOME: "/Users/runner/.rustup" });
  });

  it.each(["relative", String.raw`C:\Users\runner`, String.raw`\Users\runner`])(
    "rejects a source home outside absolute macOS paths: %s", sourceHome => {
      expect(() => macosUpdaterProbeToolchainHomes({ HOME: sourceHome }, "/Users/runner"))
        .toThrow("absolute source home");
    }
  );
});
