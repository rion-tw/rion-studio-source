import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { verifyElectronProductionPromotionReadiness } from
  "./electronProductionPromotionReadiness.mjs";

const ALLOWED_OPTIONS = new Set([
  "candidate-directory",
  "candidate-receipt",
  "candidate-receipt-sha256",
  "candidate-run-attempt",
  "candidate-run-control-sha",
  "candidate-run-id",
  "candidate-trusted-control-receipt",
  "challenge-id",
  "challenge-nonce-sha256",
  "electron-macos-receipt-sha256",
  "electron-windows-receipt-sha256",
  "evidence-directory",
  "evidence-run-attempt",
  "evidence-run-control-sha",
  "evidence-run-id",
  "mac-directory",
  "output",
  "owner-approval",
  "prior-candidate-directory",
  "prior-candidate-receipt",
  "prior-candidate-receipt-sha256",
  "prior-candidate-run-attempt",
  "prior-candidate-run-control-sha",
  "prior-candidate-run-id",
  "prior-candidate-trusted-control-receipt",
  "prior-electron-source-sha",
  "prior-electron-version",
  "prior-mac-directory",
  "prior-windows-directory",
  "provisional-publication-receipt",
  "provisional-publication-receipt-sha256",
  "provisional-publication-run-attempt",
  "provisional-publication-run-control-sha",
  "provisional-publication-run-id",
  "readiness-control-sha",
  "source-sha",
  "tauri-macos-receipt-sha256",
  "tauri-macos-lineage-receipt",
  "tauri-macos-lineage-receipt-sha256",
  "tauri-lineage-run-attempt",
  "tauri-lineage-run-control-sha",
  "tauri-lineage-run-id",
  "tauri-release-tag",
  "tauri-source-sha",
  "tauri-version",
  "tauri-windows-receipt-sha256",
  "tauri-windows-lineage-receipt",
  "tauri-windows-lineage-receipt-sha256",
  "version",
  "windows-directory"
]);

export async function runElectronProductionPromotionReadinessCli(
  argumentsList = process.argv.slice(2),
  environment = process.env
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify") {
    throw new Error(
      "Usage: electronProductionPromotionReadinessCli.mjs verify [exact evidence options]"
    );
  }
  const options = parseArguments(optionArguments);
  const receiptDigests = {
    "tauri-v22-to-electron-v23": {
      "darwin-aarch64": requiredOption(options, "tauri-macos-receipt-sha256"),
      "windows-x86_64": requiredOption(options, "tauri-windows-receipt-sha256")
    },
    "electron-v23-to-electron-v23": {
      "darwin-aarch64": requiredOption(options, "electron-macos-receipt-sha256"),
      "windows-x86_64": requiredOption(options, "electron-windows-receipt-sha256")
    }
  };
  return verifyElectronProductionPromotionReadiness({
    candidateDirectory: requiredOption(options, "candidate-directory"),
    candidateReceiptPath: requiredOption(options, "candidate-receipt"),
    candidateReceiptSha256: requiredOption(options, "candidate-receipt-sha256"),
    candidateTrustedControlReceiptPath: requiredOption(
      options,
      "candidate-trusted-control-receipt"
    ),
    challengeId: requiredOption(options, "challenge-id"),
    challengeNonceSha256: requiredOption(options, "challenge-nonce-sha256"),
    evidenceDirectory: requiredOption(options, "evidence-directory"),
    evidenceReceiptSha256: receiptDigests,
    macDirectory: requiredOption(options, "mac-directory"),
    outputPath: requiredOption(options, "output"),
    ownerApproval: requiredOption(options, "owner-approval"),
    provenance: {
      candidateRunControlSha: requiredOption(options, "candidate-run-control-sha"),
      candidateRunAttempt: requiredPositiveInteger(options, "candidate-run-attempt"),
      candidateRunId: requiredOption(options, "candidate-run-id"),
      evidenceRunControlSha: requiredOption(options, "evidence-run-control-sha"),
      evidenceRunAttempt: requiredPositiveInteger(options, "evidence-run-attempt"),
      evidenceRunId: requiredOption(options, "evidence-run-id"),
      priorCandidateRunControlSha: requiredOption(
        options,
        "prior-candidate-run-control-sha"
      ),
      priorCandidateRunAttempt: requiredPositiveInteger(
        options,
        "prior-candidate-run-attempt"
      ),
      priorCandidateRunId: requiredOption(options, "prior-candidate-run-id"),
      provisionalPublicationRunControlSha: requiredOption(
        options,
        "provisional-publication-run-control-sha"
      ),
      provisionalPublicationRunAttempt: requiredPositiveInteger(
        options,
        "provisional-publication-run-attempt"
      ),
      provisionalPublicationRunId: requiredOption(
        options,
        "provisional-publication-run-id"
      ),
      readinessControlSha: requiredOption(options, "readiness-control-sha"),
      repository: requiredEnvironment(environment, "GITHUB_REPOSITORY"),
      tauriLineageRunControlSha: requiredOption(options, "tauri-lineage-run-control-sha"),
      tauriLineageRunAttempt: requiredPositiveInteger(options, "tauri-lineage-run-attempt"),
      tauriLineageRunId: requiredOption(options, "tauri-lineage-run-id")
    },
    priorCandidateDirectory: requiredOption(options, "prior-candidate-directory"),
    priorCandidateReceiptPath: requiredOption(options, "prior-candidate-receipt"),
    priorCandidateReceiptSha256: requiredOption(
      options,
      "prior-candidate-receipt-sha256"
    ),
    priorCandidateTrustedControlReceiptPath: requiredOption(
      options,
      "prior-candidate-trusted-control-receipt"
    ),
    provisionalPublicationReceiptPath: requiredOption(
      options,
      "provisional-publication-receipt"
    ),
    provisionalPublicationReceiptSha256: requiredOption(
      options,
      "provisional-publication-receipt-sha256"
    ),
    priorElectronSourceSha: requiredOption(options, "prior-electron-source-sha"),
    priorElectronVersion: requiredOption(options, "prior-electron-version"),
    priorMacDirectory: requiredOption(options, "prior-mac-directory"),
    priorWindowsDirectory: requiredOption(options, "prior-windows-directory"),
    publicKey: requiredEnvironment(environment, "RION_STUDIO_UPDATER_PUBLIC_KEY"),
    sourceSha: requiredOption(options, "source-sha"),
    tauriReleaseTag: requiredOption(options, "tauri-release-tag"),
    tauriLineageReceiptPath: {
      "darwin-aarch64": requiredOption(options, "tauri-macos-lineage-receipt"),
      "windows-x86_64": requiredOption(options, "tauri-windows-lineage-receipt")
    },
    tauriLineageReceiptSha256: {
      "darwin-aarch64": requiredOption(options, "tauri-macos-lineage-receipt-sha256"),
      "windows-x86_64": requiredOption(options, "tauri-windows-lineage-receipt-sha256")
    },
    tauriSourceSha: requiredOption(options, "tauri-source-sha"),
    tauriVersion: requiredOption(options, "tauri-version"),
    version: requiredOption(options, "version"),
    windowsDirectory: requiredOption(options, "windows-directory")
  });
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid promotion-readiness option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new Error(`Unknown promotion-readiness option --${key}.`);
    }
    if (options.has(key)) throw new Error(`Duplicate promotion-readiness option --${key}.`);
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredPositiveInteger(options, name) {
  const value = requiredOption(options, name);
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} exceeds the safe integer range.`);
  return parsed;
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionPromotionReadinessCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
