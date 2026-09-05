import { describe, expect, it } from "vitest";

import {
  assertElectronRuntimeProbe,
  EXPECTED_APPKIT_RUNTIME_ABI,
  EXPECTED_ELECTRON_RUNTIME
} from "../scripts/verifyElectronRuntime.mjs";
import { RION_APPKIT_RUNTIME_ABI_VERSION } from
  "../src/electron/main/macosAppKitRuntimeHostFactory";

const validProbe = {
  ...EXPECTED_ELECTRON_RUNTIME,
  arch: process.arch,
  appKitRuntimeAbi: process.platform === "darwin" ? EXPECTED_APPKIT_RUNTIME_ABI : 0,
  core: "0.1.0",
  modules: "148",
  napi: "10",
  platform: process.platform
};

describe("Electron runtime verifier", () => {
  it("pins the Electron, Chromium, and embedded Node versions", () => {
    expect(EXPECTED_APPKIT_RUNTIME_ABI).toBe(6);
    expect(EXPECTED_APPKIT_RUNTIME_ABI).toBe(RION_APPKIT_RUNTIME_ABI_VERSION);
    expect(() => assertElectronRuntimeProbe(
      validProbe,
      EXPECTED_ELECTRON_RUNTIME.electron
    )).not.toThrow();
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, core: "23.4.5" },
      EXPECTED_ELECTRON_RUNTIME.electron,
      "23.4.5"
    )).not.toThrow();
  });

  it.each(["electron", "chrome", "node", "modules", "napi"] as const)(
    "rejects a mismatched %s runtime",
    (name) => {
      expect(() => assertElectronRuntimeProbe(
        { ...validProbe, [name]: "0.0.0" },
        EXPECTED_ELECTRON_RUNTIME.electron
      )).toThrow(`${name} mismatch`);
    }
  );

  it("rejects package, Core, ABI, and target drift", () => {
    expect(() => assertElectronRuntimeProbe(validProbe, "0.0.0"))
      .toThrow("package.json Electron pin mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, core: "0.0.0" },
      EXPECTED_ELECTRON_RUNTIME.electron
    )).toThrow("Rust Core version mismatch");
    expect(() => assertElectronRuntimeProbe(
      validProbe,
      EXPECTED_ELECTRON_RUNTIME.electron,
      "23.4.5"
    )).toThrow("expected 23.4.5");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, appKitRuntimeAbi: 99 },
      EXPECTED_ELECTRON_RUNTIME.electron
    )).toThrow("AppKit runtime ABI mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, napi: undefined },
      EXPECTED_ELECTRON_RUNTIME.electron
    )).toThrow("napi mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, arch: "mismatch" },
      EXPECTED_ELECTRON_RUNTIME.electron
    )).toThrow("target mismatch");
  });

  it.runIf(process.platform === "darwin")(
    "rejects an addon built against retired AppKit runtime ABI 1",
    () => {
      expect(() => assertElectronRuntimeProbe(
        { ...validProbe, appKitRuntimeAbi: 1 },
        EXPECTED_ELECTRON_RUNTIME.electron
      )).toThrow(
        `AppKit runtime ABI mismatch: expected ${EXPECTED_APPKIT_RUNTIME_ABI}, received 1`
      );
    }
  );
});
