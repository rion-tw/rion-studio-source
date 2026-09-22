import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ECS_PROTOTYPE, ECS_PROTOTYPE_DIST, ecsPrototypeExecutable } from "./ecsPrototypeRuntime.mjs";

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const requireElectron = createRequire(join(electronRoot, "package.json"));
const target = `${process.platform}-${process.arch}`;
const expected = ECS_PROTOTYPE.hashes[target];
if (!expected) throw new Error(`Unsupported ECS prototype target: ${target}`);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.devDependencies.electron !== "44.4.3" || requireElectron("./package.json").version !== "44.4.3") {
  throw new Error("The official Electron package pin has drifted.");
}
const filename = `electron-v${ECS_PROTOTYPE.version}-${target}.zip`;
const { downloadArtifact } = requireElectron("@electron/get");
const archive = await downloadArtifact({ version: ECS_PROTOTYPE.version, artifactName: "electron",
  platform: process.platform, arch: process.arch, checksums: { [filename]: expected },
  mirrorOptions: { mirror: ECS_PROTOTYPE.mirror } });
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== expected) throw new Error("ECS archive SHA-256 mismatch.");
let installed;
try {
  installed = (await readFile(join(ECS_PROTOTYPE_DIST, "version"), "utf8")).trim() === ECS_PROTOTYPE.version;
  if (installed) await access(ecsPrototypeExecutable());
} catch { installed = false; }
if (!installed) {
  const parent = dirname(ECS_PROTOTYPE_DIST);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, "extract-"));
  try {
    const { extract } = requireElectron("@electron-internal/extract-zip");
    await extract(archive, { dir: temporary });
    const version = (await readFile(join(temporary, "version"), "utf8")).trim();
    if (version !== ECS_PROTOTYPE.version) throw new Error("The extracted ECS version differs from the archive pin.");
    await rm(ECS_PROTOTYPE_DIST, { force: true, recursive: true });
    await rename(temporary, ECS_PROTOTYPE_DIST);
    await access(ecsPrototypeExecutable());
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
console.log(`Verified ECS ${ECS_PROTOTYPE.version} ${target} archive SHA-256 ${expected}`);
