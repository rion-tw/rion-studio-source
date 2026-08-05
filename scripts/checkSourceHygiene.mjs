import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const reportOnly = process.argv.includes("--report");
const sourceExtensions = new Set([
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
const limits = { bytes: 64 * 1024, lines: 1600 };
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
    name: "launch-preview live-window self-deadlock",
    paths: /^src-tauri\/src\/system_runtime\/section_22_with_native_creation_lane\.rs$/u,
    pattern: /match\s+presentation\.lock\(\)/u
  },
  {
    name: "background window projection topology writeback",
    paths: /^src-tauri\/src\/system_runtime\/section_13_window_zoom_indicator_label\.rs$/u,
    pattern: /fn request_window_contract_presentation[\s\S]{0,1600}commit_live_selection/u
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
    name: "process-wide native runtime failure gate",
    paths: /^src-tauri\/src\//u,
    pattern: /SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY/u
  },
  {
    name: "close-fenced launcher delay",
    paths: /^src-tauri\/src\//u,
    pattern: /launcher_source_is_closing|SYSTEM_RUNTIME_TAB_CLOSING/u
  },
  {
    name: "native surface follower writing live topology",
    paths: /^src-tauri\/src\/system_runtime\/section_11_provisionally_move_tab_with_visibility\.rs$/u,
    pattern: /presentation\.(?:move_tab|commit_live_topology|commit_live_window_record|commit_live_selection|commit_live_tab_removal)/u
  },
  {
    name: "stale tab callback surfaced by the UI shell",
    paths: /^(?:src-tauri\/src\/(?:runtime_tabs_macos|runtime_tab_menu)|src\/renderer\/runtime-shell)/u,
    pattern: /Runtime tab (?:was not found|is closing)/iu
  },
  {
    name: "RuntimeTab host ownership",
    paths: /^src-tauri\/src\/system_runtime\/section_02_windows_surface_identity_matches\.rs$/u,
    pattern: /struct RuntimeTab \{[^}]{0,5000}\n\s*(?:pub\([^)]*\)\s+)?window_id:/u
  },
  {
    name: "combined live topology and native projection state",
    paths: /^src-tauri\/src\/system_runtime\//u,
    pattern: /struct LiveWindowTabState/u
  },
  {
    name: "runtime loading state inside LiveTabRecord",
    paths: /^src-tauri\/src\/system_runtime\/section_03_start\.rs$/u,
    pattern: /struct LiveTabRecord \{[^}]{0,2000}\n\s*phase:/u
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

function isFacade(path) {
  return path.endsWith("/mod.rs") ||
    path === "crates/rion-core/src/lib.rs" ||
    path === "crates/rion-platform/src/lib.rs" ||
    path === "src-tauri/src/lib.rs";
}
