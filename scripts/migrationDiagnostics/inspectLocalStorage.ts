// Internal stopped-profile comparison. Secret input stays on the inherited pipe.
import { readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { app, session, WebContentsView } from "electron";
import { ChromiumSessionMigrationLocalStorageCodec } from "../../src/electron/main/chromiumSessionMigrationLocalStorage";
import type { ChromiumRoleSessionPort } from "../../src/electron/main/chromiumRoleSessionRegistry";
import { controlledDocumentAllowed } from "./offlinePolicy";
import { mergeMissing } from "./mergeMissing";
const root = realpathSync(process.env.RION_MIGRATION_DIAGNOSTIC_ROOT ?? "");
if (app.isPackaged || process.env.RION_MIGRATION_DIAGNOSTICS !== "1" || !["darwin", "win32"].includes(process.platform)) throw new Error("DIAGNOSTIC_ENTRY_DISABLED");
const input = JSON.parse(readFileSync(0, "utf8")) as { profile: string; mode?: "applyMissing" | "verify"; expected?: string; origins: Array<{ origin: string; entries: Array<{ key: { data: string }; value: { data: string } }> }> };
const profile = realpathSync(input.profile);
const relation = relative(root, profile);
if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("DIAGNOSTIC_PATH_ESCAPE");
app.setPath("userData", root); app.setPath("sessionData", profile);
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
async function run() {
  await app.whenReady();
  const handle = session.fromPath(profile, { cache: false });
  const handled = new Set<string>();
  const install = handle.protocol.handle.bind(handle.protocol);
  const remove = handle.protocol.unhandle.bind(handle.protocol);
  handle.protocol.handle = (scheme, handler) => { install(scheme, handler); handled.add(scheme); };
  handle.protocol.unhandle = scheme => { handled.delete(scheme); remove(scheme); };
  handle.webRequest.onBeforeRequest((d, callback) => callback({ cancel: !controlledDocumentAllowed(d.url, handled) }));
  const codec = new ChromiumSessionMigrationLocalStorageCodec({ create: options => new WebContentsView(options as Electron.WebContentsViewConstructorOptions) } as ConstructorParameters<typeof ChromiumSessionMigrationLocalStorageCodec>[0]);
  const origins = [];
  const finalRecords = [];
  for (const origin of input.origins) {
    const entries = await codec.readback(handle as unknown as ChromiumRoleSessionPort, origin.origin);
    const current = new Map(entries.map(e => [e.key, e.value]));
    let identical = 0; let missing = 0; let conflicting = 0;
    for (const e of origin.entries) {
      const key = Buffer.from(e.key.data, "base64").toString("utf16le");
      const value = Buffer.from(e.value.data, "base64").toString("utf16le");
      if (!current.has(key)) missing++; else if (current.get(key) === value) identical++; else conflicting++;
    }
    const retained = origin.entries.map(e => ({ key: Buffer.from(e.key.data, "base64").toString("utf16le"), value: Buffer.from(e.value.data, "base64").toString("utf16le") }));
    const final = input.mode === "applyMissing" ? await codec.replaceAndReadback(handle as unknown as ChromiumRoleSessionPort, origin.origin, mergeMissing(entries, retained)) : entries;
    finalRecords.push({ origin: origin.origin, entries: final });
    origins.push({ originSha256: createHash("sha256").update(origin.origin).digest("hex"), currentEntries: entries.length, identical, missing, conflicting });
  }
  const digest = createHash("sha256").update(JSON.stringify(finalRecords)).digest("hex");
  if (input.mode === "verify" && digest !== input.expected) throw new Error("FRESH_READBACK_MISMATCH");
  if (input.mode === "applyMissing") handle.flushStorageData();
  writeSync(1, JSON.stringify({ origins, digest, mode: input.mode ?? "compare", externalNetwork: "blocked", nativeChromiumReadback: true }));
  app.exit(0);
}
void run().catch(() => app.exit(1));
