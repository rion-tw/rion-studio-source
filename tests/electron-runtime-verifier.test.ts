import { describe, expect, it } from "vitest";

import {
  assertElectronRuntimeProbe,
  EXPECTED_APPKIT_RUNTIME_ABI,
  EXPECTED_ECS_PROTOTYPE_RUNTIME,
  EXPECTED_PACKAGE_ELECTRON_SPEC,
  EXPECTED_ELECTRON_RUNTIME
} from "../scripts/verifyElectronRuntime.mjs";
import { RION_APPKIT_RUNTIME_ABI_VERSION } from
  "../src/electron/main/macosAppKitRuntimeHostFactory";

const validProbe = {
  ...EXPECTED_ELECTRON_RUNTIME,
  arch: process.arch,
  appKitRuntimeAbi: process.platform === "darwin" ? EXPECTED_APPKIT_RUNTIME_ABI : 0,
  core: "0.1.0",
  cdmComponentApi: false,
  modules: "149",
  napi: "10",
  platform: process.platform
};

describe("Electron runtime verifier", () => {
  it("pins the Electron, Chromium, and embedded Node versions", () => {
    expect(EXPECTED_APPKIT_RUNTIME_ABI).toBe(11);
    expect(EXPECTED_APPKIT_RUNTIME_ABI).toBe(RION_APPKIT_RUNTIME_ABI_VERSION);
    expect(() => assertElectronRuntimeProbe(
      validProbe,
      EXPECTED_PACKAGE_ELECTRON_SPEC
    )).not.toThrow();
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, core: "23.4.5" },
      EXPECTED_PACKAGE_ELECTRON_SPEC,
      "23.4.5"
    )).not.toThrow();
  });

  it.each(["electron", "chrome", "node", "modules", "napi"] as const)(
    "rejects a mismatched %s runtime",
    (name) => {
      expect(() => assertElectronRuntimeProbe(
        { ...validProbe, [name]: "0.0.0" },
        EXPECTED_PACKAGE_ELECTRON_SPEC
      )).toThrow(`${name} mismatch`);
    }
  );

  it("rejects package, Core, ABI, and target drift", () => {
    expect(() => assertElectronRuntimeProbe(validProbe, "0.0.0"))
      .toThrow("package.json Electron pin mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, core: "0.0.0" },
      EXPECTED_PACKAGE_ELECTRON_SPEC
    )).toThrow("Rust Core version mismatch");
    expect(() => assertElectronRuntimeProbe(
      validProbe,
      EXPECTED_PACKAGE_ELECTRON_SPEC,
      "23.4.5"
    )).toThrow("expected 23.4.5");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, appKitRuntimeAbi: 99 },
      EXPECTED_PACKAGE_ELECTRON_SPEC
    )).toThrow("AppKit runtime ABI mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, napi: undefined },
      EXPECTED_PACKAGE_ELECTRON_SPEC
    )).toThrow("napi mismatch");
    expect(() => assertElectronRuntimeProbe(
      { ...validProbe, arch: "mismatch" },
      EXPECTED_PACKAGE_ELECTRON_SPEC
    )).toThrow("target mismatch");
  });

  it("requires a working CDM API only in the isolated ECS distribution", () => {
    const ecs = { ...validProbe, ...EXPECTED_ECS_PROTOTYPE_RUNTIME, cdmComponentApi: true };
    expect(() => assertElectronRuntimeProbe(ecs, EXPECTED_PACKAGE_ELECTRON_SPEC,
      "0.1.0", "ecs-prototype")).not.toThrow();
    expect(() => assertElectronRuntimeProbe({ ...ecs, cdmComponentApi: false },
      EXPECTED_PACKAGE_ELECTRON_SPEC, "0.1.0", "ecs-prototype"))
      .toThrow("Widevine component API is unavailable");
    expect(() => assertElectronRuntimeProbe(ecs, EXPECTED_PACKAGE_ELECTRON_SPEC))
      .toThrow("chrome mismatch");
  });

  it.runIf(process.platform === "darwin")(
    "rejects an addon built against retired AppKit runtime ABI 1",
    () => {
      expect(() => assertElectronRuntimeProbe(
        { ...validProbe, appKitRuntimeAbi: 1 },
        EXPECTED_PACKAGE_ELECTRON_SPEC
      )).toThrow(
        `AppKit runtime ABI mismatch: expected ${EXPECTED_APPKIT_RUNTIME_ABI}, received 1`
      );
    }
  );
});
