import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH =
  ".github/workflows/electron-production-updater-evidence.yml";
const PINNED_ACTION = /uses: [^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/gmu;

describe("Electron production updater evidence workflow", () => {
  it("is owner-gated, protected-main-only, serialized, and hard-disabled", async () => {
    const source = await workflow();
    const authorize = job(source, "authorize-and-seal", "native-transaction");
    const jobs = [
      authorize,
      job(source, "native-transaction", "attest-terminal-cell"),
      job(source, "attest-terminal-cell", "aggregate-and-verify"),
      job(source, "aggregate-and-verify")
    ];

    expect(source).toContain("workflow_dispatch:");
    expect(topLevelSection(source, "permissions")).toBe(
      "  actions: read\n  attestations: read\n  contents: read\n\n"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  group: electron-production-updater-evidence-${{ inputs.target_source_sha }}-${{ inputs.target_version }}"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  cancel-in-progress: false"
    );
    for (const workflowJob of jobs) {
      expect(workflowJob).toMatch(/^\s{4}if: \$\{\{ false \}\}$/mu);
    }
    expect(authorize).toContain("environment: electron-production-release");
    expect(authorize).toContain('test "${DEFAULT_BRANCH}" = "main"');
    expect(authorize).toContain('test "${DISPATCH_REF}" = "refs/heads/main"');
    expect(authorize).toContain('test "${DISPATCH_REF_PROTECTED}" = "true"');
    expect(authorize).toContain(
      'test "${OWNER_APPROVAL}" = "AUTHORIZE ELECTRON PRODUCTION UPDATER EVIDENCE"'
    );
    expect(authorize).toContain(
      "Checkout the exact trusted control plane"
    );
    expect(authorize).not.toContain("ref: ${{ inputs.target_source_sha }}");
    expect(authorize).not.toContain("ref: ${{ inputs.prior_source_sha }}");
  });

  it("seals exact upstream identities and all four attempt cells before native work", async () => {
    const source = await workflow();
    const authorize = job(source, "authorize-and-seal", "native-transaction");

    for (const upstreamWorkflow of [
      ".github/workflows/electron-production-candidate.yml",
      ".github/workflows/electron-updater-tauri-v22-compatibility.yml",
      ".github/workflows/electron-production-provisional-publish.yml"
    ]) {
      expect(authorize).toContain(upstreamWorkflow);
    }
    expect(authorize).toContain('test "$(jq -r .event <<< "${document}")" = "workflow_dispatch"');
    expect(authorize).toContain('test "$(jq -r .conclusion <<< "${document}")" = "success"');
    expect(authorize).toContain('test "$(jq -r .head_branch <<< "${document}")" = "main"');
    expect(authorize).toContain("gh attestation verify");
    expect(authorize).toContain("runInvocationURI == $invocation_uri");
    expect(authorize).toContain(
      "electronProductionUpdaterTrustedControlIntakeCli.mjs create"
    );
    expect(authorize).toContain(
      "electronProductionUpdaterEvidenceAttemptPlanCli.mjs create"
    );
    expect(authorize).toContain(
      "electronProductionUpdaterEvidenceCellBindingsCli.mjs create"
    );
    expect(authorize).toContain(
      "tauri-v22-to-electron-v23 electron-v23-to-electron-v23"
    );
    expect(authorize).toContain(
      "for platform in darwin-aarch64 windows-x86_64"
    );
    expect(authorize).toContain("openssl rand 32");
    expect(authorize).toContain("--trusted-bindings-sha256 \"${trusted_sha}\"");
  });

  it("runs exactly the required two transitions on macOS and Windows", async () => {
    const source = await workflow();
    const native = job(source, "native-transaction", "attest-terminal-cell");
    const matrix = subsection(native, "    strategy:", "    runs-on:");

    expect(matrix.match(/^\s{10}- platform:/gmu)).toHaveLength(4);
    expect(matrix.match(/platform: darwin-aarch64/gmu)).toHaveLength(2);
    expect(matrix.match(/platform: windows-x86_64/gmu)).toHaveLength(2);
    expect(matrix.match(/transition: tauri-v22-to-electron-v23/gmu)).toHaveLength(2);
    expect(matrix.match(/transition: electron-v23-to-electron-v23/gmu)).toHaveLength(2);
    expect(matrix.match(/runner: macos-14/gmu)).toHaveLength(2);
    expect(matrix.match(/runner: windows-latest/gmu)).toHaveLength(2);
    expect(matrix).toContain("fail-fast: false");
  });

  it("keeps native transaction runners read-only and free of signing authority", async () => {
    const source = await workflow();
    const native = job(source, "native-transaction", "attest-terminal-cell");
    const permissions = subsection(native, "    permissions:", "    strategy:");

    expect(permissions).toBe(
      "    permissions:\n" +
      "      actions: read\n" +
      "      attestations: none\n" +
      "      contents: read\n" +
      "      id-token: none\n"
    );
    expect(native).not.toContain("secrets.");
    expect(native).not.toContain("RION_STUDIO_UPDATER_PRIVATE_KEY");
    expect(native).not.toContain("RION_STUDIO_UPDATER_KEY_PASSWORD");
    expect(native).not.toContain("actions/create-github-app-token@");
    expect(native).not.toContain("actions/attest-build-provenance@");
  });

  it("drives the exact source updater through visible UI and product terminality", async () => {
    const source = await workflow();
    const native = job(source, "native-transaction", "attest-terminal-cell");

    expect(native).toContain("releases/assets/${asset_id}");
    expect(native).toContain(
      'test "$(jq -r .assets.artifact.name "${lineage}")" = "${artifact_name}"'
    );
    expect(native).toContain('gh run download "${prior_run_id}"');
    expect(native).toContain(
      "electronProductionUpdaterSourceRuntimeCli.mjs prepare"
    );
    expect(native).toContain(
      "electronProductionUpdaterDataPreservationObserverCli.mjs prepare"
    );
    expect(native).toContain(
      "electronProductionUpdaterSourceRuntimeCli.mjs launch"
    );
    expect(native).toContain(
      "electronProductionUpdaterVisibleUiCli.mjs open-settings"
    );
    expect(native).toContain("electronProductionUpdaterVisibleUiCli.mjs check");
    expect(native).toContain(
      "electronProductionUpdaterEvidenceEndpointObservationCli.mjs observe"
    );
    expect(native).toContain(
      "electronProductionUpdaterVisibleInstallCoordinatorCli.mjs observe"
    );
    expect(native).toContain(
      "electronProductionUpdaterPostInstallCellCoordinatorCli.mjs"
    );
    expect(native.indexOf("SourceRuntimeCli.mjs launch"))
      .toBeLessThan(native.indexOf("VisibleUiCli.mjs open-settings"));
    expect(native.indexOf("VisibleUiCli.mjs check"))
      .toBeLessThan(native.indexOf("VisibleInstallCoordinatorCli.mjs observe"));
    expect(native.indexOf("VisibleInstallCoordinatorCli.mjs observe"))
      .toBeLessThan(native.indexOf("PostInstallCellCoordinatorCli.mjs"));
  });

  it("retains the macOS AppKit host boundary and observes the target Chromium process", async () => {
    const source = await workflow();
    const native = job(source, "native-transaction", "attest-terminal-cell");

    expect(native).toContain("buildDarwinPackagedProcessInventory");
    expect(native).toContain(
      'path.join(root, "Rion Studio.app", "Contents", "MacOS", "Rion Studio")'
    );
    expect(native).toContain("--target-executable \"${target_executable}\"");
    expect(native).toContain("--inventory-executable");
    expect(native).toContain("--inventory-executable-sha256");
    expect(native).toContain("--native-host-observation");
    expect(native).toContain("--product-terminal-receipt-output");
    expect(native).toContain("--target-user-data");
    expect(native).not.toContain("BrowserWindow-only");
    expect(native).not.toContain("remote-debugging-port");
    expect(native).not.toContain("puppeteer");
    expect(native).not.toContain("playwright");
  });

  it("separates detached receipt attestation from native execution and verifies the aggregate", async () => {
    const source = await workflow();
    const attest = job(source, "attest-terminal-cell", "aggregate-and-verify");
    const aggregate = job(source, "aggregate-and-verify");

    expect(attest).toContain("runs-on: ubuntu-latest");
    expect(attest).toContain("attestations: write");
    expect(attest).toContain("id-token: write");
    expect(attest).not.toContain("environment: electron-production-release");
    expect(attest).not.toContain("secrets.");
    expect(attest).toContain("Attest only the terminal receipt subject");
    expect(attest).toContain(
      "subject-path: terminal-cell/${{ matrix.transition }}/${{ matrix.platform }}/terminal-receipt.json"
    );
    expect(attest.match(/subject-path:/gmu)).toHaveLength(1);
    expect(aggregate).toContain("gh attestation verify");
    expect(aggregate).toContain("runInvocationURI == $invocation_uri");
    expect(aggregate).toContain(
      "electronProductionUpdaterEvidenceAggregateCli.mjs verify"
    );
    expect(aggregate).toContain(
      "electron-production-updater-terminal-evidence-${{ inputs.target_version }}-${{ inputs.target_source_sha }}-attempt-${{ github.run_attempt }}"
    );
  });

  it("pins every third-party action and does not hard-code application major versions", async () => {
    const source = await workflow();
    const uses = source.match(/^\s*uses: .*$/gmu) ?? [];

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line.trim(), line).toMatch(PINNED_ACTION);
    expect(source).not.toMatch(/startsWith\("2[23]\."\)|==\s*2[23]/u);
  });
});

async function workflow(): Promise<string> {
  return (await readFile(WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");
}

function job(source: string, name: string, nextName?: string): string {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  if (!nextName) return source.slice(start);
  const end = source.indexOf(`  ${nextName}:\n`, start + startMarker.length);
  if (end < 0) throw new Error(`Missing workflow job ${nextName}.`);
  return source.slice(start, end);
}

function subsection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow subsection ${startMarker.trim()}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing workflow subsection ${endMarker.trim()}.`);
  return source.slice(start, end);
}

function topLevelSection(source: string, name: string): string {
  const marker = `${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing top-level section ${name}.`);
  const bodyStart = start + marker.length;
  const body = source.slice(bodyStart);
  const next = body.search(/^[-\w]+:/mu);
  return next < 0 ? body : body.slice(0, next);
}
