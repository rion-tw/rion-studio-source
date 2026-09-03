import { mkdir } from "node:fs/promises";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertMacosCompatibilityExpectedBindings,
  assertMacosCompatibilityTargetBindings,
  readMacosParentIsolationResult,
  rereadMacosPreparedUpdaterInput,
  rereadMacosTauriV22Evidence
} from "./electronUpdaterMacosCompatibilityEvidenceReaders.mjs";
import {
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredRealDirectory,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveAbsentSiblingRoot,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
  readElectronUpdaterCompatibilityProvisionalReceipt,
  writeElectronUpdaterCompatibilityProvisionalReceipt
} from "./electronUpdaterCompatibilityProvisionalReceipt.mjs";

export {
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
  writeElectronUpdaterCompatibilityProvisionalReceipt
};

export const ELECTRON_UPDATER_MACOS_COMPATIBILITY_TERMINAL_RECEIPT_NAME =
  "terminal-layout-probe-receipt.json";

const TERMINAL_EVIDENCE_KIND =
  "tauri-v22-input-plus-v23-layout-replacement-probe";
const MAX_JSON_BYTES = 1024 * 1024;

export async function finalizeMacosElectronUpdaterCompatibilityTerminalReceipt(
  input
) {
  const childOutputRoot = await requiredRealDirectory(
    input.childOutputRoot,
    "macOS child output root"
  );
  const sealedOutput = await resolveAbsentSiblingRoot(
    input.sealedOutputRoot,
    childOutputRoot
  );
  const expected = assertMacosCompatibilityExpectedBindings(input.expected);
  const target = assertMacosTarget(input.target);
  const preparedInput = await rereadMacosPreparedUpdaterInput(
    input.preparedInput,
    expected,
    childOutputRoot
  );
  const v22 = await rereadMacosTauriV22Evidence(
    input.tauriV22,
    expected,
    childOutputRoot
  );
  assertMacosCompatibilityTargetBindings(preparedInput, v22, expected, target);
  const provisional = await readElectronUpdaterCompatibilityProvisionalReceipt(
    input.provisionalReceiptPath,
    childOutputRoot,
    "darwin"
  );
  assertObservedMacosTransitions(provisional.receipt.cases, {
    priorV23Version: target.priorV23Version,
    targetVersion: preparedInput.receipt.version,
    tauriV22Version: v22.inputReceipt.releaseVersion
  });
  const isolation = await readMacosParentIsolationResult(
    input.isolationResultPath,
    childOutputRoot,
    expected
  );
  const finalizedAt = requiredRfc3339(
    input.finalizedAt ?? new Date().toISOString(),
    "macOS terminal receipt finalization time"
  );
  for (const [timestamp, label] of [
    [provisional.receipt.probeCompletedAt, "provisional probe observation"],
    [isolation.result.completedAt, "Darwin isolation completion"]
  ]) {
    if (Date.parse(finalizedAt) < Date.parse(timestamp)) {
      throw new Error(`The macOS terminal receipt cannot precede the ${label}.`);
    }
  }

  const terminalReceipt = buildTerminalReceipt({
    finalizedAt,
    isolation,
    preparedInput,
    provisional,
    target,
    v22
  });
  await mkdir(sealedOutput.root, { mode: 0o700, recursive: false });
  const outputPath = path.join(
    sealedOutput.root,
    ELECTRON_UPDATER_MACOS_COMPATIBILITY_TERMINAL_RECEIPT_NAME
  );
  await writeExclusive(outputPath, serializeCanonicalJson(terminalReceipt));
  const output = await readCanonicalJsonFile(
    outputPath,
    MAX_JSON_BYTES,
    "macOS terminal compatibility receipt"
  );
  return Object.freeze({
    receipt: Object.freeze(terminalReceipt),
    receiptIdentity: publicIdentity(outputPath, output),
    receiptPath: outputPath
  });
}

function buildTerminalReceipt(input) {
  const source = input.v22.inputReceipt;
  const prepared = input.preparedInput.receipt;
  const isolationKind = input.isolation.result.containment.kind;
  const cases = input.provisional.receipt.cases.map((observation) => {
    if (!observation.probe.startsWith("macos-")) return { ...observation };
    return {
      ...observation,
      isolation: isolationKind,
    };
  });
  return {
    schemaVersion: 3,
    evidenceKind: TERMINAL_EVIDENCE_KIND,
    status: "verified-after-parent-isolation",
    cutoverEligible: false,
    platform: "darwin-aarch64",
    source: {
      runtime: "tauri-v22",
      releaseTag: source.releaseTag,
      releaseVersion: source.releaseVersion,
      sourceSha: source.sourceSha,
      artifactName: source.artifactName,
      artifactBytes: source.artifactBytes,
      artifactSha256: source.artifactSha256,
      signatureName: source.signatureName,
      signatureSha256: source.signatureSha256,
      manifestName: source.manifestName,
      manifestSha256: source.manifestSha256,
      checksumName: source.checksumName,
      checksumSha256: source.checksumSha256,
      inputReceipt: input.v22.inputReceiptIdentity,
      publicLineageReceipt: input.v22.lineageReceiptIdentity,
      runningExecutable: input.v22.lineageReceipt.runningExecutable
    },
    target: {
      runtime: "electron-v23",
      sourceSha: source.targetSha,
      version: prepared.version,
      artifactName: path.basename(prepared.artifact.path),
      artifactBytes: prepared.artifact.bytes,
      artifactSha256: prepared.artifact.sha256,
      signatureName: path.basename(prepared.artifactSignature.path),
      signatureBytes: prepared.artifactSignature.bytes,
      signatureSha256: prepared.artifactSignature.sha256,
      manifestName: path.basename(prepared.manifest.path),
      manifestBytes: prepared.manifest.bytes,
      manifestSha256: prepared.manifest.sha256,
      packageVerification: prepared.macosPackageVerification,
      preparedInputReceipt: input.preparedInput.receiptIdentity,
      updaterEndpoint: input.target.updaterEndpoint
    },
    trust: {
      updaterPublicKeySha256: source.updaterPublicKeySha256
    },
    transaction: {
      sourceUpdaterInvoked: false,
      terminalOutcome: "applied",
      cases
    },
    provisionalReceipt: {
      ...input.provisional.receiptIdentity,
      probeCompletedAt: input.provisional.receipt.probeCompletedAt
    },
    parentIsolation: {
      commandExitCode: 0,
      commandExecutable: input.isolation.commandExecutable,
      commandHarness: input.isolation.commandHarness,
      resultIdentity: input.isolation.resultIdentity,
      result: input.isolation.result
    },
    finalizedAt: input.finalizedAt
  };
}

function assertObservedMacosTransitions(cases, expected) {
  const bundleCases = cases.filter((entry) =>
    entry.probe === "macos-bundle-replacement");
  const helperCases = cases.filter((entry) =>
    entry.probe === "macos-helper-handoff-and-relaunch");
  const observedBundleSources = bundleCases
    .map((entry) => entry.sourceVersion)
    .sort();
  const expectedBundleSources = [
    expected.priorV23Version,
    expected.tauriV22Version
  ].sort();
  if (
    bundleCases.length !== 2 ||
    helperCases.length !== 1 ||
    JSON.stringify(observedBundleSources) !==
      JSON.stringify(expectedBundleSources) ||
    helperCases[0].sourceRuntime !== "tauri-v22" ||
    helperCases[0].sourceVersion !== expected.tauriV22Version ||
    ![...bundleCases, ...helperCases].every((entry) =>
      entry.targetVersion === expected.targetVersion &&
      entry.sourceVersion !== expected.targetVersion)
  ) {
    throw new Error(
      "The observed macOS updater transitions do not match the published v22, prior-v23, and prepared target bindings."
    );
  }
}

function assertMacosTarget(value) {
  assertExactKeys(value, [
    "priorV23Version",
    "updaterEndpoint",
    "version"
  ], "macOS terminal receipt target");
  return Object.freeze({
    priorV23Version: requiredSemanticVersion(
      value.priorV23Version,
      "prior macOS Electron v23 version"
    ),
    updaterEndpoint: requiredHttpsEndpoint(value.updaterEndpoint),
    version: requiredSemanticVersion(value.version, "macOS Electron target version")
  });
}

function requiredHttpsEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new Error("The macOS target updater endpoint must be one HTTPS URL.", {
      cause: error
    });
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash ||
    !endpoint.pathname.endsWith("/latest.json")
  ) {
    throw new Error(
      "The macOS target updater endpoint must be one direct HTTPS latest.json URL."
    );
  }
  return endpoint.href;
}
