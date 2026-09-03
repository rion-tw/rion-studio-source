import { mkdir } from "node:fs/promises";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertWindowsCompatibilityTargetBindings,
  rereadWindowsPreparedUpdaterInput,
  rereadWindowsTauriV22Evidence
} from "./electronUpdaterCompatibilityEvidenceReaders.mjs";
import {
  assertWindowsCompatibilityExpectedBindings,
  readWindowsParentIsolationResult
} from "./electronUpdaterWindowsCompatibilityIsolationReader.mjs";
import {
  publicIdentity,
  readCanonicalJsonFile,
  assertExactKeys,
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

export const ELECTRON_UPDATER_COMPATIBILITY_TERMINAL_RECEIPT_NAME =
  "terminal-layout-probe-receipt.json";

const TERMINAL_EVIDENCE_KIND =
  "tauri-v22-input-plus-v23-layout-replacement-probe";
const MAX_JSON_BYTES = 1024 * 1024;

export async function finalizeWindowsElectronUpdaterCompatibilityTerminalReceipt(
  input
) {
  const childOutputRoot = await requiredRealDirectory(
    input.childOutputRoot,
    "child output root"
  );
  const sealedOutput = await resolveAbsentSiblingRoot(
    input.sealedOutputRoot,
    childOutputRoot
  );
  const expected = assertWindowsCompatibilityExpectedBindings(input.expected);
  const target = assertWindowsTarget(input.target);
  const preparedInput = await rereadWindowsPreparedUpdaterInput(
    input.preparedInput,
    expected,
    childOutputRoot
  );
  const v22 = await rereadWindowsTauriV22Evidence(
    input.tauriV22,
    expected,
    childOutputRoot
  );
  assertWindowsCompatibilityTargetBindings(
    preparedInput,
    v22,
    expected,
    target
  );
  const provisional = await readElectronUpdaterCompatibilityProvisionalReceipt(
    input.provisionalReceiptPath,
    childOutputRoot
  );
  const isolation = await readWindowsParentIsolationResult(
    input.isolationResultPath,
    childOutputRoot,
    expected,
    preparedInput
  );
  const finalizedAt = requiredRfc3339(
    input.finalizedAt ?? new Date().toISOString(),
    "terminal receipt finalization time"
  );
  if (Date.parse(finalizedAt) < Date.parse(provisional.receipt.probeCompletedAt)) {
    throw new Error(
      "The terminal receipt cannot precede the provisional probe observation."
    );
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
    ELECTRON_UPDATER_COMPATIBILITY_TERMINAL_RECEIPT_NAME
  );
  await writeExclusive(outputPath, serializeCanonicalJson(terminalReceipt));
  const output = await readCanonicalJsonFile(
    outputPath,
    MAX_JSON_BYTES,
    "terminal compatibility receipt"
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
  const cases = input.provisional.receipt.cases.map((observation) => {
    if (observation.probe !== "windows-installed-layout-replacement-and-relaunch") {
      return { ...observation };
    }
    return {
      isolation: input.isolation.result.isolationKind,
      outcome: observation.outcome,
      probe: observation.probe,
      sourceRuntime: observation.sourceRuntime,
      sourceVersion: observation.sourceRuntime === "tauri-v22"
        ? source.releaseVersion
        : input.target.priorV23Version,
      targetVersion: prepared.version
    };
  });
  return {
    schemaVersion: 2,
    evidenceKind: TERMINAL_EVIDENCE_KIND,
    status: "verified-after-parent-isolation",
    cutoverEligible: false,
    platform: "windows-x86_64",
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
      resultIdentity: input.isolation.resultIdentity,
      result: input.isolation.result
    },
    finalizedAt: input.finalizedAt
  };
}

function assertWindowsTarget(value) {
  assertExactKeys(value, [
    "priorV23Version",
    "updaterEndpoint",
    "version"
  ], "terminal receipt target");
  return Object.freeze({
    priorV23Version: requiredSemanticVersion(
      value.priorV23Version,
      "prior Electron v23 version"
    ),
    updaterEndpoint: requiredHttpsEndpoint(value.updaterEndpoint),
    version: requiredSemanticVersion(value.version, "Electron target version")
  });
}

function requiredHttpsEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new Error("The target updater endpoint must be one HTTPS URL.", {
      cause: error
    });
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash ||
    !endpoint.pathname.endsWith("/latest.json")
  ) {
    throw new Error(
      "The target updater endpoint must be one direct HTTPS latest.json URL."
    );
  }
  return endpoint.href;
}
