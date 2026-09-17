import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = process.argv.find(value => value.startsWith("--chromium-source="))?.split("=").slice(1).join("=");
if (!source) throw new Error("Pass --chromium-source=<Chromium src directory>; --apply opts into mutation.");
const manifest = JSON.parse(await readFile(new URL("../patches/electron/dnr-session-allocation.inputs.json", import.meta.url), "utf8"));
for (const [path, expected] of Object.entries(manifest.sha256)) {
  const actual = createHash("sha256").update(await readFile(resolve(source, path))).digest("hex");
  if (actual !== expected) throw new Error(`Pinned Chromium source mismatch: ${path}`);
}
const patch = fileURLToPath(new URL("../patches/electron/dnr-session-allocation.patch", import.meta.url));
execFileSync("git", ["apply", "--check", patch], { cwd: resolve(source), stdio: "inherit" });
if (process.argv.includes("--apply")) execFileSync("git", ["apply", patch], { cwd: resolve(source), stdio: "inherit" });
console.log(`${process.argv.includes("--apply") ? "Applied" : "Verified"} DNR allocation patch for Electron ${manifest.electron} / Chromium ${manifest.chromium}.`);
