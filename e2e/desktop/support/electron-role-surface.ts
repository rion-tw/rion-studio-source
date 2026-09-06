import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { sendChromiumEscapeKey } from "./chromium-escape-key";

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

async function switchTrackedWindow(handle: string): Promise<void> {
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
  mainWindowHandle: string
): Promise<string> {
  const canonicalExpected = new URL(expectedUrl).href;
  let targetHandle: string | undefined;
  await browser.waitUntil(async () => {
    const handles = await browser.getWindowHandles();
    for (const handle of handles) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        if (new URL(await currentDocumentUrl()).href === canonicalExpected) {
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

async function withRolePageTarget<Value>(
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

async function visiblePageElementGeometry(
  selector: string
): Promise<VisibleElectronPageGeometry> {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 10_000 });
  await element.scrollIntoView({ block: "center", inline: "center" });
  const geometry = await browser.execute((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) return null;
    const bounds = target.getBoundingClientRect();
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
    await element.scrollIntoView({ block: "center", inline: "center" });
    await element.click();
  });
}

/**
 * Clicks a visible control while retaining its WebDriver target. This is used
 * only when a deliberately pending popup navigation would block a main-target
 * switch until an external native parent-retirement action cancels that load.
 */
export async function clickVisibleElectronPageElementKeepingTarget(
  expectedUrl: string,
  mainWindowHandle: string,
  selector: string
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const element = await $(selector);
    await element.waitForDisplayed({ timeout: 10_000 });
    await element.scrollIntoView({ block: "center", inline: "center" });
    await element.click();
  }, false);
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
    await element.scrollIntoView({ block: "center", inline: "center" });
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
    await location.setValue(destination);
    await browser.action("key").down(Key.Enter).up(Key.Enter).perform();
  });
}

/** Sends a visible Escape key to the exact focused Chromium runtime document. */
export async function submitElectronPageEscape(
  expectedUrl: string,
  mainWindowHandle: string,
  input: Readonly<{
    platform: "macos" | "windows";
    processId: number;
    runtimeTabName: string;
  }>
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Chromium page did not gain focus" }
    );
    if (input.platform === "macos") {
      await pressVisibleMacosApplicationShortcut({
        command: "escape",
        processId: input.processId,
        runtimeTabName: input.runtimeTabName,
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
  options: Readonly<{ focusCanvas?: boolean }> = {}
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const canvas = await $("#game-input-canvas");
    await canvas.waitForDisplayed({ timeout: 10_000 });
    if (options.focusCanvas !== false) {
      const size = await canvas.getSize();
      await browser.action("pointer", {
        parameters: { pointerType: "mouse" }
      }).move({
        origin: canvas,
        x: -Math.floor(size.width / 4),
        y: -Math.floor(size.height / 4)
      }).down("left").up("left").perform();
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

/** Submits the platform shortcut from the real visible managed Role document. */
export async function submitElectronRolePageQuickAccessShortcut(
  expectedUrl: string,
  mainWindowHandle: string,
  platform: "macos" | "windows"
): Promise<void> {
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const button = await $("#qa-target");
    await button.waitForDisplayed({ timeout: 10_000 });
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Chromium Role page did not gain focus" }
    );
    const modifier = platform === "macos" ? Key.Command : Key.Ctrl;
    await browser.action("key")
      .down(modifier)
      .down("k")
      .up("k")
      .up(modifier)
      .perform();
  });
}

/** Sends native Windows F11 input through the retained foreground hook. */
export async function submitElectronRolePageFullscreenShortcut(
  expectedUrl: string,
  mainWindowHandle: string,
  windowId: string
): Promise<void> {
  const { processId } = await electronDesktopE2eProbe();
  const { nativeWindowHandle } = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  if (!nativeWindowHandle) throw new Error("The exact Windows runtime handle is missing");
  await withRolePageTarget(expectedUrl, mainWindowHandle, async () => {
    const button = await $("#qa-target");
    await button.waitForDisplayed({ timeout: 10_000 });
    await button.click();
    await browser.waitUntil(
      () => browser.execute(() => document.hasFocus()),
      { timeout: 10_000, timeoutMsg: "The visible Chromium Role page did not gain focus" }
    );
    await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle });
    // WebDriver key injection bypasses the Win32 hook that owns F11 routing.
    await pressVisibleWindowsApplicationShortcut({
      command: "toggleFullscreen", processId, nativeWindowHandle, targetMode: "focused-runtime"
    });
  });
}

/** Moves the real pointer onto the trusted local Windows reveal edge. */
export async function movePointerToWindowsRuntimeHostRevealEdge(
  mainWindowHandle: string
): Promise<void> {
  let hostHandle: string | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        const url = new URL(await currentDocumentUrl());
        if (url.protocol === "file:" && url.pathname.endsWith(
          "/runtime-windows-host.html"
        )) {
          hostHandle = handle;
          return true;
        }
      } catch {
        // A superseded host target is ignored until WebDriver publishes the
        // current trusted local shell target.
      }
    }
    await switchTrackedWindow(mainWindowHandle);
    return false;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The trusted local Windows runtime-host target was not attached"
  });
  if (!hostHandle) throw new Error("The Windows runtime-host target is unavailable");
  await switchTrackedWindow(hostHandle);
  try {
    const edge = await $("[data-runtime-reveal-edge]:not([hidden])");
    await edge.waitForDisplayed({ timeout: 10_000 });
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ duration: 200, origin: edge, x: 1, y: 1 })
      .perform();
  } finally {
    await switchTrackedWindow(mainWindowHandle);
  }
}

/** Drags the visible bundled-host separator with a real WebDriver pointer. */
export async function dragWindowsVisibleWorkspaceDivider(
  mainWindowHandle: string,
  deltaCssPixels = 72
): Promise<void> {
  let hostHandle: string | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        const url = new URL(await currentDocumentUrl());
        if (url.protocol === "file:" && url.pathname.endsWith(
          "/runtime-windows-host.html"
        )) {
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
    const divider = await $("button.runtime-workspace-divider:not([hidden])");
    await divider.waitForDisplayed({ timeout: 10_000 });
    const axis = await divider.getAttribute("data-axis");
    if (axis !== "vertical" && axis !== "horizontal") {
      throw new Error("The visible Windows workspace divider has no exact axis");
    }
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ duration: 250, origin: divider })
      .down("left")
      .move({
        duration: 700,
        origin: divider,
        x: axis === "vertical" ? deltaCssPixels : 0,
        y: axis === "horizontal" ? deltaCssPixels : 0
      })
      .up("left")
      .perform();
    await browser.waitUntil(async () =>
      (await divider.getAttribute("data-dragging")) !== "true", {
      timeout: 10_000,
      timeoutMsg: "The Windows workspace-divider pointer did not terminate"
    });
  } finally {
    await switchTrackedWindow(mainWindowHandle);
  }
}
