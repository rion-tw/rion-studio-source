import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const transcriptRace = vi.hoisted(() => ({
  armed: false,
  eventLine: "",
  path: ""
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const actualReadFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const snapshot = await actualReadFile(...args);
      if (transcriptRace.armed) {
        transcriptRace.armed = false;
        await actual.appendFile(transcriptRace.path, transcriptRace.eventLine);
      }
      return snapshot;
    }
  };
});

import { waitForTranscriptEvent } from "../e2e/desktop/support/transcript";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  transcriptRace.armed = false;
  transcriptRace.eventLine = "";
  transcriptRace.path = "";
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("desktop E2E transcript event waiting", () => {
  it("observes an event written between the initial read and its completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-transcript-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "events.ndjson");
    await writeFile(transcriptPath, "");
    transcriptRace.path = transcriptPath;
    transcriptRace.eventLine = `${JSON.stringify({
      details: { complete: true },
      kind: "application-final-flush-complete",
      timestamp: "2026-08-13T22:12:09.551715+00:00"
    })}\n`;
    transcriptRace.armed = true;

    const event = await waitForTranscriptEvent(
      transcriptPath,
      (candidate) => candidate.kind === "application-final-flush-complete",
      1_000
    );

    expect(event.kind).toBe("application-final-flush-complete");
    expect(event.details).toEqual({ complete: true });
  });
});
