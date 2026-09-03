import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { normalizeUpdaterPublicKey } from "./electronProductionCandidate.mjs";
import { readTrustedControlReceipt } from
  "./electronProductionCandidateTrustedControl.mjs";
import { verifyElectronProductionCandidateBundle } from
  "./electronProductionCandidateVerifier.mjs";
import { readElectronProductionPublicationReceipt } from
  "./electronProductionPublicationReceipt.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW,
  assertElectronProductionUpdaterEvidenceAttemptPlanBindings,
  readElectronProductionUpdaterEvidenceAttemptPlanBindings
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  TAURI_V22_COMPATIBILITY_WORKFLOW,
  assertTauriV22PublicLineagePair,
  readTauriV22PublicLineageReceipt
} from "./tauriV22PublicLineage.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND =
  "rion-electron-production-updater-trusted-control-intake";
export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE =
  "electron-production-updater-evidence-attempt-plan-bindings.json";

const CANDIDATE_WORKFLOW =
  ".github/workflows/electron-production-candidate.yml";
const PROVISIONAL_WORKFLOW =
  ".github/workflows/electron-production-provisional-publish.yml";
const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);

export async function createElectronProductionUpdaterTrustedControlBindings(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, ["descriptorPath", "outputPath"],
    "updater trusted-control intake input");
  const dependencies = resolveDependencies(dependencyOverrides);
  const descriptorPath = requiredAbsolutePath(
    input.descriptorPath,
    "updater trusted-control descriptor"
  );
  const descriptorFile = await readCanonicalJsonFile(
    descriptorPath,
    MAX_DESCRIPTOR_BYTES,
    "updater trusted-control descriptor"
  );
  const descriptor = assertDescriptor(descriptorFile.value);
  const publicKey = normalizeUpdaterPublicKey(
    descriptor.productionUpdaterPublicKey
  );

  const [
    targetCandidate,
    targetControl,
    priorCandidate,
    priorControl,
    macosLineage,
    windowsLineage,
    provisionalFile
  ] = await Promise.all([
    dependencies.verifyCandidate(candidateVerificationInput(
      descriptor.target,
      publicKey.canonicalBase64
    )),
    dependencies.readTrustedControl(controlReadInput(descriptor.target)),
    dependencies.verifyCandidate(candidateVerificationInput(
      descriptor.priorV23,
      publicKey.canonicalBase64
    )),
    dependencies.readTrustedControl(controlReadInput(descriptor.priorV23)),
    dependencies.readTauriLineage({
      expectedReceiptSha256:
        descriptor.tauriV22.artifacts["darwin-aarch64"].receiptSha256,
      receiptPath: descriptor.tauriV22.artifacts["darwin-aarch64"].receiptPath
    }),
    dependencies.readTauriLineage({
      expectedReceiptSha256:
        descriptor.tauriV22.artifacts["windows-x86_64"].receiptSha256,
      receiptPath: descriptor.tauriV22.artifacts["windows-x86_64"].receiptPath
    }),
    dependencies.readPublicationReceipt({
      expectedSha256: descriptor.provisionalPublication.receiptSha256,
      receiptPath: descriptor.provisionalPublication.receiptPath
    })
  ]);

  assertCandidateVerification(
    targetCandidate,
    targetControl,
    descriptor.target,
    publicKey.sha256,
    "target"
  );
  assertCandidateVerification(
    priorCandidate,
    priorControl,
    descriptor.priorV23,
    publicKey.sha256,
    "prior-v23"
  );
  const lineage = dependencies.assertTauriLineagePair({
    macos: macosLineage,
    windows: windowsLineage
  });
  assertTauriBindings(
    lineage,
    descriptor.tauriV22,
    descriptor.target,
    publicKey.sha256
  );
  assertProvisionalBindings(
    provisionalFile,
    descriptor.provisionalPublication,
    descriptor.target,
    descriptor.tauriV22,
    targetCandidate,
    lineage
  );

  const bindings = assertElectronProductionUpdaterEvidenceAttemptPlanBindings({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
    producer: descriptor.producer,
    upstream: {
      target: candidateIdentity(descriptor.target),
      priorV23: candidateIdentity(descriptor.priorV23),
      tauriV22: {
        artifacts: Object.fromEntries(PLATFORMS.map((platform) => [
          platform,
          {
            artifactName: descriptor.tauriV22.artifacts[platform].artifactName,
            receiptSha256: descriptor.tauriV22.artifacts[platform].receiptSha256
          }
        ])),
        controlSha: descriptor.tauriV22.controlSha,
        releaseTag: descriptor.tauriV22.releaseTag,
        repository: descriptor.tauriV22.repository,
        runAttempt: descriptor.tauriV22.runAttempt,
        runId: descriptor.tauriV22.runId,
        sourceSha: descriptor.tauriV22.sourceSha,
        targetSourceSha: descriptor.tauriV22.targetSourceSha,
        version: descriptor.tauriV22.version,
        workflow: descriptor.tauriV22.workflow
      },
      provisionalPublication: {
        artifactName: descriptor.provisionalPublication.artifactName,
        controlSha: descriptor.provisionalPublication.controlSha,
        receiptSha256: descriptor.provisionalPublication.receiptSha256,
        repository: descriptor.provisionalPublication.repository,
        revision: provisionalFile.receipt.revision,
        runAttempt: descriptor.provisionalPublication.runAttempt,
        runId: descriptor.provisionalPublication.runId,
        transactionId: provisionalFile.receipt.transactionId,
        workflow: descriptor.provisionalPublication.workflow
      }
    }
  });
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE,
    "updater trusted-control bindings"
  );
  await writeExclusive(outputPath, serializeCanonicalJson(bindings));
  const written = await readCanonicalJsonFile(
    outputPath,
    MAX_BINDINGS_BYTES,
    "updater trusted-control bindings"
  );
  const verified = assertElectronProductionUpdaterEvidenceAttemptPlanBindings(
    written.value
  );
  if (!isDeepStrictEqual(verified, bindings)) {
    throw new Error("The updater trusted-control bindings changed after creation.");
  }
  return Object.freeze({
    bindings: verified,
    bindingsIdentity: publicIdentity(outputPath, written),
    bindingsPath: outputPath,
    descriptorIdentity: publicIdentity(descriptorPath, descriptorFile)
  });
}

export async function readElectronProductionUpdaterTrustedControlDescriptor(input) {
  assertExactKeys(input, ["descriptorPath"],
    "updater trusted-control descriptor read input");
  const descriptorPath = requiredAbsolutePath(
    input.descriptorPath,
    "updater trusted-control descriptor"
  );
  const file = await readCanonicalJsonFile(
    descriptorPath,
    MAX_DESCRIPTOR_BYTES,
    "updater trusted-control descriptor"
  );
  return deepFreeze({
    descriptor: assertDescriptor(file.value),
    descriptorIdentity: publicIdentity(descriptorPath, file),
    descriptorPath
  });
}

export async function readElectronProductionUpdaterTrustedControlBindings(
  input
) {
  assertExactKeys(input, ["bindingsPath", "expectedSha256"],
    "updater trusted-control bindings read input");
  const result = await readElectronProductionUpdaterEvidenceAttemptPlanBindings(
    requiredAbsolutePath(input.bindingsPath, "updater trusted-control bindings")
  );
  assertEqual(
    result.bindingsIdentity.sha256,
    requiredDigest(input.expectedSha256, "updater trusted-control bindings SHA-256"),
    "updater trusted-control bindings SHA-256"
  );
  return result;
}

function assertDescriptor(value) {
  assertExactKeys(value, [
    "kind",
    "priorV23",
    "producer",
    "productionUpdaterPublicKey",
    "provisionalPublication",
    "schemaVersion",
    "target",
    "tauriV22"
  ], "updater trusted-control descriptor");
  assertEqual(value.schemaVersion, 1,
    "updater trusted-control descriptor schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND,
    "updater trusted-control descriptor kind");
  const target = assertCandidateDescriptor(value.target, "target");
  const priorV23 = assertCandidateDescriptor(value.priorV23, "prior-v23");
  const tauriV22 = assertTauriDescriptor(value.tauriV22, target);
  const provisionalPublication = assertProvisionalDescriptor(
    value.provisionalPublication,
    target
  );
  const producer = assertProducerDescriptor(value.producer, target);
  if (typeof value.productionUpdaterPublicKey !== "string" ||
      value.productionUpdaterPublicKey.trim().length === 0) {
    throw new Error("The production updater public key is required.");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND,
    producer,
    productionUpdaterPublicKey: value.productionUpdaterPublicKey,
    target,
    priorV23,
    tauriV22,
    provisionalPublication
  });
}

function assertCandidateDescriptor(value, label) {
  assertExactKeys(value, [
    "artifactName",
    "candidateDirectory",
    "candidateReceiptPath",
    "candidateReceiptSha256",
    "controlReceiptPath",
    "controlSha",
    "macDirectory",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "trustedControlReceiptSha256",
    "version",
    "windowsDirectory",
    "workflow"
  ], `${label} candidate descriptor`);
  const sourceSha = requiredCommitSha(value.sourceSha, `${label} source SHA`);
  const version = requiredSemanticVersion(value.version, `${label} version`);
  const runAttempt = requiredPositiveInteger(value.runAttempt, `${label} run attempt`);
  assertEqual(
    value.artifactName,
    `electron-production-candidate-${version}-${sourceSha}-attempt-${runAttempt}`,
    `${label} candidate artifact name`
  );
  assertControlProvenance(value, CANDIDATE_WORKFLOW, `${label} candidate`);
  return Object.freeze({
    artifactName: value.artifactName,
    candidateDirectory: requiredAbsolutePath(
      value.candidateDirectory,
      `${label} candidate directory`
    ),
    candidateReceiptPath: requiredAbsolutePath(
      value.candidateReceiptPath,
      `${label} candidate receipt`
    ),
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      `${label} candidate receipt SHA-256`
    ),
    controlReceiptPath: requiredAbsolutePath(
      value.controlReceiptPath,
      `${label} trusted-control receipt`
    ),
    controlSha: value.controlSha,
    macDirectory: requiredAbsolutePath(value.macDirectory, `${label} macOS candidate`),
    repository: value.repository,
    runAttempt,
    runId: requiredRunId(value.runId, `${label} run ID`),
    sourceSha,
    trustedControlReceiptSha256: requiredDigest(
      value.trustedControlReceiptSha256,
      `${label} trusted-control receipt SHA-256`
    ),
    version,
    windowsDirectory: requiredAbsolutePath(
      value.windowsDirectory,
      `${label} Windows candidate`
    ),
    workflow: value.workflow
  });
}

function assertTauriDescriptor(value, target) {
  assertExactKeys(value, [
    "artifacts",
    "controlSha",
    "releaseTag",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "targetSourceSha",
    "version",
    "workflow"
  ], "Tauri v22 lineage descriptor");
  assertControlProvenance(value, TAURI_V22_COMPATIBILITY_WORKFLOW,
    "Tauri v22 lineage");
  const version = requiredSemanticVersion(value.version, "Tauri v22 version");
  const runAttempt = requiredPositiveInteger(value.runAttempt,
    "Tauri v22 lineage run attempt");
  const runId = requiredRunId(value.runId, "Tauri v22 lineage run ID");
  assertEqual(value.releaseTag, `v${version}`, "Tauri v22 release tag");
  assertEqual(value.targetSourceSha, target.sourceSha,
    "Tauri v22 target source SHA");
  assertExactKeys(value.artifacts, PLATFORMS, "Tauri v22 lineage artifacts");
  const artifacts = {};
  for (const platform of PLATFORMS) {
    const artifact = value.artifacts[platform];
    assertExactKeys(artifact, ["artifactName", "receiptPath", "receiptSha256"],
      `${platform} Tauri v22 lineage artifact`);
    assertEqual(
      artifact.artifactName,
      `tauri-v22-public-lineage-${platform}-${runId}-${runAttempt}`,
      `${platform} Tauri v22 lineage artifact name`
    );
    artifacts[platform] = Object.freeze({
      artifactName: artifact.artifactName,
      receiptPath: requiredAbsolutePath(
        artifact.receiptPath,
        `${platform} Tauri v22 lineage receipt`
      ),
      receiptSha256: requiredDigest(
        artifact.receiptSha256,
        `${platform} Tauri v22 lineage receipt SHA-256`
      )
    });
  }
  return deepFreeze({
    artifacts,
    controlSha: value.controlSha,
    releaseTag: value.releaseTag,
    repository: value.repository,
    runAttempt,
    runId,
    sourceSha: requiredCommitSha(value.sourceSha, "Tauri v22 source SHA"),
    targetSourceSha: target.sourceSha,
    version,
    workflow: value.workflow
  });
}

function assertProvisionalDescriptor(value, target) {
  assertExactKeys(value, [
    "artifactName",
    "controlSha",
    "receiptPath",
    "receiptSha256",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "provisional-publication descriptor");
  assertControlProvenance(value, PROVISIONAL_WORKFLOW, "provisional publication");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "provisional-publication run attempt"
  );
  assertEqual(
    value.artifactName,
    `electron-production-publication-provisional-${target.version}-` +
      `${target.sourceSha}-attempt-${runAttempt}`,
    "provisional-publication artifact name"
  );
  return Object.freeze({
    artifactName: value.artifactName,
    controlSha: value.controlSha,
    receiptPath: requiredAbsolutePath(
      value.receiptPath,
      "provisional-publication receipt"
    ),
    receiptSha256: requiredDigest(
      value.receiptSha256,
      "provisional-publication receipt SHA-256"
    ),
    repository: value.repository,
    runAttempt,
    runId: requiredRunId(value.runId, "provisional-publication run ID"),
    workflow: value.workflow
  });
}

function assertProducerDescriptor(value, target) {
  assertExactKeys(value, [
    "aggregateArtifactName",
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "updater evidence producer descriptor");
  assertControlProvenance(
    value,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW,
    "updater evidence producer"
  );
  const runAttempt = requiredPositiveInteger(value.runAttempt,
    "updater evidence producer run attempt");
  assertEqual(
    value.aggregateArtifactName,
    `electron-production-updater-terminal-evidence-${target.version}-` +
      `${target.sourceSha}-attempt-${runAttempt}`,
    "updater evidence aggregate artifact name"
  );
  return Object.freeze({
    aggregateArtifactName: value.aggregateArtifactName,
    controlSha: value.controlSha,
    repository: value.repository,
    runAttempt,
    runId: requiredRunId(value.runId, "updater evidence producer run ID"),
    workflow: value.workflow
  });
}

function assertControlProvenance(value, workflow, label) {
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    `${label} repository`);
  assertEqual(value.workflow, workflow, `${label} workflow`);
  requiredCommitSha(value.controlSha, `${label} control SHA`);
}

function candidateVerificationInput(value, publicKey) {
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

function controlReadInput(value) {
  return {
    controlPlaneSha: value.controlSha,
    receiptPath: value.controlReceiptPath,
    repository: value.repository,
    runAttempt: value.runAttempt,
    runId: value.runId,
    sourceSha: value.sourceSha,
    version: value.version
  };
}

function assertCandidateVerification(candidate, control, expected, keySha, label) {
  assertEqual(candidate.receiptSha256, expected.candidateReceiptSha256,
    `${label} candidate receipt SHA-256`);
  assertEqual(candidate.sourceSha, expected.sourceSha, `${label} source SHA`);
  assertEqual(candidate.version, expected.version, `${label} version`);
  assertEqual(control.receiptSha256, expected.trustedControlReceiptSha256,
    `${label} trusted-control receipt SHA-256`);
  assertEqual(control.receipt.candidate.sourceSha, expected.sourceSha,
    `${label} trusted-control source SHA`);
  assertEqual(control.receipt.candidate.version, expected.version,
    `${label} trusted-control version`);
  assertEqual(control.receipt.candidate.updaterEndpoint, candidate.updaterEndpoint,
    `${label} updater endpoint`);
  assertEqual(control.receipt.updaterTrust.publicKeySha256, keySha,
    `${label} trusted-control updater key`);
  assertEqual(candidate.receipt.publicKeySha256, keySha,
    `${label} candidate updater key`);
}

function assertTauriBindings(lineage, expected, target, keySha) {
  const entries = [
    ["darwin-aarch64", lineage.macos],
    ["windows-x86_64", lineage.windows]
  ];
  for (const [platform, receipt] of entries) {
    assertEqual(receipt.platform, platform, `${platform} public-lineage platform`);
    assertEqual(receipt.release.tag, expected.releaseTag,
      `${platform} public-lineage release tag`);
    assertEqual(receipt.release.version, expected.version,
      `${platform} public-lineage version`);
    assertEqual(receipt.sourceTag.peeledCommitSha, expected.sourceSha,
      `${platform} public-lineage source SHA`);
    assertEqual(receipt.targetSourceSha, target.sourceSha,
      `${platform} public-lineage target SHA`);
    assertEqual(receipt.trust.updaterPublicKeySha256, keySha,
      `${platform} public-lineage updater key`);
    assertEqual(receipt.producer.repository, expected.repository,
      `${platform} public-lineage repository`);
    assertEqual(receipt.producer.workflow, expected.workflow,
      `${platform} public-lineage workflow`);
    assertEqual(receipt.producer.runId, expected.runId,
      `${platform} public-lineage run ID`);
    assertEqual(receipt.producer.runAttempt, expected.runAttempt,
      `${platform} public-lineage run attempt`);
    assertEqual(receipt.producer.headSha, target.sourceSha,
      `${platform} public-lineage producer head SHA`);
  }
}

function assertProvisionalBindings(
  file,
  expected,
  target,
  tauri,
  candidate,
  lineage
) {
  assertEqual(file.receiptIdentity.sha256, expected.receiptSha256,
    "provisional-publication receipt SHA-256");
  const receipt = file.receipt;
  assertEqual(receipt.phase, "provisional", "provisional-publication phase");
  assertEqual(receipt.terminal, false, "provisional-publication terminality");
  assertEqual(receipt.outcome, null, "provisional-publication outcome");
  assertEqual(receipt.publication.acknowledgement, "confirmed",
    "provisional-publication acknowledgement");
  assertEqual(receipt.publication.observedState, "target",
    "provisional-publication observed state");
  assertEqual(receipt.publication.observedStateSha256, receipt.target.stateSha256,
    "provisional-publication target readback");
  for (const [actual, wanted, label] of [
    [receipt.target.candidateReceiptSha256, target.candidateReceiptSha256,
      "provisional target candidate receipt SHA-256"],
    [receipt.target.sourceSha, target.sourceSha, "provisional target source SHA"],
    [receipt.target.version, target.version, "provisional target version"],
    [receipt.target.manifestSha256, candidate.receipt.assets["latest.json"],
      "provisional target manifest SHA-256"],
    [receipt.baseline.sourceSha, tauri.sourceSha,
      "provisional baseline source SHA"],
    [receipt.baseline.version, tauri.version, "provisional baseline version"],
    [receipt.baseline.releaseTag, tauri.releaseTag,
      "provisional baseline release tag"],
    [receipt.baseline.manifestSha256, lineage.macos.assets.manifest.sha256,
      "provisional baseline manifest SHA-256"]
  ]) assertEqual(actual, wanted, label);
}

function candidateIdentity(value) {
  return Object.freeze({
    artifactName: value.artifactName,
    candidateReceiptSha256: value.candidateReceiptSha256,
    controlSha: value.controlSha,
    repository: value.repository,
    runAttempt: value.runAttempt,
    runId: value.runId,
    sourceSha: value.sourceSha,
    trustedControlReceiptSha256: value.trustedControlReceiptSha256,
    version: value.version,
    workflow: value.workflow
  });
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive integer string.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater trusted-control intake dependencies must be an object.");
  }
  const defaults = {
    assertTauriLineagePair: assertTauriV22PublicLineagePair,
    readPublicationReceipt: readElectronProductionPublicationReceipt,
    readTauriLineage: readTauriV22PublicLineageReceipt,
    readTrustedControl: readTrustedControlReceipt,
    verifyCandidate: verifyElectronProductionCandidateBundle
  };
  assertExactKeys(value, Object.keys(value).filter((key) => key in defaults),
    "updater trusted-control intake dependency overrides");
  const result = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    result[name] = value[name] ?? fallback;
    if (typeof result[name] !== "function") {
      throw new Error(`The updater trusted-control intake dependency ${name} is invalid.`);
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
