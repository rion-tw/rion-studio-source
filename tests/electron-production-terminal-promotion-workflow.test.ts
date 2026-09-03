import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH =
  ".github/workflows/electron-production-terminal-promotion.yml";
const PINNED_ACTION = /uses: [^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/gmu;

describe("Electron production terminal promotion workflow", () => {
  it("is protected-main-only, owner-gated, serialized, and hard-disabled", async () => {
    const source = await workflow();

    expect(topLevelSection(source, "permissions")).toBe(
      "  actions: read\n  contents: read\n\n"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  group: public-latest-rion-studio"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  cancel-in-progress: false"
    );
    for (const name of jobNames(source)) {
      expect(job(source, name), name).toMatch(
        new RegExp(
          `^  ${name}:\\n(?:.*\\n){0,8}    if: \\$\\{\\{ false \\}\\}`,
          "mu"
        )
      );
    }
    const verify = job(source, "verify-inputs", "observe-target");
    expect(verify).toContain("environment: electron-production-release");
    expect(verify).toContain('test "${DEFAULT_BRANCH}" = "main"');
    expect(verify).toContain('test "${DISPATCH_REF}" = "refs/heads/main"');
    expect(verify).toContain('test "${DISPATCH_REF_PROTECTED}" = "true"');
    expect(verify).toContain(
      'test "${APPROVAL}" = "FINALIZE ELECTRON PRODUCTION PROMOTION"'
    );
    expect(source.match(/ref: \$\{\{ github\.sha \}\}/gmu)).toHaveLength(5);
  });

  it("binds the readiness receipt, provisional receipt, capsule snapshots, and held lease", async () => {
    const source = await workflow();
    const verify = job(source, "verify-inputs", "observe-target");

    expect(verify).toContain(
      ".github/workflows/electron-production-promotion-readiness.yml"
    );
    expect(verify).toContain(
      ".github/workflows/electron-production-provisional-publish.yml"
    );
    expect(verify).toContain('test "$(jq -r .conclusion "${output}")" = "success"');
    expect(verify).toContain('test "$(jq -r .head_branch "${output}")" = "main"');
    expect(verify).toContain(
      "electron-production-publication-recovery-capsule-${PROVISIONAL_RUN_ID}-attempt-${PROVISIONAL_ATTEMPT}"
    );
    for (const digest of [
      "READINESS_RECEIPT_SHA256",
      "PROVISIONAL_RECEIPT_SHA256",
      "SOURCE_SNAPSHOT_SHA256",
      "TARGET_SNAPSHOT_SHA256",
      "HELD_LEASE_SHA256"
    ]) expect(verify).toContain(digest);
    expect(verify).toMatch(
      /publication\.terminalPromotionReceipt[\s\S]{0,120}"false"/u
    );
    expect(verify).toMatch(
      /\.purpose[\s\S]{0,120}"electron-v23-provisional-publication"/u
    );
  });

  it("requires exact target observations before and after the lease release", async () => {
    const source = await workflow();
    const pre = job(source, "observe-target", "release-lease");
    const release = job(source, "release-lease", "observe-final");
    const final = job(source, "observe-final", "finalize-receipt");

    for (const observationJob of [pre, final]) {
      expect(observationJob).toContain(
        "electronProductionPublicLatestRecoveryCli.mjs observe"
      );
      expect(observationJob).toContain(
        'observation.classification'
      );
      expect(observationJob).toMatch(
        /observation\.classification[\s\S]{0,180}"target"/u
      );
      expect(observationJob).not.toContain("secrets.");
      expect(observationJob).not.toContain("permission-contents: write");
    }
    expect(release.indexOf("Require the target observation"))
      .toBeLessThan(release.indexOf("Create the narrow public repository lease token"));
    expect(release).toContain(
      "electronProductionPublicLatestLeaseRemoteCli.mjs release"
    );
    expect(release).toMatch(
      /\.outcome lease-release\/lease-remote-operation\.json[\s\S]{0,120}"applied"/u
    );
  });

  it("isolates the sole write credential from finalization and attestation", async () => {
    const source = await workflow();
    const release = job(source, "release-lease", "observe-final");
    const finalize = job(source, "finalize-receipt", "attest-terminal-receipt");
    const attest = job(source, "attest-terminal-receipt");

    expect(release).toContain(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
    );
    expect(release).toContain("permission-contents: write");
    expect(release).toContain("secrets.RION_RELEASE_APP_PRIVATE_KEY");
    expect(release).not.toContain("electronProductionTerminalPromotionCli.mjs");
    expect(finalize).toContain("electronProductionTerminalPromotionCli.mjs finalize");
    expect(finalize).not.toContain("secrets.");
    expect(finalize).not.toContain("create-github-app-token");
    expect(finalize).not.toContain("attest-build-provenance");
    expect(attest).toContain("attestations: write");
    expect(attest).toContain("id-token: write");
    expect(attest).not.toContain("secrets.");
    expect(attest).not.toContain("actions/checkout@");
    expect(attest).toContain(
      "subject-path: terminal-receipt/electron-production-terminal-promotion-receipt.json"
    );
  });

  it("passes every external identity to the closed terminal receipt CLI", async () => {
    const source = await workflow();
    const finalize = job(source, "finalize-receipt", "attest-terminal-receipt");

    for (const option of [
      "--readiness-receipt-sha256",
      "--provisional-publication-receipt-sha256",
      "--source-snapshot-sha256",
      "--target-snapshot-sha256",
      "--held-lease-sha256",
      "--pre-release-observation-sha256",
      "--lease-remote-operation-sha256",
      "--lease-release-resolved-at",
      "--final-observation-sha256",
      "--finalized-at",
      "--owner-approval"
    ]) expect(finalize).toContain(option);
    expect(finalize).toContain(
      "--output terminal-output/electron-production-terminal-promotion-receipt.json"
    );
  });

  it("attests only promoted with retained AppKit and pins all third-party actions", async () => {
    const source = await workflow();
    const attest = job(source, "attest-terminal-receipt");

    expect(attest).toContain('test "$(jq -r .terminal "${receipt}")" = "true"');
    expect(attest).toContain('test "$(jq -r .outcome "${receipt}")" = "promoted"');
    expect(attest).toContain(".compatibility.macosAppKitRetained");
    expect(attest.match(/subject-path:/gmu)).toHaveLength(1);
    const uses = source.match(/^\s*uses: .*$/gmu) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line.trim(), line).toMatch(PINNED_ACTION);
  });
});

async function workflow() {
  return (await readFile(WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");
}

function jobNames(source: string) {
  const body = source.slice(source.indexOf("jobs:\n") + "jobs:\n".length);
  return [...body.matchAll(/^\s{2}([a-z][a-z0-9-]*):$/gmu)]
    .map((match) => match[1]);
}

function job(source: string, name: string, nextName?: string) {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  if (!nextName) return source.slice(start);
  const end = source.indexOf(`  ${nextName}:\n`, start + startMarker.length);
  if (end < 0) throw new Error(`Missing workflow job ${nextName}.`);
  return source.slice(start, end);
}

function topLevelSection(source: string, name: string) {
  const marker = `${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing top-level section ${name}.`);
  const body = source.slice(start + marker.length);
  const next = body.search(/^[-\w]+:/mu);
  return next < 0 ? body : body.slice(0, next);
}
