import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { prepareElectronUpdaterProbeInput } from
  "./electronUpdaterPreparedProbeInput.mjs";

export async function prepareElectronUpdaterTransactionProbeInput(
  argumentsList,
  environment = process.env,
  runtime = process
) {
  assertSupportedPreparationEnvironment(environment, runtime);
  const options = parseArguments(argumentsList, runtime.platform);
  const artifactPath = requiredAbsolutePath(
    options.get("artifact"),
    "--artifact"
  );
  const referenceApplicationPath = runtime.platform === "darwin"
    ? requiredMacosApplicationPath(options.get("app"))
    : undefined;
  const preparedInputRoot = requiredAbsolutePath(
    environment.RION_UPDATER_PREPARED_INPUT_ROOT,
    "RION_UPDATER_PREPARED_INPUT_ROOT"
  );
  const runtimeRoot = requiredAbsolutePath(
    environment.RION_UPDATER_CI_FIXTURE_ROOT,
    "RION_UPDATER_CI_FIXTURE_ROOT"
  );
  if (preparedInputRoot === runtimeRoot) {
    throw new Error("Prepared updater inputs must be separate from runtime outputs.");
  }
  const version = requiredSemanticVersion(
    environment.RION_STUDIO_ELECTRON_PACKAGE_VERSION,
    "RION_STUDIO_ELECTRON_PACKAGE_VERSION"
  );
  return prepareElectronUpdaterProbeInput({
    architecture: runtime.arch,
    artifactPath,
    environment,
    fixtureRoot: preparedInputRoot,
    platform: runtime.platform,
    referenceApplicationPath,
    version,
    workingDirectory: path.resolve(".")
  });
}

function assertSupportedPreparationEnvironment(environment, runtime) {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "The updater probe input preparation is restricted to GitHub CI."
    );
  }
  if (
    !(
      (runtime.platform === "darwin" && runtime.arch === "arm64") ||
      (runtime.platform === "win32" && runtime.arch === "x64")
    )
  ) {
    throw new Error(
      "The updater probe input preparation requires macOS arm64 or Windows x64."
    );
  }
}

function parseArguments(argumentsList, platform) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        `Invalid updater input preparation option near ${option ?? "<end>"}.`
      );
    }
    const name = option.slice(2);
    if (name === "app" && platform === "win32") {
      throw new Error("Updater input preparation --app is forbidden on Windows.");
    }
    if (name !== "artifact" && name !== "app") {
      throw new Error(`Unsupported updater input preparation option --${name}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate updater input preparation option --${name}.`);
    }
    values.set(name, value);
  }
  return values;
}

function requiredMacosApplicationPath(value) {
  const applicationPath = requiredAbsolutePath(value, "--app");
  if (path.basename(applicationPath) !== "Rion Studio.app") {
    throw new Error("--app must be an absolute Rion Studio.app path.");
  }
  return applicationPath;
}

function requiredAbsolutePath(value, name) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function requiredSemanticVersion(value, name) {
  const normalized = value?.trim();
  if (!normalized || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`${name} must be a semantic version.`);
  }
  return normalized;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  try {
    await prepareElectronUpdaterTransactionProbeInput(argumentsList);
    console.log("Prepared production-signed updater probe input.");
  } catch {
    console.error("Updater probe input preparation failed.");
    process.exitCode = 1;
  }
}
