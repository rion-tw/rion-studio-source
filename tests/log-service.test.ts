import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LogService } from "../src/main/logging/LogService";

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
});
