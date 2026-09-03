import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW =
  ".github/workflows/electron-updater-tauri-v22-compatibility.yml";

describe("Tauri v22 compatibility trusted control plane", () => {
  it("admits only the protected fixed default branch and separates both SHAs", async () => {
    const workflow = await source();
    const authorize = job(workflow, "authorize-control-plane", "build-target-input");
    const sealing = job(workflow, "attest-signing-input", "prepare-signed-input");

    expect(authorize).toContain(
      'test "${SOURCE_REPOSITORY}" = "rion-tw/rion-studio-source"'
    );
    expect(authorize).toContain('test "${DEFAULT_BRANCH}" = "main"');
    expect(authorize).toContain('test "${DISPATCH_REF}" = "refs/heads/main"');
    expect(authorize).toContain('test "${DISPATCH_REF_PROTECTED}" = "true"');
    expect(authorize).toContain(
      "electron-updater-tauri-v22-compatibility.yml@refs/heads/main"
    );
    expect(authorize).toContain(
      'echo "control_plane_sha=${CONTROL_PLANE_SHA}" >> "${GITHUB_OUTPUT}"'
    );

    expect(sealing).toContain('kind: "rion-electron-updater-tauri-v22-trusted-control"');
    expect(sealing).toContain('controlPlaneRef: "refs/heads/main"');
    expect(sealing).toContain("controlPlaneSha: process.env.CONTROL_PLANE_SHA");
    expect(sealing).toContain("candidateSourceSha: process.env.TARGET_SHA");
    expect(sealing).toContain("candidateVersion: process.env.TARGET_VERSION");
    expect(sealing).toContain("captureStableBoundedFileIdentity(");
    expect(sealing).toContain("attest-build-provenance");
  });

  it("never exposes credentials to the candidate checkout", async () => {
    const workflow = await source();
    const build = job(workflow, "build-target-input", "attest-signing-input");
    const signing = job(workflow, "prepare-signed-input", "artifact-compatibility");

    expect(build).toContain("ref: ${{ inputs.target_sha }}");
    expect(build).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(build).not.toContain("id-token: write");
    expect(build).not.toContain("attestations: write");

    expect(signing).not.toContain("ref: ${{ inputs.target_sha }}");
    expect(signing).toContain(
      "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}"
    );
    const verify = signing.indexOf(
      "- name: Verify attestation and every sealed input byte before private key entry"
    );
    const privateKey = signing.indexOf(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
    );
    expect(verify).toBeGreaterThan(-1);
    expect(privateKey).toBeGreaterThan(verify);
    expect(signing.slice(verify, privateKey)).toContain(
      "Unsigned compatibility archive bytes changed after attestation."
    );
    expect(signing.slice(verify, privateKey)).toContain(
      '--signer-digest "${CONTROL_PLANE_SHA}"'
    );
    expect(signing.slice(verify, privateKey)).toContain(
      '--source-digest "${CONTROL_PLANE_SHA}"'
    );
    const afterPrivateKey = signing.slice(privateKey);
    expect(afterPrivateKey).not.toContain("pnpm run package:electron");
    expect(afterPrivateKey).not.toContain("runElectronUpdaterTransactionProbe.mjs");
    expect(afterPrivateKey).not.toContain("ref: ${{ inputs.target_sha }}");
  });

  it("runs native compatibility and final attestation only from trusted control", async () => {
    const workflow = await source();
    const compatibility = job(workflow, "artifact-compatibility", "attest-lineage");
    const lineageAttestation = workflow.slice(workflow.indexOf("  attest-lineage:"));

    for (const trustedJob of [compatibility, lineageAttestation]) {
      expect(trustedJob).toContain(
        "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}"
      );
      expect(trustedJob).not.toContain("ref: ${{ inputs.target_sha }}");
    }
    expect(compatibility).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(compatibility).toContain(
      "Re-verify trusted provenance and restore candidate bytes without signing material"
    );
    expect(compatibility).toContain(
      '(.unsignedArchive.sha256 | test("^[0-9a-f]{64}$"))'
    );
    expect(compatibility).toContain(
      'observed_archive="$(ARCHIVE_PATH="${archive}" node --input-type=module'
    );
    expect(compatibility).toContain(
      'test "$(jq -r .sha256 <<< "${observed_archive}")" = \\'
    );
    expect(compatibility).toContain(
      '"--app" "${RION_UPDATER_UNSIGNED_INPUT_ROOT}/release/electron/mac-arm64/Rion Studio.app"'
    );
    expect(lineageAttestation).toContain("attestations: write");
    expect(lineageAttestation).toContain("id-token: write");
    expect(lineageAttestation).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  });

  it("rejects repository, signer, candidate-checkout, and archive-binding tampering", async () => {
    const workflow = await source();
    expect(() => assertTrustedBoundary(workflow)).not.toThrow();

    const tampered = [
      workflow.replace(
        'test "${SOURCE_REPOSITORY}" = "rion-tw/rion-studio-source"',
        'test -n "${SOURCE_REPOSITORY}"'
      ),
      workflow.replaceAll(
        '--signer-digest "${CONTROL_PLANE_SHA}"',
        '--signer-digest "${TARGET_SHA}"'
      ),
      workflow.replaceAll(
        '--source-digest "${CONTROL_PLANE_SHA}"',
        '--source-digest "${TARGET_SHA}"'
      ),
      workflow.replaceAll(
        "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}",
        "ref: ${{ inputs.target_sha }}"
      ),
      workflow.replace(
        "Unsigned compatibility archive bytes changed after attestation.",
        "Unsigned archive accepted."
      )
    ];
    for (const candidate of tampered) {
      expect(() => assertTrustedBoundary(candidate)).toThrow();
    }
  });
});

function assertTrustedBoundary(workflow: string): void {
  const signing = job(workflow, "prepare-signed-input", "artifact-compatibility");
  const required = [
    'test "${SOURCE_REPOSITORY}" = "rion-tw/rion-studio-source"',
    'test "${DISPATCH_REF}" = "refs/heads/main"',
    'test "${DISPATCH_REF_PROTECTED}" = "true"',
    '--signer-digest "${CONTROL_PLANE_SHA}"',
    '--source-digest "${CONTROL_PLANE_SHA}"',
    "Unsigned compatibility archive bytes changed after attestation."
  ];
  for (const fragment of required) {
    if (!workflow.includes(fragment)) {
      throw new Error(`Trusted compatibility boundary lost ${fragment}.`);
    }
  }
  if (
    !signing.includes(
      "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}"
    ) ||
    signing.includes("ref: ${{ inputs.target_sha }}")
  ) {
    throw new Error("The signing job no longer uses only trusted control.");
  }
}

function job(workflow: string, name: string, nextName: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

async function source(): Promise<string> {
  return (await readFile(WORKFLOW, "utf8")).replaceAll("\r\n", "\n");
}
