import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const [version, ...unexpectedArgs] = args.map((argument) => argument.trim());
if (
  unexpectedArgs.length > 0 ||
  !version ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
) {
  throw new Error("Usage: pnpm run release:version -- <semantic-version>");
}

await updateJson("package.json", (value) => ({ ...value, version }));
await updateJson("src-tauri/tauri.conf.json", (value) => ({ ...value, version }));

const cargoToml = await read("Cargo.toml");
const updatedCargoToml = cargoToml.replace(
  /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/,
  `$1"${version}"`
);
if (updatedCargoToml === cargoToml) throw new Error("Cargo workspace version was not updated.");
await write("Cargo.toml", updatedCargoToml);

let cargoLock = await read("Cargo.lock");
for (const name of [
  "rion-appkit",
  "rion-core",
  "rion-node",
  "rion-platform",
  "rion-tauri",
  "rion-updater"
]) {
  const expression = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = )"[^"]+"`);
  const updated = cargoLock.replace(expression, `$1"${version}"`);
  if (updated === cargoLock) throw new Error(`Cargo.lock package ${name} was not updated.`);
  cargoLock = updated;
}
await write("Cargo.lock", cargoLock);
console.log(`Applied Rion Studio release version ${version}.`);

async function updateJson(path, transform) {
  const value = JSON.parse(await read(path));
  await write(path, `${JSON.stringify(transform(value), null, 2)}\n`);
}

function read(path) {
  return readFile(new URL(path, new URL(`file://${repositoryRoot}/`)), "utf8");
}

function write(path, contents) {
  return writeFile(new URL(path, new URL(`file://${repositoryRoot}/`)), contents, "utf8");
}
