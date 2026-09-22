import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ECS_PROTOTYPE } from "./ecsPrototypeRuntime.mjs";

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const requireElectron = createRequire(join(electronRoot, "package.json"));
const target = `${process.platform}-${process.arch}`;
const expected = ECS_PROTOTYPE.hashes[target];
if (!expected) throw new Error(`Unsupported ECS prototype target: ${target}`);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.devDependencies.electron !== ECS_PROTOTYPE.dependency ||
    requireElectron("./package.json").version !== ECS_PROTOTYPE.version) {
  throw new Error("The ECS prototype package pin has drifted.");
}
const filename = `electron-v${ECS_PROTOTYPE.version}-${target}.zip`;
if (requireElectron("./checksums.json")[filename] !== expected) throw new Error("ECS upstream checksum pin drifted.");
const { downloadArtifact } = requireElectron("@electron/get");
const archive = await downloadArtifact({ version: ECS_PROTOTYPE.version, artifactName: "electron",
  platform: process.platform, arch: process.arch, checksums: { [filename]: expected },
  mirrorOptions: { mirror: ECS_PROTOTYPE.mirror } });
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== expected) throw new Error("ECS archive SHA-256 mismatch.");
const env = { ...process.env };
for (const name of ["ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_INSTALL_PLATFORM", "ELECTRON_INSTALL_ARCH",
  "npm_config_platform", "npm_config_arch", "electron_config_cache", "electron_use_remote_checksums",
  "npm_config_electron_use_remote_checksums", "force_no_cache"]) delete env[name];
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(electronRoot, "install.js")], { env, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`ECS installation exited ${code}`)));
});
console.log(`Verified ECS ${ECS_PROTOTYPE.version} ${target} archive SHA-256 ${expected}`);
