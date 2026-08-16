import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import { focusMainApplicationWindow } from "./control";

const LANGUAGE_STORAGE_KEY = "rion-studio-language";
const RENDERER_PROBE_TIMEOUT_MS = 5_000;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const LEGAL_CHECKBOX_SELECTOR = "[role='checkbox']";
const LEGAL_CONTINUE_SELECTOR = "[data-testid='legal-onboarding-continue']";
const FIRST_RUN_SKIP_SELECTOR = "[data-testid='onboarding-skip']";
const MAIN_SIDEBAR_SELECTOR = ".app-main-sidebar";

type InitialScreen = "first-run" | "legal" | "main";

const INITIAL_SCREEN_SELECTORS: Record<InitialScreen, string> = {
  "first-run": FIRST_RUN_SKIP_SELECTOR,
  legal: LEGAL_CONTINUE_SELECTOR,
  main: MAIN_SIDEBAR_SELECTOR
};

interface RendererNavigationResult {
  error?: string;
  ok: boolean;
}

async function waitForRenderer(
  condition: () => boolean,
  timeoutMsg: string
): Promise<void> {
  const { script: previousScriptTimeout } = await browser.getTimeouts();
  let lastProbeError: unknown;
  await browser.setTimeout({ script: RENDERER_PROBE_TIMEOUT_MS });
  try {
    try {
      await browser.waitUntil(async () => {
        try {
          return await browser.execute(condition);
        } catch (error) {
          lastProbeError = error;
          return false;
        }
      }, {
        timeout: RENDERER_READY_TIMEOUT_MS,
        timeoutMsg
      });
    } catch (error) {
      if (lastProbeError === undefined) throw error;
      const detail = lastProbeError instanceof Error
        ? lastProbeError.message
        : String(lastProbeError);
      throw new Error(`${timeoutMsg}. Last readiness probe failed: ${detail}`, { cause: error });
    }
  } finally {
    if (typeof previousScriptTimeout === "number") {
      await browser.setTimeout({ script: previousScriptTimeout });
    }
  }
}

export async function ensureEnglishUi(): Promise<void> {
  await waitForRenderer(
    () => document.readyState === "complete",
    "Desktop renderer did not finish loading"
  );
  const needsReload = await browser.execute((storageKey) => {
    const shouldReload = localStorage.getItem(storageKey) !== "en"
      || document.documentElement.lang !== "en";
    localStorage.setItem(storageKey, "en");
    return shouldReload;
  }, LANGUAGE_STORAGE_KEY);
  if (needsReload) {
    await browser.refresh();
    await waitForRenderer(
      () => document.readyState === "complete" && document.documentElement.lang === "en",
      "Desktop renderer did not reload in English"
    );
  }
}

async function waitForInitialScreen(
  expected: readonly InitialScreen[] = ["legal", "first-run", "main"]
): Promise<InitialScreen> {
  let screen: InitialScreen | undefined;
  await browser.waitUntil(async () => {
    for (const candidate of expected) {
      const element = await $(INITIAL_SCREEN_SELECTORS[candidate]);
      if (await element.isExisting()) {
        screen = candidate;
        return true;
      }
    }
    return false;
  }, {
    timeout: RENDERER_READY_TIMEOUT_MS,
    timeoutMsg: `Desktop renderer did not reach an expected initial screen: ${expected.join(", ")}`
  });
  if (!screen) throw new Error("Desktop renderer initial screen is unavailable");
  return screen;
}

export async function acceptLegalAndSkipFirstRun(): Promise<void> {
  let screen = await waitForInitialScreen();
  if (screen === "legal") {
    await browser.waitUntil(
      async () => {
        const checkboxes = await $$(LEGAL_CHECKBOX_SELECTOR);
        return await checkboxes.length === 2;
      },
      {
        timeout: 10_000,
        timeoutMsg: "Legal onboarding did not expose both agreement checkboxes"
      }
    );
    const checkboxes = await $$(LEGAL_CHECKBOX_SELECTOR);
    for (const checkbox of checkboxes) await checkbox.click();
    const continueButton = await $(LEGAL_CONTINUE_SELECTOR);
    await continueButton.waitForEnabled({ timeout: 10_000 });
    await continueButton.click();
    await continueButton.waitForExist({ reverse: true, timeout: 15_000 });
    screen = await waitForInitialScreen(["first-run", "main"]);
  }

  if (screen === "first-run") {
    const skip = await $(FIRST_RUN_SKIP_SELECTOR);
    await skip.waitForEnabled({ timeout: 10_000 });
    await skip.click();
    await skip.waitForExist({ reverse: true, timeout: 15_000 });
  }
  const sidebar = await $(MAIN_SIDEBAR_SELECTOR);
  await sidebar.waitForExist({ timeout: 20_000 });
}

export async function navigate(path: string): Promise<void> {
  const result = await browser.executeAsync(
    (nextPath: string, done: (result: RendererNavigationResult) => void) => {
      const navigateToRoute = window.__rionStudioDesktopE2eNavigate;
      if (!navigateToRoute) {
        done({ error: "Desktop E2E router navigation is unavailable", ok: false });
        return;
      }
      void navigateToRoute(nextPath).then(
        () => done({ ok: true }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    path
  ) as RendererNavigationResult;
  if (!result.ok) throw new Error(result.error ?? `Desktop renderer rejected navigation to ${path}`);
  await waitForRoute(path);
}

export async function waitForRoute(path: string): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute((expected) => window.location.hash === `#${expected}`, path),
    { timeout: 15_000, timeoutMsg: `Desktop renderer did not navigate to ${path}` }
  );
  const pending = await $("[data-renderer-pending]");
  if (await pending.isExisting()) {
    await pending.waitForExist({ reverse: true, timeout: 15_000 });
  }
}

export async function setEditorTitle(value: string): Promise<void> {
  const title = await $("#app-editor-form [role='textbox'][contenteditable]");
  await title.waitForExist({ timeout: 10_000 });
  await browser.execute((nextValue) => {
    const element = document.querySelector<HTMLElement>(
      "#app-editor-form [role='textbox'][contenteditable]"
    );
    if (!element) throw new Error("Editor title is unavailable");
    element.textContent = nextValue;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType: "insertText"
    }));
  }, value);
  await expect(title).toHaveText(value);
}

export async function submitEditor(expectedRoute: string): Promise<void> {
  const submit = await $("#app-editor-form button[type='submit']");
  await expect(submit).toBeEnabled();
  await submit.click();
  await waitForRoute(expectedRoute);
}

export async function clickConfirmation(label: "Cancel" | "Delete"): Promise<void> {
  await clickDialogButton(label);
}

export async function clickDialogButton(label: string): Promise<void> {
  const dialog = await $("dialog[open]");
  await dialog.waitForExist({ timeout: 10_000 });
  await dialog.$(`button=${label}`).click();
  await dialog.waitForExist({ reverse: true, timeout: 10_000 });
}

export async function selectEntityItems(entityIds: readonly string[]): Promise<void> {
  if (entityIds.length === 0) throw new Error("At least one entity is required for UI selection");
  await browser.action("key").down(Key.Ctrl).perform(true);
  try {
    for (const entityId of entityIds) {
      const entity = await $(`[data-selection-id='${entityId}']`);
      await entity.waitForExist({ timeout: 10_000 });
      await entity.click();
    }
  } finally {
    await browser.releaseActions();
  }
  const toolbar = await $(`[role='toolbar'][aria-label='${entityIds.length} selected']`);
  if (!(await toolbar.isExisting())) {
    await browser.execute((selectionIds) => {
      const isMacOS = document.documentElement.dataset.platform === "macos";
      for (const selectionId of selectionIds) {
        const item = document.querySelector<HTMLElement>(
          `[data-selection-id='${CSS.escape(selectionId)}']`
        );
        if (!item) throw new Error(`Selection item ${selectionId} is unavailable`);
        item.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          button: 0,
          buttons: 0,
          cancelable: true,
          ctrlKey: !isMacOS,
          metaKey: isMacOS,
          view: window
        }));
      }
    }, entityIds);
  }
  await toolbar.waitForExist({ timeout: 10_000 });
}

export async function dragEntityTo(
  sourceId: string,
  targetId: string,
  handleLabel: string
): Promise<void> {
  await browser.execute(() => {
    const testWindow = window as unknown as {
      __rionPointerEventCount?: number;
      __rionPointerEventCounterInstalled?: boolean;
    };
    testWindow.__rionPointerEventCount = 0;
    if (testWindow.__rionPointerEventCounterInstalled) return;
    testWindow.__rionPointerEventCounterInstalled = true;
    window.addEventListener("pointerdown", () => {
      testWindow.__rionPointerEventCount = (testWindow.__rionPointerEventCount ?? 0) + 1;
    }, true);
  });
  const source = await $(`[data-selection-id='${sourceId}']`);
  const target = await $(`[data-selection-id='${targetId}']`);
  await source.waitForDisplayed({ timeout: 10_000 });
  await target.waitForDisplayed({ timeout: 10_000 });
  await source.scrollIntoView({ block: "center" });
  const handle = await source.$(`button[aria-label='${handleLabel}']`);
  await handle.waitForExist({ timeout: 10_000 });
  await browser.action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 250, origin: handle })
    .pause(200)
    .down("left")
    .move({ duration: 700, origin: target })
    .up("left")
    .perform();
  const pointerEventCount = await browser.execute(() => (
    window as unknown as { __rionPointerEventCount?: number }
  ).__rionPointerEventCount ?? 0);
  if (pointerEventCount > 0) return;

  await browser.execute((sourceSelectionId, targetSelectionId, label) => {
    const sourceCard = document.querySelector<HTMLElement>(
      `[data-selection-id='${CSS.escape(sourceSelectionId)}']`
    );
    const targetCard = document.querySelector<HTMLElement>(
      `[data-selection-id='${CSS.escape(targetSelectionId)}']`
    );
    const handleButton = Array.from(sourceCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === label);
    if (!sourceCard || !targetCard || !handleButton) {
      throw new Error("Pointer reorder UI targets are unavailable");
    }

    const sourceRect = handleButton.getBoundingClientRect();
    const targetRect = targetCard.getBoundingClientRect();
    const pointerId = 1;
    const dispatch = (
      targetElement: EventTarget,
      type: "pointerdown" | "pointermove" | "pointerup",
      clientX: number,
      clientY: number,
      buttons: number
    ): void => {
      targetElement.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons,
        cancelable: true,
        clientX,
        clientY,
        isPrimary: true,
        pointerId,
        pointerType: "mouse"
      }));
    };
    const originalSetPointerCapture = handleButton.setPointerCapture;
    const originalReleasePointerCapture = handleButton.releasePointerCapture;
    handleButton.setPointerCapture = () => undefined;
    handleButton.releasePointerCapture = () => undefined;
    try {
      dispatch(
        handleButton,
        "pointerdown",
        sourceRect.left + sourceRect.width / 2,
        sourceRect.top + sourceRect.height / 2,
        1
      );
      dispatch(
        window,
        "pointermove",
        targetRect.left + targetRect.width / 2,
        targetRect.top + targetRect.height / 2,
        1
      );
      dispatch(
        window,
        "pointerup",
        targetRect.left + targetRect.width / 2,
        targetRect.top + targetRect.height / 2,
        0
      );
    } finally {
      handleButton.setPointerCapture = originalSetPointerCapture;
      handleButton.releasePointerCapture = originalReleasePointerCapture;
    }
  }, sourceId, targetId, handleLabel);
}

export async function clickEntityMenuAction(
  entityId: string,
  triggerLabel: string,
  actionLabel: string
): Promise<void> {
  const entity = await $(`[data-selection-id='${entityId}']`);
  await entity.waitForExist({ timeout: 10_000 });
  const trigger = await entity.$(`button[aria-label='${triggerLabel}']`);
  await trigger.waitForExist({ timeout: 10_000 });
  await trigger.scrollIntoView({ block: "center", inline: "center" });
  await focusMainApplicationWindow();
  await browser.execute((control) => control.focus({ preventScroll: true }), trigger);
  await trigger.waitForDisplayed({ timeout: 10_000 });
  await trigger.moveTo();
  await trigger.waitForClickable({ timeout: 10_000 });
  if (await trigger.getAttribute("data-state") === null) {
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: trigger })
      .down("left")
      .up("left")
      .perform();
  } else {
    await browser.action("key").down(Key.Enter).up(Key.Enter).perform();
  }
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(`.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}
