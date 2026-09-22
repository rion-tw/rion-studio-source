import { $, browser, expect } from "@wdio/globals";
import { readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { electronDesktopE2eWorkspaceWebSecurityPolicy } from "./electron-driver";
import { withRolePageTarget } from "./electron-role-surface";
import { rendererCall } from "./renderer-bridge";
import { runtimeTabShellErrors } from "./native-runtime-tabs";

/** Optional network-dependent diagnosis; no product API or policy override. */
export async function diagnoseWorkspaceWebDrm(input: {
  chromeShellUrl: string; mainWindowHandle: string; windowId: string; roleIds: readonly string[];
}): Promise<void> {
  const url = "https://rion-drm.fixture.test/drm-capabilities";
  const before = await electronDesktopE2eWorkspaceWebSecurityPolicy(input.windowId);
  const baselineErrors = await runtimeTabShellErrors();
  let capability: { trustedClick: boolean; secureContext: boolean; nextStage: string } | undefined;
  let playback: { state: string; trustedClick: boolean; audioTrack: boolean; vmpUatStatus: string | null } | undefined;
  await withRolePageTarget(url, input.mainWindowHandle, async () => {
    await $("#run-drm-probe").click();
    await browser.waitUntil(async () => (await $("#drm-result").getAttribute("data-state")) === "complete",
      { timeout: 60_000, timeoutMsg: "DRM probe did not complete; elapsed time is not capability evidence" });
    capability = JSON.parse(await $("#drm-result").getText());
    if (process.env.RION_STUDIO_E2E_DRM_PLAYBACK === "1" && await $("#run-drm-playback").isEnabled()) {
      await $("#run-drm-playback").click();
      await browser.waitUntil(async () => (await $("#drm-playback-result").getAttribute("data-state")) === "complete",
        { timeout: 90_000, timeoutMsg: "No terminal encrypted playback evidence; elapsed time is not success" });
      playback = JSON.parse(await $("#drm-playback-result").getText());
    }
  });
  const runtime = await browser.electron.execute((electron, expectedUrl) => {
    const contents = electron.webContents.getAllWebContents().filter(wc => wc.getURL() === expectedUrl);
    if (contents.length !== 1) throw new Error("DRM evidence requires the exact Workspace Web surface");
    return { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, packaged: electron.app.isPackaged,
      executable: electron.app.getPath("exe"), userData: electron.app.getPath("userData"),
      sessionStoragePath: contents[0].session.storagePath,
      switches: process.argv.filter(arg => /^--[a-zA-Z0-9-]+(?:=|$)/.test(arg)).map(arg => arg.split("=")[0]),
      cdmSwitches: ["widevine-cdm-path", "widevine-cdm-version", "disable-component-update", "no-sandbox"]
        .map(name => ({ name, present: electron.app.commandLine.hasSwitch(name) })) };
  }, url);
  const policy = await electronDesktopE2eWorkspaceWebSecurityPolicy(input.windowId);
  const decisions = policy.observations.filter(entry => entry.kind === "drm-permission")
    .filter(entry => entry.sequence > (before.observations.at(-1)?.sequence ?? 0));
  // Walk only this launched binary's distribution, never an installed browser or
  // a user profile. Missing named artifacts is not proof of compiled CDM support.
  const bundleRoot = runtime.platform === "darwin" ? dirname(dirname(runtime.executable)) : dirname(runtime.executable);
  const components: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/widevine|clearkey|ffmpeg/i.test(entry.name)) components.push(entry.name);
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  };
  await visit(bundleRoot);
  const statuses = await rendererCall("listRoleStatuses");
  const rolesRunning = input.roleIds.every(id => statuses.find(status => status.roleId === id)?.state === "running");
  const shellErrorsUnchanged = JSON.stringify(await runtimeTabShellErrors()) === JSON.stringify(baselineErrors);
  const { executable: _executable, userData: _userData, sessionStoragePath: _sessionStoragePath, ...safeRuntime } = runtime;
  const report = { schemaVersion: 1, phase: process.env.RION_STUDIO_E2E_PHASE,
    runtime: safeRuntime, components: [...new Set(components)].sort(),
    componentScope: "launched-distribution-filenames-only; compiled-or-dynamic-CDM-not-proven",
    session: { exactGlobalWebStore: runtime.sessionStoragePath === policy.contentProfilePath,
      isolatedUserData: resolve(runtime.userData) === resolve(process.env.RION_STUDIO_E2E_CHROMIUM_USER_DATA_DIR ??
        process.env.RION_STUDIO_USER_DATA_DIR!),
      policyVersion: policy.policyVersion },
    permission: { callbacks: decisions.map(entry => ({ allowed: entry.allowed, reason: entry.reason })),
      interpretation: decisions.length ? "callback-observed" : "no-callback-observed" },
    capability, playback: playback ?? { state: "not-attempted" }, twoRolesRunning: rolesRunning, shellErrorsUnchanged,
    transport: "reserved-HTTPS-origin-over-E2E-local-transport; public-manifest-over-real-HTTPS",
    acceptance: { netflixTwoMinutes: "not-tested", audibleAudio: "not-tested", resolution: null,
      playerControls: "not-tested", productionPackage: "not-tested" } };
  await writeFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "workspace-web-drm-capability.json"),
    `${JSON.stringify(report, null, 2)}\n`);
  expect(capability?.trustedClick).toBe(true);
  expect(capability?.secureContext).toBe(true);
  expect(report.session.exactGlobalWebStore).toBe(true);
  expect(report.session.isolatedUserData).toBe(true);
  for (const decision of decisions) expect(decision.allowed).toBe(true);
  expect(rolesRunning).toBe(true);
  expect(shellErrorsUnchanged).toBe(true);
  if (process.env.RION_STUDIO_E2E_DRM_PLAYBACK === "1") {
    expect(playback?.trustedClick).toBe(true);
    expect(playback?.state).toBe("played");
    expect(playback?.audioTrack).toBe(true);
    expect(["PLATFORM_SOFTWARE_VERIFIED", "PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED"])
      .toContain(playback?.vmpUatStatus);
  }
  // Always recover through the visible toolbar after capability failure.
  await withRolePageTarget(input.chromeShellUrl, input.mainWindowHandle, async () => { await $("#home").click(); });
  await withRolePageTarget("rion-start://home/", input.mainWindowHandle, async () => {
    await expect($("[data-workspace-drm-notice]")).toBeDisplayed();
  });
}
