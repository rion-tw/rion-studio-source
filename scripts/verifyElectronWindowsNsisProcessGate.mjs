import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
if (process.platform !== "win32") {
  throw new Error("The NSIS runtime-presence probe requires native Windows.");
}
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { getMakeNsisPath, getNsisPluginsPath } = builderRequire(
  "app-builder-lib/out/toolsets/windows.js"
);
const compiler = await getMakeNsisPath();
const plugins = await getNsisPluginsPath();
const root = resolve(".desktop-e2e-artifacts", `nsis-process-gate-${randomUUID()}`);
await mkdir(root, { recursive: false });
const hook = resolve("build/electron-installer.nsh");
const results = [];
for (const [name, expectedExit] of [["absent", 0], ["running", 1]]) {
  const executableName = `${name}-${randomUUID()}.exe`;
  const executable = join(root, executableName);
  const sourcePath = join(root, `${name}.nsi`);
  const marker = join(root, `${name}-admitted.txt`);
  const source = [
    "Unicode true", "RequestExecutionLevel user", "SilentInstall silent",
    'Name "Rion NSIS runtime-presence fixture"',
    `OutFile "${executable}"`,
    `!addplugindir /x86-unicode "${join(plugins, "x86-unicode")}"`,
    "!define BUILD_UNINSTALLER",
    `!define APP_EXECUTABLE_FILENAME "${name === "running" ? executableName : `absent-${randomUUID()}.exe`}"`,
    'LangString appCannotBeClosed 1033 "Close the fixture before retrying."',
    `!include "${hook}"`,
    "Section", "!insertmacro customCheckAppRunning",
    `FileOpen $9 "${marker}" w`, 'FileWrite $9 "admitted"', "FileClose $9",
    "SetErrorLevel 0", "SectionEnd"
  ].join("\n");
  await writeFile(sourcePath, source);
  const compiled = await executeFile(compiler.path, ["/WX", "/V3", sourcePath], {
    env: { ...process.env, ...compiler.env }, windowsHide: true
  });
  await writeFile(join(root, `${name}-compile.log`), compiled.stdout + compiled.stderr);
  let exitCode = 0;
  try {
    // Bounded native test invocation; this does not install or launch Rion Studio.
    await executeFile(executable, ["/S"], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    if (typeof error.code !== "number" || error.killed) throw error;
    exitCode = error.code;
  }
  if (exitCode !== expectedExit) {
    throw new Error(`NSIS ${name} process gate exited ${exitCode}; expected ${expectedExit}`);
  }
  const admitted = await readFile(marker, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (admitted !== (name === "absent" ? "admitted" : null)) {
    throw new Error(`NSIS ${name} process gate has inconsistent admission evidence`);
  }
  results.push({ name, exitCode, admitted: admitted !== null, executable });
}
const receipt = { platform: "win32", compiler: compiler.path, hook, results };
await writeFile(join(root, "result.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, report: join(root, "result.json") }));
