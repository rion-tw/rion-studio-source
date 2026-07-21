import { describe, expect, it, vi } from "vitest";

import {
  parseWindowsGraphicsEvents,
  WindowsGraphicsEventCollector
} from "../src/main/browser/WindowsGraphicsEventCollector";

const since = new Date("2026-07-21T10:00:00.000Z");

describe("WindowsGraphicsEventCollector", () => {
  it("does not invoke Windows tools on other platforms", async () => {
    const execFile = vi.fn();
    const collector = new WindowsGraphicsEventCollector({ execFile, platform: "darwin" });

    await expect(collector.collect(since)).resolves.toEqual({ available: false, events: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("collects only recent display-driver reset events", async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: `${eventXml("Display", "2026-07-21T10:05:00.0000000Z")}${eventXml("Display", "2026-07-21T09:59:59.0000000Z")}${otherEventXml()}`
    });
    const collector = new WindowsGraphicsEventCollector({ execFile, platform: "win32" });

    await expect(collector.collect(since)).resolves.toEqual({
      available: true,
      events: [{ eventId: 4101, provider: "Display", timestamp: "2026-07-21T10:05:00.000Z" }]
    });
    expect(execFile).toHaveBeenCalledWith("wevtutil", expect.arrayContaining([
      "qe",
      "System",
      "/f:RenderedXml",
      "/rd:true"
    ]));
  });

  it("returns a safe unavailable result for missing permission or command failures", async () => {
    const collector = new WindowsGraphicsEventCollector({
      execFile: vi.fn().mockRejectedValue(new Error("Access is denied.")),
      platform: "win32"
    });

    await expect(collector.collect(since)).resolves.toEqual({
      available: false,
      events: [],
      error: "Access is denied."
    });
  });

  it("tolerates empty and malformed event output", () => {
    expect(parseWindowsGraphicsEvents("", since)).toEqual([]);
    expect(parseWindowsGraphicsEvents("<Event><System><EventID>4101</EventID></System></Event>", since)).toEqual([]);
    expect(parseWindowsGraphicsEvents(eventXml("Display", "not-a-date"), since)).toEqual([]);
  });
});

function eventXml(provider: string, timestamp: string): string {
  return `<Event><System><Provider Name="${provider}"/><EventID>4101</EventID><TimeCreated SystemTime="${timestamp}"/></System></Event>`;
}

function otherEventXml(): string {
  return `<Event><System><Provider Name="Display"/><EventID>1</EventID><TimeCreated SystemTime="2026-07-21T10:05:00.0000000Z"/></System></Event>`;
}
