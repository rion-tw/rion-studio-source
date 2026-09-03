import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const PUBLISH_PATH = ".github/workflows/publish-public-release.yml";
const FINALIZE_PATH = ".github/workflows/finalize-private-release.yml";
const EXACT_ASSETS = [
  "Rion.Studio-mac.app.tar.gz",
  "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-mac.dmg",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.sig",
  "SHA256SUMS.txt",
  "latest.json"
];

describe("stable Tauri v22 durable public publisher", () => {
  it("accepts only the two protected-main reusable callers and trusted control SHA", async () => {
    const [publish, finalize] = await Promise.all([workflow(), finalizer()]);

    expect(publish).not.toContain("workflow_dispatch:\n    inputs:");
    for (const source of [publish, finalize]) {
      expect(source).toContain('test "${GITHUB_REPOSITORY}" = "${SOURCE_CONTROL_REPOSITORY}"');
      expect(source).toContain('test "${EVENT_REPOSITORY}" = "${SOURCE_CONTROL_REPOSITORY}"');
      expect(source).toContain('test "${EVENT_DEFAULT_BRANCH}" = "main"');
      expect(source).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
      expect(source).toContain('test "${REF_PROTECTED}" = "true"');
      expect(source).toContain('test "${WORKFLOW_SHA}" = "${GITHUB_SHA}"');
      expect(source).toContain(".github/workflows/release.yml@refs/heads/main");
      expect(source).toContain(".github/workflows/resume-release.yml@refs/heads/main");
      expect(source).toContain("persist-credentials: false");
      expect(source).not.toContain("ref: ${{ inputs.tag }}");
      expect(source).not.toContain("Checkout release tag");
    }
    expect(publish).toContain("ref: ${{ github.sha }}");
    expect(finalize).toContain(
      "ref: ${{ needs.authorize-control-plane.outputs.control_sha }}"
    );
  });

  it("treats private release assets and notes as API-ID product data before the App key", async () => {
    const source = await workflow();
    const capture = step(
      source,
      "Capture the private release as immutable product data before public credentials"
    );
    const reverify = step(
      source,
      "Independently reverify the staged input before the App private key"
    );
    const token = source.indexOf("Create the narrow public repository writer token");

    expect(capture).toContain("releases/tags/${TAG}");
    expect(capture).toContain('releases/${release_id}');
    expect(capture).toContain("releases/assets/${asset_id}");
    expect(capture).toContain("private-release-api.json");
    expect(capture).toContain("private-release-notes.md");
    expect(capture).toContain("stable-publication-input.json");
    expect(capture.match(/kind: "rion-stable-tauri-v22-publication-input"/gu)).toHaveLength(1);
    expect(capture).toContain("git archive --format=tar");
    expect(capture).not.toContain("git checkout");
    expect(source).not.toContain("gh release download");
    for (const asset of EXACT_ASSETS) expect(capture).toContain(asset);
    expect(reverify).toContain("--verify-checksums --require-tauri-v22");
    expect(source.indexOf(reverify)).toBeLessThan(token);
    expect(token).toBeGreaterThan(source.indexOf("stable-publication-input.json"));
  });

  it("stages exactly seven Tauri assets as non-latest and captures both releases by ID", async () => {
    const source = await workflow();
    const stage = step(
      source,
      "Stage and capture the exact Tauri v22 target and current latest"
    );

    for (const asset of EXACT_ASSETS) expect(stage).toContain(asset);
    expect(stage).toContain("--draft=false --latest=false");
    expect(stage).toContain('test "$(jq \'.assets | length\' "${api_file}")" = "7"');
    expect(stage).toContain("releases/${release_id}");
    expect(stage).toContain("releases/assets/${asset_id}");
    expect(stage).toContain("source-public-latest-snapshot.json");
    expect(stage).toContain("target-observed-snapshot.json");
    expect(stage).toContain("target-expected-latest-snapshot.json");
    expect(stage).toContain("deriveTauriV22ExpectedLatestState");
    expect(stage).toContain("--verify-checksums --require-tauri-v22");
    expect(stage).not.toContain("--clobber");
  });

  it("makes an already-latest exact target an explicit no-lease idempotent path", async () => {
    const source = await workflow();
    const stage = step(
      source,
      "Stage and capture the exact Tauri v22 target and current latest"
    );
    const acquire = step(source, "Acquire the durable public-latest publication lease");
    const gate = step(source, "Require a terminal exact public latest result");

    expect(stage).toContain('if test "${latest_id}" = "${target_id}"; then');
    expect(stage).toContain("mode=idempotent-already-latest");
    expect(stage).toContain("target-current-latest-snapshot.json");
    expect(acquire).toContain("if: steps.stage.outputs.mode == 'latest-mutation'");
    expect(gate).toContain('if test "${MODE}" = "idempotent-already-latest"; then');
    expect(gate).toContain('test "${RELEASE_STEP_OUTCOME}" = "skipped"');
  });

  it("holds the remote lease around one closed latest mutation and releases only safe pairs", async () => {
    const source = await workflow();
    const acquire = step(source, "Acquire the durable public-latest publication lease");
    const mutation = step(
      source,
      "Re-read the exact source, observe the held lease, and submit latest mutation"
    );
    const readback = step(
      source,
      "Always capture and classify a fresh public latest readback"
    );
    const release = step(
      source,
      "Release the lease only for a safe acknowledgement and exact readback"
    );

    expect(acquire.match(/randomUUID\(\)/gu)).toHaveLength(2);
    expect(acquire).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs acquire");
    expect(acquire).toContain("--purpose tauri-v22-publication");
    expect(acquire).toContain(
      "--holder-workflow .github/workflows/publish-public-release.yml"
    );
    expect(mutation).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs observe");
    expect(mutation).toContain("gh api --method PATCH --include");
    expect(mutation).toContain("-f make_latest=true");
    expect(mutation.indexOf(".mjs observe")).toBeLessThan(
      mutation.indexOf("gh api --method PATCH")
    );
    expect(mutation).toContain("acknowledgement=confirmed");
    expect(mutation).toContain("acknowledgement=rejected");
    expect(mutation).toContain("acknowledgement=unknown");
    expect(readback).toContain("if: ${{ always()");
    expect(readback).toContain("classifyElectronProductionPublicLatestSnapshot");
    expect(release).toContain("acknowledgement == 'confirmed'");
    expect(release).toContain("classification == 'target'");
    expect(release).toContain("acknowledgement == 'rejected'");
    expect(release).toContain("classification == 'source'");
    expect(release.indexOf(".mjs observe")).toBeLessThan(
      release.indexOf(".mjs release")
    );
    for (const block of [acquire, mutation, release]) {
      expect(block).not.toMatch(/\b(?:retry|sleep)\b/iu);
    }
  });

  it("uses trusted main code for released-source documents and keeps evidence token-free", async () => {
    const source = await workflow();
    const docs = step(
      source,
      "Synchronize public documentation using trusted main control code"
    );

    expect(docs).toContain('test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"');
    expect(docs).toContain("synchronizePublicDocuments");
    expect(docs).toContain("stable-publication-input/release-docs");
    expect(source).toContain("stable-publication-evidence");
    expect(source).not.toMatch(/stable-publication-evidence.*(?:GH_TOKEN|private-key)/iu);
  });

  it("keeps private upload and terminal finalization on trusted main control", async () => {
    const source = await finalizer();
    const authorize = job(
      source,
      "authorize-control-plane",
      "verify-and-upload-private-release"
    );
    const upload = job(source, "verify-and-upload-private-release", "publish-public-release");
    const terminal = job(source, "finalize-private-release");

    expect(source).toContain("permissions:\n  contents: read");
    expect(authorize).not.toContain("contents: write");
    for (const credentialJob of [upload, terminal]) {
      expect(credentialJob).toContain("permissions:\n      contents: write");
      expect(credentialJob).toContain(
        "ref: ${{ needs.authorize-control-plane.outputs.control_sha }}"
      );
      expect(credentialJob).not.toContain("ref: ${{ inputs.tag }}");
    }
    expect(upload).toContain("releases/assets/${asset_id}");
    expect(upload).toContain("--verify-checksums --require-tauri-v22");
    expect(upload).not.toContain("gh release download");
    expect(terminal).toContain("releases/${RELEASE_ID}");
    expect(terminal).toContain("-F draft=false -f make_latest=false");
  });

  it("keeps every embedded Bash program syntactically valid", async () => {
    for (const source of await Promise.all([workflow(), finalizer()])) {
      const scripts = bashPrograms(source);
      expect(scripts.length).toBeGreaterThanOrEqual(5);
      for (const script of scripts) {
        expect(() => execFileSync("bash", ["-n"], {
          encoding: "utf8",
          input: script
        })).not.toThrow();
      }
    }
  });
});

function workflow() {
  return readFile(PUBLISH_PATH, "utf8");
}

function finalizer() {
  return readFile(FINALIZE_PATH, "utf8");
}

function step(source: string, name: string) {
  const start = source.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step ${name}.`);
  const next = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function job(source: string, name: string, nextName?: string) {
  const start = source.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  const next = nextName === undefined ? -1 : source.indexOf(`\n  ${nextName}:`, start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function bashPrograms(source: string) {
  const lines = source.split("\n");
  const programs: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "        run: |") continue;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line !== "" && !line.startsWith("          ")) {
        index -= 1;
        break;
      }
      body.push(line.startsWith("          ") ? line.slice(10) : line);
    }
    programs.push(`${body.join("\n")}\n`);
  }
  return programs;
}
