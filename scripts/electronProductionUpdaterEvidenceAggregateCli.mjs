import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionUpdaterEvidenceAggregate
} from "./electronProductionUpdaterEvidenceAggregate.mjs";
import {
  readElectronProductionUpdaterEvidenceAttemptPlan
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  requiredAbsolutePath,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_AGGREGATE_VERIFICATION_KIND =
  "rion-production-updater-evidence-aggregate-verification";

const ALLOWED_OPTIONS = new Set([
  "aggregate-root",
  "attempt-plan",
  "expected-attempt-plan-sha256"
]);

export async function runElectronProductionUpdaterEvidenceAggregateCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const writeStdout = dependencyOverrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify") {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceAggregateCli.mjs verify " +
      "--aggregate-root <directory> --attempt-plan <canonical-json> " +
      "--expected-attempt-plan-sha256 <sha256>"
    );
  }
  const options = parseArguments(optionArguments);
  const attemptPlanPath = requiredAbsolutePath(
    requiredOption(options, "attempt-plan"),
    "updater evidence attempt plan"
  );
  const expectedAttemptPlanSha256 = requiredDigest(
    requiredOption(options, "expected-attempt-plan-sha256"),
    "updater evidence attempt-plan SHA-256"
  );
  const planRead = await readElectronProductionUpdaterEvidenceAttemptPlan({
    expectedSha256: expectedAttemptPlanSha256,
    planPath: attemptPlanPath
  }, dependencyOverrides);
  const plan = planRead.plan;
  const aggregate = await readElectronProductionUpdaterEvidenceAggregate({
    aggregateRoot: requiredOption(options, "aggregate-root"),
    expectedChallenge: plan.challenge,
    expectedCells: plan.cells,
    expectedProvenance: {
      artifactName: plan.producer.aggregateArtifactName,
      repository: plan.producer.repository,
      runAttempt: plan.producer.runAttempt,
      runId: plan.producer.runId,
      sourceSha: plan.upstream.target.sourceSha,
      workflow: plan.producer.workflow
    },
    expectedSources: {
      priorV23: {
        candidateReceiptSha256: plan.upstream.priorV23.candidateReceiptSha256,
        sourceSha: plan.upstream.priorV23.sourceSha,
        version: plan.upstream.priorV23.version
      },
      tauriV22: {
        sourceSha: plan.upstream.tauriV22.sourceSha,
        version: plan.upstream.tauriV22.version
      }
    },
    expectedTarget: {
      candidateReceiptSha256: plan.upstream.target.candidateReceiptSha256,
      sourceSha: plan.upstream.target.sourceSha,
      version: plan.upstream.target.version
    }
  });
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_AGGREGATE_VERIFICATION_KIND,
    status: "verified",
    aggregateRoot: aggregate.aggregateRoot,
    attemptPlanSha256: planRead.planIdentity.sha256,
    artifactName: aggregate.producer.artifactName,
    challengeId: aggregate.challenge.id,
    evidenceAttemptIds: aggregate.evidenceAttemptIds,
    plannedCells: aggregate.cells,
    receiptSha256: aggregate.receiptSha256,
    target: aggregate.target
  });
  await writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid updater evidence aggregate option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new Error(`Unknown updater evidence aggregate option --${key}.`);
    }
    if (options.has(key)) {
      throw new Error(`Duplicate updater evidence aggregate option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionUpdaterEvidenceAggregateCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
