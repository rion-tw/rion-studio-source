import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopE2eUserDataDir,
  resolveDesktopE2eUserDataLayout
} from "../scripts/desktopE2eUserDataPaths.mjs";

describe("desktop E2E user-data paths", () => {
  const artifactBase = resolve(".desktop-e2e-artifacts");
  const artifactRoot = resolve(artifactBase, "2026-09-12T03-50-09-675Z-win32");

  it("keeps default Windows runtime profiles in a preserved short artifact path", () => {
    const layout = resolveDesktopE2eUserDataLayout({
      artifactBase,
      artifactRoot,
      configuredRoot: undefined,
      platform: "win32",
      runId: "2026-09-12T03-50-09-675Z"
    });
    const directory = desktopE2eUserDataDir(
      layout,
      "chromium-role-session-recovery"
    );

    expect(layout.compactWindowsLayout).toBe(true);
    expect(layout.userDataRoot.startsWith(artifactBase)).toBe(true);
    expect(layout.userDataRoot).toMatch(/[\\/]\.u-[0-9a-f]{12}$/u);
    expect(directory).toMatch(/[\\/][0-9a-f]{12}$/u);
    expect(directory.length).toBeLessThan(
      resolve(artifactRoot, "user-data", "chromium-role-session-recovery").length
    );
  });

  it("preserves explicit roots and readable namespaces on every platform", () => {
    const configuredRoot = resolve("configured-e2e-user-data");
    const layout = resolveDesktopE2eUserDataLayout({
      artifactBase,
      artifactRoot,
      configuredRoot,
      platform: "win32",
      runId: "ignored"
    });

    expect(layout).toEqual({
      compactWindowsLayout: false,
      userDataRoot: configuredRoot
    });
    expect(desktopE2eUserDataDir(layout, "readable-lifecycle")).toBe(
      resolve(configuredRoot, "readable-lifecycle")
    );
  });
});
