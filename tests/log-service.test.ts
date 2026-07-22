import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  await service.usePersistence(createMemoryPersistence(directory));
  return service;
}

function createMemoryPersistence(directory: string): LogPersistence {
  let entries: LogEntry[] = [];
  return {
    append: async (batch) => { entries.push(...structuredClone(batch)); },
    clear: async () => { entries = []; },
    exportJsonlTo: async (path) => writeFile(
      path,
      entries.map((entry) => JSON.stringify(entry)).join("\n")
    ),
    getStatus: async (currentLevel) => ({
      currentLevel,
      directory,
      fileCount: entries.length > 0 ? 1 : 0,
      maxBytes: 100 * 1024 * 1024,
      retentionDays: 14,
      totalBytes: Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n"))
    }),
    query: async (query) => {
      const search = query.search?.toLocaleLowerCase();
      const filtered = entries.filter((entry) =>
        (!query.sources?.length || query.sources.includes(entry.source)) &&
        (!search || JSON.stringify(entry).toLocaleLowerCase().includes(search))
      ).reverse();
      return { entries: filtered.slice(0, query.limit ?? 100) };
    }
  };
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

    const exportPath = join(directories[0]!, "logs.jsonl");
    const [file] = await service.getFiles(exportPath);
    const contents = await readFile(file!.path!, "utf8");
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

  it("does not create a production JSONL fallback when native startup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-logs-fallback-"));
    directories.push(directory);
    const service = new LogService({ userDataPath: directory, deferFileWrites: true });
    await service.initialize();
    service.error("main", "native_startup_failed", "Native startup failed.");

    await service.flush();

    await expect(service.query()).rejects.toThrow("Rust log persistence is not initialized");
    await expect(readdir(service.directory)).rejects.toThrow();
  });

  it("drains queued writes and rejects late log events during shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-logs-shutdown-"));
    directories.push(directory);
    const append = vi.fn(async (_entries: LogEntry[]) => undefined);
    const service = new LogService({ userDataPath: directory });
    await service.usePersistence({
      ...createMemoryPersistence(directory),
      append
    });

    service.info("main", "before_shutdown", "Written before shutdown.");
    await service.shutdown();
    service.info("main", "after_shutdown", "Must not reach Rust persistence.");
    await service.flush();

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0].map((entry) => entry.event)).toEqual(["before_shutdown"]);
    await expect(service.usePersistence(createMemoryPersistence(directory))).rejects.toThrow(
      "Log service is shut down"
    );
  });
});
