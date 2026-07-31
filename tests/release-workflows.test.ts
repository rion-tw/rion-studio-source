import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri-only release workflows", () => {
  it("runs common checks and platform validation on macOS and Windows", async () => {
    const [
      workflow,
      packageJsonSource,
      windowsLoaderDiagnostic,
      tauriBuildScript,
      windowsManifest,
      windowsTestResource
    ] = await Promise.all([
      readWorkflow(".github/workflows/ci.yml"),
      readFile("package.json", "utf8"),
      readFile("scripts/diagnoseWindowsTestLoader.ps1", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/windows-app-manifest.xml", "utf8"),
      readFile("src-tauri/windows-test-manifest.rc", "utf8")
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
    expect(platformChecks).toContain("id: target_rust_tests");
    expect(platformChecks).toContain("./scripts/diagnoseWindowsTestLoader.ps1");
    expect(platformChecks).toContain("steps.target_rust_tests.outcome == 'failure'");
    expect(platformChecks).toContain("name: windows-rust-test-loader-");
    expect(platformChecks).toContain("path: diagnostics/windows-test-loader");
    expect(windowsLoaderDiagnostic).toContain('Filter "rion_studio_lib-*.exe"');
    expect(windowsLoaderDiagnostic).toContain("/imports $testBinary.FullName");
    expect(windowsLoaderDiagnostic).toContain("/dependents $testBinary.FullName");
    expect(windowsLoaderDiagnostic).toContain("/headers $testBinary.FullName");
    expect(windowsLoaderDiagnostic).toContain("Copy-Item -LiteralPath $pdbPath");
    expect(windowsLoaderDiagnostic).toContain('"import-probe.txt"');
    expect(windowsLoaderDiagnostic).toContain("NativeLibrary]::TryGetExport");
    expect(windowsLoaderDiagnostic).toContain('"application-manifest.xml"');
    expect(windowsLoaderDiagnostic).toContain("Common Controls v6 dependency");
    expect(tauriBuildScript).toContain(
      'embed_resource::compile_for_everything("windows-test-manifest.rc"'
    );
    expect(tauriBuildScript).toContain(".manifest_required()");
    expect(tauriBuildScript).toContain("WindowsAttributes::new_without_app_manifest()");
    expect(windowsManifest).toContain('name="Microsoft.Windows.Common-Controls"');
    expect(windowsManifest).toContain('version="6.0.0.0"');
    expect(windowsTestResource).toContain(
      'CREATEPROCESS_MANIFEST_RESOURCE_ID RT_MANIFEST "windows-app-manifest.xml"'
    );
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
    expect(platformChecks).toContain("cargo check -p rion-tauri --all-targets");
    expect(platformChecks).toContain(
      "shared-key: platform-tauri-${{ runner.os }}-${{ runner.arch }}"
    );
    expect(workflow).not.toContain("pnpm exec tauri build");
    expect(workflow).not.toContain("pnpm run dist");
    expect(workflow).not.toContain("test:native:");
    expect(workflow).not.toContain("attestation");
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith("test:native:")))
      .toBe(false);
    expect(workflow).toContain("rust-concurrency-sanitizer:");
    expect(workflow.toLowerCase()).not.toContain("electron");
    expect(workflow).not.toContain("Node-API");
  });

  it("keeps the owner-locked unsigned platform policy while updater artifacts stay verified", async () => {
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
    for (const platformSigningInput of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "WINDOWS_CERTIFICATE",
      "WINDOWS_CERTIFICATE_PASSWORD",
      "WINDOWS_TIMESTAMP_URL"
    ]) {
      expect(workflow).not.toContain(platformSigningInput);
    }
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
    expect(build).toContain(
      "shared-key: platform-tauri-${{ runner.os }}-${{ runner.arch }}"
    );
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain('grep -F "Signature=adhoc"');
    expect(workflow).toContain('grep -F "TeamIdentifier=not set"');
    expect(workflow).not.toContain("Import Apple Developer ID certificate");
    expect(workflow).not.toContain("xcrun stapler validate");
    expect(workflow).not.toContain("Import Windows Authenticode certificate");
    expect(releaseScript).toContain('signingIdentity: "-"');
    expect(releaseScript).toContain("delete buildEnvironment[name]");
    expect(releaseScript).not.toContain("releasePlatformBundle");
    expect(packageScript).toContain('signingIdentity: "-"');
    expect(packageScript).not.toContain("test:native:");
    expect(workflow).not.toContain("test:native:");
    expect(workflow).not.toContain("attestation");
    expect(macConfig.bundle.macOS.signingIdentity).toBe("-");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('$signature.Status -ne "NotSigned"');
    expect(workflow).not.toContain("WINDOWS_CERTIFICATE_THUMBPRINT");
    expect(workflow).toContain("createTauriUpdaterManifest.mjs");
    expect(workflow).not.toContain("createLegacyUpdateManifests.mjs");
    expect(workflow).toContain("releaseArtifacts.mjs");
    expect(workflow).toContain("Rion.Studio-mac.app.tar.gz.sig");
    expect(workflow).toContain("Rion.Studio-win.exe.sig");
    expect(workflow).toContain("upgrade-compatibility:");
    expect(workflow).toContain("Verify macOS manual replacement preserves shared data");
    expect(workflow).toContain("Verify Windows clean install and previous Tauri in-place upgrade");
    expect(workflow).toContain('@("/S", "--updated", "--force-run", "/D=$installPath")');
    expect(upgrade).toContain("timeout-minutes: 10");
    expect(upgrade).toContain("function Invoke-BoundedProcess");
    expect(upgrade).toContain("$process.WaitForExit($TimeoutSeconds * 1000)");
    expect(upgrade).toContain("$process.Kill($true)");
    expect(upgrade).toContain('[Environment]::GetFolderPath("ApplicationData")');
    expect(upgrade).not.toContain("Start-Process -FilePath $installer -ArgumentList");
    expect(upgrade).not.toContain("RION_STUDIO_USER_DATA_DIR");
    expect(workflow).toContain("rion-studio.sqlite3");
    expect(workflow).toContain("roles/upgrade/browser/data.marker");
    expect(workflow.toLowerCase()).not.toContain("electron");
  });

  it("publishes verified assets before the public release handoff", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const buildIndex = workflow.indexOf("build-tauri-release:");
    const verifyIndex = workflow.indexOf("verify-and-upload-private-release:");
    const publishIndex = workflow.indexOf("publish-public-release:");
    const build = workflow.slice(buildIndex, verifyIndex);
    const verify = workflow.slice(verifyIndex, publishIndex);

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
    for (const platformSigningInput of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "WINDOWS_CERTIFICATE",
      "WINDOWS_CERTIFICATE_PASSWORD",
      "WINDOWS_TIMESTAMP_URL"
    ]) {
      expect(build).not.toContain(platformSigningInput);
    }
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
    expect(verify).toContain(
      "node scripts/releaseArtifacts.mjs release-assets ${{ needs.resolve-release.outputs.release_version }} --verify-checksums"
    );
    expect(verify).not.toContain("--write-checksums");
    expect(workflow).not.toContain("--clobber");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(workflow.toLowerCase()).not.toContain("electron");
  });

  it("records the owner-locked platform signing decision for future agents", async () => {
    const [agentInstructions, agentContext] = await Promise.all([
      readWorkflow("AGENTS.md"),
      readWorkflow(".agents/context.md")
    ]);

    expect(agentInstructions).toContain("Release Distribution (Owner-Locked)");
    expect(agentInstructions).toContain("ad-hoc identity (`-`)");
    expect(agentInstructions).toContain("Windows installers remain Authenticode-unsigned");
    expect(agentInstructions).toContain("updater signing");
    expect(agentInstructions).toContain("owner explicitly changes this decision");
    expect(agentContext).toContain("owner-locked release decision live in `AGENTS.md`");
    expect(agentContext).toContain("`.agents/context/release.md`");
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
