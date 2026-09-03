import path from "node:path";

import {
  assertDirectChild,
  assertEqual,
  assertExactKeys,
  compareSemanticVersions,
  readStableFile,
  requiredAbsolutePath,
  requiredRealDirectory,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME =
  "macos-bundle-replacement-result.json";

const MAXIMUM_RESULT_BYTES = 64 * 1024;

export async function readElectronUpdaterMacosBundleProbeResult(input) {
  const resultPath = requiredAbsolutePath(
    input?.resultPath,
    "macOS bundle probe result"
  );
  const fixtureRoot = await requiredRealDirectory(
    input?.fixtureRoot,
    "macOS bundle probe fixture root"
  );
  assertEqual(
    path.basename(resultPath),
    ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME,
    "macOS bundle probe result filename"
  );
  await assertDirectChild(
    resultPath,
    fixtureRoot,
    "macOS bundle probe result"
  );
  const file = await readStableFile(
    resultPath,
    MAXIMUM_RESULT_BYTES,
    "macOS bundle probe result"
  );
  let value;
  try {
    value = JSON.parse(file.source.toString("utf8"));
  } catch (error) {
    throw new Error("The macOS bundle probe result is invalid JSON.", {
      cause: error
    });
  }
  assertExactKeys(value, ["cases"], "macOS bundle probe result");
  if (!Array.isArray(value.cases) || value.cases.length !== 2) {
    throw new Error(
      "The macOS bundle probe must publish both source-layout and prior-Electron cases."
    );
  }
  const cases = value.cases.map((entry, index) =>
    assertElectronUpdaterMacosBundleCase(
      entry,
      `macOS bundle probe case ${index}`
    ));
  if (new Set(cases.map((entry) => entry.sourceVersion)).size !== cases.length) {
    throw new Error("The macOS bundle probe source versions must be distinct.");
  }
  if (!cases.every((entry) => entry.targetVersion === cases[0].targetVersion)) {
    throw new Error("The macOS bundle probe target versions do not match.");
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    identity: Object.freeze({
      bytes: file.bytes,
      sha256: file.sha256
    })
  });
}

export function assertElectronUpdaterMacosBundleCase(value, label) {
  assertExactKeys(value, [
    "outcome",
    "probe",
    "sourceRuntime",
    "sourceVersion",
    "targetVersion"
  ], label);
  assertEqual(value.outcome, "applied", `${label} outcome`);
  assertEqual(value.probe, "macos-bundle-replacement", `${label} probe`);
  assertEqual(value.sourceRuntime, "electron-v23", `${label} source runtime`);
  const transition = assertElectronUpdaterMacosVersionTransition(value, label);
  return Object.freeze({
    outcome: "applied",
    probe: "macos-bundle-replacement",
    sourceRuntime: "electron-v23",
    ...transition
  });
}

export function assertElectronUpdaterMacosVersionTransition(value, label) {
  const sourceVersion = requiredSemanticVersion(
    value?.sourceVersion,
    `${label} source version`
  );
  const targetVersion = requiredSemanticVersion(
    value?.targetVersion,
    `${label} target version`
  );
  if (compareSemanticVersions(targetVersion, sourceVersion) <= 0) {
    throw new Error(
      `The ${label} target version must be strictly newer than its source version.`
    );
  }
  return Object.freeze({ sourceVersion, targetVersion });
}
