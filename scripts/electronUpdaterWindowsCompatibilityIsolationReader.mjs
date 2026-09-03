import path from "node:path";

import {
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  canonicalRegularFilePath,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  assertWindowsIsolatedProfileResult,
  WINDOWS_ISOLATED_PROFILE_RESULT_NAME
} from "./windowsIsolatedProfileResultContract.mjs";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_COMMAND_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_COMMAND_HARNESS_BYTES = 16 * 1024 * 1024;

export async function readWindowsParentIsolationResult(
  resultPath,
  childOutputRoot,
  expected,
  prepared
) {
  const requested = requiredAbsolutePath(
    resultPath,
    "outer Windows isolation result"
  );
  assertEqual(
    path.basename(requested),
    WINDOWS_ISOLATED_PROFILE_RESULT_NAME,
    "outer Windows isolation result filename"
  );
  const canonicalPath = await canonicalRegularFilePath(
    requested,
    MAX_JSON_BYTES,
    "outer Windows isolation result"
  );
  assertPathOutsideRoot(
    canonicalPath,
    childOutputRoot,
    "outer Windows isolation result"
  );
  const file = await readCanonicalJsonFile(
    requested,
    MAX_JSON_BYTES,
    "outer Windows isolation result"
  );
  const result = assertWindowsIsolatedProfileResult(file.value);
  assertEqual(
    result.attemptNonce,
    expected.isolationAttemptNonce,
    "outer Windows isolation attempt nonce"
  );
  assertEqual(
    result.commandInvocationSha256,
    expected.isolationCommandInvocationSha256,
    "outer Windows command invocation SHA-256"
  );
  const [commandExecutable, commandHarness] = await Promise.all([
    rereadExpectedParentInput({
      childOutputRoot,
      expectedSha256: expected.isolationCommandExecutableSha256,
      label: "outer Windows command executable",
      maximumBytes: MAX_COMMAND_EXECUTABLE_BYTES,
      path: expected.isolationCommandExecutablePath
    }),
    rereadExpectedParentInput({
      childOutputRoot,
      expectedSha256: expected.isolationCommandHarnessSha256,
      label: "outer Windows command harness",
      maximumBytes: MAX_COMMAND_HARNESS_BYTES,
      path: expected.isolationCommandHarnessPath
    })
  ]);
  assertAttestedIdentity(
    result.attestedInputs.commandExecutable,
    commandExecutable,
    "outer Windows attested command executable"
  );
  assertAttestedIdentity(
    result.attestedInputs.commandHarness,
    commandHarness,
    "outer Windows attested command harness"
  );
  assertAttestedIdentity(
    result.attestedInputs.forbiddenSourceList,
    prepared.receiptIdentity,
    "outer Windows attested forbidden-source list"
  );
  const preparedArtifact = prepared.receipt.artifact;
  assertAttestedIdentity(
    result.attestedInputs.installer,
    {
      bytes: preparedArtifact.bytes,
      fileName: path.basename(preparedArtifact.path),
      sha256: preparedArtifact.sha256
    },
    "outer Windows attested installer"
  );
  return Object.freeze({
    result,
    resultIdentity: publicIdentity(requested, file)
  });
}

export function assertWindowsCompatibilityExpectedBindings(value) {
  assertExactKeys(value, [
    "isolationAttemptNonce",
    "isolationCommandExecutablePath",
    "isolationCommandExecutableSha256",
    "isolationCommandHarnessPath",
    "isolationCommandHarnessSha256",
    "isolationCommandInvocationSha256",
    "preparedInputReceiptSha256",
    "targetSourceSha",
    "tauriV22InputReceiptSha256",
    "tauriV22LineageReceiptSha256",
    "updaterPublicKeySha256"
  ], "terminal receipt expected bindings");
  if (!/^[a-f0-9]{32}$/u.test(value.isolationAttemptNonce ?? "")) {
    throw new Error("The expected isolation attempt nonce is invalid.");
  }
  requiredAbsolutePath(
    value.isolationCommandExecutablePath,
    "expected isolation command executable"
  );
  requiredAbsolutePath(
    value.isolationCommandHarnessPath,
    "expected isolation command harness"
  );
  for (const [field, label] of [
    ["isolationCommandExecutableSha256", "command executable"],
    ["isolationCommandHarnessSha256", "command harness"],
    ["isolationCommandInvocationSha256", "command invocation"],
    ["preparedInputReceiptSha256", "prepared-input receipt"],
    ["tauriV22InputReceiptSha256", "Tauri v22 input receipt"],
    ["tauriV22LineageReceiptSha256", "Tauri v22 public-lineage receipt"],
    ["updaterPublicKeySha256", "updater trust"]
  ]) requiredDigest(value[field], `expected isolation ${label} SHA-256`);
  requiredCommitSha(value.targetSourceSha, "expected target source SHA");
  return Object.freeze({ ...value });
}

async function rereadExpectedParentInput(input) {
  const requested = requiredAbsolutePath(input.path, input.label);
  const canonical = await canonicalRegularFilePath(
    requested,
    input.maximumBytes,
    input.label
  );
  assertPathOutsideRoot(canonical, input.childOutputRoot, input.label);
  const file = await readStableFile(requested, input.maximumBytes, input.label);
  assertEqual(file.sha256, input.expectedSha256, `${input.label} pre-run SHA-256`);
  return publicIdentity(requested, file);
}

function assertAttestedIdentity(attested, observed, label) {
  for (const field of ["bytes", "fileName", "sha256"]) {
    assertEqual(attested[field], observed[field], `${label} ${field}`);
  }
}
