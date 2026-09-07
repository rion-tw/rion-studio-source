import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { exactResponse, runProcess } from "../scripts/migrationDiagnostics/process.mjs";

import { controlledDocumentAllowed } from "../scripts/migrationDiagnostics/offlinePolicy";

import { mergeMissing } from "../scripts/migrationDiagnostics/mergeMissing";

function wire(platform: string) {
  const body = Buffer.from(JSON.stringify({ receipt: "synthetic" }));
  const header = Buffer.alloc(20);
  header.write("RCHRES01"); header.writeUInt32BE(body.length, 12);
  return Buffer.concat([Buffer.from(platform === "win32" ? "\r\n" : ""), header, body]);
}

describe("migration diagnostic native framing", () => {
  it.each(["darwin", "win32"])("requires the exact %s frame and rejects truncation or trailing bytes", platform => {
    const valid = wire(platform);
    expect(exactResponse(valid, platform)).toEqual({ outcome: 0, metadata: { receipt: "synthetic" } });
    for (let end = 0; end < valid.length; end++) expect(() => exactResponse(valid.subarray(0, end), platform)).toThrow();
    expect(() => exactResponse(Buffer.concat([valid, Buffer.from([0])]), platform)).toThrow();
    expect(() => exactResponse(Buffer.concat([Buffer.from("junk"), valid]), platform)).toThrow();
  });
  it("does not accept portable hosts as native platform evidence", () => {
    expect(() => exactResponse(wire("darwin"), "linux")).toThrow("NATIVE_PLATFORM_REQUIRED");
  });
  it("requires clean native exit in addition to a valid-looking response", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write('receipt'); process.exit(1)"])).rejects.toThrow("NATIVE_PROCESS_FAILED");
  });
  it("cancellation kills and joins the exact child without interpreting partial output", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(runProcess(process.execPath, ["-e", "process.stdin.resume()"], { signal: abort.signal })).rejects.toThrow("DIAGNOSTIC_CANCELLED");
  });
  it("joins a child with missing acknowledgement as failed when its external deadline expires", async () => {
    await expect(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 30 })).rejects.toThrow("NATIVE_PROCESS_FAILED");
  });
});

describe("migration diagnostic production isolation", () => {
  it("requires an explicit Rust feature and has no production build reference", async () => {
    const [cargo, core, builder, build, vite] = await Promise.all([
      readFile("crates/rion-core/Cargo.toml", "utf8"), readFile("crates/rion-core/src/lib.rs", "utf8"),
      readFile("electron-builder.config.mjs", "utf8"), readFile("scripts/buildElectronRust.mjs", "utf8"),
      readFile("electron.vite.config.ts", "utf8")
    ]);
    expect(cargo).toContain('required-features = ["session-migration-diagnostics"]');
    expect(core).toContain('#[cfg(feature = "session-migration-diagnostics")]\npub mod migration_diagnostics;');
    expect(build).not.toContain("session-migration-diagnostics");
    for (const source of [builder, vite]) expect(source).not.toContain("migrationDiagnostics");
  });
});


describe("retained source offline document admission", () => {
  it.each(["darwin", "win32"])("requires an installed local handler on %s, including IP literals", () => {
    const handler = new Set(["https"]);
    for (const host of ["actual-site.example", "127.0.0.1", "[::1]", "fixture.invalid"]) {
      const url = `https://${host}/.__rion_session_migration__`;
      expect(controlledDocumentAllowed(url, handler)).toBe(true);
      expect(controlledDocumentAllowed(url, new Set())).toBe(false);
      for (const suffix of ["?network=1", "#redirect", "/other"]) expect(controlledDocumentAllowed(url + suffix, handler)).toBe(false);
    }
    for (const url of ["https://example.com/", "http://example.com/.__rion_session_migration__", "https://user:pass@example.com/.__rion_session_migration__", "file:///.__rion_session_migration__"]) {
      expect(controlledDocumentAllowed(url, handler)).toBe(false);
    }
  });
});


describe("retained LocalStorage missing-key repair", () => {
  it.each(["darwin", "win32"])("preserves all current keys and conflicting sign-in values on %s", () => {
    const current = [{ key: "session", value: "new-login" }, { key: "new-setting", value: "current" }];
    const old = [{ key: "session", value: "expired-login" }, { key: "舊設定\0", value: "\ud800retained" }];
    const result = mergeMissing(current, old);
    expect(result).toEqual([{ key: "new-setting", value: "current" }, { key: "session", value: "new-login" }, { key: "舊設定\0", value: "\ud800retained" }]);
    expect(mergeMissing(result, old)).toEqual(result);
    expect(current).toHaveLength(2);
    expect(() => mergeMissing(current, [old[0], old[0]])).toThrow("DUPLICATE_RETAINED_KEY");
    expect(() => mergeMissing([current[0], current[0]], [])).toThrow("DUPLICATE_CURRENT_KEY");
  });
});
