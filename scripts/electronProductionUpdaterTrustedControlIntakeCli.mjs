import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  createElectronProductionUpdaterTrustedControlBindings,
  readElectronProductionUpdaterTrustedControlBindings
} from "./electronProductionUpdaterTrustedControlIntake.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_CLI_SUMMARY_KIND =
  "rion-electron-production-updater-trusted-control-intake-cli-summary";

const OPTIONS = Object.freeze({
  create: Object.freeze(["descriptor", "output"]),
  verify: Object.freeze(["bindings", "expected-sha256"])
});

export async function runElectronProductionUpdaterTrustedControlIntakeCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterTrustedControlIntakeCli.mjs " +
      "<create|verify> [exact options]"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = command === "create"
    ? await dependencies.create({
        descriptorPath: requiredOption(options, "descriptor"),
        outputPath: requiredOption(options, "output")
      }, dependencies.intakeDependencies)
    : await dependencies.read({
        bindingsPath: requiredOption(options, "bindings"),
        expectedSha256: requiredOption(options, "expected-sha256")
      });
  const summary = Object.freeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_CLI_SUMMARY_KIND,
    command,
    status: command === "create" ? "created" : "verified",
    artifact: result.bindingsIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList, command) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error(`Every updater trusted-control ${command} option needs one value.`);
  }
  const allowed = new Set(OPTIONS[command]);
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid updater trusted-control ${command} option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`Unknown updater trusted-control ${command} option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate updater trusted-control ${command} option --${name}.`);
    }
    options.set(name, value);
  }
  const observed = [...options.keys()].sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`The updater trusted-control ${command} option set is not exact.`);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater trusted-control CLI dependencies must be an object.");
  }
  const allowed = new Set(["create", "intakeDependencies", "read", "writeStdout"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown updater trusted-control CLI dependency ${key}.`);
    }
  }
  const create = value.create ?? createElectronProductionUpdaterTrustedControlBindings;
  const read = value.read ?? readElectronProductionUpdaterTrustedControlBindings;
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if ([create, read, writeStdout].some((entry) => typeof entry !== "function")) {
    throw new Error("Updater trusted-control CLI dependencies are invalid.");
  }
  return Object.freeze({
    create,
    intakeDependencies: value.intakeDependencies ?? {},
    read,
    writeStdout
  });
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterTrustedControlIntakeCli().catch(() => {
    process.stderr.write("Electron production updater trusted-control intake failed closed.\n");
    process.exitCode = 1;
  });
}
