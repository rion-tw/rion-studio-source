import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  openVisibleProductionUpdaterSettings,
  pressVisibleProductionUpdaterCheck,
  pressVisibleProductionUpdaterInstall
} from "./electronProductionUpdaterVisibleUi.mjs";
import {
  publicIdentity,
  readStableFile,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_SETTINGS_FILE =
  "visible-settings-actions.json";
export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_CHECK_FILE =
  "check-action.json";
export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_INSTALL_FILE =
  "install-action.json";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const COMMANDS = Object.freeze({
  "open-settings": Object.freeze({
    fileName: ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_SETTINGS_FILE,
    invoke: openVisibleProductionUpdaterSettings
  }),
  check: Object.freeze({
    fileName: ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_CHECK_FILE,
    invoke: pressVisibleProductionUpdaterCheck
  }),
  install: Object.freeze({
    fileName: ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_INSTALL_FILE,
    invoke: pressVisibleProductionUpdaterInstall
  })
});
const ALLOWED_OPTIONS = new Set(["output", "platform", "process-id"]);

export async function runElectronProductionUpdaterVisibleUiCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(
      "Usage: electronProductionUpdaterVisibleUiCli.mjs " +
      "<open-settings|check|install> --platform <darwin|win32> " +
      "--process-id <pid> --output <absolute-path>"
    );
  }
  const options = parseArguments(optionArguments);
  const dependencies = assertDependencies(dependencyOverrides);
  const processId = requiredProcessId(requiredOption(options, "process-id"));
  const platform = requiredPlatform(requiredOption(options, "platform"));
  const descriptor = COMMANDS[command];
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    descriptor.fileName,
    `visible updater ${command} receipt`
  );
  const receipt = await descriptor.invoke(
    { platform, processId },
    dependencyOverrides
  );
  await writeExclusive(outputPath, serializeCanonicalJson(receipt));
  const file = await readStableFile(
    outputPath,
    MAX_RECEIPT_BYTES,
    `visible updater ${command} receipt`
  );
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: "rion-production-updater-visible-ui-cli-result",
    action: command,
    receipt: publicIdentity(outputPath, file)
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every visible updater UI option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid visible updater UI option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!ALLOWED_OPTIONS.has(name)) {
      throw new Error(`Unknown visible updater UI option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate visible updater UI option --${name}.`);
    }
    options.set(name, value);
  }
  for (const name of ALLOWED_OPTIONS) requiredOption(options, name);
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function requiredProcessId(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("The visible updater UI process ID is invalid.");
  }
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId <= 1) {
    throw new Error("The visible updater UI process ID is invalid.");
  }
  return processId;
}

function requiredPlatform(value) {
  if (value !== "darwin" && value !== "win32") {
    throw new Error("The visible updater UI platform is invalid.");
  }
  return value;
}

function assertDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Visible updater UI CLI dependencies must be an object.");
  }
  const allowed = new Set(["now", "runMacos", "runWindows", "writeStdout"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown visible updater UI CLI dependency ${key}.`);
    }
  }
  if (value.writeStdout !== undefined && typeof value.writeStdout !== "function") {
    throw new Error("The visible updater UI stdout dependency is invalid.");
  }
  return Object.freeze({
    writeStdout: value.writeStdout ?? ((source) => process.stdout.write(source))
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterVisibleUiCli().catch(() => {
    process.stderr.write("Electron production updater visible UI action failed closed.\n");
    process.exitCode = 1;
  });
}
