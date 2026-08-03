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
      workflow.indexOf("  renderer-assets:")
    );
    const rendererAssets = workflow.slice(
      workflow.indexOf("  renderer-assets:"),
      workflow.indexOf("  rust-concurrency-sanitizer:")
    );
    const sanitizer = workflow.slice(
      workflow.indexOf("  rust-concurrency-sanitizer:"),
      workflow.indexOf("  platform-build:")
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
    expect(checks).not.toContain("needs:");
    expect(checks).not.toContain("pnpm run build:renderer");
    expect(checks).not.toContain("renderer-assets-");
    expect(checks).not.toContain("Install Linux Tauri build dependencies");
    expect(checks).not.toContain("run: pnpm run lint:rust\n");
    expect(checks).not.toContain("run: pnpm run test:rust\n");
    expect(checks).not.toContain("run: pnpm run build\n");
    expect(rendererAssets).toContain("pnpm install --frozen-lockfile");
    expect(rendererAssets).toContain("pnpm run build:renderer");
    expect(rendererAssets).toContain(
      "name: renderer-assets-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(rendererAssets).toContain("path: out/renderer");
    expect(rendererAssets).not.toContain("needs:");
    expect(sanitizer).not.toContain("needs:");
    expect(platformChecks).toContain("pnpm run lint:rust");
    expect(platformChecks).toContain("pnpm run test:rust");
    expect(platformChecks).toContain("actions/download-artifact@");
    expect(platformChecks).toContain(
      "name: renderer-assets-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(platformChecks).not.toContain("pnpm run build:renderer");
    expect(platformChecks).not.toContain("pnpm install --frozen-lockfile");
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
    expect(rendererAssets.indexOf("pnpm run build:renderer")).toBeLessThan(
      rendererAssets.indexOf("Upload renderer assets for platform checks")
    );
    expect(platformChecks).toContain("needs: renderer-assets");
    expect(platformChecks).not.toContain("needs: checks");
    expect(platformChecks.indexOf("Download renderer assets for platform checks")).toBeLessThan(
      platformChecks.indexOf("pnpm run lint:rust")
    );
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
    const [buildWorkflow, compatibilityWorkflow, candidateWorkflow, releaseScript, packageScript, macConfigSource] = await Promise.all([
      readWorkflow(".github/workflows/tauri-release-build.yml"),
      readWorkflow(".github/workflows/tauri-release-compatibility.yml"),
      readWorkflow(".github/workflows/tauri-release-candidate.yml"),
      readWorkflow("scripts/buildTauriRelease.mjs"),
      readWorkflow("scripts/packageTauri.mjs"),
      readWorkflow("src-tauri/tauri.macos.conf.json")
    ]);
    const macConfig = JSON.parse(macConfigSource);
    const quality = buildWorkflow.slice(
      buildWorkflow.indexOf("  quality:"),
      buildWorkflow.indexOf("  build:")
    );
    const validate = buildWorkflow.slice(
      buildWorkflow.indexOf("  validate:"),
      buildWorkflow.indexOf("  quality:")
    );
    const build = buildWorkflow.slice(
      buildWorkflow.indexOf("  build:"),
      buildWorkflow.indexOf("  manifest:")
    );
    const compatibility = compatibilityWorkflow.slice(
      compatibilityWorkflow.indexOf("  upgrade-compatibility:"),
      compatibilityWorkflow.indexOf("  release-ready:")
    );
    const releaseReady = compatibilityWorkflow.slice(
      compatibilityWorkflow.indexOf("  release-ready:")
    );

    expect(buildWorkflow).toContain("workflow_call:");
    expect(buildWorkflow).toContain("verified_sha:");
    expect(buildWorkflow).toContain("required: false");
    expect(buildWorkflow).toContain("run_quality:");
    expect(buildWorkflow).toContain(
      "value: ${{ jobs.manifest.outputs.release_artifact_name }}"
    );
    expect(buildWorkflow).toContain(
      "value: ${{ jobs.validate.outputs.version }}"
    );
    expect(buildWorkflow).toContain('[[ "${VERIFIED_SHA}" =~ ^[0-9a-f]{40}$ ]]');
    expect(buildWorkflow).toContain('test "$(git rev-parse HEAD)" = "${VERIFIED_SHA}"');
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
      expect(buildWorkflow).not.toContain(platformSigningInput);
    }
    expect(validate.indexOf("require_secret RION_STUDIO_UPDATER_PUBLIC_KEY"))
      .toBeLessThan(validate.indexOf('[[ "${RELEASE_TAG}"'));
    expect(quality).toContain("if: inputs.run_quality");
    expect(quality).toContain("uses: ./.github/workflows/ci.yml");
    expect(build).toContain("always() &&");
    expect(build).toContain("needs.validate.result == 'success'");
    expect(build).toContain("needs.quality.result == 'success'");
    expect(build).toContain("needs.quality.result == 'skipped'");
    expect(build).not.toContain("pnpm run verify:system-only");
    expect(build).not.toContain("pnpm run test");
    expect(build).not.toContain("pnpm run lint");
    expect(buildWorkflow).toContain("  manifest:");
    expect(buildWorkflow).toContain("needs.build.result == 'success'");
    expect(buildWorkflow).toContain("release_artifact_name: ${{ steps.artifact.outputs.name }}");
    expect(compatibilityWorkflow).toContain("workflow_call:");
    expect(compatibilityWorkflow).toContain("release_artifact_name:");
    expect(compatibilityWorkflow).toContain("name: ${{ inputs.release_artifact_name }}");
    expect(compatibility).toContain("timeout-minutes: 10");
    expect(compatibilityWorkflow).toContain("PUBLIC_RELEASE_REPOSITORY: rion-tw/rion-studio");
    expect(compatibility).toContain("Verify macOS manual replacement preserves shared data");
    expect(compatibility).toContain("Verify Windows clean install and previous Tauri in-place upgrade");
    expect(compatibility).toContain('@("/S", "--updated", "/D=$installPath")');
    expect(compatibility).not.toContain("--force-run");
    expect(compatibility).not.toContain("Start-Process -FilePath $previousExecutable");
    expect(compatibility).not.toContain("Get-CimInstance Win32_Process");
    expect(compatibility).toContain(
      'gh release download --repo "${PUBLIC_RELEASE_REPOSITORY}" --pattern Rion.Studio-mac.dmg'
    );
    expect(compatibility).toContain(
      "gh release download --repo $env:PUBLIC_RELEASE_REPOSITORY --pattern Rion.Studio-win.exe"
    );
    expect(compatibility).not.toContain(
      'gh release download --repo "${GITHUB_REPOSITORY}" --pattern Rion.Studio-mac.dmg'
    );
    expect(compatibility).not.toContain(
      "gh release download --repo $env:GITHUB_REPOSITORY --pattern Rion.Studio-win.exe"
    );
    expect(compatibility).toContain("function Invoke-BoundedProcess");
    expect(compatibility).toContain("$process.WaitForExit($TimeoutSeconds * 1000)");
    expect(compatibility).toContain("$process.Kill($true)");
    expect(compatibility).toContain('[Environment]::GetFolderPath("ApplicationData")');
    expect(compatibility).not.toContain("Start-Process -FilePath $installer -ArgumentList");
    expect(compatibility).not.toContain("RION_STUDIO_USER_DATA_DIR");
    expect(releaseReady).toContain("if: always()");
    expect(releaseReady).toContain('test "${UPGRADE_RESULT}" = "success"');
    expect(candidateWorkflow).toContain("workflow_call:");
    expect(candidateWorkflow).toContain("workflow_dispatch:");
    expect(candidateWorkflow).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(candidateWorkflow).toContain("uses: ./.github/workflows/tauri-release-compatibility.yml");
    expect(candidateWorkflow).toContain(
      "run_quality: ${{ github.event_name == 'workflow_dispatch' }}"
    );
    expect(buildWorkflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(buildWorkflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(buildWorkflow).toContain("pnpm run release:version -- ${{ needs.validate.outputs.version }}");
    expect(buildWorkflow).toContain("pnpm run dist -- --bundles");
    expect(build).toContain(
      "shared-key: platform-tauri-${{ runner.os }}-${{ runner.arch }}"
    );
    expect(buildWorkflow).toContain("codesign --verify --deep --strict");
    expect(buildWorkflow).toContain('grep -F "Signature=adhoc"');
    expect(buildWorkflow).toContain('grep -F "TeamIdentifier=not set"');
    expect(buildWorkflow).not.toContain("Import Apple Developer ID certificate");
    expect(buildWorkflow).not.toContain("xcrun stapler validate");
    expect(buildWorkflow).not.toContain("Import Windows Authenticode certificate");
    expect(releaseScript).toContain('signingIdentity: "-"');
    expect(releaseScript).toContain("delete buildEnvironment[name]");
    expect(releaseScript).not.toContain("releasePlatformBundle");
    expect(packageScript).toContain('signingIdentity: "-"');
    expect(packageScript).not.toContain("test:native:");
    expect(buildWorkflow).not.toContain("test:native:");
    expect(buildWorkflow).not.toContain("attestation");
    expect(macConfig.bundle.macOS.signingIdentity).toBe("-");
    expect(buildWorkflow).toContain("Get-AuthenticodeSignature");
    expect(buildWorkflow).toContain('$signature.Status -ne "NotSigned"');
    expect(buildWorkflow).not.toContain("WINDOWS_CERTIFICATE_THUMBPRINT");
    expect(buildWorkflow).toContain("createTauriUpdaterManifest.mjs");
    expect(buildWorkflow).not.toContain("createLegacyUpdateManifests.mjs");
    expect(buildWorkflow).toContain("releaseArtifacts.mjs");
    expect(buildWorkflow).toContain("Rion.Studio-mac.app.tar.gz.sig");
    expect(buildWorkflow).toContain("Rion.Studio-win.exe.sig");
    expect(build).toContain("pnpm run check:release-size -- candidate");
    expect(build.indexOf("Normalize release assets"))
      .toBeLessThan(build.indexOf("Verify release size budgets"));
    expect(build.indexOf("Verify release size budgets"))
      .toBeLessThan(build.indexOf("Upload verified platform candidate"));
    expect(compatibilityWorkflow).toContain("rion-studio.sqlite3");
    expect(compatibilityWorkflow).toContain("preserve-sqlite-store");
    expect(compatibilityWorkflow).toContain("The in-place upgrade modified the SQLite store.");
    expect(compatibilityWorkflow).toContain("roles/upgrade/browser/data.marker");
    expect(buildWorkflow.toLowerCase()).not.toContain("electron");
    expect(compatibilityWorkflow.toLowerCase()).not.toContain("electron");
  });

  it("publishes verified assets before the public release handoff", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const buildIndex = workflow.indexOf("build-tauri-release:");
    const verifyIndex = workflow.indexOf("verify-and-upload-private-release:");
    const compatibilityIndex = workflow.indexOf("verify-upgrade-compatibility:");
    const publishIndex = workflow.indexOf("publish-public-release:");
    const build = workflow.slice(buildIndex, verifyIndex);
    const verify = workflow.slice(verifyIndex, compatibilityIndex);
    const compatibility = workflow.slice(compatibilityIndex, publishIndex);
    const publish = workflow.slice(publishIndex);

    expect(workflow).toContain("name: Private Tauri Release");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(workflow).toContain("uses: ./.github/workflows/tauri-release-compatibility.yml");
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
    expect(verify).not.toContain("verify-upgrade-compatibility");
    expect(compatibility).toContain("- resolve-release");
    expect(compatibility).toContain("- build-tauri-release");
    expect(compatibility).toContain(
      "release_artifact_name: ${{ needs.build-tauri-release.outputs.release_artifact_name }}"
    );
    expect(publish).toContain("- verify-and-upload-private-release");
    expect(publish).toContain("- verify-upgrade-compatibility");
    expect(workflow).not.toContain("--clobber");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    expect(compatibilityIndex).toBeGreaterThan(buildIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(publishIndex).toBeGreaterThan(compatibilityIndex);
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
