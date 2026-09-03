import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { verifyElectronProductionCandidateBundle } from
  "./electronProductionCandidateVerifier.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
  assertElectronProductionUpdaterEvidenceEndpointObservationBindings
} from "./electronProductionUpdaterEvidenceEndpointObservation.mjs";
import {
  readElectronProductionUpdaterEvidenceAttemptPlan
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  readElectronProductionUpdaterTrustedControlBindings,
  readElectronProductionUpdaterTrustedControlDescriptor
} from "./electronProductionUpdaterTrustedControlIntake.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredDigest,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import { readTauriV22PublicLineageReceipt } from "./tauriV22PublicLineage.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_BUNDLE_BINDINGS_FILE =
  "bundle-bindings.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_BINDINGS_FILE =
  "endpoint-observation-bindings.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND =
  "rion-electron-production-updater-evidence-cell-bindings";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const TAURI_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";

export async function createElectronProductionUpdaterEvidenceCellBindings(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "attemptPlanPath",
    "descriptorPath",
    "expectedAttemptPlanSha256",
    "expectedTrustedBindingsSha256",
    "outputRoot",
    "platform",
    "transitionKind",
    "trustedBindingsPath"
  ], "updater evidence cell-bindings input");
  const dependencies = resolveDependencies(dependencyOverrides);
  const platform = requiredEnum(input.platform, PLATFORMS, "cell-bindings platform");
  const transitionKind = requiredEnum(
    input.transitionKind,
    TRANSITIONS,
    "cell-bindings transition"
  );
  const expectedAttemptPlanSha256 = requiredDigest(
    input.expectedAttemptPlanSha256,
    "cell-bindings attempt-plan SHA-256"
  );
  const expectedTrustedBindingsSha256 = requiredDigest(
    input.expectedTrustedBindingsSha256,
    "cell-bindings trusted bindings SHA-256"
  );
  const [planRead, trustedRead, descriptorRead] = await Promise.all([
    dependencies.readPlan({
      expectedSha256: expectedAttemptPlanSha256,
      planPath: requiredAbsolutePath(input.attemptPlanPath, "cell-bindings attempt plan")
    }),
    dependencies.readTrustedBindings({
      bindingsPath: requiredAbsolutePath(
        input.trustedBindingsPath,
        "cell-bindings trusted bindings"
      ),
      expectedSha256: expectedTrustedBindingsSha256
    }),
    dependencies.readDescriptor({
      descriptorPath: requiredAbsolutePath(
        input.descriptorPath,
        "cell-bindings trusted descriptor"
      )
    })
  ]);
  assertEqual(planRead.planIdentity.sha256, expectedAttemptPlanSha256,
    "cell-bindings attempt-plan SHA-256");
  assertEqual(trustedRead.bindingsIdentity.sha256, expectedTrustedBindingsSha256,
    "cell-bindings trusted bindings SHA-256");
  assertTrustedPlan(trustedRead.bindings, planRead.plan);
  const descriptor = descriptorRead.descriptor;
  const selectedCell = selectCell(planRead.plan, platform, transitionKind);
  const publicKey = descriptor.productionUpdaterPublicKey;
  const [targetCandidate, priorCandidate, lineage] = await Promise.all([
    dependencies.verifyCandidate(candidateInput(descriptor.target, publicKey)),
    dependencies.verifyCandidate(candidateInput(descriptor.priorV23, publicKey)),
    dependencies.readLineage({
      expectedReceiptSha256:
        descriptor.tauriV22.artifacts[platform].receiptSha256,
      receiptPath: descriptor.tauriV22.artifacts[platform].receiptPath
    })
  ]);
  assertCandidateMatchesPlan(
    targetCandidate,
    planRead.plan.upstream.target,
    "target"
  );
  assertCandidateMatchesPlan(
    priorCandidate,
    planRead.plan.upstream.priorV23,
    "prior-v23"
  );
  assertLineageMatchesPlan(lineage, planRead.plan.upstream.tauriV22, platform);
  const sourceBinding = transitionKind === "tauri-v22-to-electron-v23"
    ? tauriSourceBinding(lineage)
    : electronSourceBinding(
        priorCandidate,
        planRead.plan.upstream.priorV23.candidateReceiptSha256,
        platform
      );
  const targetBinding = electronTargetBinding(
    targetCandidate,
    planRead.plan.upstream.target.candidateReceiptSha256,
    platform
  );
  const bundleBindings = deepFreeze({
    provenance: planRead.plan.producer,
    sourceBinding,
    targetBinding
  });
  const endpointBindings =
    assertElectronProductionUpdaterEvidenceEndpointObservationBindings({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
      attemptPlanSha256: planRead.planIdentity.sha256,
      context: {
        challenge: planRead.plan.challenge,
        evidenceAttemptId: selectedCell.evidenceAttemptId,
        platform,
        transitionKind
      },
      endpoint: {
        artifactName: targetBinding.artifactName,
        artifactSha256: targetBinding.artifactSha256,
        manifestName: "latest.json",
        requestEndpoint: transitionKind === "tauri-v22-to-electron-v23"
          ? sourceBinding.defaultUpdaterEndpoint
          : sourceBinding.embeddedUpdaterEndpoint,
        servedManifestSha256: targetBinding.servedManifestSha256,
        signatureName: targetBinding.signatureName,
        signatureSha256: targetBinding.signatureSha256,
        targetEmbeddedUpdaterEndpoint: targetBinding.embeddedUpdaterEndpoint,
        targetVersion: targetBinding.version,
        updaterPublicKeySha256: targetBinding.updaterPublicKeySha256
      }
    });
  const outputRoot = await resolveCreateNewDirectory(input.outputRoot);
  await mkdir(outputRoot, { mode: 0o700 });
  const bundlePath = path.join(
    outputRoot,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_BUNDLE_BINDINGS_FILE
  );
  const endpointPath = path.join(
    outputRoot,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_BINDINGS_FILE
  );
  await Promise.all([
    writeExclusive(bundlePath, serializeCanonicalJson(bundleBindings)),
    writeExclusive(endpointPath, serializeCanonicalJson(endpointBindings))
  ]);
  const [bundleFile, endpointFile] = await Promise.all([
    readCanonicalJsonFile(bundlePath, MAX_DOCUMENT_BYTES,
      "updater evidence bundle bindings"),
    readCanonicalJsonFile(endpointPath, MAX_DOCUMENT_BYTES,
      "updater evidence endpoint bindings")
  ]);
  assertDeepEqual(bundleFile.value, bundleBindings, "bundle bindings writeback");
  assertDeepEqual(endpointFile.value, endpointBindings, "endpoint bindings writeback");
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND,
    platform,
    transitionKind,
    outputRoot,
    bundleBindings,
    bundleIdentity: publicIdentity(bundlePath, bundleFile),
    endpointBindings,
    endpointIdentity: publicIdentity(endpointPath, endpointFile)
  });
}

function candidateInput(value, publicKey) {
  return {
    candidateDirectory: value.candidateDirectory,
    candidateReceiptPath: value.candidateReceiptPath,
    candidateReceiptSha256: value.candidateReceiptSha256,
    macDirectory: value.macDirectory,
    publicKey,
    sourceSha: value.sourceSha,
    version: value.version,
    windowsDirectory: value.windowsDirectory
  };
}

function tauriSourceBinding(lineage) {
  return deepFreeze({
    artifactName: lineage.assets.artifact.name,
    artifactSha256: lineage.assets.artifact.sha256,
    defaultUpdaterEndpoint: TAURI_ENDPOINT,
    lineageKind: "published-release",
    manifestName: "latest.json",
    manifestSha256: lineage.assets.manifest.sha256,
    releaseTag: lineage.release.tag,
    runningImageSha256: lineage.runningExecutable.sha256,
    runtime: "tauri-v22",
    sourceSha: lineage.sourceTag.peeledCommitSha,
    version: lineage.release.version
  });
}

function electronSourceBinding(candidate, candidateReceiptSha256, platform) {
  const receipt = candidate.receipt;
  const platformReceipt = receipt.platforms[platform];
  return deepFreeze({
    artifactName: platformReceipt.artifact.fileName,
    artifactSha256: platformReceipt.artifact.sha256,
    candidateReceiptSha256,
    embeddedUpdaterEndpoint: receipt.updaterEndpoint,
    lineageKind: "production-candidate",
    manifestName: "latest.json",
    manifestSha256: receipt.assets["latest.json"],
    runningImageSha256: platformReceipt.blackBox.executable.sha256,
    runtime: "electron-v23",
    sourceSha: receipt.sourceSha,
    version: receipt.version
  });
}

function electronTargetBinding(candidate, candidateReceiptSha256, platform) {
  const receipt = candidate.receipt;
  const platformReceipt = receipt.platforms[platform];
  return deepFreeze({
    artifactName: platformReceipt.artifact.fileName,
    artifactSha256: platformReceipt.artifact.sha256,
    candidateReceiptSha256,
    embeddedUpdaterEndpoint: receipt.updaterEndpoint,
    manifestName: "latest.json",
    runtime: "electron-v23",
    servedManifestSha256: receipt.assets["latest.json"],
    signatureName: platformReceipt.artifact.signatureFileName,
    signatureSha256: platformReceipt.artifact.signatureSha256,
    sourceSha: receipt.sourceSha,
    targetRunningImageSha256: platformReceipt.blackBox.executable.sha256,
    updaterPublicKeySha256: receipt.publicKeySha256,
    version: receipt.version
  });
}

function assertCandidateMatchesPlan(candidate, expected, label) {
  assertEqual(candidate.receiptSha256, expected.candidateReceiptSha256,
    `${label} candidate receipt SHA-256`);
  assertEqual(candidate.sourceSha, expected.sourceSha, `${label} source SHA`);
  assertEqual(candidate.version, expected.version, `${label} version`);
}

function assertLineageMatchesPlan(lineage, expected, platform) {
  assertEqual(lineage.platform, platform, "Tauri lineage platform");
  assertEqual(lineage.release.tag, expected.releaseTag, "Tauri lineage release tag");
  assertEqual(lineage.release.version, expected.version, "Tauri lineage version");
  assertEqual(lineage.sourceTag.peeledCommitSha, expected.sourceSha,
    "Tauri lineage source SHA");
  assertEqual(lineage.targetSourceSha, expected.targetSourceSha,
    "Tauri lineage target SHA");
}

function assertTrustedPlan(bindings, plan) {
  assertDeepEqual(bindings.producer, plan.producer, "trusted producer bindings");
  assertDeepEqual(bindings.upstream, plan.upstream, "trusted upstream bindings");
}

function selectCell(plan, platform, transitionKind) {
  const cells = plan.cells.filter((cell) =>
    cell.platform === platform && cell.transitionKind === transitionKind
  );
  if (cells.length !== 1) {
    throw new Error("The updater evidence plan does not contain one exact cell.");
  }
  return cells[0];
}

async function resolveCreateNewDirectory(value) {
  const requested = requiredAbsolutePath(value, "cell-bindings output root");
  const parent = await realpath(path.dirname(requested));
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("The cell-bindings output parent must be a real directory.");
  }
  const output = path.join(parent, path.basename(requested));
  try { await lstat(output); } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  throw new Error("The cell-bindings output root must be create-new.");
}

function requiredEnum(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater cell-bindings dependencies must be an object.");
  }
  const allowed = new Set([
    "readDescriptor", "readLineage", "readPlan", "readTrustedBindings",
    "verifyCandidate"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown cell-bindings dependency ${key}.`);
  }
  const result = {
    readDescriptor: value.readDescriptor ??
      readElectronProductionUpdaterTrustedControlDescriptor,
    readLineage: value.readLineage ?? readTauriV22PublicLineageReceipt,
    readPlan: value.readPlan ?? readElectronProductionUpdaterEvidenceAttemptPlan,
    readTrustedBindings: value.readTrustedBindings ??
      readElectronProductionUpdaterTrustedControlBindings,
    verifyCandidate: value.verifyCandidate ?? verifyElectronProductionCandidateBundle
  };
  for (const [name, entry] of Object.entries(result)) {
    if (typeof entry !== "function") {
      throw new Error(`The updater cell-bindings dependency ${name} is invalid.`);
    }
  }
  return Object.freeze(result);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
