import { describe, expect, it } from "vitest";

import { assertElectronPackageBuildTarget } from "../scripts/verifyElectronPackageBuildTarget.mjs";

describe("native Electron distribution build target", () => {
  it.each([["darwin", "arm64"], ["win32", "x64"]])("accepts the published %s-%s target", (platform, architecture) => {
    expect(() => assertElectronPackageBuildTarget(platform, architecture)).not.toThrow();
  });

  it.each([["darwin", "x64"], ["win32", "arm64"], ["linux", "x64"]])("rejects %s-%s before an unrelated addon can be packaged", (platform, architecture) => {
    expect(() => assertElectronPackageBuildTarget(platform, architecture)).toThrow("matching build runtime");
  });
});
