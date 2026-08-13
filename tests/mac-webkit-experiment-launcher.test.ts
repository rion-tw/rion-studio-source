import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAC_WEBKIT_EXPERIMENT_MODES,
  macWebKitExperimentExecutableEnvironment,
  macWebKitExperimentEnvironment,
  parseMacWebKitExperimentArguments
} from "../scripts/runMacWebKitExperiment.mjs";

describe("macOS WKWebView experiment launcher", () => {
  it("keeps system experiments isolated without inheriting an STP framework", () => {
    const options = parseMacWebKitExperimentArguments(
      ["--mode=system-direct", "--sample-ms=10000"],
      { cwd: "/workspace", platform: "darwin" }
    );
    const environment = macWebKitExperimentEnvironment(options, {
      DYLD_FRAMEWORK_PATH: "/unexpected"
    });
    expect(options.dataDir).toBe(path.resolve("/workspace/target/rion-webkit-experiment-data"));
    expect(environment.DYLD_FRAMEWORK_PATH).toBeUndefined();
    expect(environment.RION_WEBKIT_EXPERIMENT_ISOLATED).toBe("1");
    expect(environment.RION_WEBKIT_EXPERIMENT_MODE).toBe("system-direct");
  });

  it("derives the STP framework path and bounds diagnostic duration", () => {
    const options = parseMacWebKitExperimentArguments([
      "--mode=stp-gpu-process-dom-rendering",
      "--sample-ms=600000",
      "--stp-app=/Applications/Safari Technology Preview.app"
    ], { platform: "darwin" });
    expect(options.stpFrameworkPath).toBe(
      "/Applications/Safari Technology Preview.app/Contents/Frameworks"
    );
    expect(macWebKitExperimentEnvironment(options).DYLD_FRAMEWORK_PATH)
      .toBe(options.stpFrameworkPath);
    expect(() => parseMacWebKitExperimentArguments(
      ["--mode=stp-direct", "--sample-ms=600001", "--stp-app=/tmp/STP.app"],
      { platform: "darwin" }
    )).toThrow("between 1500 and 600000");
  });

  it("rejects STP modes without an explicit app and non-macOS hosts", () => {
    expect(() => parseMacWebKitExperimentArguments(
      ["--mode=stp-gpu-process"],
      { platform: "darwin" }
    )).toThrow("require --stp-app");
    expect(() => parseMacWebKitExperimentArguments(
      ["--mode=system-gpu-process"],
      { platform: "win32" }
    )).toThrow("requires macOS");
  });

  it("orders the six-cell matrix and keeps system cells on system WebKit", () => {
    const options = parseMacWebKitExperimentArguments([
      "--mode=matrix",
      "--stp-app=/Applications/Safari Technology Preview.app"
    ], { platform: "darwin" });
    expect(options.modes).toEqual(MAC_WEBKIT_EXPERIMENT_MODES);
    const systemEnvironment = macWebKitExperimentEnvironment({
      ...options,
      mode: options.modes[0]
    }, { DYLD_FRAMEWORK_PATH: "/unexpected" });
    expect(systemEnvironment.DYLD_FRAMEWORK_PATH).toBeUndefined();
    const stpEnvironment = macWebKitExperimentEnvironment({
      ...options,
      mode: options.modes[2]
    });
    expect(stpEnvironment.DYLD_FRAMEWORK_PATH).toBe(options.stpFrameworkPath);
  });

  it("restores the STP framework override at the final executable boundary", () => {
    const environment = macWebKitExperimentExecutableEnvironment({
      DYLD_FRAMEWORK_PATH: "/stripped-or-stale",
      RION_WEBKIT_EXPERIMENT_ISOLATED: "1",
      RION_WEBKIT_EXPERIMENT_MODE: "stp-gpu-process",
      RION_WEBKIT_EXPERIMENT_STP_APP: "/Applications/Safari Technology Preview.app"
    });
    expect(environment.DYLD_FRAMEWORK_PATH).toBe(
      "/Applications/Safari Technology Preview.app/Contents/Frameworks"
    );

    const systemEnvironment = macWebKitExperimentExecutableEnvironment({
      DYLD_FRAMEWORK_PATH: "/unexpected",
      RION_WEBKIT_EXPERIMENT_ISOLATED: "1",
      RION_WEBKIT_EXPERIMENT_MODE: "system-gpu-process"
    });
    expect(systemEnvironment.DYLD_FRAMEWORK_PATH).toBeUndefined();
    expect(() => macWebKitExperimentExecutableEnvironment({
      RION_WEBKIT_EXPERIMENT_ISOLATED: "1",
      RION_WEBKIT_EXPERIMENT_MODE: "stp-direct"
    })).toThrow("requires an absolute");
  });
});
