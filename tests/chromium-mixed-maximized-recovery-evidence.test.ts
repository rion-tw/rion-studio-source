import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateChromiumRecoveryParityRuntimeEvidence,
  validateChromiumRecoveryParitySqliteEvidence } from
  "../scripts/desktopE2eChromiumRecoveryParityEvidence.mjs";

type Platform = "macos" | "windows";
const normalBounds = { x: 80, y: 60, width: 960, height: 680 };
const placement = { normalBounds, savedWorkArea: { x: 0, y: 0, width: 1200, height: 800 },
  presentation: "maximized" };
const slots = [
  { id: "web-slot", rect: { x: 0, y: 0, width: 0.5, height: 1 }, roleId: null,
    web: { lastUrl: "http://fixture/role/web?marker=mixed-web-marker" } },
  { id: "role-slot", rect: { x: 0.5, y: 0, width: 0.5, height: 1 }, roleId: "workspace-role", web: null }
];
let sessionGeneration = 0;

function fixture(platform: Platform) {
  const lifecycle = { contractVersion: 1, platform, placement: structuredClone(placement),
    roleTab: { chromiumPathSha256: "role-tab-path", roleId: "role-tab", tabId: "role-tab-id" },
    roleWorkspace: { chromiumPathSha256: "workspace-role-path", roleId: "workspace-role" },
    web: { marker: "mixed-web-marker", slotId: "web-slot" }, windowId: "window",
    workspace: { id: "workspace", tabId: "workspace-tab", slots: structuredClone(slots) } };
  const owner = { windowId: "window", parentNativeHostId: 4, windowGeneration: 14,
    topologyRevision: 14, visible: true, focused: true,
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    appKitIdentity: platform === "macos"
      ? { logicalWindowId: "window", nativeGeneration: 3 } : null };
  const roleTabBounds = { x: 0, y: 40, width: 1200, height: 720 };
  const roleBounds = { x: 604, y: 40, width: 596, height: 720 };
  const webBounds = { x: 0, y: 74, width: 600, height: 686 };
  const saved = { id: "window", name: "Chromium Mixed Recovery Window",
    placement: structuredClone(placement), activeTabId: "workspace-tab", tabs: [
      { id: "role-tab-id", tabType: "role", sourceId: "role-tab" },
      { id: "workspace-tab", tabType: "workspace", sourceId: "workspace", workspaceSlots: [
        { id: "web-slot", rect: structuredClone(slots[0]!.rect), web: structuredClone(slots[0]!.web) },
        { id: "role-slot", rect: structuredClone(slots[1]!.rect), roleId: "workspace-role" }
      ] }
    ] };
  const native = {
    gameWindow: { currentRuntime: { ...owner, coreTabIds: ["role-tab-id", "workspace-tab"],
      nativeTabIds: ["role-tab-id", "workspace-tab"],
      nativeDisplay: { presentation: "maximized", bounds: normalBounds } } },
    roleTab: { currentRuntime: { ...owner, tabId: "role-tab-id" },
      latestSessionEnsure: { chromiumPathSha256: "role-tab-path" } },
    roleWorkspace: { currentRuntime: { ...owner, tabId: "workspace-tab" },
      latestSessionEnsure: { chromiumPathSha256: "workspace-role-path" } },
    web: { ...owner, presentation: "maximized", tabId: "workspace-tab",
      coreSlots: structuredClone(slots), role: { roleId: "workspace-role", bounds: roleBounds, visible: true },
      web: { slotId: "web-slot", contentSession: "global-web-persistent",
        chromeShellSession: "rion-web-chrome-shell:memory", isolatedSessions: true,
        contentBounds: webBounds, chromeBounds: { x: 0, y: 40, width: 600, height: 34 },
        slotBounds: { x: 0, y: 40, width: 600, height: 720 }, visible: true } },
    toolbar: { ...owner, presentation: "maximized", tabIds: ["role-tab-id", "workspace-tab"],
      native: { windowGeneration: owner.windowGeneration, topologyRevision: owner.topologyRevision },
      surfaces: [{ id: "role-tab", tabId: "role-tab-id", visible: false, bounds: roleTabBounds },
        { id: "workspace-role", tabId: "workspace-tab", visible: true, bounds: roleBounds }],
      workspaceTabs: [{ tabId: "workspace-tab", slots: structuredClone(slots) }] }
  };
  const observation = { lifecycle, native, saved, viewports: {
    roleTab: { width: roleTabBounds.width, height: roleTabBounds.height, visibility: "visible", renderFrames: 2 },
    roleWorkspace: { width: roleBounds.width, height: roleBounds.height, visibility: "visible", renderFrames: 2 },
    web: { width: webBounds.width, height: webBounds.height, visibility: "visible", renderFrames: 2 }
  }, viewportActivation: {
    roleTab: { activeTabId: "role-tab-id", afterSequence: 0,
      toolbar: { ...structuredClone(native.toolbar), surfaces: [
        { id: "role-tab", tabId: "role-tab-id", visible: true, bounds: roleTabBounds }
      ] }, visibilityEvent: { kind: "visibility", hidden: false,
        roleId: "chromium-mixed-recovery-role-tab", sequence: 1 } },
    workspace: { activeTabId: "workspace-tab", afterSequence: 1, visibilityEvents: {
      roleWorkspace: { kind: "visibility", hidden: false,
        roleId: "chromium-mixed-recovery-role-workspace", sequence: 2 },
      web: { kind: "visibility", hidden: false, roleId: "chromium-mixed-recovery-web", sequence: 3 }
    } }
  }, runtimeState: { activeTabId: "workspace-tab", visible: true, projectionPending: false,
    restoreInProgressWindowIds: [] as string[] } };
  const background = { gameWindow: { currentRuntime: { ...structuredClone(native.gameWindow.currentRuntime),
    focused: false } }, launcherFocus: { launcherNativeHostId: 1, launcherFocused: true,
    focusedNativeHostId: 1, runtimeNativeFocused: false, nativeForeground: {
      launcher: { parentWasForeground: true, parentVisible: true, parentMinimized: false },
      runtime: { parentWasForeground: false, parentVisible: true, parentMinimized: false }
    } } };
  return { lifecycle, observation, background, saved };
}

async function validate(subject: ReturnType<typeof fixture>, phase: string, sqlite = false) {
  const directory = await mkdtemp(join(tmpdir(), "rion-mixed-placement-"));
  const phaseDirectory = join(directory, phase);
  try {
    await mkdir(phaseDirectory);
    await writeFile(join(directory, "chromium-mixed-recovery-evidence.json"), JSON.stringify(subject.lifecycle));
    await writeFile(join(phaseDirectory, "chromium-mixed-recovery-runtime.json"), JSON.stringify(subject.observation));
    await writeFile(join(phaseDirectory, "mixed-restored-background-native.json"), JSON.stringify(subject.background));
    if (!sqlite) return await validateChromiumRecoveryParityRuntimeEvidence({
      phase, phaseDirectory, platform: subject.lifecycle.platform
    });
    return await validateChromiumRecoveryParitySqliteEvidence({ phase, phaseDirectory,
      entities: { gameWindows: [{ id: "window", name: subject.saved.name, payload: subject.saved }] },
      settings: [{ key: "runtimeRestoreSession", payload: { schemaVersion: 2,
        cleanExit: phase !== "chromium-mixed-recovery-force", lastFocusedWindowId: "window",
        liveWindowIds: ["window"], restoreInProgressWindowIds: [], sessionGeneration: ++sessionGeneration } }]
    });
  } finally { await rm(directory, { force: true, recursive: true }); }
}

describe.each(["macos", "windows"] as const)("%s populated maximized recovery evidence", platform => {
  it.each(["seed", "force", "restore"])("accepts exact saved/native %s viewports and slots", async suffix => {
    const subject = fixture(platform);
    const phase = `chromium-mixed-recovery-${suffix}`;
    await expect(validate(subject, phase)).resolves.toMatchObject({ savedPresentation: "maximized",
      savedNormalBounds: normalBounds, populatedDocumentViewportsVerified: true,
      normalizedWorkspaceSlotsVerified: true });
    await expect(validate(subject, phase, true)).resolves.toMatchObject({ savedPresentation: "maximized",
      savedNormalBounds: normalBounds, cleanExit: suffix !== "force" });
  });

  it.each(["roleTab", "roleWorkspace", "web"] as const)("rejects a stale %s document viewport", async name => {
    const subject = fixture(platform);
    subject.observation.viewports[name].width -= 10;
    await expect(validate(subject, "chromium-mixed-recovery-seed")).rejects.toThrow(
      `${name} document viewport does not match its native surface`
    );
  });

  it.each(["active-tab", "hidden-surface", "stale-visibility", "native-fence"])(
    "rejects %s evidence before reading the dormant Role document", async mode => {
      const subject = fixture(platform);
      const activation = subject.observation.viewportActivation.roleTab;
      if (mode === "active-tab") activation.activeTabId = "workspace-tab";
      else if (mode === "hidden-surface") activation.toolbar.surfaces[0]!.visible = false;
      else if (mode === "stale-visibility") activation.afterSequence = activation.visibilityEvent.sequence;
      else activation.toolbar.native.topologyRevision += 1;
      await expect(validate(subject, "chromium-mixed-recovery-seed"))
        .rejects.toThrow("exact visible native tab activation");
    }
  );

  it("rejects a Workspace viewport read before its real visible event", async () => {
    const subject = fixture(platform);
    subject.observation.viewportActivation.workspace.visibilityEvents.web.hidden = true;
    await expect(validate(subject, "chromium-mixed-recovery-restore"))
      .rejects.toThrow("exact visible native tab activation");
  });

  it.each(["hidden", "no-render"])("rejects %s Role-tab dimensions even when they match", async mode => {
    const subject = fixture(platform);
    if (mode === "hidden") subject.observation.viewports.roleTab.visibility = "hidden";
    else subject.observation.viewports.roleTab.renderFrames = 0;
    await expect(validate(subject, "chromium-mixed-recovery-seed"))
      .rejects.toThrow("roleTab document viewport does not match its native surface");
  });

  it("rejects normal native presentation despite a maximized saved record", async () => {
    const subject = fixture(platform);
    subject.observation.native.gameWindow.currentRuntime.nativeDisplay.presentation = "normal";
    await expect(validate(subject, "chromium-mixed-recovery-seed")).rejects.toThrow("native populated maximize");
  });

  it("rejects restore evidence before the exact cohort terminal", async () => {
    const subject = fixture(platform);
    subject.observation.runtimeState.restoreInProgressWindowIds.push("window");
    await expect(validate(subject, "chromium-mixed-recovery-restore")).rejects.toThrow("exact terminal cohort");
  });

  it("rejects changed normalized slots after restore", async () => {
    const subject = fixture(platform);
    subject.observation.native.web.coreSlots[0]!.rect.width = 0.4;
    await expect(validate(subject, "chromium-mixed-recovery-restore")).rejects.toThrow("normalized Workspace slot layout drifted");
  });

  it.each(["runtime", "sqlite"])("rejects changed saved normal bounds in %s evidence", async mode => {
    const subject = fixture(platform);
    subject.saved.placement.normalBounds.width += 40;
    await expect(validate(subject, "chromium-mixed-recovery-seed", mode === "sqlite"))
      .rejects.toThrow("saved maximized placement or normal bounds drifted");
  });

  it("rejects changed SQLite normalized slots", async () => {
    const subject = fixture(platform);
    subject.saved.tabs[1]!.workspaceSlots![0]!.rect.width = 0.4;
    await expect(validate(subject, "chromium-mixed-recovery-seed", true))
      .rejects.toThrow("saved normalized Workspace slot layout drifted");
  });
});

describe("Windows background maximize restore evidence", () => {
  it.each(["runtime", "launcher", "adapter", "rust-runtime", "rust-launcher"])("rejects focus theft recorded by the native %s readback", async source => {
    const subject = fixture("windows");
    if (source === "runtime") subject.background.gameWindow.currentRuntime.focused = true;
    else if (source === "launcher") subject.background.launcherFocus.focusedNativeHostId = 4;
    else if (source === "adapter") subject.background.launcherFocus.runtimeNativeFocused = true;
    else if (source === "rust-runtime") subject.background.launcherFocus.nativeForeground.runtime.parentWasForeground = true;
    else subject.background.launcherFocus.nativeForeground.launcher.parentWasForeground = false;
    await expect(validate(subject, "chromium-mixed-recovery-restore"))
      .rejects.toThrow("background native maximize reclaimed the launcher's focus");
  });
});
