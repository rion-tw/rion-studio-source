import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

export const CHROME_IMPORT_MARKER = "chrome-import-marker";
export const CHROME_IMPORT_ROLE = "Chromium Import Role";

export async function chromeImportSourceDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(await readFile(path));
    }
  }
  await visit("Default");
  await visit("Local State");
  return hash.digest("hex");
}

export async function prepareChromeImportSource(
  artifactDirectory: string,
  origin: string
): Promise<Readonly<{ root: string; digest: string }>> {
  if (!isAbsolute(artifactDirectory) || new URL(origin).hostname !== "127.0.0.1") {
    throw new Error("An absolute artifact directory and loopback fixture origin are required");
  }
  const root = join(artifactDirectory, "chrome-import-source");
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
  await execute(require("electron") as string, [
    resolve("tests/fixtures/chrome-profile-source.cjs"), root, origin
  ], { env: environment, timeout: 30_000 });
  // Test-owned plaintext rows deliberately avoid the user's DPAPI/Keychain.
  // Rust still parses and filters this actual Chrome SQLite schema.
  await mkdir(join(root, "Default", "Network"), { recursive: true });
  const database = new DatabaseSync(join(root, "Default", "Network", "Cookies"));
  try {
    database.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('version', '23');
      CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, path TEXT,
        expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
        encrypted_value BLOB, top_frame_site_key TEXT);`);
    const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, '/', ?, 0, 0, 2, X'', '')");
    const expires = (BigInt(Date.now()) * 1000n) + 11_644_473_600_000_000n + 86_400_000_000n;
    insert.run("127.0.0.1", "rion-e2e-session", CHROME_IMPORT_MARKER, expires);
    insert.run("excluded.example.test", "excluded-cookie", "must-not-import", expires);
  } finally {
    database.close();
  }
  return { root, digest: await chromeImportSourceDigest(root) };
}
