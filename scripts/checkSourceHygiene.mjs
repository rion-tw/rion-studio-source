import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { promisify } from "node:util";

import {
  EVENT_TOPOLOGY_LEDGER_PATH,
  scanEventTopologySources
} from "./eventTopologyPolicy.mjs";

const execute = promisify(execFile);
const reportOnly = process.argv.includes("--report");
const sourceExtensions = new Set([
  ".cs",
  ".css",
  ".h",
  ".js",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".ps1",
  ".rs",
  ".ts",
  ".tsx"
]);
const generatedPrefixes = ["src/shared/generated/"];
const limits = { bytes: 64 * 1024, lines: 3200 };
const facadeLineLimit = 250;
const architectureGuards = [
  {
    name: "legacy full runtime projection effect",
    pattern: /EmbeddedApplyRuntime/u
  },
  {
    name: "Core-to-live topology overlay",
    pattern: /snapshot_with_live_tab_topology/u
  },
  {
    name: "receipt-gated drag deadline",
    pattern: /TAB_DRAG_OPERATION_TIMEOUT|AwaitingDropIntent/u
  },
  {
    name: "receipt-gated tab activation convergence",
    pattern: /TabActivationCoordinator|tabActivationConverged|__rionApplyRuntimeTabActivation/u
  },
  {
    name: "Core window topology command",
    pattern: /BrowserRuntimeCommand::(?:RegisterWindow|RemoveWindow)/u
  },
  {
    name: "user-visible tab convergence failure",
    pattern: /Runtime tab mutation did not converge/u
  },
  {
    name: "platform cfg in the shared RuntimeKernel orchestrator",
    paths: /^crates\/rion-core\/src\/runtime_kernel\/(?:ports|state|types)\.rs$/u,
    pattern: /#\[cfg\([^\]]*(?:windows|target_os)[^\]]*\)\]|cfg!\((?:windows|target_os)/u
  }
];

const { stdout } = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: process.cwd(),
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024
});
const trackedFiles = stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((path) => path.replaceAll("\\", "/"));

const failures = [];

// A path-scoped guard whose scope matches nothing can never fire, so it reports
// safety it does not provide. Retiring the Tauri runtime left 25 such guards
// behind, unnoticed. Fail instead: either repoint the guard at the path that now
// owns the rule, or delete it.
for (const guard of architectureGuards) {
  if (!guard.paths) continue;
  if (trackedFiles.some((path) => guard.paths.test(path))) continue;
  failures.push(
    `scripts/checkSourceHygiene.mjs: architecture guard "${guard.name}" ` +
    `is scoped to ${guard.paths}, which matches no tracked file`
  );
}
const eventTopologyLedger = JSON.parse(await readFile(EVENT_TOPOLOGY_LEDGER_PATH, "utf8"));
const eventTopologySources = [];
for (const path of trackedFiles) {
  if (!sourceExtensions.has(extname(path))) continue;
  if (generatedPrefixes.some((prefix) => path.startsWith(prefix))) continue;

  let source;
  try {
    source = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  const sourceText = source.toString("utf8");
  eventTopologySources.push({ path, source: sourceText });
  const lineCount = source.length === 0
    ? 0
    : sourceText.split(/\r?\n/u).length - (source.at(-1) === 10 ? 1 : 0);
  if (lineCount > limits.lines || source.length > limits.bytes) {
    failures.push(
      `${path}: ${lineCount} lines, ${source.length} bytes ` +
      `(limits: ${limits.lines} lines, ${limits.bytes} bytes)`
    );
  }
  if (isFacade(path) && lineCount > facadeLineLimit) {
    failures.push(`${path}: facade has ${lineCount} lines (limit: ${facadeLineLimit})`);
  }
  for (const guard of architectureGuards) {
    if (path !== "scripts/checkSourceHygiene.mjs" &&
        (!guard.paths || guard.paths.test(path)) && guard.pattern.test(sourceText)) {
      failures.push(`${path}: reintroduces ${guard.name}`);
    }
  }
}

failures.push(...scanEventTopologySources(eventTopologySources, eventTopologyLedger));

for (const path of trackedFiles.filter((candidate) => /^tsconfig(?:\.[^.]+)?\.json$/u.test(candidate))) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  for (const include of config.include ?? []) {
    if (/[*?{}]/u.test(include)) continue;
    try {
      await access(include);
    } catch {
      failures.push(`${path}: stale include path ${normalize(include)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Source hygiene found ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (!reportOnly) process.exitCode = 1;
} else {
  console.log(`Source hygiene passed for ${trackedFiles.length} tracked files.`);
}

// crates/rion-appkit/src/lib.rs and crates/rion-node/src/lib.rs are deliberately
// absent: those crate roots are implementation entry points that hold the AppKit
// and Node-API surfaces directly, not façades that re-export a module tree. They
// remain bound by the ordinary line and byte limits above.
function isFacade(path) {
  return path.endsWith("/mod.rs") ||
    path === "crates/rion-core/src/lib.rs" ||
    path === "crates/rion-platform/src/lib.rs";
}
