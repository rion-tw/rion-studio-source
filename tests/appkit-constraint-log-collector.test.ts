import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appKitConstraintPrefixes, collectAppKitConstraintDiagnostics } from
  "../scripts/collectAppKitConstraintDiagnostics.mjs";

let root: string;
beforeEach(async () => { root = await mkdtemp(resolve(tmpdir(), "rion-appkit-native-log-")); });
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir())+sep) || !root.includes("rion-appkit-native-log-")) {
    throw new Error("Diagnostic test cleanup escaped its temporary root");
  }
  await rm(root, { recursive: true, force: true });
});
async function witness(processId = 731, phase = "chromium-workspace-gap-dividers-seed", changes = {}) {
  const directory = resolve(root, "run-darwin", "phases", phase);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "appkit-constraint-launch-witness.json"), JSON.stringify({
    schemaVersion: 1, processId, bridgeProcessId: processId, nativeDiagnosticEnabled: true, phase, ...changes
  }));
}
const row = (processID: number, prefix = appKitConstraintPrefixes[0]!) => ({
  processID, timestamp: "2026-10-14 22:00:00.000000+0000",
  eventMessage: prefix+JSON.stringify({ windowPointer: "0x1234", minSize: { width: 640, height: 512 } })
});
const options = (records: unknown[] = [row(731)]) => ({
  artifactRoot: root, platform: "darwin" as const,
  inspectPrefixes: vi.fn(async () => appKitConstraintPrefixes),
  execute: vi.fn(async () => ({ stdout: JSON.stringify(records) }))
});

describe("exact AppKit native diagnostic log collection", () => {
  it("queries only admitted PIDs and exact public prefixes, persisting scoped evidence and binary prefix proof", async () => {
    await witness();
    await witness(732, "chromium-entity-persistence-seed");
    const input = options([row(731), row(732, appKitConstraintPrefixes[1]), row(999),
      { ...row(731), eventMessage: "unrelated private application message" },
      { ...row(731), eventMessage: "prefix impostor "+row(731).eventMessage }]);
    await expect(collectAppKitConstraintDiagnostics(input)).resolves.toMatchObject({
      processIds: [731, 732], rowCount: 2, invalidPayloadCount: 0
    });
    expect(input.execute).toHaveBeenCalledWith("/usr/bin/log", ["show", "--style", "json", "--info", "--debug",
      "--last", "15m", "--predicate",
      '(processID == 731 OR processID == 732) AND (eventMessage BEGINSWITH "RION_APPKIT_CONSTRAINT_DIAGNOSTIC " OR eventMessage BEGINSWITH "RION_APPKIT_CORNER_CONSTRAINT_DIAGNOSTIC ")'],
    { timeout: 60_000, maxBuffer: 64*1024*1024 });
    const stored = JSON.parse(await readFile(resolve(root, "appkit-constraint-native-logs", "native-constraint-rows.json"), "utf8"));
    expect(stored).toHaveLength(2);
    expect(stored.map((value: { processId: number }) => value.processId)).toEqual([731, 732]);
    expect(await readFile(resolve(root, "appkit-constraint-native-logs", "native-prefix-presence.txt"), "utf8"))
      .toBe(appKitConstraintPrefixes.map(value => value.trimEnd()).join("\n")+"\n");
  });

  it.each([{ processId: 0, bridgeProcessId: 0 }, { processId: 731.5, bridgeProcessId: 731.5 },
    { bridgeProcessId: 732 }, { nativeDiagnosticEnabled: false }, { processId: "731", bridgeProcessId: "731" },
    { schemaVersion: 2 }])("rejects invalid process/flag witness %j before log access", async change => {
    await witness(731, "chromium-workspace-gap-dividers-seed", change);
    const input = options();
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toThrow("witness is invalid");
    expect(input.execute).not.toHaveBeenCalled();
  });

  it("rejects missing witnesses without querying arbitrary native processes", async () => {
    const input = options();
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toThrow("No AppKit native process/flag witnesses");
    expect(input.execute).not.toHaveBeenCalled();
  });

  it("requires both prefixes in the actual native binary before collecting logs", async () => {
    await witness();
    const input = options();
    input.inspectPrefixes.mockResolvedValue([appKitConstraintPrefixes[0]!]);
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toThrow("missing a diagnostic prefix");
    expect(input.execute).not.toHaveBeenCalled();
  });

  it("explicitly fails zero diagnostic rows while preserving the collection report", async () => {
    await witness();
    const input = options([row(999)]);
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toThrow("No native AppKit constraint diagnostic rows");
    const report = JSON.parse(await readFile(resolve(root, "appkit-constraint-native-logs", "collection-report.json"), "utf8"));
    expect(report).toMatchObject({ processIds: [731], rowCount: 0 });
  });

  it("rejects truncated or redacted native JSON while preserving the raw scoped rows", async () => {
    await witness();
    const input = options([{ ...row(731), eventMessage: appKitConstraintPrefixes[0]+"<private>" }]);
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toThrow("incomplete JSON payloads");
    const report = JSON.parse(await readFile(resolve(root, "appkit-constraint-native-logs", "collection-report.json"), "utf8"));
    expect(report).toMatchObject({ rowCount: 1, invalidPayloadCount: 1 });
  });

  it("preserves an external native log read failure without retry or fallback", async () => {
    await witness();
    const input = options();
    const error = new Error("native log read denied");
    input.execute.mockRejectedValue(error);
    await expect(collectAppKitConstraintDiagnostics(input)).rejects.toBe(error);
    expect(input.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses this native diagnostic on another platform", async () => {
    const input = options();
    await expect(collectAppKitConstraintDiagnostics({ ...input, platform: "win32" })).rejects.toThrow("requires macOS");
    expect(input.inspectPrefixes).not.toHaveBeenCalled();
    expect(input.execute).not.toHaveBeenCalled();
  });
});
