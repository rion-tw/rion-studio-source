import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri-only release workflows", () => {
  it("runs common checks and native package gates on macOS and Windows", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("pnpm run verify:system-only");
    expect(workflow).toContain("pnpm run typecheck");
    expect(workflow).toContain("pnpm run test");
    expect(workflow).toContain("pnpm run lint");
    expect(workflow).toContain("pnpm run build");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("pnpm run test:native:system-input");
    expect(workflow).toContain("pnpm run test:native:runtime-restore");
    expect(workflow).toContain("pnpm run test:native:file-operations");
    expect(workflow).not.toContain("--require-compiled-attestation");
    expect(workflow).not.toContain("RION_STUDIO_WINDOWS_INPUT_ATTESTED");
    expect(workflow).not.toContain("RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR");
    expect(workflow).toContain("rust-concurrency-sanitizer:");
    expect(workflow.toLowerCase()).not.toContain("electron");
    expect(workflow).not.toContain("Node-API");
  });

  it("keeps legacy platform code-signing behavior while updater artifacts stay verified", async () => {
    const [workflow, releaseScript, packageScript, macConfigSource] = await Promise.all([
      readWorkflow(".github/workflows/tauri-release-candidate.yml"),
      readWorkflow("scripts/buildTauriRelease.mjs"),
      readWorkflow("scripts/packageTauri.mjs"),
      readWorkflow("src-tauri/tauri.macos.conf.json")
    ]);
    const macConfig = JSON.parse(macConfigSource);

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("uses: ./.github/workflows/ci.yml");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(workflow).toContain("pnpm run release:version");
    expect(workflow).toContain("pnpm run dist -- --bundles");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Signature=adhoc");
    expect(workflow).toContain("TeamIdentifier=not set");
    expect(workflow).not.toContain("Import Developer ID certificate");
    expect(workflow).not.toContain("xcrun stapler validate");
    expect(workflow).not.toContain("APPLE_CERTIFICATE");
    expect(workflow).not.toContain("WINDOWS_CERTIFICATE");
    expect(workflow).not.toContain("Import Windows Authenticode certificate");
    expect(releaseScript).toContain('signingIdentity: "-"');
    expect(releaseScript).toContain('delete buildEnvironment[name]');
    expect(packageScript).toContain('signingIdentity: "-"');
    expect(macConfig.bundle.macOS.signingIdentity).toBe("-");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('$signature.Status -ne "NotSigned"');
    expect(workflow).toContain("createTauriUpdaterManifest.mjs");
    expect(workflow).toContain("createLegacyUpdateManifests.mjs");
    expect(workflow).toContain("releaseArtifacts.mjs");
    expect(workflow).toContain("Rion.Studio-mac.app.tar.gz.sig");
    expect(workflow).toContain("Rion.Studio-win.exe.sig");
    expect(workflow).toContain("upgrade-compatibility:");
    expect(workflow).toContain("Verify macOS manual replacement preserves shared data");
    expect(workflow).toContain("Verify Windows clean install and legacy in-place upgrade");
    expect(workflow).toContain('@("/S", "--updated", "--force-run", "/D=$installPath")');
    expect(workflow).toContain("rion-studio.sqlite3");
    expect(workflow).toContain("roles/legacy/browser/data.marker");
    expect(workflow.toLowerCase()).not.toContain("electron");
  });

  it("publishes verified assets before the public release handoff", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const buildIndex = workflow.indexOf("build-tauri-release:");
    const verifyIndex = workflow.indexOf("verify-and-upload-private-release:");
    const publishIndex = workflow.indexOf("publish-public-release:");

    expect(workflow).toContain("name: Private Tauri Release");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("uses: ./.github/workflows/tauri-release-candidate.yml");
    expect(workflow).toContain("tauri-release-assets-");
    expect(workflow).toContain("cmp release-assets/SHA256SUMS.txt");
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).not.toContain("--clobber");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(workflow.toLowerCase()).not.toContain("electron");
  });

  it("publishes source-free assets only after draft verification", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");
    const draftIndex = workflow.indexOf("gh release create");
    const uploadIndex = workflow.indexOf("gh release upload");
    const verifyIndex = workflow.indexOf("cmp release-assets/SHA256SUMS.txt");
    const publishIndex = workflow.indexOf("gh release edit");

    expect(draftIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(draftIndex);
    expect(verifyIndex).toBeGreaterThan(uploadIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(workflow).toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).not.toContain("--clobber");
  });

  it("restores latest only after validating the canonical artifact set", async () => {
    const workflow = await readWorkflow(".github/workflows/restore-public-latest.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("node scripts/releaseArtifacts.mjs rollback-assets");
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).toContain("gh release edit");
    expect(workflow).toContain("--latest");
  });
});

async function readWorkflow(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}
