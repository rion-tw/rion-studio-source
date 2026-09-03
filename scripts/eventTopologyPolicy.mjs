import { extname } from "node:path";

export const EVENT_TOPOLOGY_LEDGER_PATH = "docs/event-topology-exceptions.json";

const requiredExceptionFields = [
  "id",
  "paths",
  "mechanism",
  "authoritativeEvent",
  "reason",
  "terminalOutcome",
  "cleanup"
];
const timerSourceExtensions = new Set([".js", ".ts", ".tsx"]);
const timerSourcePrefixes = [
  "src/electron/main/",
  "src/renderer/src/",
  "src/shared/browser-overlay/"
];
const productSourcePrefixes = [
  "crates/rion-core/src/",
  "crates/rion-platform/src/",
  "src-tauri/native/",
  "src-tauri/src/",
  "src/electron/main/",
  "src/renderer/src/",
  "src/shared/browser-overlay/"
];
const classificationPattern = /event-topology:\s*(presentation|coalesce)\b/u;
const exceptionPattern = /event-topology-exception:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/u;
const controlFlowPattern = /\b(?:polling|watchdog|dirty[ _-]?check)\b/iu;

export function scanEventTopologySources(sources, ledger) {
  const failures = validateLedger(ledger);
  if (failures.length > 0) return failures;

  const exceptions = new Map(ledger.exceptions.map((entry) => [entry.id, entry]));
  const usedPaths = new Map(ledger.exceptions.map((entry) => [entry.id, new Set()]));

  for (const { path, source } of sources) {
    if (!isProductSource(path)) continue;
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      for (const mechanism of mechanismsForLine(path, line)) {
        const marker = findMarker(lines, index);
        if (!marker) {
          failures.push(
            `${path}:${index + 1}: ${mechanism.name} requires an event-topology classification`
          );
          continue;
        }
        if (marker.kind === "classification") {
          if (!mechanism.classifications.has(marker.value)) {
            failures.push(
              `${path}:${index + 1}: ${mechanism.name} requires an event-topology exception`
            );
          }
          continue;
        }

        const exception = exceptions.get(marker.value);
        if (!exception) {
          failures.push(
            `${path}:${index + 1}: unknown event-topology exception ${marker.value}`
          );
          continue;
        }
        if (!exception.paths.includes(path)) {
          failures.push(
            `${path}:${index + 1}: event-topology exception ${marker.value} does not allow this path`
          );
          continue;
        }
        usedPaths.get(marker.value)?.add(path);
      }
    }
  }

  for (const exception of ledger.exceptions) {
    const paths = usedPaths.get(exception.id) ?? new Set();
    for (const path of exception.paths) {
      if (!paths.has(path)) {
        failures.push(
          `${EVENT_TOPOLOGY_LEDGER_PATH}: ${exception.id} is unused by ${path}`
        );
      }
    }
  }

  return failures;
}

function validateLedger(ledger) {
  const failures = [];
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger?.exceptions)) {
    return [`${EVENT_TOPOLOGY_LEDGER_PATH}: invalid schema`];
  }
  const ids = new Set();
  for (const entry of ledger.exceptions) {
    for (const field of requiredExceptionFields) {
      const value = entry?.[field];
      if (field === "paths" ? !Array.isArray(value) || value.length === 0 : !value) {
        failures.push(`${EVENT_TOPOLOGY_LEDGER_PATH}: exception is missing ${field}`);
      }
    }
    if (ids.has(entry.id)) {
      failures.push(`${EVENT_TOPOLOGY_LEDGER_PATH}: duplicate exception ${entry.id}`);
    }
    ids.add(entry.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id)) {
      failures.push(`${EVENT_TOPOLOGY_LEDGER_PATH}: invalid exception id ${entry.id}`);
    }
    if (Array.isArray(entry.paths) && new Set(entry.paths).size !== entry.paths.length) {
      failures.push(`${EVENT_TOPOLOGY_LEDGER_PATH}: duplicate path in ${entry.id}`);
    }
  }
  return failures;
}

function isProductSource(path) {
  return productSourcePrefixes.some((prefix) => path.startsWith(prefix)) &&
    !path.includes("/tests/");
}

function mechanismsForLine(path, line) {
  const mechanisms = [];
  const trimmed = line.trimStart();
  const commentOnly = trimmed.startsWith("//") || trimmed.startsWith("/*") ||
    trimmed.startsWith("*");
  if (!commentOnly && controlFlowPattern.test(line)) {
    mechanisms.push({ name: "polling/watchdog/dirty-check control flow", classifications: new Set() });
  }
  if (!timerSourceExtensions.has(extname(path)) ||
      !timerSourcePrefixes.some((prefix) => path.startsWith(prefix))) {
    return mechanisms;
  }
  if (/\b(?:window\.)?setInterval\s*\(/u.test(line)) {
    mechanisms.push({ name: "setInterval", classifications: new Set() });
  }
  if (/\b(?:window\.)?setTimeout\s*\(/u.test(line)) {
    mechanisms.push({
      name: "setTimeout",
      classifications: new Set(["presentation", "coalesce"])
    });
  }
  if (/\bwithTimeout(?:<[^>]+>)?\s*\(/u.test(line)) {
    mechanisms.push({ name: "withTimeout", classifications: new Set() });
  }
  if (/\bPromise\.race\s*\(/u.test(line)) {
    mechanisms.push({ name: "Promise.race", classifications: new Set() });
  }
  return mechanisms;
}

function findMarker(lines, index) {
  const first = Math.max(0, index - 3);
  for (let markerIndex = index; markerIndex >= first; markerIndex -= 1) {
    const line = lines[markerIndex] ?? "";
    const exception = line.match(exceptionPattern)?.[1];
    if (exception) return { kind: "exception", value: exception };
    const classification = line.match(classificationPattern)?.[1];
    if (classification) return { kind: "classification", value: classification };
  }
  return undefined;
}
