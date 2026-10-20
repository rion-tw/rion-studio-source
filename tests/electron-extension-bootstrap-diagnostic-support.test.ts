import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMITTED_EXTENSION, admittedExtensionMetadata, admittedManifestIdentity, assertDiagnosticTree,
  containedDiagnosticPath, findAdmittedMacExtensionInput, instrumentDiagnosticPreload,
  isGeneratedRulesetCachePath, redactDiagnosticJson, redactDiagnosticText, strictDiagnosticResultPassed
} from "../scripts/electronExtensionBootstrapDiagnosticSupport.mjs";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-bootstrap-diagnostic-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    containedDiagnosticPath(resolve(tmpdir()), root);
    await rm(root, { recursive: true, force: true });
  }
});
const metadata = (directory: string, changes = {}) => ({ settings: [{ key: "extensions",
  payload: { installed: [{ ...ADMITTED_EXTENSION, directory, removed: false, ...changes }] } }] });

describe("extension diagnostic admission with host-native paths", () => {
  it("normalizes absolute descendants and rejects prefix siblings, root aliases and traversal", () => {
    const root = resolve("probe", "extensions");
    expect(containedDiagnosticPath(root, join(root, "unused", "..", "adblock"))).toBe(join(root, "adblock"));
    for (const path of [root, `${root}-outside`, resolve(root, "..", "outside")]) {
      expect(() => containedDiagnosticPath(root, path)).toThrow("DIAGNOSTIC_PATH_OUTSIDE_OWNER");
    }
    expect(() => containedDiagnosticPath(root, "relative")).toThrow("DIAGNOSTIC_PATH_NOT_ABSOLUTE");
  });

  it("admits only pinned catalogue metadata without treating it as a directory digest", () => {
    const directory = resolve("extensions", ADMITTED_EXTENSION.id);
    expect(admittedExtensionMetadata(metadata(directory, { sha256: ADMITTED_EXTENSION.sha256.toUpperCase() })))
      .toEqual({ ...ADMITTED_EXTENSION, directory });
    for (const changed of [{ version: "6.49.1" }, { sha256: "0".repeat(64) },
      { sizeBytes: 342220414 }, { removed: true }, { directory: "relative" }]) {
      expect(() => admittedExtensionMetadata(metadata(directory, changed)))
        .toThrow("DIAGNOSTIC_EXTENSION_METADATA_NOT_ADMITTED");
    }
  });

  it("rejects ambiguous settings, duplicate installed identities, and forged manifest identities", () => {
    const value = metadata(resolve("extensions", ADMITTED_EXTENSION.id));
    value.settings[0].payload.installed.push(value.settings[0].payload.installed[0]);
    expect(() => admittedExtensionMetadata(value)).toThrow("DIAGNOSTIC_EXTENSION_ID_NOT_ADMITTED");
    expect(() => admittedExtensionMetadata({ settings: [] })).toThrow("DIAGNOSTIC_EXTENSION_SETTINGS_INVALID");
    expect(() => admittedManifestIdentity({ key: "not base64" })).toThrow("DIAGNOSTIC_MANIFEST_KEY_INVALID");
    expect(() => admittedManifestIdentity({ key: Buffer.from("different extension").toString("base64"),
      version: ADMITTED_EXTENSION.version, manifest_version: 3, background: { service_worker: "background.js" } }))
      .toThrow("DIAGNOSTIC_MANIFEST_NOT_ADMITTED");
  });
});

describe("extension diagnostic filesystem fences", () => {
  async function report(root: string, directory: string) {
    const run = join(root, "2026-10-15T00-00-00-000Z-darwin");
    const userData = join(run, "user-data");
    const phase = join(run, "phases", "chromium-extensions-seed");
    await mkdir(join(userData, "chromium-extensions", "extensions"), { recursive: true });
    await mkdir(phase, { recursive: true });
    await writeFile(join(run, "report.json"), JSON.stringify({ artifactRoot: run, userDataRoot: userData,
      driver: "electron", runtimeTarget: "chromium-v23-macos-appkit", startedAt: "2026-10-15T00:00:00Z",
      phases: [{ phase: "chromium-extensions-seed", status: "FAIL" }] }));
    await writeFile(join(phase, "sqlite-query.json"), JSON.stringify(metadata(directory)));
    return { run, userData, phase };
  }

  it("rejects an installed directory in another profile even when metadata matches", async () => {
    const root = await fixture();
    const foreign = join(root, "foreign-package");
    await mkdir(foreign);
    await report(root, foreign);
    await expect(findAdmittedMacExtensionInput(root)).rejects.toThrow("DIAGNOSTIC_PATH_OUTSIDE_OWNER");
  });

  it("rejects package junctions escaping the exact report's extension owner", async () => {
    const root = await fixture();
    const alias = join(root, "2026-10-15T00-00-00-000Z-darwin", "user-data",
      "chromium-extensions", "extensions", ADMITTED_EXTENSION.id);
    const foreign = join(root, "foreign-package");
    await mkdir(foreign);
    await report(root, alias);
    await symlink(foreign, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(findAdmittedMacExtensionInput(root)).rejects.toThrow("DIAGNOSTIC_PATH_OUTSIDE_OWNER");
  });

  it("counts ordinary source files and rejects nested symbolic links before copying", async () => {
    const root = await fixture();
    const packagePath = join(root, "package");
    await mkdir(packagePath);
    await writeFile(join(packagePath, "background.js"), "hello");
    expect(await assertDiagnosticTree(packagePath)).toEqual({ files: 1, bytes: 5 });
    const foreign = join(root, "outside");
    await mkdir(foreign);
    await symlink(foreign, join(packagePath, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(assertDiagnosticTree(packagePath)).rejects.toThrow("DIAGNOSTIC_PACKAGE_SYMLINK_FORBIDDEN");
  });

  it("excludes only the exact generated ruleset cache while retaining other metadata", async () => {
    const root = await fixture();
    const cache = join(root, "_metadata", "generated_indexed_rulesets");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "index"), "cache");
    await writeFile(join(root, "_metadata", "verified_contents.json"), "signed");
    await writeFile(join(root, "_metadata", "generated_indexed_rulesets.json"), "source");
    expect(await assertDiagnosticTree(root)).toEqual({ files: 3, bytes: 17 });
    expect(await assertDiagnosticTree(root, true)).toEqual({ files: 2, bytes: 12 });
    expect(isGeneratedRulesetCachePath(root, join(cache, "index"))).toBe(true);
    expect(isGeneratedRulesetCachePath(root, join(root, "_metadata", "generated_indexed_rulesets.json"))).toBe(false);
  });
});

describe("extension diagnostic evidence", () => {
  it("redacts inherited secrets, escaped JSON values, Authorization and URL tokens while preserving valid JSON", () => {
    const value = JSON.stringify({ sessionToken: "unknown-token", line: "Bearer abc.def",
      privateKey: "line\nsecret", url: "https://example.invalid/?access_token=abc&other=retained" });
    const redacted = redactDiagnosticText(value, { CI_SECRET: "line\nsecret" });
    expect(JSON.parse(redacted)).toEqual({ sessionToken: "[REDACTED]", line: "Bearer [REDACTED]",
      privateKey: "[REDACTED]", url: "https://example.invalid/?access_token=[REDACTED]&other=retained" });
    expect(redactDiagnosticText("first\r\nknown-token\r\nlast", { GITHUB_TOKEN: "known-token" }))
      .toBe("first\n[REDACTED]\nlast");
  });

  it("preserves ScriptCatchup source escaping and password identifiers from the observed native trace", () => {
    // Minimal reproduction of the actual source-rundown fragment. Its && and
    // assignment are JavaScript, not a URL password query parameter.
    const source = 'r&&r.emit(e,t);l._clientCertRequestPasswordHandler=null;\r\n' +
      String.raw`l.on("-client-certificate-request-password",async(e)=>{const{tokenName:o}=e;return"\\\""});`;
    const trace = { traceEvents: [{ name: "ScriptCatchup", args: { source } }],
      privateKey: "hidden", nested: { sessionToken: "unknown", enabled: true, count: 2 } };
    const parsed = JSON.parse(JSON.stringify(trace));
    const serialized = JSON.stringify(redactDiagnosticJson(parsed, {}));
    expect(JSON.parse(serialized)).toEqual({ traceEvents: trace.traceEvents,
      privateKey: "[REDACTED]", nested: { sessionToken: "[REDACTED]", enabled: true, count: 2 } });
    expect(JSON.parse(serialized).traceEvents[0].args.source).toBe(source);
    expect(redactDiagnosticText(source, {})).toBe(source.replaceAll("\r\n", "\n"));
  });

  it("sanitizes nested JSON string values without interpreting embedded source object keys as credentials", () => {
    const source = String.raw`const PasswordHandler={"password":"quoted\"value\\path"};`;
    const value = { source, events: [{ message: "Bearer secret-value", url: "https://example.invalid/?token=value" }],
      clientSecret: { nested: "must not leak" }, known: "line\nsecret" };
    const sanitized = redactDiagnosticJson(value, { CI_SECRET: "line\nsecret" });
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual({ source,
      events: [{ message: "Bearer [REDACTED]", url: "https://example.invalid/?token=[REDACTED]" }],
      clientSecret: "[REDACTED]", known: "[REDACTED]" });
    expect(value.clientSecret).toEqual({ nested: "must not leak" });
  });

  it("requires the exact strict process verdict and never accepts native-only startup as product readiness", () => {
    const ready = { probe: "electron-extension-bootstrap-diagnostic", mode: "strict-compat",
      ...ADMITTED_EXTENSION, extensionId: ADMITTED_EXTENSION.id, electronVersion: "44.4.3",
      status: "passed", strictReady: true, nativeLoaded: true, nativeStartupObserved: true };
    expect(strictDiagnosticResultPassed(0, ready)).toBe(true);
    for (const changed of [{ mode: "native-only" }, { strictReady: false }, { nativeStartupObserved: false },
      { extensionId: "a".repeat(32) }, { electronVersion: "44.4.2" }, { status: "failed" }]) {
      expect(strictDiagnosticResultPassed(0, { ...ready, ...changed })).toBe(false);
    }
    expect(strictDiagnosticResultPassed(1, ready)).toBe(false);
  });

  it("adds ordered preload bookends without settling the pending native ruleset operation", async () => {
    const source = await readFile("third_party/electron-chrome-extensions/src/rion-preload.ts", "utf8");
    const instrumented = instrumentDiagnosticPreload(source.replaceAll("\n", "\r\n"));
    const code = transformSync(instrumented, { loader: "ts", format: "cjs" }).code;
    const stages: string[] = [];
    let finishRulesets!: () => void;
    const nativeRulesets = new Promise<void>(complete => { finishRulesets = complete; });
    const context = { exports: {}, require: () => ({ ipcRenderer: {
      send: (_channel: string, record: { stage: string }) => stages.push(record.stage),
      invoke: async () => true
    } }), process: { type: "service-worker", contextIsolated: false, pid: 42 },
    chrome: { runtime: { id: "a".repeat(32), getManifest: () => ({
      declarative_net_request: { rule_resources: [{ id: "rules", enabled: true }] }
    }) }, declarativeNetRequest: { updateEnabledRulesets: () => nativeRulesets } }, queueMicrotask };
    runInNewContext(code, context);
    await new Promise<void>(complete => queueMicrotask(complete));
    expect(stages).toEqual(["preload-enter", "main-world-enter", "main-world-installed",
      "rulesets-enable-before", "preload-complete", "first-main-world-microtask"]);
    finishRulesets();
    await new Promise<void>(complete => setImmediate(complete));
    expect(stages.slice(-3)).toEqual(["rulesets-enable-completed", "compatibility-ready-before",
      "compatibility-ready-completed"]);
    expect(instrumented).not.toMatch(/sendSync|startWorkerForScope|setTimeout|runIfWaitingForDebugger/u);
    expect(() => instrumentDiagnosticPreload(`${source}\n${source}`)).toThrow("DIAGNOSTIC_PRELOAD_SOURCE_CHANGED");
  });
});
