import { $, browser } from "@wdio/globals";

import {
  controlWindow,
  focusMainApplicationWindow,
  keyboardInputSequence,
  probe,
  rendererCall,
  runtimeUiAction,
  waitEvent,
  windowSnapshot,
  type DesktopE2eWindowSnapshot
} from "./control";
import { navigate } from "./ui";

const REVEAL_EDGE_HEIGHT = 2;
const TOOLBAR_HEIGHT_TOLERANCE = 0.5;

async function setFullscreenToolbarPreference(alwaysShow: boolean): Promise<void> {
  await focusMainApplicationWindow();
  await navigate("/settings?section=preferences");
  const toggle = await $(
    "button[role='switch'][aria-label='Always show the toolbar in full screen']"
  );
  await toggle.waitForExist({ timeout: 10_000 });
  const expectedState = alwaysShow ? "checked" : "unchecked";
  if ((await toggle.getAttribute("data-state")) !== expectedState) {
    await toggle.waitForEnabled({ timeout: 10_000 });
    await toggle.click();
  }
  await browser.waitUntil(
    async () => {
      const preferences = await rendererCall("getRuntimeWindowPreferences");
      return preferences.alwaysShowToolbarInFullScreen === alwaysShow
        && (await toggle.getAttribute("data-state")) === expectedState;
    },
    {
      timeout: 10_000,
      timeoutMsg: `Fullscreen toolbar preference did not become ${expectedState}`
    }
  );
}

async function setFullscreenToolbarPreferenceFromVisibleNativeMenu(
  snapshot: DesktopE2eWindowSnapshot,
  alwaysShow: boolean
): Promise<void> {
  if (process.platform !== "darwin") {
    await setFullscreenToolbarPreference(alwaysShow);
    return;
  }
  await controlWindow(snapshot.windowId, {
    action: "clickVisibleFullscreenToolbarMenu"
  });
  await browser.waitUntil(
    async () => {
      const preferences = await rendererCall("getRuntimeWindowPreferences");
      return preferences.alwaysShowToolbarInFullScreen === alwaysShow;
    },
    {
      timeout: 10_000,
      timeoutMsg: `Native fullscreen toolbar menu preference did not become ${alwaysShow}`
    }
  );
}

async function returnToFullscreenGameWindow(
  snapshot: DesktopE2eWindowSnapshot
): Promise<DesktopE2eWindowSnapshot> {
  if (process.platform === "darwin") {
    let inactiveSamples = 0;
    await browser.waitUntil(
      async () => {
        const observed = await windowSnapshot(snapshot.windowId);
        inactiveSamples = observed.native.focused ? 0 : inactiveSamples + 1;
        return inactiveSamples >= 10;
      },
      {
        interval: 50,
        timeout: 10_000,
        timeoutMsg: "The Settings Space transition did not settle"
      }
    );
    await controlWindow(snapshot.windowId, { action: "activateFullscreenSpace" });
  } else {
    await controlWindow(snapshot.windowId, { action: "focus" });
  }
  await browser.waitUntil(
    async () => (await windowSnapshot(snapshot.windowId)).native.focused,
    {
      interval: 50,
      timeout: 10_000,
      timeoutMsg: "Game Window did not become focused after returning to fullscreen"
    }
  );
  return windowSnapshot(snapshot.windowId);
}

async function clickRoleContent(
  snapshot: DesktopE2eWindowSnapshot,
  roleId: string,
  tabId: string
): Promise<void> {
  if (process.platform === "darwin") {
    await controlWindow(snapshot.windowId, {
      action: "movePointerToRoleContent"
    });
  }
  await runtimeUiAction(snapshot.windowId, {
    action: "clickRoleContent",
    roleId,
    tabId,
    windowGeneration: snapshot.windowGeneration
  });
}

async function waitForRuntimeTabReady(
  windowId: string,
  tabId: string
): Promise<DesktopE2eWindowSnapshot> {
  const cursor = (await probe()).latestSequence;
  let snapshot = await windowSnapshot(windowId);
  if (snapshot.kernel?.tabs.find((tab) => tab.tabId === tabId)?.launchPhase === "ready") {
    return snapshot;
  }
  await waitEvent({
    afterSequence: cursor,
    kind: `tab-launch-phase:${tabId}:ready`,
    timeoutMs: 55_000,
    windowId
  });
  snapshot = await windowSnapshot(windowId);
  const launchPhase = snapshot.kernel?.tabs.find((tab) => tab.tabId === tabId)?.launchPhase;
  if (launchPhase !== "ready") {
    throw new Error(`Runtime tab ${tabId} did not remain ready: observed=${String(launchPhase)}`);
  }
  return snapshot;
}

async function toggleFullscreenWithVisibleShortcut(
  snapshot: DesktopE2eWindowSnapshot,
  roleId: string,
  tabId: string,
  presentation: "fullscreen" | "normal"
): Promise<DesktopE2eWindowSnapshot> {
  await clickRoleContent(snapshot, roleId, tabId);
  await browser.waitUntil(
    async () => (await windowSnapshot(snapshot.windowId)).native.focused,
    {
      interval: 50,
      timeout: 10_000,
      timeoutMsg: "Game Window did not become the focused shortcut target"
    }
  );
  const cursor = (await probe()).latestSequence;
  const requests = process.platform === "darwin"
    ? [
        { code: "ControlLeft", phase: "keyDown" as const },
        { code: "MetaLeft", phase: "keyDown" as const },
        { code: "KeyF", phase: "keyDown" as const },
        { code: "KeyF", phase: "keyUp" as const },
        { code: "MetaLeft", phase: "keyUp" as const },
        { code: "ControlLeft", phase: "keyUp" as const }
      ]
    : [
        { code: "F11", phase: "keyDown" as const },
        { code: "F11", phase: "keyUp" as const }
      ];
  await keyboardInputSequence(requests);
  try {
    await waitEvent({
      afterSequence: cursor,
      kind: "placement-accepted",
      minimumGeneration: snapshot.windowGeneration,
      presentation,
      timeoutMs: 45_000,
      windowId: snapshot.windowId
    });
  } catch (error) {
    const observed = await windowSnapshot(snapshot.windowId);
    throw new Error(
      `Fullscreen shortcut did not reach ${presentation}: observed=${JSON.stringify(observed.native)}`,
      { cause: error }
    );
  }
  return windowSnapshot(snapshot.windowId);
}

async function enterFullscreenWithVisibleControl(
  snapshot: DesktopE2eWindowSnapshot,
  roleId: string,
  tabId: string
): Promise<DesktopE2eWindowSnapshot> {
  if (process.platform !== "darwin") {
    return toggleFullscreenWithVisibleShortcut(snapshot, roleId, tabId, "fullscreen");
  }
  await clickRoleContent(snapshot, roleId, tabId);
  await browser.waitUntil(
    async () => (await windowSnapshot(snapshot.windowId)).native.focused,
    {
      interval: 50,
      timeout: 10_000,
      timeoutMsg: "Game Window did not become the focused fullscreen-control target"
    }
  );
  const cursor = (await probe()).latestSequence;
  await controlWindow(snapshot.windowId, { action: "clickVisibleFullscreen" });
  try {
    await waitEvent({
      afterSequence: cursor,
      kind: "placement-accepted",
      minimumGeneration: snapshot.windowGeneration,
      presentation: "fullscreen",
      timeoutMs: 45_000,
      windowId: snapshot.windowId
    });
  } catch (error) {
    const observed = await windowSnapshot(snapshot.windowId);
    throw new Error(
      `Visible fullscreen control did not enter fullscreen: observed=${JSON.stringify(observed.native)}`,
      { cause: error }
    );
  }
  return windowSnapshot(snapshot.windowId);
}

async function waitForFullscreenToolbarState(
  windowId: string,
  input: {
    baselineHeight: number;
    fullscreen: boolean;
    visible: boolean;
  }
): Promise<DesktopE2eWindowSnapshot> {
  let observed: DesktopE2eWindowSnapshot | undefined;
  let stableSamples = 0;
  try {
    await browser.waitUntil(
      async () => {
        observed = await windowSnapshot(windowId);
        let matches = observed.native.presentation
          === (input.fullscreen ? "fullscreen" : "normal");
        if (matches && !input.fullscreen) {
          const toolbar = observed.native.fullscreenToolbar;
          matches = process.platform !== "darwin"
            || (toolbar !== undefined
              && !toolbar.fullscreen
              && !toolbar.fullscreenHostReady);
        } else if (matches && process.platform === "darwin") {
          const toolbar = observed.native.fullscreenToolbar;
          matches = toolbar?.fullscreenHostReady === true && toolbar.fullscreen
            && (input.visible
            ? toolbar.alwaysShowInFullScreen
              && toolbar.accessoryOnScreen
              && toolbar.accessoryVisibleHeight > TOOLBAR_HEIGHT_TOLERANCE
              && toolbar.tabStripOnScreen
              && toolbar.toolbarPinned
              && toolbar.visibleTrafficLightCount === 3
            : !toolbar.alwaysShowInFullScreen
              && !toolbar.accessoryOnScreen
              && toolbar.accessoryVisibleHeight <= TOOLBAR_HEIGHT_TOLERANCE
              && !toolbar.tabStripOnScreen
              && !toolbar.toolbarPinned
              && toolbar.presentationAutoHideToolbar
              && !toolbar.revealLocked
              && toolbar.visibleTrafficLightCount === 0);
        } else if (matches && input.fullscreen) {
          const height = observed.native.tabStripBounds?.height;
          matches = height !== undefined && (input.visible
            ? Math.abs(height - input.baselineHeight) <= TOOLBAR_HEIGHT_TOLERANCE
            : Math.abs(height - REVEAL_EDGE_HEIGHT) <= TOOLBAR_HEIGHT_TOLERANCE);
        }
        stableSamples = matches ? stableSamples + 1 : 0;
        return stableSamples >= (input.fullscreen ? 6 : 1);
      },
      {
        interval: 50,
        timeout: 10_000,
        timeoutMsg: "Fullscreen toolbar visual state did not converge"
      }
    );
  } catch (error) {
    throw new Error(
      `Fullscreen toolbar visual state did not converge: expected=${JSON.stringify(input)} `
      + `observed=${JSON.stringify(observed?.native)}`,
      { cause: error }
    );
  }
  if (!observed) throw new Error("Fullscreen toolbar snapshot is unavailable");
  return observed;
}

async function revealMacFullscreenToolbar(
  snapshot: DesktopE2eWindowSnapshot,
  baselineHeight: number
): Promise<DesktopE2eWindowSnapshot> {
  await controlWindow(snapshot.windowId, {
    action: "movePointerToFullscreenToolbar"
  });
  let observed: DesktopE2eWindowSnapshot | undefined;
  try {
    await browser.waitUntil(
      async () => {
        observed = await windowSnapshot(snapshot.windowId);
        const toolbar = observed.native.fullscreenToolbar;
        return observed.native.presentation === "fullscreen"
          && toolbar?.fullscreen === true
          && toolbar.fullscreenHostReady
          && !toolbar.alwaysShowInFullScreen
          && toolbar.presentationAutoHideToolbar
          && !toolbar.toolbarPinned
          && toolbar.accessoryOnScreen
          && Math.abs(toolbar.accessoryVisibleHeight - baselineHeight)
            <= TOOLBAR_HEIGHT_TOLERANCE
          && toolbar.tabStripOnScreen
          && toolbar.visibleTrafficLightCount === 3;
      },
      {
        interval: 50,
        timeout: 10_000,
        timeoutMsg: "macOS fullscreen toolbar did not reveal at the screen edge"
      }
    );
  } catch (error) {
    throw new Error(
      `macOS fullscreen toolbar did not reveal at the screen edge: observed=`
      + JSON.stringify(observed?.native),
      { cause: error }
    );
  }
  if (!observed) throw new Error("Fullscreen toolbar reveal snapshot is unavailable");
  return observed;
}

export async function exerciseFullscreenToolbarPreference(roleId: string): Promise<void> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const tab = runtime.tabs.find((candidate) => candidate.active && candidate.roleIds.includes(roleId))
    ?? runtime.tabs.find((candidate) => candidate.roleIds.includes(roleId));
  if (!tab) throw new Error("The smoke role has no runtime tab for fullscreen toolbar testing");

  const originalPreferences = await rendererCall("getRuntimeWindowPreferences");
  let current = await waitForRuntimeTabReady(tab.windowId, tab.id);
  const baselineHeight = current.native.tabStripBounds?.height
    ?? current.native.fullscreenToolbar?.accessoryVisibleHeight;
  if (baselineHeight === undefined || baselineHeight <= REVEAL_EDGE_HEIGHT) {
    throw new Error(`Fullscreen toolbar baseline is unavailable: ${JSON.stringify(current.native)}`);
  }

  let failure: unknown;
  try {
    await setFullscreenToolbarPreference(false);
    current = await enterFullscreenWithVisibleControl(current, roleId, tab.id);
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: true,
      visible: false
    });
    if (process.platform === "darwin") {
      current = await revealMacFullscreenToolbar(current, baselineHeight);
      await clickRoleContent(current, roleId, tab.id);
      current = await waitForFullscreenToolbarState(current.windowId, {
        baselineHeight,
        fullscreen: true,
        visible: false
      });
    }

    await setFullscreenToolbarPreferenceFromVisibleNativeMenu(current, true);
    if (process.platform !== "darwin") {
      current = await returnToFullscreenGameWindow(current);
    }
    await clickRoleContent(current, roleId, tab.id);
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: true,
      visible: true
    });
    await clickRoleContent(current, roleId, tab.id);
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: true,
      visible: true
    });
    current = await toggleFullscreenWithVisibleShortcut(current, roleId, tab.id, "normal");
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: false,
      visible: true
    });

    current = await enterFullscreenWithVisibleControl(current, roleId, tab.id);
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: true,
      visible: true
    });
    await setFullscreenToolbarPreferenceFromVisibleNativeMenu(current, false);
    if (process.platform !== "darwin") {
      current = await returnToFullscreenGameWindow(current);
    }
    await clickRoleContent(current, roleId, tab.id);
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: true,
      visible: false
    });
    if (process.platform === "darwin") {
      current = await revealMacFullscreenToolbar(current, baselineHeight);
      await clickRoleContent(current, roleId, tab.id);
      current = await waitForFullscreenToolbarState(current.windowId, {
        baselineHeight,
        fullscreen: true,
        visible: false
      });
    }
    current = await toggleFullscreenWithVisibleShortcut(current, roleId, tab.id, "normal");
    current = await waitForFullscreenToolbarState(current.windowId, {
      baselineHeight,
      fullscreen: false,
      visible: false
    });
  } catch (error) {
    failure = error;
  }

  let cleanupFailure: unknown;
  try {
    current = await windowSnapshot(tab.windowId);
    if (current.native.presentation === "fullscreen") {
      if (!current.native.focused) {
        current = await returnToFullscreenGameWindow(current);
      }
      current = await toggleFullscreenWithVisibleShortcut(current, roleId, tab.id, "normal");
    }
    await setFullscreenToolbarPreference(
      originalPreferences.alwaysShowToolbarInFullScreen
    );
    await controlWindow(current.windowId, { action: "focus" });
    await browser.waitUntil(
      async () => (await windowSnapshot(current.windowId)).native.focused,
      {
        interval: 50,
        timeout: 10_000,
        timeoutMsg: "Game Window did not regain focus after fullscreen-toolbar cleanup"
      }
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}
