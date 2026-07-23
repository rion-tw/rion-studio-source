import { describe, expect, it, vi } from "vitest";

import { LogService } from "../src/main/logging/LogService";
import type { CoreCommand, CoreEvent, LogEntry } from "../src/shared/generated";

function createCore() {
  let listener: ((events: CoreEvent[]) => void) | undefined;
  const invokeTyped = vi.fn(async (command: CoreCommand) => {
    if (command.type === "logsStatus") {
      return {
        currentLevel: "info",
        fileCount: 1,
        totalBytes: 10,
        oldestTimestamp: null,
        newestTimestamp: null,
        retentionDays: 14,
        maxBytes: 100,
        directory: "/logs"
      };
    }
    if (command.type === "logsQuery") return { entries: [] };
    return { inserted: 1 };
  });
  return {
    core: {
      invokeTyped,
      subscribe: (next: (events: CoreEvent[]) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    emit: (events: CoreEvent[]) => listener?.(events),
    invokeTyped
  };
}

describe("LogService", () => {
  it("submits raw captures while Rust owns identity, redaction, filtering and persistence", async () => {
    const { core, invokeTyped } = createCore();
    const service = new LogService();
    await service.initialize(core as never);
    service.info("browser", "role_started", "Role started.", {
      roleId: "role-1",
      token: "secret"
    });
    await service.flush();

    const capture = invokeTyped.mock.calls.find(
      ([command]) => command.type === "logsCapture" && command.entries[0]?.event === "role_started"
    )?.[0];
    expect(capture).toMatchObject({
      type: "logsCapture",
      entries: [{
        level: "info",
        source: "browser",
        event: "role_started",
        message: "Role started."
      }]
    });
    expect(capture?.type === "logsCapture" && capture.entries[0]?.contextRawJson)
      .toContain('"token":"secret"');
    expect(JSON.stringify(capture)).not.toContain("sessionId");
    expect(JSON.stringify(capture)).not.toContain("timestamp");
  });

  it("forwards Rust-captured entries and delegates level, query, status and clear commands", async () => {
    const { core, emit, invokeTyped } = createCore();
    const service = new LogService();
    const received: LogEntry[] = [];
    service.on("entry", (entry) => received.push(entry));
    await service.initialize(core as never);
    const entry: LogEntry = {
      id: "session:1",
      timestamp: "2026-07-23T00:00:00Z",
      level: "warn",
      source: "main",
      event: "captured",
      message: "Captured",
      sessionId: "session"
    };
    emit([{ type: "logEntriesCaptured", entries: [entry] }]);
    await service.setLevel("debug");
    await service.query({ search: "captured" });
    await service.getStatus();
    await service.clear();

    expect(received).toEqual([entry]);
    expect(invokeTyped).toHaveBeenCalledWith({ type: "logsSetLevel", level: "debug" });
    expect(invokeTyped).toHaveBeenCalledWith({
      type: "logsQuery",
      query: { search: "captured" }
    });
    expect(invokeTyped).toHaveBeenCalledWith({ type: "logsStatus" });
    expect(invokeTyped).toHaveBeenCalledWith({ type: "logsClear" });
  });

  it("tracks only transport acknowledgements and ignores late capture after shutdown", async () => {
    const { core, invokeTyped } = createCore();
    const service = new LogService();
    await service.initialize(core as never);
    service.warn("main", "before_shutdown", "Before shutdown.");
    await service.shutdown();
    service.warn("main", "after_shutdown", "After shutdown.");

    const events = invokeTyped.mock.calls
      .map(([command]) => command)
      .filter((command): command is Extract<CoreCommand, { type: "logsCapture" }> =>
        command.type === "logsCapture"
      )
      .flatMap((command) => command.entries.map((entry) => entry.event));
    expect(events).toContain("before_shutdown");
    expect(events).not.toContain("after_shutdown");
  });
});
