import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/restore-public-latest.yml";
const EXACT_ASSETS = [
  "Rion.Studio-mac.app.tar.gz",
  "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-mac.dmg",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.sig",
  "SHA256SUMS.txt",
  "latest.json"
];

describe("public latest restore durable lease workflow", () => {
  it("runs only from the trusted manual main control plane", async () => {
    const source = await workflow();

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: electron-production-release");
    expect(source).toContain("github.repository == 'rion-tw/rion-studio-source'");
    expect(source).toContain(
      "github.event.repository.full_name == 'rion-tw/rion-studio-source'"
    );
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain("github.ref_protected == true");
    expect(source).toContain(
      "github.workflow_ref == 'rion-tw/rion-studio-source/" +
      ".github/workflows/restore-public-latest.yml@refs/heads/main'"
    );
    expect(source).toContain('test "${GITHUB_EVENT_NAME}" = "workflow_dispatch"');
    expect(source).toContain('test "${GITHUB_REPOSITORY}" = "${SOURCE_CONTROL_REPOSITORY}"');
    expect(source).toContain('test "${EVENT_REPOSITORY}" = "${SOURCE_CONTROL_REPOSITORY}"');
    expect(source).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(source).toContain('test "${EVENT_DEFAULT_BRANCH}" = "main"');
    expect(source).toContain('test "${REF_PROTECTED}" = "true"');
    expect(source).toContain('test "${WORKFLOW_REF}" = \\');
    expect(source).toContain("ref: ${{ github.sha }}");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain('test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"');
    expect(source).not.toMatch(/transaction_id:\s*\n|lease_id:\s*\n/u);
    expect(source).not.toContain("--token");
    expect(source).not.toContain("--repository");
    expect(source).not.toContain("--ref");
    expect(source).not.toContain("--path");
  });

  it("captures source, target, and fresh readback through release IDs and seven exact assets", async () => {
    const source = await workflow();
    const capture = step(source, "Capture exact source and target snapshots by immutable release ID");
    const readback = step(source, "Always capture and classify a fresh latest readback");

    expect(capture).toContain("releases/tags/${TAG}");
    expect(capture).toContain("releases/latest");
    expect(capture).toContain('releases/${release_id}');
    expect(capture).toContain('test "${target_id}" != "${source_id}"');
    expect(capture).toContain(".published_at");
    expect(capture).toContain(".draft");
    expect(capture).toContain(".prerelease");
    expect(capture).toContain("target-observed-snapshot.json");
    expect(capture).toContain("target-expected-latest-snapshot.json");
    expect(capture).toContain("source-public-latest-snapshot.json");
    expect(capture).toContain("deriveTauriV22ExpectedLatestState");
    expect(capture).toContain("--verify-checksums --require-tauri-v22");
    expect(capture).toContain("source_runtime=tauri-v22");
    expect(capture).toContain("source_runtime=electron-v23");
    expect(capture).toContain("Electron Framework.framework");
    expect(capture).toContain("Contents/Resources/app.asar");
    expect(source).not.toContain("gh release download");

    for (const asset of EXACT_ASSETS) {
      expect(capture).toContain(asset);
      expect(readback).toContain(asset);
    }
    for (const block of [capture, readback]) {
      expect(block).toContain("releases/assets/${asset_id}");
      expect(block).toContain("'[.assets[] | select(.name == $name)] | length'");
      expect(block).toContain("'.assets | length'");
    }
    expect(readback).toContain("if: ${{ always() }}");
    expect(readback).toContain('classification = "unknown"');
    expect(readback).toContain("classifyElectronProductionPublicLatestSnapshot");
  });

  it("generates the transaction locally and holds an exact remote lease around mutation", async () => {
    const source = await workflow();
    const acquire = step(source, "Acquire the durable public-latest lease");
    const observe = step(source, "Observe the exact held lease immediately before mutation");
    const mutation = step(source, "Submit latest mutation with closed acknowledgement");

    expect(acquire.match(/randomUUID\(\)/gu)).toHaveLength(2);
    expect(acquire).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs acquire");
    expect(acquire).toContain("--purpose tauri-v22-latest-restore");
    expect(acquire).toContain("--holder-workflow .github/workflows/restore-public-latest.yml");
    expect(acquire).toContain('--holder-run-id "${GITHUB_RUN_ID}"');
    expect(acquire).toContain('--holder-run-attempt "${GITHUB_RUN_ATTEMPT}"');
    expect(acquire).toContain('--control-head-sha "${GITHUB_SHA}"');
    expect(acquire).toContain('--source-runtime "${SOURCE_RUNTIME}"');
    expect(acquire).toContain("--target-runtime tauri-v22");
    expect(observe).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs observe");
    expect(observe).toContain('--held-lease-sha256 "${HELD_SHA256}"');
    expect(source.indexOf("Observe the exact held lease immediately before mutation"))
      .toBeLessThan(source.indexOf("Submit latest mutation with closed acknowledgement"));

    expect(mutation).toContain("gh api --method PATCH --include");
    expect(mutation).toContain("-f make_latest=true");
    expect(mutation).toContain("acknowledgement=confirmed");
    expect(mutation).toContain("acknowledgement=rejected");
    expect(mutation).toContain("acknowledgement=unknown");
    expect(mutation).toContain('^4[0-9]{2}$');
    expect(mutation).not.toContain("sleep");
    expect(mutation).not.toContain("timeout");
    expect(mutation).not.toContain("retry");
  });

  it("releases only for closed safe pairs and otherwise preserves held evidence and fails", async () => {
    const source = await workflow();
    const release = step(
      source,
      "Release the lease only for a safe acknowledgement and exact readback"
    );
    const final = step(source, "Record the closed restore result");
    const gate = step(source, "Require a safely released lease");

    expect(release).toContain("acknowledgement == 'confirmed'");
    expect(release).toContain("classification == 'target'");
    expect(release).toContain("acknowledgement == 'rejected'");
    expect(release).toContain("classification == 'source'");
    expect(release).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs observe");
    expect(release).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs release");
    expect(release.indexOf(".mjs observe")).toBeLessThan(release.indexOf(".mjs release"));
    expect(final).toContain("lease_status=held");
    expect(final).toContain("lease_status=released");
    expect(final).toContain("lease_status=not-acquired");
    expect(source).toContain("path: restore-evidence");
    expect(source).toContain("held-acquired");
    expect(source).toContain("held-pre-mutation");
    expect(source).toContain("held-pre-release");
    expect(source).toContain("released");
    expect(gate).toContain('test "${RELEASE_STEP_OUTCOME}" = "success"');
    expect(source).not.toMatch(/restore-evidence.*(?:GH_TOKEN|token)/iu);
  });

  it("keeps every embedded Bash program syntactically valid", async () => {
    const source = await workflow();
    const scripts = bashPrograms(source);
    expect(scripts.length).toBeGreaterThanOrEqual(9);
    for (const script of scripts) {
      expect(() => execFileSync("bash", ["-n"], {
        encoding: "utf8",
        input: script
      })).not.toThrow();
    }
  });
});

async function workflow() {
  return readFile(WORKFLOW_PATH, "utf8");
}

function step(source: string, name: string) {
  const start = source.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step ${name}.`);
  const next = source.indexOf("\n      - name:", start + 1);
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
