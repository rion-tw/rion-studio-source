import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/electron-production-candidate.yml";
const HELPER_PATH = "scripts/electronProductionCandidateTrustedControl.mjs";
const SOURCE_SHA = "a".repeat(40);
const CONTROL_PLANE_SHA = "b".repeat(40);
const VERSION = "23.4.5";
const PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production candidate workflow trust boundary", () => {
  it("keeps candidate code outside every private-key and authoritative receipt job", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    const authorize = jobSource(workflow, "authorize-control-plane", "validate");
    const validate = jobSource(workflow, "validate", "quality");
    const quality = jobSource(workflow, "quality", "build");
    const build = jobSource(workflow, "build", "attest-signing-input");
    const attest = jobSource(workflow, "attest-signing-input", "sign");
    const sign = jobSource(workflow, "sign", "assemble");
    const assemble = workflow.slice(workflow.indexOf("  assemble:"));

    expect(workflow).toContain("actions: read\n  attestations: read\n  contents: read");
    expect(authorize).toContain("environment: electron-production-release");
    expect(authorize).toContain("EXPECTED_REPOSITORY: rion-tw/rion-studio-source");
    expect(authorize).toContain('test "${REPOSITORY}" = "${EXPECTED_REPOSITORY}"');
    expect(authorize).toContain('test "${EVENT_REPOSITORY}" = "${EXPECTED_REPOSITORY}"');
    expect(authorize).toContain('test "${DEFAULT_BRANCH}" = "main"');
    expect(authorize).toContain('test "${DISPATCH_REF}" = "refs/heads/main"');
    expect(authorize).toContain('test "${DISPATCH_REF_PROTECTED}" = "true"');
    expect(authorize).toContain('test "${WORKFLOW_REF}" = "${EXPECTED_WORKFLOW_REF}"');

    for (const trustedJob of [validate, attest, sign, assemble]) {
      expect(trustedJob).toContain(
        "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}"
      );
      expect(trustedJob).not.toContain("ref: ${{ inputs.source_sha }}");
    }
    expect(validate).toContain("electron-production-candidate-trusted-control-receipt.json");

    expect(quality).toContain("ref: ${{ inputs.source_sha }}");
    expect(quality).not.toContain("secrets:");
    expect(build).toContain("ref: ${{ inputs.source_sha }}");
    expect(build).not.toContain("environment: electron-production-release");
    expect(build).not.toContain("secrets.");
    expect(build).not.toContain("attestations: write");
    expect(build).not.toContain("id-token: write");

    expect(attest).toContain("attestations: write");
    expect(attest).toContain("id-token: write");
    expect(attest).toContain("create-signing-input");
    expect(attest).toContain("actions/attest-build-provenance@");
    expect(attest).not.toContain("secrets.");

    expect(sign).toContain("gh attestation verify");
    expect(sign).toContain("verify-signing-input");
    expect(sign).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_PLANE_SHA}"');
    expect(sign).not.toContain('test "$(git rev-parse HEAD)" = "${SOURCE_SHA}"');
    expect(sign.indexOf("verify-signing-input")).toBeLessThan(
      sign.indexOf("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")
    );
    expect(sign).toContain("--source-sha \"${SOURCE_SHA}\"");
    expect(sign).toContain("RION_STUDIO_SIGNING_UNSIGNED_ARCHIVE");
    expect(sign).toContain("RION_STUDIO_SIGNING_BLACK_BOX_REPORT");

    expect(assemble).toContain(
      'test "$(git rev-parse HEAD)" = "${CONTROL_PLANE_SHA}"'
    );
    expect(assemble).not.toContain(
      'test "$(git rev-parse HEAD)" = "${SOURCE_SHA}"'
    );
    expect(assemble).toContain("--source-sha \"${SOURCE_SHA}\"");
    expect(assemble).toContain("electron-production-candidate-receipt.json");
  });

  it("binds and rereads a closed signing-input inventory", async () => {
    const root = await temporaryDirectory();
    const signingInput = join(root, "signing-input");
    const controlDirectory = join(signingInput, "control");
    const unsignedDirectory = join(signingInput, "unsigned");
    const blackBoxDirectory = join(signingInput, "black-box", "attempt");
    await Promise.all([
      mkdir(controlDirectory, { recursive: true }),
      mkdir(unsignedDirectory, { recursive: true }),
      mkdir(blackBoxDirectory, { recursive: true })
    ]);
    const controlReceipt = join(
      controlDirectory,
      "electron-production-candidate-trusted-control-receipt.json"
    );
    runHelper([
      "create-control",
      ...commonArguments(),
      "--control-plane-ref", "refs/heads/main",
      "--event", "workflow_dispatch",
      "--owner-approval", "BUILD ELECTRON PRODUCTION CANDIDATE",
      "--published-at", "2026-08-31T10:30:00Z",
      "--updater-base-url", "https://updates.example.test/rion/v23",
      "--output", controlReceipt
    ], { RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY });
    await Promise.all([
      writeFile(
        join(unsignedDirectory, "electron-production-unsigned-macos-arm64.tar.gz"),
        "sealed unsigned archive"
      ),
      writeFile(join(blackBoxDirectory, "packaged-smoke-report.json"), "{}\n"),
      writeFile(join(blackBoxDirectory, "packaged-role-native-host.png"), "png")
    ]);
    const signingReceipt = join(
      root,
      "electron-production-candidate-signing-input-receipt.json"
    );
    runHelper([
      "create-signing-input",
      ...commonArguments(),
      "--platform", "darwin-aarch64",
      "--input-root", signingInput,
      "--control-receipt", controlReceipt,
      "--output", signingReceipt
    ]);

    const verified = JSON.parse(runHelper([
      "verify-signing-input",
      ...commonArguments(),
      "--platform", "darwin-aarch64",
      "--input-root", signingInput,
      "--receipt", signingReceipt
    ]).stdout) as {
      blackBoxReportPath: string;
      unsignedArchivePath: string;
      updaterPublicKey: string;
      windowsInstallerPayloadProofPath: string | null;
    };
    expect(verified.blackBoxReportPath).toBe(
      join(blackBoxDirectory, "packaged-smoke-report.json")
    );
    expect(verified.unsignedArchivePath).toBe(
      join(unsignedDirectory, "electron-production-unsigned-macos-arm64.tar.gz")
    );
    expect(verified.updaterPublicKey).toBe(PUBLIC_KEY);
    expect(verified.windowsInstallerPayloadProofPath).toBeNull();

    await writeFile(join(blackBoxDirectory, "packaged-smoke-report.json"), "tampered\n");
    const tampered = runHelper([
      "verify-signing-input",
      ...commonArguments(),
      "--platform", "darwin-aarch64",
      "--input-root", signingInput,
      "--receipt", signingReceipt
    ], {}, false);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain(
      "sealed signing-input inventory or bytes changed after attestation"
    );
  });

  it("rejects a trusted-control receipt for any non-authoritative repository", async () => {
    const root = await temporaryDirectory();
    const foreignArguments = commonArguments();
    foreignArguments[foreignArguments.indexOf("--repository") + 1] =
      "fork/rion-studio-source";
    const result = runHelper([
      "create-control",
      ...foreignArguments,
      "--control-plane-ref", "refs/heads/main",
      "--event", "workflow_dispatch",
      "--owner-approval", "BUILD ELECTRON PRODUCTION CANDIDATE",
      "--published-at", "2026-08-31T10:30:00Z",
      "--updater-base-url", "https://updates.example.test/rion/v23",
      "--output", join(root, "foreign-control-receipt.json")
    ], { RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY }, false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not the fixed source repository");
  });
});

function commonArguments() {
  return [
    "--control-plane-sha", CONTROL_PLANE_SHA,
    "--repository", "rion-tw/rion-studio-source",
    "--run-id", "12345",
    "--run-attempt", "2",
    "--source-sha", SOURCE_SHA,
    "--version", VERSION
  ];
}

function runHelper(
  argumentsList: string[],
  environment: Record<string, string> = {},
  requireSuccess = true
) {
  const result = spawnSync(process.execPath, [HELPER_PATH, ...argumentsList], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
  if (requireSuccess && result.status !== 0) {
    throw new Error(`Trusted-control helper failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function jobSource(workflow: string, job: string, nextJob: string) {
  const start = workflow.indexOf(`  ${job}:`);
  const end = workflow.indexOf(`  ${nextJob}:`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Missing workflow job boundary ${job}.`);
  return workflow.slice(start, end);
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rion-candidate-control-"));
  temporaryDirectories.push(directory);
  return directory;
}
