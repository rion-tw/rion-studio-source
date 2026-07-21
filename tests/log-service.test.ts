import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LogService } from "../src/main/logging/LogService";
import type { LogPersistence } from "../src/main/logging/LogService";
import type { LogEntry } from "../src/shared/types";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<LogService> {
  const directory = await mkdtemp(join(tmpdir(), "rion-logs-"));
  directories.push(directory);
  const service = new LogService({ userDataPath: directory, appVersion: "1.2.3", platform: "win32" });
  await service.initialize();
  return service;
}

describe("LogService", () => {
  it("writes structured entries, filters and paginates them", async () => {
    const service = await createService();
    service.info("browser", "role_started", "Role started.", { roleId: "role-1", token: "secret" });
    service.warn("macro", "macro_slow", "Macro was slow.");
    await service.flush();

    const first = await service.query({ sources: ["browser"], limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ source: "browser", event: "role_started", context: { roleId: "role-1", token: "<REDACTED>" } });

    const files = await readdir(service.directory);
    const contents = await readFile(join(service.directory, files[0]!), "utf8");
    expect(contents).not.toContain("secret");
    expect((await service.getStatus()).totalBytes).toBeGreaterThan(0);
  });

  it("keeps debug disabled by default and clears existing history", async () => {
    const service = await createService();
    service.debug("main", "hidden", "Hidden debug message.");
    service.setLevel("debug");
    service.debug("main", "visible", "Visible debug message.");
    await service.flush();
    expect((await service.query({ search: "debug message" })).entries.map((entry) => entry.event)).toEqual(["visible"]);

    await service.clear();
    await service.flush();
    const entries = (await service.query()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe("logs_cleared");
  });

  it("rejects unsafe query values", async () => {
    const service = await createService();
    await expect(service.query({ limit: 201 })).rejects.toThrow("Invalid log page size");
    await expect(service.query({ cursor: "../file" })).rejects.toThrow("Invalid log cursor");
  });

  it("buffers startup entries until the Rust persistence is ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-logs-deferred-"));
    directories.push(directory);
    const service = new LogService({
      userDataPath: directory,
      deferFileWrites: true,
      appVersion: "1.2.3",
      platform: "darwin"
    });
    const append = vi.fn(async (_entries: LogEntry[]) => undefined);
    await service.initialize();
    service.warn("main", "startup_warning", "Startup warning.");
    await service.flush();
    await expect(readdir(service.directory)).rejects.toThrow();

    const persistence: LogPersistence = {
      append,
      clear: vi.fn(async () => undefined),
      exportJsonl: vi.fn(async () => ""),
      exportJsonlTo: vi.fn(async () => undefined),
      getStatus: vi.fn(async (currentLevel) => ({
        currentLevel,
        directory,
        fileCount: 0,
        maxBytes: 1,
        retentionDays: 14,
        totalBytes: 0
      })),
      query: vi.fn(async () => ({ entries: [] }))
    };
    await service.usePersistence(persistence);

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0].map((entry) => entry.event)).toEqual([
      "app_session_started",
      "startup_warning"
    ]);
  });

  it("flushes deferred entries to JSONL when native startup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-logs-fallback-"));
    directories.push(directory);
    const service = new LogService({ userDataPath: directory, deferFileWrites: true });
    await service.initialize();
    service.error("main", "native_startup_failed", "Native startup failed.");

    await service.useFileFallback();

    const files = await readdir(service.directory);
    expect(await readFile(join(service.directory, files[0]!), "utf8")).toContain(
      "native_startup_failed"
    );
  });
});
