import { $, browser, expect } from "@wdio/globals";

import type { EmbeddedRuntimeState, LaunchWorkspace, Role, RoleStatus } from
  "../../../src/shared/types";
import {
  electronDesktopE2ePopupLifecycleJournal,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eWorkspaceWebRuntime,
  electronDesktopE2eWorkspaceWebSecurityPolicy,
  type ElectronDesktopE2ePopupLifecycleJournalInspection,
  type ElectronDesktopE2eWorkspaceWebRuntimeInspection
} from "../support/electron-driver";
import {
  clickVisibleElectronPageElement,
  clickVisibleElectronPageElementKeepingTarget,
  clickVisibleElectronPageElementWithPointer,
  restoreElectronMainWindowTarget,
  submitElectronPageEscape
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureRequest,
  waitFixtureEvent
} from "../support/fixture";
import {
  prepareNativeFileUploadFixture,
  selectVisibleNativeUploadFile,
  writeVisibleFileUploadEvidence
} from "../support/native-file-upload";
import {
  closeVisibleRuntimeTab,
  closeVisibleRuntimeWindow,
  readVisibleMacosRuntimeTabCloseEvidence
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  setEditorName,
  setInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017]
// [journey:CHROMIUM-MACOS-APPKIT-POPUP-012]
// [journey:CHROMIUM-WINDOWS-POPUP-012]
// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SECURITY-POLICY-027]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-WEB-SECURITY-POLICY-027]
// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FILE-UPLOAD-028]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028]

const ROLE_NAME = "Chromium Entity Role Edited";
const WORKSPACE_NAME = "Chromium Workspace Web Fullscreen";
const WEB_NAME = "Chromium Workspace Web fullscreen fixture";
const WEB_FIXTURE_ID = "chromium-workspace-web-fullscreen";
const POPUP_FIXTURE_ID = "e2e-workspace-popup";
const WEB_SESSION_MARKER = "chromium-workspace-web-fullscreen-marker";

type PopupLifecycleObservation =
  ElectronDesktopE2ePopupLifecycleJournalInspection["observations"][number];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Workspace Web fullscreen journey`);
  return value;
}

function configuredWebUrl(): string {
  const url = new URL(
    `/role/${WEB_FIXTURE_ID}`,
    required("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  );
  url.searchParams.set("mode", "seed");
  url.searchParams.set("marker", WEB_SESSION_MARKER);
  return url.href;
}

function popupUrl(): string {
  return new URL(
    `/role/${POPUP_FIXTURE_ID}`,
    required("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  ).href;
}

function downloadUrl(): string {
  return new URL(
    `/download/${WEB_FIXTURE_ID}`,
    required("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  ).href;
}

async function preparePhase(): Promise<"macos" | "windows"> {
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
  expect(probe.driver).toBe("electron");
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  return probe.platform;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findRole(): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles"))
      .find((candidate) => candidate.name === ROLE_NAME);
    return role !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find dependency Role ${ROLE_NAME}` });
  return role!;
}

async function findWorkspace(): Promise<LaunchWorkspace> {
  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces"))
      .find((candidate) => candidate.name === WORKSPACE_NAME);
    return workspace !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find Workspace ${WORKSPACE_NAME}` });
  return workspace!;
}

async function createWorkspace(role: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);

  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  const preset = await $("[data-workspace-web-preset-select]");
  await preset.waitForClickable({ timeout: 10_000 });
  await preset.click();
  const youtube = await $("[role='option'][data-workspace-web-preset='youtube']");
  await youtube.waitForDisplayed({ timeout: 10_000 });
  await youtube.click();
  await browser.waitUntil(async () =>
    await $("#workspace-web-name").getValue() === "YouTube" &&
    await $("#workspace-web-url").getValue() === "https://www.youtube.com/", {
    timeout: 10_000,
    timeoutMsg: "The visible popular-site menu did not apply the YouTube preset"
  });
  await setInputValue("#workspace-web-name", WEB_NAME);
  await setInputValue("#workspace-web-url", configuredWebUrl());

  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  const workspace = await findWorkspace();
  expect(workspace.slots).toEqual(expect.arrayContaining([
    expect.objectContaining({ web: { name: WEB_NAME, startUrl: configuredWebUrl() } }),
    expect.objectContaining({ roleId: role.id })
  ]));
  return workspace;
}

async function launchWorkspace(
  workspace: LaunchWorkspace,
  role: Role
): Promise<Readonly<{ mainWindowHandle: string; tabId: string; windowId: string }>> {
  const mainWindowHandle = await browser.getWindowHandle();
  await openSection("Workspaces", "/workspaces");
  const card = await $(`[data-selection-id='${workspace.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const open = await card.$("button[aria-label='Open workspace']");
  await open.waitForDisplayed({ timeout: 10_000 });
  await open.waitForClickable({ timeout: 10_000 });
  await open.click();

  let runtime: EmbeddedRuntimeState | undefined;
  let status: RoleStatus | undefined;
  let tab: EmbeddedRuntimeState["tabs"][number] | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    runtime = await rendererCall("getEmbeddedRuntimeState");
    tab = runtime.tabs.find((candidate) =>
      candidate.type === "workspace" && candidate.sourceId === workspace.id &&
      candidate.roleIds.includes(role.id)
    );
    return status?.state === "running" && Boolean(tab) &&
      runtime.windows.some((window) => window.id === tab?.windowId && window.visible);
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The mixed fullscreen Workspace did not reach its native Chromium host"
  });
  expect(status?.resolvedEngine).toBe("chromium");
  return { mainWindowHandle, tabId: tab!.id, windowId: tab!.windowId };
}

async function waitForWebSession(
  expectedBefore: readonly (string | null)[],
  afterSequence: number
): Promise<void> {
  const session = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: WEB_FIXTURE_ID
  });
  expect(session.session).toEqual(expect.objectContaining({
    after: { cookie: WEB_SESSION_MARKER, localStorage: WEB_SESSION_MARKER },
    marker: WEB_SESSION_MARKER,
    mode: "seed"
  }));
  expect(session.session?.before?.cookie)
    .toBe(session.session?.before?.localStorage);
  expect(expectedBefore).toContain(session.session?.before?.cookie ?? null);
}

function expectFixtureFullscreen(
  event: Awaited<ReturnType<typeof waitFixtureEvent>>,
  active: boolean
): void {
  expect(event.fullscreen).toEqual(expect.objectContaining({
    active,
    targetId: active ? "contained-fullscreen-controls" : null,
    toolbarPresent: false
  }));
  if (!active) return;
  expect(Math.abs(event.fullscreen!.rect.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(event.fullscreen!.rect.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    event.fullscreen!.rect.width - event.fullscreen!.viewport.width
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(
    event.fullscreen!.rect.height - event.fullscreen!.viewport.height
  )).toBeLessThanOrEqual(1);
}

function expectMainHostGeometryInvariant(
  before: ElectronDesktopE2eWorkspaceWebRuntimeInspection,
  current: ElectronDesktopE2eWorkspaceWebRuntimeInspection
): void {
  expect(current.windowId).toBe(before.windowId);
  expect(current.windowGeneration).toBe(before.windowGeneration);
  expect(current.presentation).toBe(before.presentation);
  expect(current.windowBounds).toEqual(before.windowBounds);
  expect(current.coreSlots).toEqual(before.coreSlots);
  expect(current.role).toEqual(before.role);
  expect(current.web.slotBounds).toEqual(before.web.slotBounds);
  expect(current.web.chromeBounds).toEqual(before.web.chromeBounds);
}

function expectMainHostInvariant(
  before: ElectronDesktopE2eWorkspaceWebRuntimeInspection,
  current: ElectronDesktopE2eWorkspaceWebRuntimeInspection
): void {
  expectMainHostGeometryInvariant(before, current);
  expect(current.topologyRevision).toBe(before.topologyRevision);
}

function exactPopupParentFence(
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection
): PopupLifecycleObservation["parent"] {
  return {
    ownerId: inspection.web.surfaceId,
    ownerKind: "globalWeb",
    ownerNativeGeneration: inspection.web.generation,
    parentAppkitIdentity: inspection.appKitIdentity,
    parentAttemptGeneration: inspection.attemptGeneration,
    parentNativeHostId: inspection.parentNativeHostId,
    parentTabId: inspection.tabId,
    parentTopologyRevision: inspection.topologyRevision,
    parentWindowGeneration: inspection.windowGeneration,
    parentWindowId: inspection.windowId,
    roleOwnerGeneration: null,
    slotId: inspection.web.slotId
  };
}

async function waitForPopupLifecycleObservation(input: Readonly<{
  action: "nativeClosed" | "nativeReady";
  afterSequence: number;
  openOperationId?: string;
  popupId?: string;
  windowId: string;
}>): Promise<Readonly<{
  journal: ElectronDesktopE2ePopupLifecycleJournalInspection;
  observation: PopupLifecycleObservation;
}>> {
  let result: Readonly<{
    journal: ElectronDesktopE2ePopupLifecycleJournalInspection;
    observation: PopupLifecycleObservation;
  }> | undefined;
  await browser.waitUntil(async () => {
    const journal = await electronDesktopE2ePopupLifecycleJournal(input.windowId);
    const matches = journal.observations.filter((observation) =>
      observation.sequence > input.afterSequence &&
      observation.action === input.action &&
      (input.popupId === undefined || observation.popupId === input.popupId) &&
      (input.openOperationId === undefined ||
        observation.openOperationId === input.openOperationId)
    );
    if (matches.length !== 1) return false;
    result = Object.freeze({ journal, observation: matches[0]! });
    return true;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `Popup ${input.action} Core receipt was not observed`
  });
  return result!;
}

async function waitForContainedProjection(
  windowId: string,
  contained: boolean,
  afterRevision: number
): Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection> {
  let observed: ElectronDesktopE2eWorkspaceWebRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    try {
      const candidate = await electronDesktopE2eWorkspaceWebRuntime(windowId);
      if (candidate.web.containedFullscreen !== contained ||
          candidate.web.containedFullscreenRevision <= afterRevision) {
        return false;
      }
      observed = candidate;
      return true;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `Workspace Web contained fullscreen did not become ${contained}`
  });
  return observed!;
}

async function clickAndObserveFullscreen(input: Readonly<{
  afterRevision: number;
  contained: boolean;
  expectedUrl: string;
  mainWindowHandle: string;
  roleId: string;
  selector: string;
  windowId: string;
}>): Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection> {
  const afterSequence = await fixtureCursor();
  await clickVisibleElectronPageElement(
    input.expectedUrl,
    input.mainWindowHandle,
    input.selector
  );
  const click = await waitFixtureEvent({
    afterSequence,
    kind: "contained-control-click",
    roleId: input.roleId
  });
  expect(click).toEqual(expect.objectContaining({
    isTrusted: true,
    targetId: input.selector.slice(1)
  }));
  const event = await waitFixtureEvent({
    afterSequence,
    kind: input.contained ? "contained-fullscreen-enter" : "contained-fullscreen-exit",
    roleId: input.roleId
  });
  expectFixtureFullscreen(event, input.contained);
  return waitForContainedProjection(
    input.windowId,
    input.contained,
    input.afterRevision
  );
}

async function escapeAndObserveFullscreen(input: Readonly<{
  afterRevision: number;
  expectedUrl: string;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  processId: number;
  roleId: string;
  runtimeTabName: string;
  windowId: string;
}>): Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection> {
  const afterSequence = await fixtureCursor();
  await submitElectronPageEscape(input.expectedUrl, input.mainWindowHandle, {
    platform: input.platform,
    processId: input.processId,
    runtimeTabName: input.runtimeTabName
  });
  const event = await waitFixtureEvent({
    afterSequence,
    kind: "contained-fullscreen-exit",
    roleId: input.roleId
  });
  expectFixtureFullscreen(event, false);
  return waitForContainedProjection(input.windowId, false, input.afterRevision);
}

function expectNormalPairedProjection(
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection
): void {
  expect(inspection.web).toEqual(expect.objectContaining({
    chromeVisible: true,
    containedFullscreen: false,
    contentVisible: true,
    isolatedSessions: true,
    visible: true
  }));
  expect(inspection.web.contentBounds.y)
    .toBe(inspection.web.chromeBounds.y + inspection.web.chromeBounds.height);
  expect(inspection.web.contentBounds.height + inspection.web.chromeBounds.height)
    .toBe(inspection.web.slotBounds.height);
}

async function exerciseDeniedPermissionAndDownload(input: Readonly<{
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection;
  mainWindowHandle: string;
}>): Promise<void> {
  const before = await electronDesktopE2eWorkspaceWebSecurityPolicy(
    input.inspection.windowId
  );
  expect(before).toEqual(expect.objectContaining({
    contentProfilePath: input.inspection.web.contentProfilePath,
    generation: input.inspection.web.generation,
    policyVersion: 1,
    sessionStoragePath: input.inspection.web.contentSessionStoragePath,
    surfaceId: input.inspection.web.surfaceId,
    windowId: input.inspection.windowId
  }));
  const priorSequence = before.observations.at(-1)?.sequence ?? 0;

  const permissionCursor = await fixtureCursor();
  await clickVisibleElectronPageElement(
    configuredWebUrl(),
    input.mainWindowHandle,
    "#permission-geolocation"
  );
  expect(await waitFixtureEvent({
    afterSequence: permissionCursor,
    kind: "permission-requested",
    roleId: WEB_FIXTURE_ID
  })).toEqual(expect.objectContaining({
    isTrusted: true,
    targetId: "permission-geolocation"
  }));
  expect(await waitFixtureEvent({
    afterSequence: permissionCursor,
    kind: "permission-denied",
    roleId: WEB_FIXTURE_ID
  })).toEqual(expect.objectContaining({ errorCode: "1" }));
  const afterPermission = await electronDesktopE2eWorkspaceWebSecurityPolicy(
    input.inspection.windowId
  );
  expect(afterPermission.observations.filter(
    (observation) => observation.sequence > priorSequence &&
      observation.kind === "permission-request"
  )).toEqual([expect.objectContaining({
    callback: false,
    kind: "permission-request",
    origin: required("RION_STUDIO_E2E_FIXTURE_ORIGIN"),
    permission: "geolocation"
  })]);

  const downloadCursor = await fixtureCursor();
  await clickVisibleElectronPageElement(
    configuredWebUrl(),
    input.mainWindowHandle,
    "#blocked-download"
  );
  expect(await waitFixtureEvent({
    afterSequence: downloadCursor,
    kind: "download-requested",
    roleId: WEB_FIXTURE_ID
  })).toEqual(expect.objectContaining({
    isTrusted: true,
    targetId: "blocked-download"
  }));
  await waitFixtureEvent({
    afterSequence: downloadCursor,
    kind: "download-response-started",
    roleId: WEB_FIXTURE_ID
  });
  await waitFixtureEvent({
    afterSequence: downloadCursor,
    kind: "download-transport-cancelled",
    roleId: WEB_FIXTURE_ID
  });
  const permissionSequence = afterPermission.observations.at(-1)?.sequence ?? 0;
  const afterDownload = await electronDesktopE2eWorkspaceWebSecurityPolicy(
    input.inspection.windowId
  );
  expect(afterDownload.observations.filter(
    (observation) => observation.sequence > permissionSequence &&
      observation.kind === "will-download"
  )).toEqual([expect.objectContaining({
    defaultPrevented: true,
    kind: "will-download",
    origin: required("RION_STUDIO_E2E_FIXTURE_ORIGIN"),
    url: downloadUrl()
  })]);
  expect(afterDownload).toEqual(expect.objectContaining({
    contentProfilePath: before.contentProfilePath,
    generation: before.generation,
    sessionStoragePath: before.sessionStoragePath,
    surfaceId: before.surfaceId,
    windowId: before.windowId
  }));
}

async function exerciseVisibleFileUpload(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<number> {
  const fixture = await prepareNativeFileUploadFixture();
  const probe = await electronDesktopE2eProbe();
  expect(probe.platform).toBe(input.platform);
  const afterSequence = await fixtureCursor();

  // Start the native observer before the click. The two promises remain live
  // together so a modal chooser cannot strand WebDriver's element command.
  const nativeSelection = selectVisibleNativeUploadFile({
    fixturePath: fixture.path,
    platform: input.platform,
    processId: probe.processId
  });
  const visibleClick = clickVisibleElectronPageElementWithPointer(
    configuredWebUrl(),
    input.mainWindowHandle,
    "#file-upload"
  );
  const [selection] = await Promise.all([nativeSelection, visibleClick]);
  try {
    expect(await waitFixtureEvent({
      afterSequence,
      kind: "file-upload-requested",
      roleId: WEB_FIXTURE_ID
    })).toEqual(expect.objectContaining({
      isTrusted: true,
      targetId: "file-upload"
    }));
    const selected = await waitFixtureEvent({
      afterSequence,
      kind: "file-upload-selected",
      roleId: WEB_FIXTURE_ID
    });
    expect(selected).toEqual(expect.objectContaining({
      fileUpload: {
        bytes: fixture.bytes,
        fileName: fixture.fileName,
        sha256: fixture.sha256
      },
      isTrusted: true,
      targetId: "file-upload"
    }));
    await writeVisibleFileUploadEvidence({
      fixture,
      observed: selected.fileUpload!,
      platform: input.platform,
      processId: probe.processId
    });
  } finally {
    await selection.cleanup();
  }
  return probe.processId;
}

async function exerciseContainedFullscreen(input: Readonly<{
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId: string;
}>): Promise<void> {
  const { inspection: launched, mainWindowHandle, platform } = input;
  expect(launched.hostKind).toBe(
    platform === "macos" ? "appkit-chromium" : "bundled-chromium"
  );
  expect(launched.presentation).toBe("normal");
  expect(launched.popups).toEqual([]);
  expectNormalPairedProjection(launched);
  await exerciseDeniedPermissionAndDownload({
    inspection: launched,
    mainWindowHandle
  });
  const processId = await exerciseVisibleFileUpload({ mainWindowHandle, platform });
  let restoredHost: ElectronDesktopE2eWorkspaceWebRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    const candidate = await electronDesktopE2eWorkspaceWebRuntime(
      launched.windowId
    );
    if (!candidate.focused || candidate.web.containedFullscreen) return false;
    restoredHost = candidate;
    return true;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The AppKit/Windows host did not restore focus after native upload"
  });
  const before = restoredHost!;
  expectMainHostGeometryInvariant(launched, before);

  const entered = await clickAndObserveFullscreen({
    afterRevision: before.web.containedFullscreenRevision,
    contained: true,
    expectedUrl: configuredWebUrl(),
    mainWindowHandle,
    roleId: WEB_FIXTURE_ID,
    selector: "#contained-fullscreen-enter",
    windowId: before.windowId
  });
  expectMainHostInvariant(before, entered);
  expect(entered.web.chromeVisible).toBe(false);
  expect(entered.web.contentVisible).toBe(true);
  expect(entered.web.contentBounds).toEqual(entered.web.slotBounds);

  const siteRestored = await clickAndObserveFullscreen({
    afterRevision: entered.web.containedFullscreenRevision,
    contained: false,
    expectedUrl: configuredWebUrl(),
    mainWindowHandle,
    roleId: WEB_FIXTURE_ID,
    selector: "#contained-fullscreen-exit",
    windowId: before.windowId
  });
  expectMainHostInvariant(before, siteRestored);
  expectNormalPairedProjection(siteRestored);

  const reentered = await clickAndObserveFullscreen({
    afterRevision: siteRestored.web.containedFullscreenRevision,
    contained: true,
    expectedUrl: configuredWebUrl(),
    mainWindowHandle,
    roleId: WEB_FIXTURE_ID,
    selector: "#contained-fullscreen-enter",
    windowId: before.windowId
  });
  const escapeRestored = await escapeAndObserveFullscreen({
    afterRevision: reentered.web.containedFullscreenRevision,
    expectedUrl: configuredWebUrl(),
    mainWindowHandle,
    platform,
    processId,
    roleId: WEB_FIXTURE_ID,
    runtimeTabName: WORKSPACE_NAME,
    windowId: before.windowId
  });
  expectMainHostInvariant(before, escapeRestored);
  expectNormalPairedProjection(escapeRestored);

  const popupReadyAfter = await fixtureCursor();
  await clickVisibleElectronPageElement(
    configuredWebUrl(),
    mainWindowHandle,
    "#contained-fullscreen-popup"
  );
  const popupRequest = await waitFixtureEvent({
    afterSequence: popupReadyAfter,
    kind: "contained-popup-requested",
    roleId: WEB_FIXTURE_ID
  });
  expect(popupRequest.isTrusted).toBe(true);
  await waitFixtureEvent({
    afterSequence: popupReadyAfter,
    kind: "contained-popup-ready",
    roleId: POPUP_FIXTURE_ID
  });
  let popupBefore: ElectronDesktopE2eWorkspaceWebRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    const candidate = await electronDesktopE2eWorkspaceWebRuntime(before.windowId);
    if (candidate.popups.length !== 1 || !candidate.popups[0]?.visible) return false;
    popupBefore = candidate;
    return true;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The controlled Chromium popup did not expose its native host"
  });
  expectMainHostGeometryInvariant(before, popupBefore!);
  expect(popupBefore!.topologyRevision).toBeGreaterThan(before.topologyRevision);
  expect(popupBefore!.popups[0]).toEqual(expect.objectContaining({
    hostKind: before.hostKind,
    presentation: "normal",
    topologyRevision: 1,
    visible: true,
    windowGeneration: 1
  }));
  if (platform === "macos") {
    expect(popupBefore!.popups[0]!.appKitIdentity).toEqual({
      launchGeneration: popupBefore!.popups[0]!.openOperationId,
      logicalWindowId: popupBefore!.popups[0]!.logicalWindowId,
      nativeGeneration: popupBefore!.popups[0]!.appKitIdentity?.nativeGeneration
    });
  } else {
    expect(popupBefore!.popups[0]!.appKitIdentity).toBeNull();
  }

  const popupEnterAfter = await fixtureCursor();
  await clickVisibleElectronPageElement(
    popupUrl(),
    mainWindowHandle,
    "#contained-fullscreen-enter"
  );
  expectFixtureFullscreen(await waitFixtureEvent({
    afterSequence: popupEnterAfter,
    kind: "contained-fullscreen-enter",
    roleId: POPUP_FIXTURE_ID
  }), true);
  const popupEntered = await electronDesktopE2eWorkspaceWebRuntime(before.windowId);
  expectMainHostInvariant(popupBefore!, popupEntered);
  expect(popupEntered.popups).toEqual(popupBefore!.popups);

  const popupSiteExitAfter = await fixtureCursor();
  await clickVisibleElectronPageElement(
    popupUrl(),
    mainWindowHandle,
    "#contained-fullscreen-exit"
  );
  expectFixtureFullscreen(await waitFixtureEvent({
    afterSequence: popupSiteExitAfter,
    kind: "contained-fullscreen-exit",
    roleId: POPUP_FIXTURE_ID
  }), false);
  const popupSiteRestored = await electronDesktopE2eWorkspaceWebRuntime(
    before.windowId
  );
  expectMainHostInvariant(popupBefore!, popupSiteRestored);
  expect(popupSiteRestored.popups).toEqual(popupBefore!.popups);

  const popupSecondEnterAfter = await fixtureCursor();
  await clickVisibleElectronPageElement(
    popupUrl(),
    mainWindowHandle,
    "#contained-fullscreen-enter"
  );
  await waitFixtureEvent({
    afterSequence: popupSecondEnterAfter,
    kind: "contained-fullscreen-enter",
    roleId: POPUP_FIXTURE_ID
  });
  const popupEscapeAfter = await fixtureCursor();
  await submitElectronPageEscape(popupUrl(), mainWindowHandle, {
    platform,
    processId,
    runtimeTabName: new URL(popupUrl()).hostname
  });
  expectFixtureFullscreen(await waitFixtureEvent({
    afterSequence: popupEscapeAfter,
    kind: "contained-fullscreen-exit",
    roleId: POPUP_FIXTURE_ID
  }), false);
  const popupRestored = await electronDesktopE2eWorkspaceWebRuntime(before.windowId);
  expectMainHostInvariant(popupBefore!, popupRestored);
  expect(popupRestored.popups).toEqual(popupBefore!.popups);

  const popup = popupRestored.popups[0]!;
  await closeVisibleRuntimeWindow({
    mainWindowHandle,
    platform,
    tabId: popup.popupId,
    tabName: new URL(popupUrl()).hostname
  });
  let restoredParent: ElectronDesktopE2eWorkspaceWebRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    const candidate = await electronDesktopE2eWorkspaceWebRuntime(before.windowId);
    if (candidate.popups.length !== 0 || !candidate.focused) return false;
    restoredParent = candidate;
    return true;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The visible native popup close did not terminalize its exact host"
  });
  expectMainHostGeometryInvariant(before, restoredParent!);
  expect(restoredParent!.topologyRevision)
    .toBeGreaterThan(popupBefore!.topologyRevision);

  const popupJournalBaseline = await electronDesktopE2ePopupLifecycleJournal(
    before.windowId
  );
  const popupBaselineSequence =
    popupJournalBaseline.observations.at(-1)?.sequence ?? 0;
  const pendingPopupParentCloseEvidence = platform === "macos"
    ? await readVisibleMacosRuntimeTabCloseEvidence({
        tabId: input.tabId,
        tabName: WORKSPACE_NAME,
        windowId: before.windowId
      })
    : undefined;
  await fixtureRequest("/api/gate", { roleId: POPUP_FIXTURE_ID });
  try {
    const popupRequestAfter = await fixtureCursor();
    if (platform === "macos") {
      await clickVisibleElectronPageElementKeepingTarget(
        configuredWebUrl(),
        mainWindowHandle,
        "#contained-fullscreen-popup"
      );
    } else {
      await clickVisibleElectronPageElement(
        configuredWebUrl(),
        mainWindowHandle,
        "#contained-fullscreen-popup"
      );
    }
    expect(await waitFixtureEvent({
      afterSequence: popupRequestAfter,
      kind: "contained-popup-requested",
      roleId: WEB_FIXTURE_ID
    })).toEqual(expect.objectContaining({ isTrusted: true }));
    const waiting = await fetch(
      `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}` +
      `/api/gates/${POPUP_FIXTURE_ID}/waiting`,
      { signal: AbortSignal.timeout(20_000) }
    );
    expect(waiting.ok).toBe(true);
    expect(await waiting.json()).toEqual(expect.objectContaining({ waiterCount: 1 }));
    const transportCursor = await fixtureCursor();

    if (platform === "macos") {
      await closeVisibleRuntimeTab({
        deferMacosRendererVerification: true,
        mainWindowHandle,
        macosCloseEvidence: pendingPopupParentCloseEvidence,
        platform,
        processId,
        tabId: input.tabId,
        tabName: WORKSPACE_NAME,
        windowId: before.windowId
      });
      expect(await waitFixtureEvent({
        afterSequence: transportCursor,
        kind: "gated-navigation-transport-cancelled",
        roleId: POPUP_FIXTURE_ID
      })).toEqual(expect.objectContaining({
        kind: "gated-navigation-transport-cancelled",
        roleId: POPUP_FIXTURE_ID
      }));
      await restoreElectronMainWindowTarget(mainWindowHandle);
    }

    const nativeReady = (await waitForPopupLifecycleObservation({
      action: "nativeReady",
      afterSequence: popupBaselineSequence,
      windowId: before.windowId
    })).observation;
    expect(nativeReady).toEqual(expect.objectContaining({
      action: "nativeReady",
      closeNative: false,
      closeReason: null,
      completionScope: "nativeAcknowledgement",
      failureCode: null,
      lifecycleTerminal: false,
      operationId: nativeReady.openOperationId,
      operationTerminal: false,
      phase: "nativeReady",
      status: "applied",
      terminalReason: null
    }));
    expect(nativeReady.parent).toEqual(exactPopupParentFence(restoredParent!));

    if (platform === "windows") {
      await closeVisibleRuntimeTab({
        mainWindowHandle,
        platform,
        tabId: input.tabId,
        tabName: WORKSPACE_NAME,
        windowId: before.windowId
      });
    }
    const terminal = await waitForPopupLifecycleObservation({
      action: "nativeClosed",
      afterSequence: nativeReady.sequence,
      openOperationId: nativeReady.openOperationId,
      popupId: nativeReady.popupId,
      windowId: before.windowId
    });
    expect(terminal.observation).toEqual(expect.objectContaining({
      action: "nativeClosed",
      closeNative: false,
      closeReason: "parentRetired",
      completionScope: "nativeDestroyed",
      failureCode: "CHROMIUM_POPUP_OWNER_RETIRED",
      lifecycleTerminal: true,
      openOperationId: nativeReady.openOperationId,
      operationId: nativeReady.openOperationId,
      operationTerminal: true,
      parent: nativeReady.parent,
      phase: "cancelled",
      popupId: nativeReady.popupId,
      status: "cancelled",
      terminalReason: "parentRetired"
    }));
    const operation = terminal.journal.observations.filter((observation) =>
      observation.sequence > popupBaselineSequence &&
      observation.popupId === nativeReady.popupId &&
      observation.openOperationId === nativeReady.openOperationId
    );
    expect(operation.map((observation) => observation.action)).toEqual([
      "nativeReady",
      "closeRequested",
      "nativeClosed"
    ]);
    expect(operation[1]).toEqual(expect.objectContaining({
      closeNative: true,
      closeReason: "parentRetired",
      lifecycleTerminal: false,
      operationId: nativeReady.openOperationId,
      operationTerminal: false,
      parent: nativeReady.parent,
      phase: "closing"
    }));
    if (platform === "windows") {
      expect(await waitFixtureEvent({
        afterSequence: transportCursor,
        kind: "gated-navigation-transport-cancelled",
        roleId: POPUP_FIXTURE_ID
      })).toEqual(expect.objectContaining({
        kind: "gated-navigation-transport-cancelled",
        roleId: POPUP_FIXTURE_ID
      }));
    }
  } finally {
    await fixtureRequest("/api/release", { roleId: POPUP_FIXTURE_ID });
  }
}

async function runPhase(
  platform: "macos" | "windows",
  restart: boolean
): Promise<void> {
  const role = await findRole();
  const workspace = restart ? await findWorkspace() : await createWorkspace(role);
  expect(workspace.slots.find((slot) => slot.web !== undefined)?.web).toEqual({
    name: WEB_NAME,
    startUrl: configuredWebUrl()
  });
  const sessionCursor = await fixtureCursor();
  const launched = await launchWorkspace(workspace, role);
  await waitForWebSession(restart
    ? [WEB_SESSION_MARKER]
    : [null, "chromium-workspace-web-slot-marker"], sessionCursor);
  const inspection = await electronDesktopE2eWorkspaceWebRuntime(launched.windowId);
  expect(inspection.tabId).toBe(launched.tabId);
  expect(inspection.web.contentUrl).toBe(configuredWebUrl());
  expect(inspection.web.contentSessionStoragePath)
    .toBe(inspection.web.contentProfilePath);
  expect(inspection.web.chromeShellStoragePath).toBeNull();
  const roleRuntime = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(roleRuntime.latestSessionEnsure.sessionStoragePath)
    .not.toBe(inspection.web.contentProfilePath);
  await exerciseContainedFullscreen({
    inspection,
    mainWindowHandle: launched.mainWindowHandle,
    platform,
    tabId: launched.tabId
  });
}

describe("Chromium Workspace Web contained fullscreen exact replacement", () => {
  it("contains main and popup fullscreen without replacing native host chrome", async () => {
    const platform = await preparePhase();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-workspace-web-fullscreen-seed") {
      await runPhase(platform, false);
    } else if (phase === "chromium-workspace-web-fullscreen-restart") {
      await runPhase(platform, true);
    } else {
      throw new Error(`Unexpected Workspace Web fullscreen journey phase ${phase}`);
    }
  });
});
