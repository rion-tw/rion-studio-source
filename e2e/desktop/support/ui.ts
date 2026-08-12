import { $, $$, browser, expect } from "@wdio/globals";

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
  const dialog = await $("dialog[open]");
  await dialog.waitForExist({ timeout: 10_000 });
  await dialog.$(`button=${label}`).click();
  await dialog.waitForExist({ reverse: true, timeout: 10_000 });
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
