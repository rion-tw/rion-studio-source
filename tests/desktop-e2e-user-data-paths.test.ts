import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopE2eUserDataDir,
  resolveDesktopE2eUserDataLayout
} from "../scripts/desktopE2eUserDataPaths.mjs";

describe("desktop E2E user-data paths", () => {
  const artifactBase = resolve("/checkout/.desktop-e2e-artifacts");
  const artifactRoot = resolve(artifactBase, "2026-09-12T03-50-09-675Z-win32");
  const runId = "2026-09-12T03-50-09-675Z";
  const temporaryBase = resolve("/temporary");

  it("keeps default Windows runtime profiles in a preserved short artifact path", () => {
    const layout = resolveDesktopE2eUserDataLayout({
      artifactBase,
      artifactRoot,
      configuredRoot: undefined,
      platform: "win32",
      runId,
      temporaryBase
    });
    const directory = desktopE2eUserDataDir(
      layout,
      "chromium-role-session-recovery"
    );

    expect(layout.compactWindowsLayout).toBe(true);
    expect(layout.outsideArtifactBase).toBe(false);
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
      runId: "ignored",
      temporaryBase
    });

    expect(layout).toEqual({
      compactWindowsLayout: false,
      outsideArtifactBase: false,
      userDataRoot: configuredRoot
    });
    expect(desktopE2eUserDataDir(layout, "readable-lifecycle")).toBe(
      resolve(configuredRoot, "readable-lifecycle")
    );
  });

  // A deep checkout — a git worktree costs roughly 45 characters over a plain
  // clone — leaves too little of Windows' 260-character budget for Chromium's
  // own files. The overflow is silent: an extension's settings store keeps the
  // short names (LOCK, LOG) and loses MANIFEST-000001, so chrome.storage fails
  // to open for every extension in the run.
  it("moves Windows runtime profiles out of a checkout too deep for MAX_PATH", () => {
    const deepBase = resolve(
      `/checkout/${"deep-worktree-segment".padEnd(90, "x")}/.desktop-e2e-artifacts`
    );
    const layout = resolveDesktopE2eUserDataLayout({
      artifactBase: deepBase,
      artifactRoot: resolve(deepBase, "2026-09-12T03-50-09-675Z-win32"),
      configuredRoot: undefined,
      platform: "win32",
      runId,
      temporaryBase
    });

    expect(layout.compactWindowsLayout).toBe(true);
    expect(layout.outsideArtifactBase).toBe(true);
    expect(layout.userDataRoot.startsWith(deepBase)).toBe(false);
    expect(layout.userDataRoot).toBe(
      resolve(temporaryBase, "rion-e2e", layout.userDataRoot.split(/[\\/]/u).at(-1)!)
    );

    // The deepest path Chromium has to create below a phase directory is an
    // extension's settings store, at 146 characters.
    const phaseDirectory = desktopE2eUserDataDir(layout, "chromium-extensions-context-menu");
    expect(phaseDirectory.length + 146).toBeLessThanOrEqual(260);
  });

  it("does not relocate a deep checkout on macOS, which has no MAX_PATH", () => {
    const deepBase = resolve(
      `/checkout/${"deep-worktree-segment".padEnd(90, "x")}/.desktop-e2e-artifacts`
    );
    const artifactRootForBase = resolve(deepBase, "2026-09-12T03-50-09-675Z-darwin");
    const layout = resolveDesktopE2eUserDataLayout({
      artifactBase: deepBase,
      artifactRoot: artifactRootForBase,
      configuredRoot: undefined,
      platform: "darwin",
      runId,
      temporaryBase
    });

    expect(layout).toEqual({
      compactWindowsLayout: false,
      outsideArtifactBase: false,
      userDataRoot: resolve(artifactRootForBase, "user-data")
    });
  });
});
