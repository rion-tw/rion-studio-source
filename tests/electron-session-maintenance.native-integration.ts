import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { resolveConfig } from "electron-vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeChromeProfileImportHelperRequestForTest } from "../src/electron/main/chromeProfileImportHelperProtocol";
import type { ChromiumSessionMigrationFreshHelperRequest } from "../src/electron/main/chromiumSessionMigrationFreshHelperContract";

const platform = process.platform;
const supported = platform === "darwin" || platform === "win32";
const electron = createRequire(import.meta.url)("electron") as string;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let directory: string;
let entry: string;

beforeAll(async () => {
  if (!supported) return;
  directory = await mkdtemp(join(tmpdir(), "rion-native-session-maintenance-"));
  entry = join(directory, "main.mjs");
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    const resolved = await resolveConfig({ configFile: "electron.vite.config.ts" }, "build", "production");
    const config = resolved.config?.main;
    if (!config) throw new Error("Missing production Electron main configuration.");
    config.build = { ...config.build, write: false, rollupOptions: {
      ...config.build?.rollupOptions, input: { index: resolve("src/electron/main/index.ts") },
      output: { codeSplitting: false, format: "es" }
    } };
    config.logLevel = "silent";
    const result = await build(config);
    if (!("output" in result)) throw new Error("Missing production main output.");
    const main = result.output.find(item => item.type === "chunk" && item.isEntry);
    if (!main || main.type !== "chunk") throw new Error("Missing executable main entry.");
    await writeFile(entry, main.code);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function invoke(request: ChromiumSessionMigrationFreshHelperRequest, envelope: Buffer) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Match the production helper's dedicated binary stdio boundary.
  environment.ELECTRON_NO_ATTACH_CONSOLE = "1";
  const child = spawn(electron, [entry, "--rion-internal-chrome-profile-helper"], {
    // Match Rust background_command's CREATE_NO_WINDOW with non-inherited pipes.
    windowsHide: true,
    env: environment, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL"
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", bytes => output.push(Buffer.from(bytes)));
  child.stderr.on("data", bytes => errors.push(Buffer.from(bytes)));
  const closed = new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 && signal === null ? accept() :
      reject(new Error(`Helper failed (${code}/${signal}): ${Buffer.concat(errors).toString("utf8")}`)));
    child.stdin.on("error", reject);
  });
  child.stdin.end(encodeChromeProfileImportHelperRequestForTest(Buffer.from(JSON.stringify(request)), envelope));
  await closed;
  const wire = Buffer.concat(output);
  // Diagnostic parsing only: never trim or accept a displaced protocol header.
  // These native fixtures contain synthetic data, never a user's browser store.
  const headerAt = wire.indexOf(Buffer.from("RCHRES01", "ascii"));
  const hasHeader = headerAt >= 0 && headerAt + 20 <= wire.length;
  const metadataEnd = hasHeader ? Math.min(wire.length, headerAt + 20 +
    Math.min(wire.readUInt32BE(headerAt + 12), 1024)) : 0;
  expect(wire.subarray(0, 8).toString("ascii"), JSON.stringify({
    wireBytes: wire.length, headerAt, prefixHex: wire.subarray(0, 20).toString("hex"),
    outcome: hasHeader ? wire[headerAt + 8] : null,
    metadata: hasHeader ? wire.subarray(headerAt + 20, metadataEnd).toString("utf8") : null,
    stderr: Buffer.concat(errors).subarray(0, 1024).toString("utf8")
  })).toBe("RCHRES01");
  expect(wire.length).toBe(20 + wire.readUInt32BE(12) + wire.readUInt32BE(16));
  const metadata = JSON.parse(wire.subarray(20, 20 + wire.readUInt32BE(12)).toString("utf8"));
  const pid = Buffer.alloc(4);
  pid.writeUInt32BE(child.pid!);
  const exitEvidence = hash(Buffer.concat([Buffer.from("rion-chrome-profile-helper-exit-v1\0"),
    pid, Buffer.from([0]), createHash("sha256").update(wire).digest()]));
  return { outcome: wire[8], metadata, stderr: Buffer.concat(errors).toString("utf8"), pid: child.pid!, exitEvidence };
}

function fixture(value: string) {
  const roleId = randomUUID();
  const transferId = randomUUID();
  const nativePlatform = platform === "darwin" ? "macos" : "windows";
  const encode = (text: string, utf16 = false) => ({ encoding: utf16 ? "base64Utf16Le" : "base64",
    data: Buffer.from(text, utf16 ? "utf16le" : "utf8").toString("base64") });
  const inventory = {
    cookies: [{ name: encode("session"), value: encode("native-fixture"), domain: "session-probe.invalid",
      path: "/", hostOnly: true, secure: true, httpOnly: true,
      expiry: { kind: "absolute", unixMs: Math.floor(Date.now() / 1000) * 1000 + 86_400_000 },
      sameSite: "lax", partition: { kind: "unpartitioned" } }],
    localStorage: [{ origin: "https://session-probe.invalid", entries: [
      { key: encode("character", true), value: encode(value, true) }
    ] }]
  };
  const envelope = Buffer.from(JSON.stringify({ metadata: { format: "rion-role-session-transfer", version: 1,
    transferId, roleId, platform: nativePlatform, sourceEngine: platform === "darwin" ? "wkwebview" : "webview2",
    targetEngine: "chromium", sourceRevision: 12 }, inventory }));
  const browser = join(directory, "roles", roleId, "browser");
  const request: ChromiumSessionMigrationFreshHelperRequest = {
    version: 1, family: "roleSessionMigration", kind: "apply", platform: nativePlatform,
    roleId, transferId, expectedJournalRevision: 4, targetRevision: 9, sourceRevision: 12, phase: "importing",
    rolePaths: { browserUserDataDir: browser, systemBrowserDataDir: join(browser, "system-webview"),
      webview2UserDataDir: join(browser, "system-webview", "webview2"), chromiumUserDataDir: join(browser, "chromium"),
      webkitDataStoreKey: `role:${roleId}:wkwebview`, webkitDataStoreIdentifier: roleId },
    envelopeSha256: hash(envelope), inventorySha256: hash(Buffer.from(JSON.stringify(inventory))),
    cookieCount: 1, localStorageOriginCount: 1, localStorageEntryCount: 1, envelopeBytes: envelope.length
  };
  return { request, envelope };
}

describe.skipIf(!supported)(`${platform} production session maintenance helpers`, () => {
  it.each(["plain-text", "角色\u0000native"])("persists %j through independent apply, verify and rollback processes", async value => {
    const { request, envelope } = fixture(value);
    const applied = await invoke(request, envelope);
    expect(applied.outcome, JSON.stringify(applied)).toBe(0);
    const verified = await invoke({ ...request, kind: "verify", parentExitEvidenceSha256: applied.exitEvidence }, envelope);
    expect(verified.metadata.verifierInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(verified.outcome, JSON.stringify(verified.metadata)).toBe(0);
    expect(verified.metadata).toMatchObject({ readbackCookieCount: 1, readbackLocalStorageEntryCount: 1,
      parentExitEvidenceSha256: applied.exitEvidence });
    const rollback = await invoke({ ...request, kind: "rollback" }, envelope);
    expect(rollback.outcome, JSON.stringify(rollback.metadata)).toBe(0);
    const cleared = await invoke({ ...request, kind: "rollbackVerify", parentExitEvidenceSha256: rollback.exitEvidence }, envelope);
    expect(cleared.metadata.verifierInstanceId).not.toBe(verified.metadata.verifierInstanceId);
    expect(cleared.outcome, JSON.stringify(cleared.metadata)).toBe(0);
    expect(cleared.metadata).toMatchObject({ readbackCookieCount: 0, readbackLocalStorageEntryCount: 0 });
  });
});
