import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  observeElectronProductionUpdaterEvidenceEndpoint,
  readElectronProductionUpdaterEvidenceEndpointObservation,
  readElectronProductionUpdaterEvidenceEndpointObservationBindings
} from "./electronProductionUpdaterEvidenceEndpointObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_CLI_SUMMARY_KIND =
  "rion-production-updater-endpoint-observation-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  observe: new Set(["bindings", "output"]),
  verify: new Set(["bindings", "expected-sha256", "observation"])
});

export async function runElectronProductionUpdaterEvidenceEndpointObservationCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceEndpointObservationCli.mjs " +
      "<observe|verify> [exact options]"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const bindingsFile =
    await readElectronProductionUpdaterEvidenceEndpointObservationBindings(
      requiredOption(options, "bindings")
    );
  const result = command === "observe"
    ? await observeElectronProductionUpdaterEvidenceEndpoint({
        bindings: bindingsFile.bindings,
        outputPath: requiredOption(options, "output"),
        signal: requiredSignal(dependencies.signal)
      }, {
        fetchImpl: dependencies.fetchImpl,
        now: dependencies.now
      })
    : await readElectronProductionUpdaterEvidenceEndpointObservation({
        bindings: bindingsFile.bindings,
        ...(options.has("expected-sha256")
          ? { expectedSha256: requiredOption(options, "expected-sha256") }
          : {}),
        observationPath: requiredOption(options, "observation")
      });
  const summary = Object.freeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_CLI_SUMMARY_KIND,
    command,
    status: command === "observe" ? "prebound" : "verified",
    attemptPlanSha256: result.observation.attemptPlanSha256,
    cell: Object.freeze({
      evidenceAttemptId: result.observation.evidenceAttemptId,
      platform: result.observation.platform,
      transitionKind: result.observation.transitionKind
    }),
    artifact: result.observationIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList, command) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid endpoint observation option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!COMMAND_OPTIONS[command].has(key)) {
      throw new Error(`Unknown ${command} option --${key}.`);
    }
    if (options.has(key)) throw new Error(`Duplicate ${command} option --${key}.`);
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The endpoint observation CLI caller must provide an AbortSignal.");
  }
  return value;
}

function resolveDependencies(overrides) {
  return {
    fetchImpl: overrides.fetchImpl,
    now: overrides.now,
    signal: overrides.signal,
    writeStdout: overrides.writeStdout ?? ((source) => process.stdout.write(source))
  };
}

function processCancellation() {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("process termination requested"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = processCancellation();
  runElectronProductionUpdaterEvidenceEndpointObservationCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
