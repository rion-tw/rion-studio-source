import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  createElectronProductionUpdaterEvidenceAttemptPlan,
  readElectronProductionUpdaterEvidenceAttemptPlan,
  readElectronProductionUpdaterEvidenceAttemptPlanBindings,
  readElectronProductionUpdaterEvidenceChallengeNonce
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_CLI_SUMMARY_KIND =
  "rion-electron-production-updater-evidence-attempt-plan-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  create: new Set(["bindings", "challenge-nonce-file", "output"]),
  verify: new Set(["expected-sha256", "plan"])
});

export async function runElectronProductionUpdaterEvidenceAttemptPlanCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceAttemptPlanCli.mjs " +
      "<create|verify> [exact options]"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = command === "create"
    ? await createPlan(options, dependencies)
    : await verifyPlan(options, dependencies);
  const summary = Object.freeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_CLI_SUMMARY_KIND,
    command,
    status: command === "create" ? "created" : "verified",
    artifact: result.planIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function createPlan(options, dependencies) {
  const [bindingsFile, challengeNonce] = await Promise.all([
    readElectronProductionUpdaterEvidenceAttemptPlanBindings(
      requiredOption(options, "bindings")
    ),
    readElectronProductionUpdaterEvidenceChallengeNonce(
      requiredOption(options, "challenge-nonce-file")
    )
  ]);
  return createElectronProductionUpdaterEvidenceAttemptPlan({
    bindings: bindingsFile.bindings,
    challengeNonce,
    outputPath: requiredOption(options, "output")
  }, {
    now: dependencies.now,
    randomUuid: dependencies.randomUuid
  });
}

async function verifyPlan(options, dependencies) {
  const expectedSha256 = optionalOption(options, "expected-sha256");
  return readElectronProductionUpdaterEvidenceAttemptPlan({
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    planPath: requiredOption(options, "plan")
  }, { now: dependencies.now });
}

function parseArguments(argumentsList, command) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid updater evidence attempt-plan option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!COMMAND_OPTIONS[command].has(key)) {
      throw new Error(`Unknown ${command} option --${key}.`);
    }
    if (options.has(key)) {
      throw new Error(`Duplicate ${command} option --${key}.`);
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

function optionalOption(options, name) {
  if (!options.has(name)) return undefined;
  return requiredOption(options, name);
}

function resolveDependencies(overrides) {
  return {
    now: overrides.now ?? (() => new Date()),
    randomUuid: overrides.randomUuid,
    writeStdout: overrides.writeStdout ?? ((source) => process.stdout.write(source))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterEvidenceAttemptPlanCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
