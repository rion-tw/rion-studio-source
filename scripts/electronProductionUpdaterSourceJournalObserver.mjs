import { watch } from "node:fs/promises";
import path from "node:path";

import {
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  publicIdentity,
  readStableFile,
  requiredAbsolutePath,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_CAPTURE_KIND =
  "rion-production-updater-source-journal-capture";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_NAME =
  "source-install-journal.json";

const MAX_JOURNAL_BYTES = 1024 * 1024;
const PLATFORM_PHASES = Object.freeze({
  "darwin-aarch64": "restartPending",
  "windows-x86_64": "installerHandoff"
});

export async function observeElectronProductionUpdaterSourceJournal(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "journalPath",
    "outputPath",
    "platform",
    "signal",
    "targetVersion",
    "visibleInstallInvokedAt"
  ], "source journal observation input");
  const journalPath = requiredAbsolutePath(
    input.journalPath,
    "source updater install journal"
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_NAME,
    "source updater journal capture"
  );
  assertPathOutsideRoot(
    outputPath,
    path.dirname(journalPath),
    "source updater journal capture"
  );
  const platform = requiredPlatform(input.platform);
  const targetVersion = requiredSemanticVersion(
    input.targetVersion,
    "source journal target version"
  );
  const visibleInstallInvokedAt = requiredRfc3339(
    input.visibleInstallInvokedAt,
    "visible install invocation time"
  );
  const signal = requiredAbortSignal(input.signal);
  const readFile = dependencyOverrides.readFile ?? readStableFile;
  const watchDirectory = dependencyOverrides.watchDirectory ?? watch;

  const initial = await tryCapture({
    journalPath,
    platform,
    readFile,
    targetVersion,
    visibleInstallInvokedAt
  });
  if (initial !== null) return sealCapture(initial, outputPath, platform);
  if (signal.aborted) throw cancelledObservation(signal.reason);

  let events;
  try {
    events = watchDirectory(path.dirname(journalPath), { signal });
    dependencyOverrides.onWatchStarted?.();
    for await (const event of events) {
      if (
        event?.filename !== undefined &&
        String(event.filename) !== path.basename(journalPath)
      ) continue;
      const captured = await tryCapture({
        journalPath,
        platform,
        readFile,
        targetVersion,
        visibleInstallInvokedAt
      });
      if (captured !== null) return sealCapture(captured, outputPath, platform);
    }
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      throw cancelledObservation(signal.reason, error);
    }
    throw error;
  } finally {
    if (typeof events?.return === "function") await events.return();
  }
  throw new Error(
    "The source journal event stream ended before authoritative handoff evidence."
  );
}

async function tryCapture(input) {
  let file;
  try {
    file = await input.readFile(
      input.journalPath,
      MAX_JOURNAL_BYTES,
      "source updater install journal"
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EAGAIN") return null;
    throw error;
  }
  let document;
  try {
    document = JSON.parse(file.source.toString("utf8"));
  } catch (error) {
    throw new Error("The source updater install journal is invalid JSON.", {
      cause: error
    });
  }
  assertExactKeys(document, ["attempt", "schemaVersion"], "source install journal");
  assertEqual(document.schemaVersion, 1, "source install journal schema version");
  assertExactKeys(document.attempt, [
    "attemptId",
    "phase",
    "startedAt",
    "targetVersion",
    "updatedAt"
  ], "source install journal attempt");
  const startedAt = requiredRfc3339(
    document.attempt.startedAt,
    "source install journal start time"
  );
  const updatedAt = requiredRfc3339(
    document.attempt.updatedAt,
    "source install journal update time"
  );
  if (Date.parse(startedAt) < Date.parse(input.visibleInstallInvokedAt)) {
    throw new Error("The source install journal predates the visible install action.");
  }
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    throw new Error("The source install journal update precedes its start.");
  }
  assertEqual(
    document.attempt.targetVersion,
    input.targetVersion,
    "source install journal target version"
  );
  const expectedPhase = PLATFORM_PHASES[input.platform];
  if (document.attempt.phase !== expectedPhase) return null;
  const attemptId = requiredSourceInstallAttemptId(document.attempt.attemptId);
  return Object.freeze({ attemptId, document, file, startedAt, updatedAt });
}

async function sealCapture(captured, outputPath, platform) {
  await writeExclusive(outputPath, captured.file.source);
  const sealed = await readStableFile(
    outputPath,
    MAX_JOURNAL_BYTES,
    "sealed source updater install journal"
  );
  assertEqual(sealed.bytes, captured.file.bytes, "sealed source journal bytes");
  assertEqual(sealed.sha256, captured.file.sha256, "sealed source journal SHA-256");
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_CAPTURE_KIND,
    platform,
    sourceInstallAttemptId: captured.attemptId,
    phase: captured.document.attempt.phase,
    startedAt: captured.startedAt,
    updatedAt: captured.updatedAt,
    journal: publicIdentity(outputPath, sealed)
  });
}

function requiredPlatform(value) {
  if (!Object.hasOwn(PLATFORM_PHASES, value)) {
    throw new Error("The source journal platform is unsupported.");
  }
  return value;
}

function requiredAbortSignal(value) {
  if (
    !value || typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function"
  ) throw new Error("The source journal observer requires an AbortSignal.");
  return value;
}

function requiredSourceInstallAttemptId(value) {
  if (
    typeof value !== "string" ||
    !/^update-install-(?:[1-9]\d*|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.test(value)
  ) throw new Error("The source install journal attempt ID is invalid.");
  return value;
}

function cancelledObservation(reason, cause) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(
    "The source journal observation was cancelled before authoritative handoff" +
      `${suffix}.`,
    cause === undefined ? undefined : { cause }
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
