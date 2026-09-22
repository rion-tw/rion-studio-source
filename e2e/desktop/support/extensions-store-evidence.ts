import { appendFile, writeFile } from "node:fs/promises";
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { browser } from "@wdio/globals";
import type {} from "@wdio/electron-service";

type StoreJournal = { __rionStoreEvents?: Readonly<Record<string, unknown>>[] };
const artifacts = () => process.env.RION_STUDIO_E2E_ARTIFACT_DIR!;

export async function observeStore(): Promise<number> {
  const url = await browser.getUrl();
  return browser.electron.execute((electron, expectedUrl) => {
    const stores = electron.webContents.getAllWebContents().filter(contents => contents.getURL() === expectedUrl);
    if (stores.length !== 1) throw new Error("The visible store must identify exactly one WebContents");
    const contents = stores[0]!;
    const journal = contents as typeof contents & StoreJournal;
    if (!journal.__rionStoreEvents) {
      journal.__rionStoreEvents = [];
      for (const name of ["did-start-navigation", "did-navigate-in-page", "did-navigate", "did-finish-load", "did-fail-load", "render-process-gone", "destroyed"] as const) {
        (contents as EventEmitter).on(name, (...args: unknown[]) => {
          const event = args[0] as { url?: string; isMainFrame?: boolean; isSameDocument?: boolean };
          journal.__rionStoreEvents!.push({
            event: name, time: Date.now(), url: event?.url,
            main: event?.isMainFrame, sameDocument: event?.isSameDocument,
            args: args.slice(1).filter(value => typeof value !== "object"),
            index: contents.isDestroyed() ? null : contents.navigationHistory.getActiveIndex(),
            currentUrl: contents.isDestroyed() ? null : contents.getURL()
          });
        });
      }
    }
    return contents.id;
  }, url);
}

export async function storeState(id: number) {
  return browser.electron.execute((electron, target) => {
    const contents = electron.webContents.fromId(target);
    if (!contents || contents.isDestroyed()) throw new Error(`Store WebContents ${target} retired`);
    return { id: contents.id, url: contents.getURL(), index: contents.navigationHistory.getActiveIndex(),
      history: contents.navigationHistory.getAllEntries().map(entry => entry.url), loading: contents.isLoadingMainFrame() };
  }, id);
}

export async function recordStoreEvidence(id: number, label: string, screenshot = false): Promise<void> {
  const native = await browser.electron.execute((electron, target) => {
    const contents = electron.webContents.fromId(target);
    if (!contents || contents.isDestroyed()) return { id: target, destroyed: true };
    return { id: target, url: contents.getURL(), index: contents.navigationHistory.getActiveIndex(),
      history: contents.navigationHistory.getAllEntries().map(entry => entry.url), loading: contents.isLoadingMainFrame(),
      events: (contents as typeof contents & StoreJournal).__rionStoreEvents };
  }, id);
  // Persist the navigation journal first, even if a crashed renderer cannot answer a DOM read.
  await appendFile(join(artifacts(), "store-navigation.jsonl"), JSON.stringify({ label, native }) + "\n");
  const document = await browser.electron.execute(async (electron, target) => {
    const contents = electron.webContents.fromId(target);
    if (!contents || contents.isDestroyed()) return null;
    return contents.executeJavaScript(`({ url: location.href, document: performance.timeOrigin,
      ready: document.readyState, title: document.title, text: document.body?.innerText.slice(0, 12000),
      headings: [...document.querySelectorAll('h1')].map(node => node.innerText),
      links: [...document.querySelectorAll('a[href]')].filter(node => node.getBoundingClientRect().height > 0)
        .map(node => ({ text: node.innerText, href: node.href })).slice(0, 100) })`);
  }, id);
  await appendFile(join(artifacts(), "store-navigation.jsonl"), JSON.stringify({ label, document }) + "\n");
  if (screenshot) {
    const png = await browser.electron.execute(async (electron, target) => {
      const contents = electron.webContents.fromId(target);
      return contents && !contents.isDestroyed() ? (await contents.capturePage()).toPNG().toString("base64") : null;
    }, id);
    if (png) await writeFile(join(artifacts(), "screenshots", "store-navigation-failure.png"), Buffer.from(png, "base64"));
  }
}
