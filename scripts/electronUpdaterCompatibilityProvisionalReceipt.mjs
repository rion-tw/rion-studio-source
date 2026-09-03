import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertDirectChild,
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  assertElectronUpdaterMacosBundleCase,
  assertElectronUpdaterMacosVersionTransition
} from "./electronUpdaterMacosProbeResultContract.mjs";

export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND =
  "rion-electron-updater-compatibility-provisional-observations";
export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME =
  "provisional-layout-probe-receipt.json";

const MAX_JSON_BYTES = 1024 * 1024;
const PROVISIONAL_CASES = Object.freeze({
  win32: Object.freeze([
    Object.freeze({
      outcome: "applied",
      probe: "packaged-artifact-manifest-fail-closed",
      sourceRuntime: "electron-v23"
    }),
    Object.freeze({
      outcome: "applied",
      probe: "windows-installed-layout-replacement-and-relaunch",
      sourceRuntime: "tauri-v22"
    }),
    Object.freeze({
      outcome: "applied",
      probe: "windows-installed-layout-replacement-and-relaunch",
      sourceRuntime: "electron-v23"
    })
  ])
});

export async function writeElectronUpdaterCompatibilityProvisionalReceipt(input) {
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
    "provisional compatibility receipt"
  );
  const platform = requiredProbePlatform(input.platform);
  const cases = assertProvisionalCases(input.cases, platform);
  const probeCompletedAt = requiredRfc3339(
    input.probeCompletedAt ?? new Date().toISOString(),
    "probe completion time"
  );
  const receipt = {
    schemaVersion: 2,
    kind: ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
    status: "provisional-awaiting-parent-isolation",
    platform,
    cases,
    probeCompletedAt
  };
  await writeExclusive(outputPath, serializeCanonicalJson(receipt));
  const identity = await readCanonicalJsonFile(
    outputPath,
    MAX_JSON_BYTES,
    "provisional compatibility receipt"
  );
  return Object.freeze({
    receipt: Object.freeze(receipt),
    receiptIdentity: publicIdentity(outputPath, identity),
    receiptPath: outputPath
  });
}

export async function readElectronUpdaterCompatibilityProvisionalReceipt(
  receiptPath,
  childOutputRoot,
  platform = "win32"
) {
  const requested = requiredAbsolutePath(
    receiptPath,
    "provisional compatibility receipt"
  );
  await assertDirectChild(
    requested,
    childOutputRoot,
    "provisional compatibility receipt"
  );
  assertEqual(
    requested.split(/[\\/]/u).at(-1),
    ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
    "provisional compatibility receipt filename"
  );
  const file = await readCanonicalJsonFile(
    requested,
    MAX_JSON_BYTES,
    "provisional compatibility receipt"
  );
  const receipt = assertProvisionalReceipt(
    file.value,
    requiredProbePlatform(platform)
  );
  return Object.freeze({
    receipt,
    receiptIdentity: publicIdentity(requested, file)
  });
}

function assertProvisionalReceipt(value, platform) {
  assertExactKeys(value, [
    "cases",
    "kind",
    "platform",
    "probeCompletedAt",
    "schemaVersion",
    "status"
  ], "provisional compatibility receipt");
  assertEqual(value.schemaVersion, 2, "provisional receipt schema version");
  assertEqual(
    value.kind,
    ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
    "provisional receipt kind"
  );
  assertEqual(
    value.status,
    "provisional-awaiting-parent-isolation",
    "provisional receipt status"
  );
  assertEqual(value.platform, platform, "provisional receipt platform");
  const cases = assertProvisionalCases(value.cases, platform);
  requiredRfc3339(value.probeCompletedAt, "provisional probe completion time");
  return Object.freeze({ ...value, cases });
}

function assertProvisionalCases(value, platform) {
  if (!Array.isArray(value)) {
    throw new Error("The provisional compatibility cases must be an array.");
  }
  if (platform === "darwin") return assertDarwinProvisionalCases(value);
  const expected = PROVISIONAL_CASES[platform];
  if (value.length !== expected.length) {
    throw new Error("The provisional compatibility cases are incomplete.");
  }
  return Object.freeze(value.map((entry, index) => {
    assertExactKeys(
      entry,
      ["outcome", "probe", "sourceRuntime"],
      `provisional compatibility case ${index}`
    );
    if (!isDeepStrictEqual(entry, expected[index])) {
      throw new Error(`The provisional compatibility case ${index} is invalid.`);
    }
    return Object.freeze({ ...entry });
  }));
}

function assertDarwinProvisionalCases(value) {
  if (value.length !== 4) {
    throw new Error(
      "The macOS provisional receipt must contain manifest, two bundle, and helper cases."
    );
  }
  const manifest = value[0];
  assertExactKeys(
    manifest,
    ["outcome", "probe", "sourceRuntime"],
    "macOS provisional manifest case"
  );
  if (!isDeepStrictEqual(manifest, {
    outcome: "applied",
    probe: "packaged-artifact-manifest-fail-closed",
    sourceRuntime: "electron-v23"
  })) {
    throw new Error("The macOS provisional manifest case is invalid.");
  }
  const bundleCases = value.slice(1, 3).map((entry, index) =>
    assertElectronUpdaterMacosBundleCase(
      entry,
      `macOS provisional bundle case ${index}`
    ));
  const helper = value[3];
  assertExactKeys(helper, [
    "outcome",
    "probe",
    "sourceRuntime",
    "sourceVersion",
    "targetVersion"
  ], "macOS provisional helper case");
  if (
    helper.outcome !== "applied" ||
    helper.probe !== "macos-helper-handoff-and-relaunch" ||
    helper.sourceRuntime !== "tauri-v22"
  ) {
    throw new Error("The macOS provisional helper case is invalid.");
  }
  const helperTransition = assertElectronUpdaterMacosVersionTransition(
    helper,
    "macOS provisional helper case"
  );
  if (
    new Set(bundleCases.map((entry) => entry.sourceVersion)).size !== 2 ||
    !bundleCases.some((entry) => entry.sourceVersion === helperTransition.sourceVersion) ||
    !bundleCases.every(
      (entry) => entry.targetVersion === helperTransition.targetVersion
    )
  ) {
    throw new Error(
      "The macOS provisional cases do not bind the Tauri source and prior-Electron bundle executions."
    );
  }
  return Object.freeze([
    Object.freeze({ ...manifest }),
    ...bundleCases,
    Object.freeze({
      outcome: "applied",
      probe: "macos-helper-handoff-and-relaunch",
      sourceRuntime: "tauri-v22",
      ...helperTransition
    })
  ]);
}

function requiredProbePlatform(value) {
  if (value !== "darwin" && value !== "win32") {
    throw new Error("The provisional compatibility platform is invalid.");
  }
  return value;
}
