import { watch } from "node:fs";
import { readFile } from "node:fs/promises";

interface DesktopE2eEvent {
  details: unknown;
  generation?: number;
  kind: string;
  revision?: number;
  sequence: number;
  timestamp: string;
  windowId?: string;
}

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

export async function readTranscriptEvents(
  path: string,
  afterSequence = 0
): Promise<DesktopE2eEvent[]> {
  const source = await readFile(path, "utf8").catch(() => "");
  return parseEvents(source).filter((event) => event.sequence > afterSequence);
}

export async function waitForTranscriptEvent(
  path: string,
  predicate: (event: DesktopE2eEvent) => boolean,
  timeoutMs = 20_000
): Promise<DesktopE2eEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const timing: { deadline?: ReturnType<typeof setTimeout> } = {};
    const close = () => {
      if (timing.deadline) clearTimeout(timing.deadline);
      watcher?.close();
    };
    const complete = (event: DesktopE2eEvent) => {
      if (settled) return;
      settled = true;
      close();
      resolve(event);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };
    const checkTranscript = async () => {
      try {
        const event = await latestMatchingEvent(path, predicate);
        if (event) complete(event);
      } catch (error) {
        fail(error);
      }
    };

    try {
      watcher = watch(path, () => void checkTranscript());
    } catch (error) {
      fail(error);
      return;
    }
    timing.deadline = setTimeout(
      () => fail(new Error(`Timed out waiting for transcript event in ${path}`)),
      timeoutMs
    );
    void checkTranscript();
  });
}
