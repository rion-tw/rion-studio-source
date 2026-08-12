import { $, $$, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

const LANGUAGE_STORAGE_KEY = "rion-studio-language";

export async function ensureEnglishUi(): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute(() => document.readyState === "complete"),
    { timeout: 30_000, timeoutMsg: "Desktop renderer did not finish loading" }
  );
  const needsReload = await browser.execute((storageKey) => {
    if (localStorage.getItem(storageKey) === "en" && document.documentElement.lang === "en") {
      return false;
    }
    localStorage.setItem(storageKey, "en");
    return true;
  }, LANGUAGE_STORAGE_KEY);
  if (needsReload) {
    await browser.execute(() => window.location.reload());
    await browser.waitUntil(
      async () => browser.execute(() => document.readyState === "complete" && document.documentElement.lang === "en"),
      { timeout: 30_000, timeoutMsg: "Desktop renderer did not reload in English" }
    );
  }
}

export async function acceptLegalAndSkipFirstRun(): Promise<void> {
  const checkboxes = await $$("button[role='checkbox']");
  if ((await checkboxes.length) === 2) {
    await checkboxes[0].click();
    await checkboxes[1].click();
    const continueButton = await $("button=Agree and continue");
    await continueButton.click();
    await continueButton.waitForExist({ reverse: true, timeout: 15_000 });
  }

  const skip = await $("button=Set up later");
  if (await skip.isExisting()) {
    await skip.click();
    await skip.waitForExist({ reverse: true, timeout: 15_000 });
  }
  await $(".app-main-sidebar").waitForExist({ timeout: 20_000 });
}

export async function navigate(path: string): Promise<void> {
  await browser.execute((nextPath) => {
    window.location.hash = `#${nextPath}`;
  }, path);
  await waitForRoute(path);
}

export async function waitForRoute(path: string): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute((expected) => window.location.hash.startsWith(`#${expected}`), path),
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
  await browser.execute((selectionId) => {
    const item = document.querySelector<HTMLElement>(
      `[data-selection-id='${CSS.escape(selectionId)}']`
    );
    if (!item) throw new Error(`Selection item ${selectionId} is unavailable`);
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      buttons: 2,
      cancelable: true,
      clientX: rect.left + Math.min(24, rect.width / 2),
      clientY: rect.top + Math.min(24, rect.height / 2),
      view: window
    }));
  }, entityId);
  const menu = await $("[role='menu'][data-state='open']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(`.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}
