import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureTranscriptByteOffset,
  readTranscriptEventsAfterByteOffset
} from "./transcript";

describe("desktop E2E transcript byte cursors", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("does not admit a prior app incarnation whose sequence is numerically newer", async () => {
    directory = await mkdtemp(join(tmpdir(), "rion-transcript-"));
    const path = join(directory, "events.ndjson");
    await writeFile(path, `${JSON.stringify({
      details: { status: "failed" },
      kind: "windows-geometry-receipt",
      sequence: 863,
      timestamp: "2026-09-05T16:30:35.438Z"
    })}\n`);
    const cursor = await captureTranscriptByteOffset(path);

    await appendFile(path, `${JSON.stringify({
      details: { status: "applied" },
      kind: "windows-geometry-receipt",
      sequence: 12,
      timestamp: "2026-09-05T16:31:00.000Z"
    })}\n`);

    const events = await readTranscriptEventsAfterByteOffset(path, cursor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      details: { status: "applied" },
      sequence: 12
    });
  });
});
