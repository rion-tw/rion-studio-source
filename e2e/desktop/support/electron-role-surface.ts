import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { runEncodedPowerShellJson } from
  "../../../scripts/encodedPowerShell.mjs";
import { fixtureCursor, waitFixtureEvent } from "./fixture";
import { sendChromiumEscapeKey } from "./chromium-escape-key";
import { visibleCanvasPoint } from "./visible-canvas-point";
import { scrollLayoutControlIntoView } from "./ui";
import { displayWorkspaceWebUrl } from "../../../src/shared/workspaceWebAddress";

import {
  electronDesktopE2eProbe,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eRolePlaceholderRuntime,
  type ElectronDesktopE2eRolePlaceholderInspection
} from "./electron-driver";
import {
  pressVisibleMacosApplicationShortcut,
  pressVisibleWindowsApplicationShortcut
} from "./native-application-actions";

import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

type ElectronWindowTracker = {
  electron?: { windowHandle?: string };
};

const ROLE_KEY_INPUT_SOURCE = "rion-role-keyboard";
const ROLE_POINTER_INPUT_SOURCE = "rion-role-pointer";

export type ElectronRoleKeyPhase = Readonly<{
  key: string;
  phase: "keyDown" | "keyUp";
}>;

export type VisibleElectronPagePoint = Readonly<{
  viewport: Readonly<{ height: number; width: number }>;
  x: number;
  y: number;
}>;

type VisibleElectronPageGeometry = Readonly<{
  bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
  viewport: Readonly<{ height: number; width: number }>;
}>;

function trackWindow(handle: string): void {
  const electron = (browser as unknown as ElectronWindowTracker).electron;
  if (electron) electron.windowHandle = handle;
}

export async function switchTrackedWindow(handle: string): Promise<void> {
  await browser.switchToWindow(handle);
  // @wdio/electron-service keeps its own active-page fence. Updating it after
  // the explicit switch prevents a later element command from selecting the
  // main renderer while the visible Role page is the intended target.
  trackWindow(handle);
}

async function currentDocumentUrl(): Promise<string> {
  return browser.execute(() => window.location.href) as Promise<string>;
}

async function rolePageTargetHandle(
  expectedUrl: string,
  mainWindowHandle: string,
  matchesDocument: () => Promise<boolean> = async () => true
): Promise<string> {
  const canonicalExpected = new URL(expectedUrl).href;
  let targetHandle: string | undefined;
  await browser.waitUntil(async () => {
    const handles = await browser.getWindowHandles();
    for (const handle of handles) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        if (new URL(await currentDocumentUrl()).href === canonicalExpected &&
            await matchesDocument()) {
          targetHandle = handle;
          return true;
        }
      } catch {
        // A superseded page target is not evidence. The next authoritative
        // target-list event observed by WebDriver gets another bounded try.
      }
    }
    await switchTrackedWindow(mainWindowHandle);
    return false;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `Chromium Role page target ${canonicalExpected} was not attached`
  });
  if (!targetHandle) {
    throw new Error(`Chromium Role page target ${canonicalExpected} is unavailable`);
  }
  return targetHandle;
}

export async function withRolePageTarget<Value>(
  expectedUrl: string,
  mainWindowHandle: string,
  action: () => Promise<Value>,
  restoreMainWindow = true
): Promise<Value> {
  const targetHandle = await rolePageTargetHandle(expectedUrl, mainWindowHandle);
  await switchTrackedWindow(targetHandle);
  try {
    return await action();
  } finally {
    if (restoreMainWindow) await switchTrackedWindow(mainWindowHandle);
  }
}

/** Selects one exact Rion-owned chrome shell when several share the same file URL. */
export async function withWorkspaceWebChromeTarget<Value>(
  chromeShellUrl: string,
  contentUrl: string,
  mainWindowHandle: string,
  action: () => Promise<Value>
): Promise<Value> {
  const expectedAddresses = new Set([
    contentUrl,
    displayWorkspaceWebUrl(contentUrl)
  ]);
  const targetHandle = await rolePageTargetHandle(
    chromeShellUrl,
    mainWindowHandle,
    async () => {
      const location = await $("#location");
      return await location.isExisting() &&
        expectedAddresses.has(await location.getValue());
    }
  );
  await switchTrackedWindow(targetHandle);
  try {
    return await action();
  } finally {
    await switchTrackedWindow(mainWindowHandle);
  }
}

async function visiblePageElementGeometry(
  selector: string
): Promise<VisibleElectronPageGeometry> {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 10_000 });
  await scrollLayoutControlIntoView(element);
  const geometry = await browser.execute((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) return null;
    const bounds = target.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2, bounds.y + bounds.height / 2
    );
    if (!hit || (hit !== target && !target.contains(hit))) {
      throw new Error(`Chromium visible control ${targetSelector} center is covered by ${
        hit instanceof HTMLElement ? `${hit.tagName}#${hit.id}.${hit.className}` : "no element"
      }`);
    }
    return {
      bounds: {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y
      },
      viewport: { height: window.innerHeight, width: window.innerWidth }
    };
  }, selector) as VisibleElectronPageGeometry | null;
  if (!geometry ||
      ![geometry.bounds.x, geometry.bounds.y, geometry.bounds.width,
        geometry.bounds.height, geometry.viewport.width,
        geometry.viewport.height].every(Number.isFinite) ||
      geometry.bounds.width <= 0 || geometry.bounds.height <= 0 ||
      geometry.viewport.width <= 0 || geometry.viewport.height <= 0) {
    throw new Error(`Visible Chromium page geometry is invalid for ${selector}`);
  }
  return geometry;
}

function geometryCenter(
  geometry: VisibleElectronPageGeometry
): VisibleElectronPagePoint {
  return Object.freeze({
    viewport: Object.freeze({ ...geometry.viewport }),
    x: geometry.bounds.x + geometry.bounds.width / 2,
    y: geometry.bounds.y + geometry.bounds.height / 2
  });
}

/** Failure-only DOM snapshot after selecting the exact WebDriver target; no input is sent. */
export async function readElectronRoleDocumentState(expectedUrl: string, mainWindowHandle: string) {
  return withRolePageTarget(expectedUrl, mainWindowHandle, async () => browser.execute(() => {
    const active = document.activeElement;
    const canvas = document.querySelector("#game-input-canvas");
    return {
      readyState: document.readyState,
      visibility: document.visibilityState,
      focusedAfterTargetSelection: document.hasFocus(),
      activeTag: active?.tagName ?? null,
      activeId: active?.id.slice(0, 128) ?? null,
      canvasIsActive: canvas !== null && canvas === active,
      canvasConnected: canvas?.isConnected === true,
      canvasTabIndex: canvas instanceof HTMLElement ? canvas.tabIndex : null
    };
  }));
}

/** Reads evidence produced by the fixture's real main-world event handler. */
export async function readElectronRoleFontState(expectedUrl: string, mainWindowHandle: string) {
  await clickVisibleElectronPageElement(expectedUrl, mainWindowHandle, "#font-evidence");
  return withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const raw = await $("#font-evidence").getAttribute("data-evidence");
    if (!raw || raw.length > 16_384) throw new Error("Page font evidence is missing or oversized");
    return JSON.parse(raw) as {
      canvasHookInstalled: boolean; loadedFamilies: string[];
      bodyFamily: string; canvasFont: string; wideGlyphWidth: number;
      narrowGlyphWidth: number; style: string; trusted: boolean;
    };
  });
}

/** Reads one visible DOM point without synthesizing the user action. */
export async function readVisibleElectronPageElementPoint(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<VisibleElectronPagePoint> {
  return withRolePageTarget(expectedUrl, mainWindowHandle, async () =>
    geometryCenter(await visiblePageElementGeometry(selector))
  );
}

/** Reads the visible verification control point across its exact iframe boundary. */
export async function readVisibleElectronRoleVerificationPoint(
  expectedUrl: string,
  mainWindowHandle: string
): Promise<VisibleElectronPagePoint> {
  return withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const frame = await $("#verification-frame");
    await frame.waitForDisplayed({ timeout: 10_000 });
    const frameGeometry = await visiblePageElementGeometry("#verification-frame");
    await browser.switchToFrame(frame);
    try {
      const control = geometryCenter(
        await visiblePageElementGeometry("#verification-complete")
      );
      const scaleX = frameGeometry.bounds.width / control.viewport.width;
      const scaleY = frameGeometry.bounds.height / control.viewport.height;
      return Object.freeze({
        viewport: Object.freeze({ ...frameGeometry.viewport }),
        x: frameGeometry.bounds.x + control.x * scaleX,
        y: frameGeometry.bounds.y + control.y * scaleY
      });
    } finally {
      await browser.switchToParentFrame();
    }
  });
}

/** Restores the Electron service and WebDriver to the exact main renderer. */
export async function restoreElectronMainWindowTarget(
  mainWindowHandle: string
): Promise<void> {
  await switchTrackedWindow(mainWindowHandle);
}

/** Clicks an exact visible control in a managed Chromium document. */
export async function clickVisibleElectronPageElement(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const element = await $(selector);
    await element.waitForDisplayed({ timeout: 10_000 });
    await scrollLayoutControlIntoView(element);
    await element.click();
  });
}

async function clickVisibleElectronPageElementWithWindowOpenModifierTarget(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string,
  modifier: "primary" | "shift",
  platform: "macos" | "windows",
  restoreMainWindow: boolean
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const element = await $(selector);
    await element.waitForDisplayed({ timeout: 10_000 });
    await scrollLayoutControlIntoView(element);
    await element.waitForClickable({ timeout: 10_000 });
    const key = modifier === "shift"
      ? Key.Shift
      : platform === "macos" ? Key.Command : Key.Ctrl;
    await browser.action("key").down(key).perform(true);
    try {
      await element.click();
    } finally {
      await browser.releaseActions();
    }
  }, restoreMainWindow);
}

/** Clicks a visible link with the Chromium gesture that selects its disposition. */
export async function clickVisibleElectronPageElementWithWindowOpenModifier(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string,
  modifier: "primary" | "shift",
  platform: "macos" | "windows"
): Promise<void> {
  await clickVisibleElectronPageElementWithWindowOpenModifierTarget(
    expectedUrl, mainWindowHandle, selector, modifier, platform, true
  );
}

/** Keeps the source target selected while a modifier-opened page is pending. */
export async function clickVisibleElectronPageElementWithWindowOpenModifierKeepingTarget(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string,
  modifier: "primary" | "shift",
  platform: "macos" | "windows"
): Promise<void> {
  await clickVisibleElectronPageElementWithWindowOpenModifierTarget(
    expectedUrl, mainWindowHandle, selector, modifier, platform, false
  );
}

/** Middle-clicks a visible link to produce Chromium's background-tab disposition. */
export async function middleClickVisibleElectronPageElement(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const element = await $(selector);
    await element.waitForDisplayed({ timeout: 10_000 });
    await scrollLayoutControlIntoView(element);
    await element.waitForClickable({ timeout: 10_000 });
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ duration: 100, origin: element })
      .down("middle")
      .up("middle")
      .perform();
  });
}

async function clickVisibleElectronPageElementWithPointerTarget(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string,
  restoreMainWindow: boolean
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const element = await $(selector);
    await element.waitForDisplayed({ timeout: 10_000 });
    await scrollLayoutControlIntoView(element);
    await element.waitForClickable({ timeout: 10_000 });
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ duration: 100, origin: element })
      .down("left")
      .up("left")
      .perform();
  }, restoreMainWindow);
}

/**
 * Presses a visible page control through WebDriver's real mouse input source.
 * File inputs require this path because ChromeDriver reserves elementClick for
 * its non-native upload protocol, while Rion must exercise the OS file panel.
 */
export async function clickVisibleElectronPageElementWithPointer(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<void> {
  await clickVisibleElectronPageElementWithPointerTarget(
    expectedUrl,
    mainWindowHandle,
    selector,
    true
  );
}

/** Keeps the clicked Role target active while its native modal panel resolves. */
export async function clickVisibleElectronPageElementWithPointerKeepingTarget(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<void> {
  await clickVisibleElectronPageElementWithPointerTarget(
    expectedUrl,
    mainWindowHandle,
    selector,
    false
  );
}

/** Submits the visible Rion-owned Workspace Web address control. */
export async function navigateVisibleElectronWorkspaceWebChrome(
  chromeShellUrl: string,
  mainWindowHandle: string,
  destination: string
): Promise<void> {
  await withRolePageTarget(chromeShellUrl, mainWindowHandle, async () => {
    const location = await $("#location");
    await location.waitForDisplayed({ timeout: 10_000 });
    await location.waitForEnabled({ timeout: 10_000 });
    await location.click();
    await browser.keys([Key.Ctrl, "a"]);
    await browser.keys(destination);
    await browser.action("key").down(Key.Enter).up(Key.Enter).perform();
  });
}

/** Sends a visible Escape key to the exact focused Chromium runtime document. */
export async function submitElectronPageEscape(
  expectedUrl: string,
  mainWindowHandle: string,
  input: Readonly<{
    hostKind?: "appKit" | "electronBrowserWindow";
    platform: "macos" | "windows";
    processId: number;
    runtimeTabName?: string;
    runtimeWindowId?: string;
  }>
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Chromium page did not gain focus" }
    );
    if (input.platform === "macos" && input.hostKind !== "electronBrowserWindow") {
      await pressVisibleMacosApplicationShortcut({
        command: "escape",
        processId: input.processId,
        runtimeTabName: input.runtimeTabName,
        runtimeWindowId: input.runtimeWindowId,
        targetMode: "focused-runtime"
      });
    } else {
      // The generic W3C action can deliver DOM Escape without triggering
      // Chromium's exclusive-access handling. Keep the exact page target and
      // submit complete native/Windows virtual key codes through ChromeDriver.
      await sendChromiumEscapeKey(browser, input.platform);
    }
  });
}

/** Closes the exact selected top-level context and its Electron BrowserWindow. */
export async function closeVisibleElectronPopup(
  expectedUrl: string,
  mainWindowHandle: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Electron popup did not gain focus" }
    );
    await browser.closeWindow();
  });
}

/**
 * Clicks the real visible button in an attached Chromium Role page target.
 * This does not call an E2E/debug input action: WebDriver targets the exact
 * WebContents document and the fixture must separately prove `isTrusted`.
 */
export async function clickVisibleElectronRolePageButton(
  expectedUrl: string,
  mainWindowHandle: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const button = await $("#qa-target");
    await button.waitForDisplayed({ timeout: 10_000 });
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();
  });
}

/**
 * Waits for the read-only exact blocked-slot projection, then presses its real
 * bundled Claim control. Core remains the sole ownership-transfer authority.
 */
export async function claimVisibleElectronRolePlaceholder(input: Readonly<{
  currentOwnerTabId: string;
  mainWindowHandle: string;
  roleId: string;
  targetTabId: string;
}>): Promise<ElectronDesktopE2eRolePlaceholderInspection> {
  let inspection: ElectronDesktopE2eRolePlaceholderInspection | undefined;
  let shellUrl: string | undefined;
  let lastInspectionError = "inspection did not run";
  try {
    await browser.waitUntil(async () => {
      await switchTrackedWindow(input.mainWindowHandle);
      try {
        const candidate = await electronDesktopE2eRolePlaceholderRuntime(input.roleId);
        const placeholder = candidate.placeholders.find((entry) =>
          entry.tabId === input.targetTabId && entry.visible
        );
        if (candidate.coreOwner.tabId !== input.currentOwnerTabId || !placeholder) {
          lastInspectionError = "Core owner or visible target placeholder did not match";
          return false;
        }
        inspection = candidate;
        shellUrl = placeholder.shellUrl;
        return true;
      } catch (error) {
        lastInspectionError = error instanceof Error ? error.message : String(error);
        return false;
      }
    }, {
      interval: 100,
      timeout: 20_000,
      timeoutMsg: `Role ${input.roleId} did not expose its exact visible Claim control`
    });
  } catch (error) {
    throw new Error(
      `Role ${input.roleId} Claim control inspection failed: ${lastInspectionError}`,
      { cause: error }
    );
  }
  if (!inspection || !shellUrl) {
    throw new Error(`Role ${input.roleId} blocked-slot projection is unavailable`);
  }
  await clickVisibleElectronPageElement(
    shellUrl,
    input.mainWindowHandle,
    "#claim"
  );
  return inspection;
}

/** Completes the visible cross-origin verification inside a managed Role. */
export async function completeVisibleElectronRoleVerification(
  expectedUrl: string,
  mainWindowHandle: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const frame = await $("#verification-frame");
    await frame.waitForDisplayed({ timeout: 10_000 });
    await browser.switchToFrame(frame);
    try {
      const complete = await $("#verification-complete");
      await complete.waitForClickable({ timeout: 10_000 });
      await complete.click();
    } finally {
      await browser.switchToParentFrame();
    }
  });
}

/**
 * Sends an exact physical-key lifecycle to the visible managed Role document.
 * WebDriver owns the input source; the E2E fixture remains responsible for
 * proving that Chromium delivered trusted DOM events to this exact document.
 */
export async function submitElectronRoleKeyPhases(
  expectedUrl: string,
  mainWindowHandle: string,
  phases: readonly ElectronRoleKeyPhase[],
  options: Readonly<{ windowId: string; focusCanvas?: boolean }>
): Promise<void> {
  const probe = options.focusCanvas === false ? null : await electronDesktopE2eProbe();
  const nativeWindowHandle = probe?.platform === "windows"
    ? (await electronDesktopE2eFullscreenToolbarRuntime(options.windowId)).nativeWindowHandle
    : null;
  if (probe?.platform === "windows" && !nativeWindowHandle) {
    throw new Error("The exact Windows runtime handle is missing");
  }
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const canvas = await $("#game-input-canvas");
    await canvas.waitForDisplayed({ timeout: 10_000 });
    if (options.focusCanvas !== false) {
      if (probe && nativeWindowHandle) {
        // ChromeDriver can deliver DOM keys without native WebContents focus.
        // A real content click establishes the same focus a user supplies.
        await focusWindowsRuntimeNativeWindow({
          processId: probe.processId, nativeWindowHandle, pointerTarget: "content-click"
        });
      }
      const point = await browser.execute(visibleCanvasPoint);
      await browser.action("pointer", {
        parameters: { pointerType: "mouse" }
      }).move({
        origin: "viewport",
        ...point
      }).down("left").up("left").perform();
      const focused = await browser.execute(() =>
        document.activeElement === document.querySelector("#game-input-canvas")
      );
      if (!focused) throw new Error("The visible canvas click did not establish keyboard focus");
    }
    for (const phase of phases) {
      const action = browser.action("key", { id: ROLE_KEY_INPUT_SOURCE });
      if (phase.phase === "keyDown") action.down(phase.key);
      else action.up(phase.key);
      await action.perform(true);
    }
  });
}

/** Sends one exact middle-button edge to the visible managed Role document. */
export async function submitElectronRoleMiddleButtonPhase(
  expectedUrl: string,
  mainWindowHandle: string,
  phase: "mouseDown" | "mouseUp"
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const target = await $("#qa-target");
    await target.waitForDisplayed({ timeout: 10_000 });
    const action = browser.action("pointer", {
      id: ROLE_POINTER_INPUT_SOURCE,
      parameters: { pointerType: "mouse" }
    }).move({ origin: target });
    if (phase === "mouseDown") action.down("middle");
    else action.up("middle");
    await action.perform(true);
  });
}

/** Submits a Windows application chord from the exact visible Role host. */
async function submitWindowsRolePageShortcut(
  expectedUrl: string,
  mainWindowHandle: string,
  windowId: string,
  command: "quickAccess" | "toggleFullscreen"
): Promise<void> {
  const { processId } = await electronDesktopE2eProbe();
  const { nativeWindowHandle } = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  if (!nativeWindowHandle) throw new Error("The exact Windows runtime handle is missing");
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const button = await $("#qa-target");
    await button.waitForDisplayed({ timeout: 10_000 });
    const roleId = await $("#role-id").getText();
    if (!roleId) throw new Error("The exact Role fixture identity is missing");
    const afterSequence = await fixtureCursor();
    // Native foreground admission precedes the physical content click. A
    // WebDriver click made while another native window is active cannot prove
    // that this View owns the keyboard focus needed by the following shortcut.
    await focusWindowsRuntimeNativeWindow({
      processId, nativeWindowHandle, pointerTarget: "content-click"
    });
    const click = await waitFixtureEvent({ afterSequence, kind: "click", roleId });
    if (click.isTrusted !== true || click.targetId !== "qa-target") {
      throw new Error("The native click did not reach the exact Role fixture target");
    }
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Chromium Role page did not gain focus" }
    );
    console.info("Windows Role focus after native foreground", await browser.execute(() => ({
      focused: document.hasFocus(),
      activeTag: document.activeElement?.tagName ?? null,
      activeId: document.activeElement?.id ?? null,
      visibility: document.visibilityState
    })));
    // Native input must reach the exact foreground host.
    await pressVisibleWindowsApplicationShortcut({
      command, processId, nativeWindowHandle, targetMode: "focused-runtime"
    });
  });
}

export async function submitElectronRolePageQuickAccessShortcut(
  expectedUrl: string,
  mainWindowHandle: string,
  windowId: string
): Promise<void> {
  await submitWindowsRolePageShortcut(expectedUrl, mainWindowHandle, windowId, "quickAccess");
}

export async function submitElectronRolePageFullscreenShortcut(
  expectedUrl: string,
  mainWindowHandle: string,
  windowId: string
): Promise<void> {
  await submitWindowsRolePageShortcut(expectedUrl, mainWindowHandle, windowId, "toggleFullscreen");
}

/** Moves the OS pointer across the managed host and Role WebContents boundary. */
async function moveWindowsRuntimePointer(
  windowId: string,
  pointerTarget: "reveal-edge" | "content"
): Promise<void> {
  const { processId } = await electronDesktopE2eProbe();
  const { nativeWindowHandle } = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  if (!nativeWindowHandle) throw new Error("The exact Windows runtime handle is missing");
  await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle, pointerTarget });
}

export async function movePointerToWindowsRuntimeHostRevealEdge(windowId: string): Promise<void> {
  await moveWindowsRuntimePointer(windowId, "reveal-edge");
}

export async function movePointerToWindowsRuntimeContent(windowId: string): Promise<void> {
  await moveWindowsRuntimePointer(windowId, "content");
}

/** Drags the visible bundled-host separator with a native Windows pointer. */
export async function dragWindowsVisibleWorkspaceDivider(
  mainWindowHandle: string,
  input: Readonly<{
    axis: "horizontal" | "vertical";
    dividerIndex: number;
    deltaCssPixels?: number;
    expectedThickness?: number;
    windowId: string;
  }>
): Promise<void> {
  const { axis, dividerIndex } = input;
  const deltaCssPixels = input.deltaCssPixels ?? 72;
  const expectedThickness = input.expectedThickness;
  const { processId } = await electronDesktopE2eProbe();
  const { nativeWindowHandle } = await electronDesktopE2eFullscreenToolbarRuntime(
    input.windowId
  );
  if (!nativeWindowHandle) throw new Error("The exact Windows runtime handle is missing");
  let hostHandle: string | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        const url = new URL(await currentDocumentUrl());
        if (url.protocol === "file:" && url.pathname.endsWith(
          "/runtime-windows-host.html"
        ) && await browser.execute(() =>
          document.documentElement.dataset.runtimeWindowId
        ) === input.windowId) {
          hostHandle = handle;
          return true;
        }
      } catch {
        // A superseded local-shell target is not the visible native divider.
      }
    }
    await switchTrackedWindow(mainWindowHandle);
    return false;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The Windows runtime-host divider target was not attached"
  });
  if (!hostHandle) throw new Error("The Windows runtime-host target is unavailable");
  await switchTrackedWindow(hostHandle);
  try {
    const divider = await $(
      `button.runtime-workspace-divider[data-axis='${axis}']` +
      `[data-divider-index='${dividerIndex}']:not([hidden])`
    );
    await divider.waitForDisplayed({ timeout: 10_000 });
    const exactAxis = await divider.getAttribute("data-axis");
    if (exactAxis !== axis || await divider.getAttribute("data-divider-index") !==
        String(dividerIndex)) {
      throw new Error("The visible Windows workspace divider has no exact axis");
    }
    const size = await divider.getSize();
    const location = await divider.getLocation();
    const thickness = exactAxis === "vertical" ? size.width : size.height;
    if (expectedThickness !== undefined && thickness !== expectedThickness) {
      throw new Error(
        `The Windows ${axis} workspace-divider thickness is ${thickness}, ` +
        `expected ${expectedThickness}`
      );
    }
    // Avoid the geometric center where a perpendicular divider can overlap
    // this hit surface in a three-or-more-slot Workspace.
    const startX = Math.round(location.x + size.width *
      (exactAxis === "horizontal" ? 0.25 : 0.5));
    const startY = Math.round(location.y + size.height *
      (exactAxis === "vertical" ? 0.25 : 0.5));
    await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RionWorkspaceDividerDrag {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static void Drag(Point start, Point end) {
    if (!SetCursorPos(start.x, start.y)) throw new InvalidOperationException("divider start placement failed");
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(16);
    if (!SetCursorPos(end.x, end.y)) throw new InvalidOperationException("divider end placement failed");
    mouse_event(0x0001, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(16);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
[RionWorkspaceDividerDrag]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$handle = [IntPtr]::new([long]$payload.nativeWindowHandle)
$owner = [uint32]0
[RionWorkspaceDividerDrag]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
if ($owner -ne [uint32]$payload.processId -or -not [RionWorkspaceDividerDrag]::IsWindowVisible($handle)) {
  throw 'exact divider HWND is no longer visible or owned by Rion'
}
[RionWorkspaceDividerDrag]::SetForegroundWindow($handle) | Out-Null
if ([RionWorkspaceDividerDrag]::GetForegroundWindow() -ne $handle) {
  throw 'exact divider HWND did not become foreground'
}
$scale = [RionWorkspaceDividerDrag]::GetDpiForWindow($handle) / 96.0
if ($scale -le 0) { throw 'exact divider HWND has no native DPI' }
$start = New-Object RionWorkspaceDividerDrag+Point
$start.x = [int][Math]::Round([double]$payload.startX * $scale)
$start.y = [int][Math]::Round([double]$payload.startY * $scale)
$end = New-Object RionWorkspaceDividerDrag+Point
$end.x = [int][Math]::Round([double]$payload.endX * $scale)
$end.y = [int][Math]::Round([double]$payload.endY * $scale)
if (-not [RionWorkspaceDividerDrag]::ClientToScreen($handle, [ref]$start) -or
    -not [RionWorkspaceDividerDrag]::ClientToScreen($handle, [ref]$end)) {
  throw 'exact divider client coordinates could not be mapped to screen'
}
[RionWorkspaceDividerDrag]::Drag($start, $end)
$actual = New-Object RionWorkspaceDividerDrag+Point
if (-not [RionWorkspaceDividerDrag]::GetCursorPos([ref]$actual) -or
    $actual.x -ne $end.x -or $actual.y -ne $end.y) {
  throw 'exact divider endpoint was not preserved'
}
`, {
      endX: startX + (exactAxis === "vertical" ? deltaCssPixels : 0),
      endY: startY + (exactAxis === "horizontal" ? deltaCssPixels : 0),
      nativeWindowHandle,
      processId,
      startX,
      startY
    }, { timeoutMilliseconds: 10_000 });
    await browser.waitUntil(async () =>
      (await divider.getAttribute("data-dragging")) !== "true", {
      timeout: 10_000,
      timeoutMsg: "The Windows workspace-divider pointer did not terminate"
    });
  } finally {
    await switchTrackedWindow(mainWindowHandle);
  }
}
