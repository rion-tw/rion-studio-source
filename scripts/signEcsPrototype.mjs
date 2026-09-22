import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

// Sign only an unpacked prototype. Any archives made earlier are stale and must
// not be published; the unchanged release pipeline still owns updater signing.
const argument = process.argv.find(value => value.startsWith("--package="));
if (!argument || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Usage on native macOS/Windows: node scripts/signEcsPrototype.mjs --package=<unpacked-directory>");
}
const directory = resolve(argument.slice("--package=".length));
const application = join(directory, process.platform === "darwin" ? "Rion Studio.app" : "Rion Studio.exe");
const info = await lstat(application);
if (info.isSymbolicLink() || (process.platform === "darwin" ? !info.isDirectory() : !info.isFile())) {
  throw new Error("Expected a real unpacked Rion Studio prototype application.");
}
async function run(command, args) {
  await new Promise((yes, no) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", no);
    child.once("exit", code => code === 0 ? yes() : no(new Error(`Prototype signing command exited ${code}`)));
  });
}
const python = process.env.RION_EVS_PYTHON || "python3";
await run(python, ["-m", "castlabs_evs.vmp", "--no-ask", "sign-pkg", "--streaming", directory]);
if (process.platform === "darwin") {
  // Re-apply the existing owner-approved ad-hoc policy after VMP changes. No
  // Developer ID, hardened runtime, or notarization credentials are introduced.
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", application]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
}
await run(python, ["-m", "castlabs_evs.vmp", "--no-ask", "verify-pkg", "--streaming", directory]);
console.log("Prototype VMP verified. Existing archives are stale; no publication was performed.");
