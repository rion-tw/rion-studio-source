import { watch } from "node:fs";
import { readFile } from "node:fs/promises";

import type { DesktopE2eEvent } from "./control";

function parseEvents(source: string): DesktopE2eEvent[] {
  return source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DesktopE2eEvent);
}

async function latestMatchingEvent(
  path: string,
  predicate: (event: DesktopE2eEvent) => boolean
): Promise<DesktopE2eEvent | undefined> {
  const source = await readFile(path, "utf8").catch(() => "");
  const events = parseEvents(source);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return undefined;
}

export async function waitForTranscriptEvent(
  path: string,
  predicate: (event: DesktopE2eEvent) => boolean,
  timeoutMs = 20_000
): Promise<DesktopE2eEvent> {
  const current = await latestMatchingEvent(path, predicate);
  if (current) return current;
  return new Promise((resolve, reject) => {
    const watcher = watch(path, async () => {
      const event = await latestMatchingEvent(path, predicate);
      if (!event) return;
      clearTimeout(deadline);
      watcher.close();
      resolve(event);
    });
    const deadline = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for transcript event in ${path}`));
    }, timeoutMs);
  });
}
