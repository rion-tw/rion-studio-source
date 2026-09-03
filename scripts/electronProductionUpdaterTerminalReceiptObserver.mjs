import { watch } from "node:fs/promises";
import path from "node:path";

import {
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  publicIdentity,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND =
  "rion-production-updater-product-terminal-receipt-capture";
export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME =
  "product-terminal-receipt.json";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const PLATFORM_PHASES = Object.freeze({
  "darwin-aarch64": "restartPending",
  "windows-x86_64": "installerHandoff"
});

export async function observeElectronProductionUpdaterTerminalReceipt(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "outputPath",
    "platform",
    "signal",
    "sourceJournalPath",
    "targetUserDataDirectory",
    "targetVersion"
  ], "product terminal receipt observation input");
  const sourceJournalPath = requiredAbsolutePath(
    input.sourceJournalPath,
    "sealed source updater install journal"
  );
  const targetUserDataDirectory = requiredAbsolutePath(
    input.targetUserDataDirectory,
    "target updater user-data directory"
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME,
    "product terminal receipt capture"
  );
  assertPathOutsideRoot(
    outputPath,
    targetUserDataDirectory,
    "product terminal receipt capture"
  );
  const platform = requiredPlatform(input.platform);
  const targetVersion = requiredSemanticVersion(
    input.targetVersion,
    "product terminal target version"
  );
  const signal = requiredAbortSignal(input.signal);
  const readFile = dependencyOverrides.readFile ?? readStableFile;
  const watchDirectory = dependencyOverrides.watchDirectory ?? watch;
  const sourceJournal = await readJournal(
    sourceJournalPath,
    platform,
    targetVersion,
    readFile
  );
  const receiptPath = path.join(
    targetUserDataDirectory,
    "app-update-terminal-receipts",
    `${sourceJournal.file.sha256}.json`
  );
  const initial = await tryReadReceipt({
    platform,
    readFile,
    receiptPath,
    sourceJournal,
    targetVersion
  });
  if (initial !== null) return sealReceipt(initial, outputPath, platform);
  if (signal.aborted) throw cancelledObservation(signal.reason);

  let events;
  try {
    events = watchDirectory(targetUserDataDirectory, {
      recursive: true,
      signal
    });
    for await (const event of events) {
      const filename = event?.filename === undefined
        ? null
        : String(event.filename).replaceAll("\\", "/");
      if (
        filename !== null &&
        filename !== path.basename(receiptPath) &&
        !filename.endsWith(`/app-update-terminal-receipts/${path.basename(receiptPath)}`) &&
        !filename.endsWith(`/${path.basename(receiptPath)}`)
      ) continue;
      const receipt = await tryReadReceipt({
        platform,
        readFile,
        receiptPath,
        sourceJournal,
        targetVersion
      });
      if (receipt !== null) return sealReceipt(receipt, outputPath, platform);
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
    "The target terminal event stream ended before a product-authored receipt."
  );
}

export async function readElectronProductionUpdaterTerminalReceiptCapture(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "expectedSha256",
    "platform",
    "receiptPath",
    "sourceJournalPath",
    "targetVersion"
  ], "product terminal receipt capture read input");
  const platform = requiredPlatform(input.platform);
  const targetVersion = requiredSemanticVersion(
    input.targetVersion,
    "product terminal target version"
  );
  const readFile = dependencyOverrides.readFile ?? readStableFile;
  const sourceJournal = await readJournal(
    requiredAbsolutePath(
      input.sourceJournalPath,
      "sealed source updater install journal"
    ),
    platform,
    targetVersion,
    readFile
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "sealed product terminal receipt"
  );
  assertEqual(
    path.basename(receiptPath),
    ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME,
    "sealed product terminal receipt filename"
  );
  const file = await readFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "sealed product terminal receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, "sealed product terminal receipt SHA-256"),
    "sealed product terminal receipt SHA-256"
  );
  return terminalReceiptCapture(
    assertProductTerminalReceipt({
      file,
      platform,
      sourceJournal,
      targetVersion
    }),
    receiptPath,
    platform
  );
}

async function readJournal(journalPath, platform, targetVersion, readFile) {
  const file = await readFile(
    journalPath,
    MAX_RECEIPT_BYTES,
    "sealed source updater install journal"
  );
  const document = parseJson(file.source, "sealed source updater install journal");
  assertExactKeys(document, ["attempt", "schemaVersion"], "source install journal");
  assertEqual(document.schemaVersion, 1, "source install journal schema version");
  const attempt = assertAttempt(document.attempt, "source install journal attempt");
  assertEqual(attempt.targetVersion, targetVersion, "source journal target version");
  assertEqual(attempt.phase, PLATFORM_PHASES[platform], "source journal handoff phase");
  return Object.freeze({ attempt, file });
}

async function tryReadReceipt(input) {
  let file;
  try {
    file = await input.readFile(
      input.receiptPath,
      MAX_RECEIPT_BYTES,
      "product-authored terminal receipt"
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EAGAIN") return null;
    throw error;
  }
  return assertProductTerminalReceipt({ ...input, file });
}

function assertProductTerminalReceipt(input) {
  const file = input.file;
  const document = parseJson(file.source, "product-authored terminal receipt");
  assertExactKeys(document, [
    "attempt",
    "authority",
    "kind",
    "reconciledAt",
    "runningVersion",
    "schemaVersion",
    "sourceJournalBytes",
    "sourceJournalSha256",
    "sourcePhase",
    "terminalOutcome"
  ], "product-authored terminal receipt");
  assertEqual(document.schemaVersion, 1, "product terminal schema version");
  assertEqual(document.kind, "rion-updater-install-terminal",
    "product terminal receipt kind");
  assertEqual(document.authority, "target-first-boot-journal-reconciliation",
    "product terminal authority");
  assertEqual(document.sourceJournalBytes, input.sourceJournal.file.bytes,
    "product terminal source journal bytes");
  assertEqual(document.sourceJournalSha256, input.sourceJournal.file.sha256,
    "product terminal source journal SHA-256");
  assertEqual(document.sourcePhase, PLATFORM_PHASES[input.platform],
    "product terminal source phase");
  assertEqual(document.runningVersion, input.targetVersion,
    "product terminal running version");
  assertEqual(document.terminalOutcome, "applied", "product terminal outcome");
  const attempt = assertAttempt(document.attempt, "product terminal attempt");
  assertEqual(attempt.attemptId, input.sourceJournal.attempt.attemptId,
    "product terminal attempt ID");
  assertEqual(attempt.targetVersion, input.targetVersion,
    "product terminal attempt target version");
  assertEqual(attempt.phase, "applied", "product terminal attempt phase");
  assertEqual(attempt.startedAt, input.sourceJournal.attempt.startedAt,
    "product terminal attempt start");
  const reconciledAt = requiredRfc3339(
    document.reconciledAt,
    "product terminal reconciliation time"
  );
  assertEqual(attempt.updatedAt, reconciledAt, "product terminal attempt update time");
  if (Date.parse(reconciledAt) < Date.parse(input.sourceJournal.attempt.updatedAt)) {
    throw new Error("The product terminal receipt predates source handoff.");
  }
  return Object.freeze({ document, file, reconciledAt });
}

async function sealReceipt(captured, outputPath, platform) {
  await writeExclusive(outputPath, captured.file.source);
  const sealed = await readStableFile(
    outputPath,
    MAX_RECEIPT_BYTES,
    "sealed product terminal receipt"
  );
  assertEqual(sealed.bytes, captured.file.bytes, "sealed product receipt bytes");
  assertEqual(sealed.sha256, captured.file.sha256, "sealed product receipt SHA-256");
  return terminalReceiptCapture(
    { ...captured, file: sealed },
    outputPath,
    platform
  );
}

function terminalReceiptCapture(captured, receiptPath, platform) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND,
    authority: captured.document.authority,
    platform,
    reconciledAt: captured.reconciledAt,
    sourceInstallAttemptId: captured.document.attempt.attemptId,
    terminalOutcome: "applied",
    receipt: publicIdentity(receiptPath, captured.file)
  });
}

function assertAttempt(value, label) {
  assertExactKeys(value, [
    "attemptId",
    "phase",
    "startedAt",
    "targetVersion",
    "updatedAt"
  ], label);
  if (typeof value.attemptId !== "string" || !value.attemptId.startsWith("update-install-")) {
    throw new Error(`The ${label} ID is invalid.`);
  }
  return Object.freeze({
    attemptId: value.attemptId,
    phase: value.phase,
    startedAt: requiredRfc3339(value.startedAt, `${label} start time`),
    targetVersion: requiredSemanticVersion(value.targetVersion, `${label} target version`),
    updatedAt: requiredRfc3339(value.updatedAt, `${label} update time`)
  });
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
}

function requiredPlatform(value) {
  if (!Object.hasOwn(PLATFORM_PHASES, value)) {
    throw new Error("The product terminal platform is unsupported.");
  }
  return value;
}

function requiredAbortSignal(value) {
  if (
    !value || typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function"
  ) throw new Error("The product terminal observer requires an AbortSignal.");
  return value;
}

function cancelledObservation(reason, cause) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(
    "The product terminal observation was cancelled before authoritative receipt" +
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
