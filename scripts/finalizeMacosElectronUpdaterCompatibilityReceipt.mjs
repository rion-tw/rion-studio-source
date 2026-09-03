import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { finalizeMacosElectronUpdaterCompatibilityTerminalReceipt } from
  "./electronUpdaterMacosCompatibilityReceiptFinalizer.mjs";

const OPTIONS = Object.freeze([
  "child-output-root",
  "isolation-attempt-nonce",
  "isolation-command-executable",
  "isolation-command-executable-sha256",
  "isolation-command-harness",
  "isolation-command-harness-sha256",
  "isolation-command-invocation-sha256",
  "isolation-result",
  "isolation-result-sha256",
  "prepared-artifact",
  "prepared-input-receipt",
  "prepared-input-receipt-sha256",
  "prepared-fixture-root",
  "prior-v23-version",
  "provisional-receipt",
  "sandbox-profile-sha256",
  "sealed-output-root",
  "target-source-sha",
  "target-updater-endpoint",
  "target-version",
  "tauri-v22-asset-directory",
  "tauri-v22-input-receipt",
  "tauri-v22-input-receipt-sha256",
  "tauri-v22-lineage-receipt",
  "tauri-v22-lineage-receipt-sha256",
  "updater-public-key-sha256"
]);

export async function finalizeMacosElectronUpdaterCompatibilityReceipt(
  argumentsList
) {
  const options = parseOptions(argumentsList);
  return finalizeMacosElectronUpdaterCompatibilityTerminalReceipt({
    childOutputRoot: options.get("child-output-root"),
    expected: {
      isolationAttemptNonce: options.get("isolation-attempt-nonce"),
      isolationCommandExecutablePath: options.get(
        "isolation-command-executable"
      ),
      isolationCommandExecutableSha256: options.get(
        "isolation-command-executable-sha256"
      ),
      isolationCommandHarnessPath: options.get("isolation-command-harness"),
      isolationCommandHarnessSha256: options.get(
        "isolation-command-harness-sha256"
      ),
      isolationCommandInvocationSha256: options.get(
        "isolation-command-invocation-sha256"
      ),
      isolationResultSha256: options.get("isolation-result-sha256"),
      preparedInputReceiptSha256: options.get(
        "prepared-input-receipt-sha256"
      ),
      sandboxProfileSha256: options.get("sandbox-profile-sha256"),
      targetSourceSha: options.get("target-source-sha"),
      tauriV22InputReceiptSha256: options.get(
        "tauri-v22-input-receipt-sha256"
      ),
      tauriV22LineageReceiptSha256: options.get(
        "tauri-v22-lineage-receipt-sha256"
      ),
      updaterPublicKeySha256: options.get("updater-public-key-sha256")
    },
    isolationResultPath: options.get("isolation-result"),
    preparedInput: {
      artifactPath: options.get("prepared-artifact"),
      fixtureRoot: options.get("prepared-fixture-root"),
      receiptPath: options.get("prepared-input-receipt"),
      version: options.get("target-version")
    },
    provisionalReceiptPath: options.get("provisional-receipt"),
    sealedOutputRoot: options.get("sealed-output-root"),
    target: {
      priorV23Version: options.get("prior-v23-version"),
      updaterEndpoint: options.get("target-updater-endpoint"),
      version: options.get("target-version")
    },
    tauriV22: {
      assetDirectory: options.get("tauri-v22-asset-directory"),
      inputReceiptPath: options.get("tauri-v22-input-receipt"),
      lineageReceiptPath: options.get("tauri-v22-lineage-receipt")
    }
  });
}

function parseOptions(argumentsList) {
  if (!Array.isArray(argumentsList)) {
    throw new Error("The macOS compatibility finalizer arguments are invalid.");
  }
  const values = new Map();
  let index = argumentsList[0] === "--" ? 1 : 0;
  while (index < argumentsList.length) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      typeof option !== "string" || !option.startsWith("--") ||
      typeof value !== "string" || value.length === 0 || value.startsWith("--")
    ) {
      throw new Error("The macOS compatibility finalizer arguments are malformed.");
    }
    const name = option.slice(2);
    if (!OPTIONS.includes(name)) {
      throw new Error("The macOS compatibility finalizer option is unknown.");
    }
    if (values.has(name)) {
      throw new Error("The macOS compatibility finalizer option is duplicated.");
    }
    values.set(name, value);
    index += 2;
  }
  if (values.size !== OPTIONS.length) {
    throw new Error("The macOS compatibility finalizer options are incomplete.");
  }
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await finalizeMacosElectronUpdaterCompatibilityReceipt(process.argv.slice(2));
    process.stdout.write(
      "Finalized macOS Electron updater compatibility receipt.\n"
    );
  } catch {
    process.stderr.write(
      "macOS Electron updater compatibility receipt finalization failed.\n"
    );
    process.exitCode = 1;
  }
}
