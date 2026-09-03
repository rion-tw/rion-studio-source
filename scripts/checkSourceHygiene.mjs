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
    name: "implicit dirty-guard RuntimeKernel writer",
    paths: /^src-tauri\/src\/system_runtime\/section_02_windows_surface_identity_matches\.rs$/u,
    pattern: /struct LiveWindowGuard|impl LiveWindowHandle\s*\{[^}]*fn lock/u
  },
  {
    name: "implicit NativeResourceRegistry deref",
    paths: /^src-tauri\/src\/system_runtime\/section_04_next_revision\.rs$/u,
    pattern: /impl\s+(?:std::ops::)?Deref(?:Mut)?\s+for\s+RuntimeState|\bresources:\s*NativeResourceRegistry/u
  },
  {
    name: "native handle lookup disguised as logical ownership",
    paths: /^src-tauri\/src\/system_runtime\/section_04_next_revision\.rs$/u,
    pattern: /fn\s+(?:tab_id_for_role|has_role_surface|live_role_ids|role_tab_pairs|native_host_for_tab|window_has_attached_tab)\b/u
  },
  {
    name: "Tauri RuntimeKernel mutation outside the authority barrier",
    paths: /^src-tauri\/src\/system_runtime\//u,
    pattern: /runtime_kernel\s*\(\s*\)\s*\.\s*apply\s*\(|\.live\s*\.\s*kernel\s*\.\s*apply\s*\(/u
  },
  {
    name: "runtime loading state inside LiveTabRecord",
    paths: /^src-tauri\/src\/system_runtime\/section_03_start\.rs$/u,
    pattern: /struct LiveTabRecord \{[^}]{0,2000}\n\s*phase:/u
  },
  {
    name: "Tauri saved-window name authority",
    paths: /^src-tauri\/src\/system_runtime\//u,
    pattern: /saved_window_names/u
  },
  {
    name: "native role zoom-mode authority",
    paths: /^src-tauri\/src\/system_runtime\/section_01_navigation_timeout\.rs$/u,
    pattern: /struct RoleSurface \{[^}]{0,2000}\n\s*zoom_mode:/u
  },
  {
    name: "effect-stack synchronous AppCore command re-entry",
    paths: /^src-tauri\/src\/system_runtime(?:\.rs|\/)/u,
    pattern: /(?:self\.)?core\s*\.invoke\s*\(/u
  },
  {
    name: "native handle source-owner probing",
    paths: /^src-tauri\/src\//u,
    pattern: /native_tab_for_source/u
  },
  {
    name: "System Runtime command-dispatched snapshot re-entry",
    paths: /^src-tauri\/src\/system_runtime(?:\.rs|\/)/u,
    pattern: /CoreCommand::BrowserRuntimeSnapshot/u
  },
  {
    name: "System Runtime command-dispatched macro input lifecycle",
    paths: /^src-tauri\/src\/system_runtime(?:\.rs|\/)/u,
    pattern: /CoreCommand::MacroInput(?:Fence|Drain|Resume)/u
  },
  {
    name: "native presentation callback RuntimeKernel re-entry",
    paths: /^src-tauri\/src\/system_runtime\/section_05_is_surface_close_effect\.rs$/u,
    pattern: /request\.live|LiveWindowHandle/u
  },
  {
    name: "System Runtime executor hidden in the shared include namespace",
    paths: /^src-tauri\/src\/system_runtime\/section_/u,
    pattern: /(?:pub\s+)?struct\s+SystemRuntimeExecutor\b/u
  },
  {
    name: "desired native projection store hidden in the shared include namespace",
    paths: /^src-tauri\/src\/system_runtime\/section_/u,
    pattern: /struct\s+NativeTabProjectionStore\b/u
  },
  {
    name: "native platform adapter included into the shared namespace",
    paths: /^src-tauri\/src\/system_runtime\.rs$/u,
    pattern: /include!\("system_runtime\/platform\/(?:macos|windows|unsupported)\.rs"\)/u
  },
  {
    name: "shared runtime error implementation hidden in a platform adapter",
    paths: /^src-tauri\/src\/system_runtime\/platform\/(?:macos|unsupported|windows(?:\.rs|\/))/u,
    pattern: /impl\s+RuntimeError\b/u
  },
  {
    name: "platform cfg in the shared RuntimeKernel orchestrator",
    paths: /^crates\/rion-core\/src\/runtime_kernel\/(?:ports|state|types)\.rs$/u,
    pattern: /#\[cfg\([^\]]*(?:windows|target_os)[^\]]*\)\]|cfg!\((?:windows|target_os)/u
  },
  {
    name: "Tauri AppCore RuntimeKernel write outside the typed kernel facade",
    paths: /^src-tauri\/src\/system_runtime\/section_/u,
    pattern: /\.apply_runtime_intent\s*\(/u
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

function isFacade(path) {
  return path.endsWith("/mod.rs") ||
    path === "crates/rion-core/src/lib.rs" ||
    path === "crates/rion-platform/src/lib.rs" ||
    path === "src-tauri/src/lib.rs";
}
