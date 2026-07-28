import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri-only release workflows", () => {
  it("runs common checks and platform builds on macOS and Windows", async () => {
    const [workflow, packageJsonSource] = await Promise.all([
      readWorkflow(".github/workflows/ci.yml"),
      readFile("package.json", "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };
    const checks = workflow.slice(
      workflow.indexOf("  checks:"),
      workflow.indexOf("  rust-concurrency-sanitizer:")
    );
    const platformChecks = workflow.slice(workflow.indexOf("  platform-build:"));

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("pnpm run verify:system-only");
    expect(workflow).toContain("pnpm run typecheck");
    expect(workflow).toContain("pnpm run test");
    expect(workflow).toContain("pnpm run lint");
    expect(checks).toContain("pnpm run lint:rust:portable");
    expect(checks).toContain("pnpm run test:rust:portable");
    expect(checks).toContain("pnpm run build:renderer");
    expect(checks).not.toContain("Install Linux Tauri build dependencies");
    expect(checks).not.toContain("run: pnpm run lint:rust\n");
    expect(checks).not.toContain("run: pnpm run test:rust\n");
    expect(checks).not.toContain("run: pnpm run build\n");
    expect(platformChecks).toContain("pnpm run lint:rust");
    expect(platformChecks).toContain("pnpm run test:rust");
    expect(platformChecks.indexOf("pnpm run build:renderer"))
      .toBeLessThan(platformChecks.indexOf("pnpm run lint:rust"));
    expect(packageJson.scripts["lint:rust:portable"]).toBe(
      "cargo fmt --all -- --check && cargo clippy -p rion-core -p rion-platform --all-targets --no-deps -- -D warnings"
    );
    expect(packageJson.scripts["test:rust:portable"]).toBe(
      "cargo test -p rion-core -p rion-platform --all-targets"
    );
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("os: windows-latest");
    expect(platformChecks).toContain("pnpm exec tauri build --bundles");
    expect(workflow).not.toContain("test:native:");
    expect(workflow).not.toContain("attestation");
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith("test:native:")))
      .toBe(false);
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
    const quality = workflow.slice(
      workflow.indexOf("  quality:"),
      workflow.indexOf("  build:")
    );
    const validate = workflow.slice(
      workflow.indexOf("  validate:"),
      workflow.indexOf("  quality:")
    );
    const build = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  manifest:")
    );
    const manifest = workflow.slice(
      workflow.indexOf("  manifest:"),
      workflow.indexOf("  upgrade-compatibility:")
    );
    const upgrade = workflow.slice(
      workflow.indexOf("  upgrade-compatibility:"),
      workflow.indexOf("  release-ready:")
    );
    const releaseReady = workflow.slice(workflow.indexOf("  release-ready:"));

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("verified_sha:");
    expect(workflow).toContain(
      "value: ${{ jobs.manifest.outputs.release_artifact_name }}"
    );
    expect(workflow).toContain('[[ "${VERIFIED_SHA}" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${VERIFIED_SHA}"');
    expect(validate).toContain("require_secret RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(validate).toContain("require_secret TAURI_SIGNING_PRIVATE_KEY");
    expect(validate).toContain("require_secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(validate.indexOf("require_secret RION_STUDIO_UPDATER_PUBLIC_KEY"))
      .toBeLessThan(validate.indexOf('[[ "${RELEASE_TAG}"'));
    expect(quality).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(quality).toContain("uses: ./.github/workflows/ci.yml");
    expect(build).toContain("always() &&");
    expect(build).toContain("needs.validate.result == 'success'");
    expect(build).toContain("needs.quality.result == 'success'");
    expect(build).toContain("needs.quality.result == 'skipped'");
    expect(build).not.toContain("pnpm run verify:system-only");
    expect(build).not.toContain("pnpm run test");
    expect(build).not.toContain("pnpm run lint");
    expect(manifest).toContain("always() &&");
    expect(manifest).toContain("needs.build.result == 'success'");
    expect(manifest).toContain("release_artifact_name: ${{ steps.artifact.outputs.name }}");
    expect(upgrade).toContain("always() &&");
    expect(upgrade).toContain("needs.manifest.result == 'success'");
    expect(upgrade).toContain("needs.manifest.outputs.release_artifact_name");
    expect(releaseReady).toContain("if: always()");
    expect(releaseReady).toContain(
      '[[ "${QUALITY_RESULT}" == "success" || "${QUALITY_RESULT}" == "skipped" ]]'
    );
    expect(releaseReady).toContain('test "${BUILD_RESULT}" = "success"');
    expect(releaseReady).toContain('test "${MANIFEST_RESULT}" = "success"');
    expect(releaseReady).toContain('test "${UPGRADE_RESULT}" = "success"');
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(workflow).toContain("pnpm run release:version -- ${{ needs.validate.outputs.version }}");
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
    expect(packageScript).not.toContain("test:native:");
    expect(workflow).not.toContain("test:native:");
    expect(workflow).not.toContain("attestation");
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
    const build = workflow.slice(buildIndex, verifyIndex);

    expect(workflow).toContain("name: Private Tauri Release");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("uses: ./.github/workflows/tauri-release-candidate.yml");
    expect(workflow).toContain(
      "verified_sha: ${{ needs.validate-ci-run.outputs.source_ref }}"
    );
    expect(build).toContain(
      "RION_STUDIO_UPDATER_PUBLIC_KEY: ${{ secrets.RION_STUDIO_UPDATER_PUBLIC_KEY }}"
    );
    expect(build).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
    );
    expect(build).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}"
    );
    expect(build).toContain("- validate-ci-run");
    expect(build).toContain("- resolve-release");
    expect(workflow).toContain("tauri-release-assets-");
    expect(workflow).toContain(
      "name: ${{ needs.build-tauri-release.outputs.release_artifact_name }}"
    );
    expect(workflow).toContain(
      'run: test "${ARTIFACT_NAME}" = "tauri-release-assets-${VERSION}"'
    );
    expect(workflow).not.toContain(
      "name: tauri-release-assets-${{ needs.resolve-release.outputs.release_version }}"
    );
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
