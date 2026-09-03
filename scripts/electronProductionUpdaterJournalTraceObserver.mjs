import { watch } from "node:fs/promises";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND =
  "rion-production-updater-source-journal-trace";
export const ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_NAME =
  "source-journal-trace.json";

const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_TAURI_ATTEMPT = 18_446_744_073_709_551_615n;
const TERMINAL_PHASES = Object.freeze({
  "darwin-aarch64": "restartPending",
  "windows-x86_64": "installerHandoff"
});

export async function observeElectronProductionUpdaterJournalTrace(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "journalPath",
    "outputPath",
    "platform",
    "signal",
    "targetVersion",
    "transitionKind",
    "visibleInstallInvokedAt"
  ], "source journal trace observation input");
  const journalPath = requiredAbsolutePath(
    input.journalPath,
    "source updater install journal"
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_NAME,
    "source journal trace output"
  );
  assertPathOutsideRoot(
    outputPath,
    path.dirname(journalPath),
    "source journal trace output"
  );
  const platform = requiredPlatform(input.platform);
  const transitionKind = requiredTransition(input.transitionKind);
  const targetVersion = requiredSemanticVersion(
    input.targetVersion,
    "source journal trace target version"
  );
  const visibleInstallInvokedAt = requiredRfc3339(
    input.visibleInstallInvokedAt,
    "visible install invocation time"
  );
  const signal = requiredAbortSignal(input.signal);
  const readFile = dependencyOverrides.readFile ?? readStableFile;
  const watchDirectory = dependencyOverrides.watchDirectory ?? watch;
  const now = dependencyOverrides.now ?? (() => new Date());
  const expectedPhases = [
    "accepted",
    "preparing",
    "installing",
    "draining",
    TERMINAL_PHASES[platform]
  ];
  const observations = [];

  await captureCurrent({
    expectedPhases,
    journalPath,
    now,
    observations,
    platform,
    readFile,
    targetVersion,
    transitionKind,
    visibleInstallInvokedAt
  });
  if (observations.length === expectedPhases.length) {
    return sealTrace({
      observations,
      outputPath,
      platform,
      targetVersion,
      transitionKind,
      visibleInstallInvokedAt
    });
  }
  if (signal.aborted) throw cancelledObservation(signal.reason);

  let events;
  try {
    events = watchDirectory(path.dirname(journalPath), { signal });
    dependencyOverrides.onWatchStarted?.();
    for await (const event of events) {
      if (!isRelevantJournalEvent(event, journalPath)) continue;
      await captureCurrent({
        expectedPhases,
        journalPath,
        now,
        observations,
        platform,
        readFile,
        targetVersion,
        transitionKind,
        visibleInstallInvokedAt
      });
      if (observations.length === expectedPhases.length) {
        return sealTrace({
          observations,
          outputPath,
          platform,
          targetVersion,
          transitionKind,
          visibleInstallInvokedAt
        });
      }
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
    "The source journal event stream ended before the exact handoff phase trace."
  );
}

export async function readElectronProductionUpdaterJournalTrace(input) {
  assertExactKeys(input, input?.expectedSha256 === undefined
    ? ["tracePath"]
    : ["expectedSha256", "tracePath"],
    "source journal trace read input");
  const tracePath = requiredAbsolutePath(input.tracePath, "source journal trace");
  assertEqual(path.basename(tracePath), ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_NAME,
    "source journal trace filename");
  const file = await readCanonicalJsonFile(
    tracePath,
    MAX_TRACE_BYTES,
    "source journal trace"
  );
  if (input.expectedSha256 !== undefined) {
    assertEqual(file.sha256,
      requiredDigest(input.expectedSha256, "source journal trace SHA-256"),
      "source journal trace SHA-256");
  }
  return deepFreeze({
    trace: assertElectronProductionUpdaterJournalTrace(file.value),
    traceIdentity: publicIdentity(tracePath, file),
    tracePath
  });
}

export function assertElectronProductionUpdaterJournalTrace(value) {
  assertExactKeys(value, [
    "kind",
    "observations",
    "platform",
    "schemaVersion",
    "sourceInstallAttemptId",
    "targetVersion",
    "transitionKind",
    "visibleInstallInvokedAt"
  ], "source journal trace");
  assertEqual(value.schemaVersion, 1, "source journal trace schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND,
    "source journal trace kind");
  const platform = requiredPlatform(value.platform);
  const transitionKind = requiredTransition(value.transitionKind);
  const targetVersion = requiredSemanticVersion(value.targetVersion,
    "source journal trace target version");
  const visibleInstallInvokedAt = requiredRfc3339(value.visibleInstallInvokedAt,
    "visible install invocation time");
  const sourceInstallAttemptId = requiredSourceInstallAttemptId(
    value.sourceInstallAttemptId,
    transitionKind
  );
  const expectedPhases = [
    "accepted",
    "preparing",
    "installing",
    "draining",
    TERMINAL_PHASES[platform]
  ];
  if (!Array.isArray(value.observations) || value.observations.length !== 5) {
    throw new Error("The source journal trace must contain exactly five observations.");
  }
  let previousUpdatedAt = null;
  let previousObservedAt = null;
  let startedAt = null;
  const observations = value.observations.map((observation, index) => {
    const label = `source journal trace observation ${index + 1}`;
    assertExactKeys(observation, [
      "journal",
      "observedAt",
      "phase",
      "sequence",
      "sourceInstallAttemptId",
      "startedAt",
      "updatedAt"
    ], label);
    assertEqual(observation.sequence, index + 1, `${label} sequence`);
    assertEqual(observation.phase, expectedPhases[index], `${label} phase`);
    assertEqual(observation.sourceInstallAttemptId, sourceInstallAttemptId,
      `${label} attempt ID`);
    const currentStartedAt = requiredRfc3339(observation.startedAt, `${label} start time`);
    const updatedAt = requiredRfc3339(observation.updatedAt, `${label} update time`);
    const observedAt = requiredRfc3339(observation.observedAt, `${label} observed-at`);
    if (startedAt === null) startedAt = currentStartedAt;
    else assertEqual(currentStartedAt, startedAt, `${label} start time`);
    if (Date.parse(currentStartedAt) < Date.parse(visibleInstallInvokedAt)) {
      throw new Error("The source journal trace predates the visible install action.");
    }
    if (Date.parse(updatedAt) < Date.parse(currentStartedAt) ||
        Date.parse(observedAt) < Date.parse(updatedAt)) {
      throw new Error(`The ${label} timestamps are not causally ordered.`);
    }
    if (previousUpdatedAt !== null && Date.parse(updatedAt) < Date.parse(previousUpdatedAt)) {
      throw new Error("The source journal trace update times are not monotonic.");
    }
    if (previousObservedAt !== null && Date.parse(observedAt) < Date.parse(previousObservedAt)) {
      throw new Error("The source journal trace observation times are not monotonic.");
    }
    previousUpdatedAt = updatedAt;
    previousObservedAt = observedAt;
    assertExactKeys(observation.journal, ["bytes", "sha256"], `${label} journal`);
    if (!Number.isSafeInteger(observation.journal.bytes) || observation.journal.bytes <= 0 ||
        observation.journal.bytes > MAX_JOURNAL_BYTES) {
      throw new Error(`The ${label} journal byte length is invalid.`);
    }
    return Object.freeze({
      sequence: index + 1,
      phase: expectedPhases[index],
      observedAt,
      sourceInstallAttemptId,
      startedAt: currentStartedAt,
      updatedAt,
      journal: Object.freeze({
        bytes: observation.journal.bytes,
        sha256: requiredDigest(observation.journal.sha256, `${label} journal SHA-256`)
      })
    });
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND,
    platform,
    transitionKind,
    targetVersion,
    visibleInstallInvokedAt,
    sourceInstallAttemptId,
    observations
  });
}

async function captureCurrent(input) {
  let file;
  try {
    file = await input.readFile(
      input.journalPath,
      MAX_JOURNAL_BYTES,
      "source updater install journal phase"
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EAGAIN") return;
    throw error;
  }
  const document = parseJournal(file.source);
  const attempt = document.attempt;
  assertEqual(
    attempt.targetVersion,
    input.targetVersion,
    "source journal trace target version"
  );
  const attemptId = requiredSourceInstallAttemptId(
    attempt.attemptId,
    input.transitionKind
  );
  const startedAt = requiredRfc3339(attempt.startedAt, "source journal trace start time");
  const updatedAt = requiredRfc3339(attempt.updatedAt, "source journal trace update time");
  if (Date.parse(startedAt) < Date.parse(input.visibleInstallInvokedAt)) {
    throw new Error("The source journal trace predates the visible install action.");
  }
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    throw new Error("The source journal trace update precedes its start.");
  }
  const observedAt = requiredObservedAt(input.now());
  if (Date.parse(observedAt) < Date.parse(updatedAt)) {
    throw new Error("The source journal phase observation predates the product update time.");
  }

  const phaseIndex = input.expectedPhases.indexOf(attempt.phase);
  if (phaseIndex < 0) {
    throw new Error(`The source journal entered non-success phase ${String(attempt.phase)}.`);
  }
  const expectedIndex = input.observations.length;
  if (phaseIndex < expectedIndex) {
    const prior = input.observations[phaseIndex];
    if (
      prior.sourceInstallAttemptId === attemptId &&
      prior.journal.sha256 === file.sha256
    ) return;
    throw new Error("The source journal phase trace regressed or mutated a captured phase.");
  }
  if (phaseIndex > expectedIndex) {
    throw new Error(
      `The source journal phase trace skipped ${input.expectedPhases[expectedIndex]}.`
    );
  }
  if (input.observations.length > 0) {
    const first = input.observations[0];
    assertEqual(attemptId, first.sourceInstallAttemptId,
      "source journal trace attempt ID");
    assertEqual(startedAt, first.startedAt, "source journal trace start time");
    const previous = input.observations.at(-1);
    if (Date.parse(updatedAt) < Date.parse(previous.updatedAt)) {
      throw new Error("The source journal trace update times are not monotonic.");
    }
    if (Date.parse(observedAt) < Date.parse(previous.observedAt)) {
      throw new Error("The source journal trace observation times are not monotonic.");
    }
  }
  input.observations.push(Object.freeze({
    sequence: expectedIndex + 1,
    phase: attempt.phase,
    observedAt,
    sourceInstallAttemptId: attemptId,
    startedAt,
    updatedAt,
    journal: Object.freeze({ bytes: file.bytes, sha256: file.sha256 })
  }));
}

function parseJournal(source) {
  let document;
  try {
    document = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The source updater install journal phase is invalid JSON.", {
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
  return document;
}

async function sealTrace(input) {
  const trace = assertElectronProductionUpdaterJournalTrace({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND,
    platform: input.platform,
    transitionKind: input.transitionKind,
    targetVersion: input.targetVersion,
    visibleInstallInvokedAt: input.visibleInstallInvokedAt,
    sourceInstallAttemptId: input.observations[0].sourceInstallAttemptId,
    observations: input.observations
  });
  await writeExclusive(input.outputPath, serializeCanonicalJson(trace));
  const file = await readStableFile(
    input.outputPath,
    MAX_TRACE_BYTES,
    "sealed source journal trace"
  );
  return deepFreeze({
    trace,
    traceIdentity: publicIdentity(input.outputPath, file),
    tracePath: input.outputPath
  });
}

function isRelevantJournalEvent(event, journalPath) {
  if (event?.filename === undefined) return true;
  const name = String(event.filename);
  const canonical = path.basename(journalPath);
  return name === canonical ||
    (name.startsWith(`.${canonical}.`) && name.endsWith(".tmp"));
}

function requiredSourceInstallAttemptId(value, transitionKind) {
  if (transitionKind === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9]\d*)$/u.exec(value);
    if (!match || BigInt(match[1]) > MAX_TAURI_ATTEMPT) {
      throw new Error("The Tauri source install attempt ID is invalid.");
    }
    return value;
  }
  if (
    typeof value !== "string" ||
    !/^update-install-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error("The Electron source install attempt ID is invalid.");
  return value;
}

function requiredObservedAt(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The source journal phase observation clock is invalid.");
  }
  return value.toISOString();
}

function requiredPlatform(value) {
  if (!Object.hasOwn(TERMINAL_PHASES, value)) {
    throw new Error("The source journal trace platform is unsupported.");
  }
  return value;
}

function requiredTransition(value) {
  if (
    value !== "tauri-v22-to-electron-v23" &&
    value !== "electron-v23-to-electron-v23"
  ) throw new Error("The source journal trace transition is unsupported.");
  return value;
}

function requiredAbortSignal(value) {
  if (
    !value || typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function"
  ) throw new Error("The source journal trace observer requires an AbortSignal.");
  return value;
}

function cancelledObservation(reason, cause) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(
    `The source journal trace was cancelled before authoritative handoff${suffix}.`,
    cause === undefined ? undefined : { cause }
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
