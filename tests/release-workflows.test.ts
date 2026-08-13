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
    expect(workflow).toContain("pull_request:");
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
    expect(platformChecks).toContain(
      "- name: Install dependencies\n" +
      "        run: pnpm install --frozen-lockfile"
    );
    expect(platformChecks.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      platformChecks.indexOf("Test renderer behavior on Windows")
    );
    expect(platformChecks).toContain("id: target_rust_tests");
    expect(platformChecks).toContain("./scripts/diagnoseWindowsTestLoader.ps1");
    expect(platformChecks).toContain("steps.target_rust_tests.outcome == 'failure'");
    expect(platformChecks).toContain("name: windows-rust-test-loader-");
    expect(platformChecks).toContain("path: diagnostics/windows-test-loader");
    expect(platformChecks).toContain("id: desktop_smoke");
    expect(platformChecks).toContain("pnpm run test:e2e:desktop:smoke");
    expect(platformChecks).toContain("if: github.event_name == 'pull_request'");
    expect(platformChecks).toContain("id: desktop_e2e");
    expect(platformChecks).toContain("continue-on-error: true");
    expect(platformChecks).toContain("timeout-minutes: 75");
    expect(platformChecks).toContain("pnpm run test:e2e:desktop:full");
    expect(platformChecks).toContain("include-hidden-files: true");
    expect(platformChecks).toContain("path: .desktop-e2e-artifacts");
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

  it("keeps extended desktop E2E on immutable hardware-runner evidence", async () => {
    const [workflow, runner, wdio] = await Promise.all([
      readWorkflow(".github/workflows/desktop-e2e-extended.yml"),
      readWorkflow("scripts/runDesktopE2e.mjs"),
      readWorkflow("e2e/desktop/wdio.conf.ts")
    ]);
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("runs-on: [self-hosted, Windows, X64, rion-desktop-e2e]");
    expect(workflow).toContain("runs-on: [self-hosted, macOS, ARM64, rion-desktop-e2e]");
    expect(workflow).toContain("Extended E2E ref must be a full immutable Git SHA");
    expect(workflow).toContain("RION_STUDIO_E2E_COMMIT: ${{ inputs.ref || github.sha }}");
    expect(workflow).toContain("pnpm run test:e2e:desktop:extended");
    expect(workflow.match(/timeout-minutes: 120/gu)).toHaveLength(2);
    expect(workflow.match(/include-hidden-files: true/gu)).toHaveLength(2);
    expect(workflow.match(/path: \.desktop-e2e-artifacts/gu)).toHaveLength(2);
    expect(workflow).toContain("if: always()");
    expect(workflow).not.toContain("continue-on-error: true");
    expect(runner).toContain(
      "if (blocked || (result.code !== 0 && !forcedTermination && !cleanShutdown))"
    );
    expect(wdio).toContain("connectionRetryCount: 0");
  });

  it("keeps the owner-locked unsigned platform policy while updater artifacts stay verified", async () => {
    const [
      buildWorkflow,
      compatibilityWorkflow,
      candidateWorkflow,
      releaseScript,
      packageScript,
      macConfigSource,
      releasePlanScript
    ] = await Promise.all([
      readWorkflow(".github/workflows/tauri-release-build.yml"),
      readWorkflow(".github/workflows/tauri-release-compatibility.yml"),
      readWorkflow(".github/workflows/tauri-release-candidate.yml"),
      readWorkflow("scripts/buildTauriRelease.mjs"),
      readWorkflow("scripts/packageTauri.mjs"),
      readWorkflow("src-tauri/tauri.macos.conf.json"),
      readWorkflow("scripts/planSemanticRelease.mjs")
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
    expect(buildWorkflow).toContain("source_ref:");
    expect(buildWorkflow).toContain("version:");
    expect(buildWorkflow).not.toContain("verified_sha:");
    expect(buildWorkflow).not.toContain("inputs.tag");
    expect(buildWorkflow).toContain("run_quality:");
    expect(buildWorkflow).toContain(
      "value: ${{ jobs.manifest.outputs.release_artifact_name }}"
    );
    expect(buildWorkflow).toContain(
      "value: ${{ jobs.validate.outputs.version }}"
    );
    expect(buildWorkflow).toContain('[[ "${SOURCE_REF}" =~ ^[0-9a-f]{40}$ ]]');
    expect(buildWorkflow).toContain('[[ "${RELEASE_VERSION}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+');
    expect(buildWorkflow).toContain('test "$(git rev-parse HEAD)" = "${SOURCE_REF}"');
    expect(buildWorkflow).not.toContain("git describe --tags --exact-match HEAD");
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
      .toBeLessThan(validate.indexOf('[[ "${SOURCE_REF}"'));
    expect(quality).toContain("if: inputs.run_quality");
    expect(quality).toContain("uses: ./.github/workflows/ci.yml");
    expect(quality).toContain("ref: ${{ inputs.source_ref }}");
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
    expect(candidateWorkflow).toContain("  resolve:");
    expect(candidateWorkflow).toContain("source_ref: ${{ needs.resolve.outputs.source_ref }}");
    expect(candidateWorkflow).toContain("version: ${{ needs.resolve.outputs.version }}");
    expect(candidateWorkflow).toContain('test "$(git describe --tags --exact-match HEAD)" = "${RELEASE_TAG}"');
    expect(candidateWorkflow).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(candidateWorkflow).toContain("uses: ./.github/workflows/desktop-e2e-extended.yml");
    expect(candidateWorkflow).toContain("uses: ./.github/workflows/tauri-release-compatibility.yml");
    expect(candidateWorkflow).toContain(
      "run_quality: ${{ github.event_name == 'workflow_dispatch' }}"
    );
    expect(buildWorkflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(buildWorkflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(buildWorkflow).toContain("pnpm run release:version -- ${{ needs.validate.outputs.version }}");
    expect(buildWorkflow).toContain("pnpm run dist -- --bundles");
    expect(buildWorkflow).toContain("Start release build timing");
    expect(buildWorkflow).toContain("Publish release build timing summary");
    expect(buildWorkflow).toContain("RELEASE_PACKAGE_SECONDS");
    expect(buildWorkflow).toContain("compression-level: 0");
    expect(build).not.toContain("fetch-depth: 0");
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
    expect(compatibilityWorkflow).toContain(
      "New-Item -ItemType Directory -Force -Path $userData | Out-Null"
    );
    expect(compatibilityWorkflow).toContain("The in-place upgrade modified the SQLite store.");
    expect(compatibilityWorkflow).toContain("roles/upgrade/browser/data.marker");
    expect(releasePlanScript).toContain("dryRun: true");
    expect(releasePlanScript).toContain('repositoryUrl: "."');
    expect(releasePlanScript).toContain("@semantic-release/commit-analyzer");
    expect(releasePlanScript).toContain('git("branch", "--show-current") !== "main"');
    expect(releasePlanScript).toContain('git("branch", "--force", "main", sourceSha)');
    expect(releasePlanScript).toContain("has_release: Boolean(releaseVersion)");
    expect(buildWorkflow.toLowerCase()).not.toContain("electron");
    expect(compatibilityWorkflow.toLowerCase()).not.toContain("electron");
  });

  it("validates the candidate before creating a resumable semantic draft", async () => {
    const [workflow, preflightWorkflow, compatibilityWorkflow, finalizeWorkflow, resumeWorkflow, config] = await Promise.all([
      readWorkflow(".github/workflows/release.yml"),
      readWorkflow(".github/workflows/tauri-release-preflight.yml"),
      readWorkflow(".github/workflows/tauri-release-compatibility.yml"),
      readWorkflow(".github/workflows/finalize-private-release.yml"),
      readWorkflow(".github/workflows/resume-release.yml"),
      readWorkflow("release.config.mjs")
    ]);
    const awaitIndex = workflow.indexOf("await-preflight:");
    const stageIndex = workflow.indexOf("stage-preflight-release:");
    const compatibilityIndex = workflow.indexOf("verify-upgrade-compatibility:");
    const semanticIndex = workflow.indexOf("semantic-release:");
    const finalizeIndex = workflow.indexOf("finalize-release:");
    const awaitPreflight = workflow.slice(awaitIndex, semanticIndex);
    const stage = workflow.slice(stageIndex, compatibilityIndex);
    const compatibility = workflow.slice(compatibilityIndex, semanticIndex);
    const semantic = workflow.slice(semanticIndex, finalizeIndex);
    const finalize = workflow.slice(finalizeIndex);

    expect(workflow).toContain("name: Private Tauri Release");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("uses: ./.github/workflows/tauri-release-compatibility.yml");
    expect(workflow).not.toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(awaitPreflight).toContain("needs: validate-ci-run");
    expect(awaitPreflight).toContain("timeout-minutes: 60");
    expect(awaitPreflight).toContain("actions: write");
    expect(awaitPreflight).toContain('workflow_file="tauri-release-preflight.yml"');
    expect(awaitPreflight).toContain("wait_for_preflight push ''");
    expect(awaitPreflight).toContain("gh workflow run");
    expect(awaitPreflight).toContain("current_has_release");
    expect(awaitPreflight).toContain("release_version");
    expect(semantic).toContain("- await-preflight");
    expect(semantic).toContain("- verify-upgrade-compatibility");
    expect(semantic).toContain("ref: ${{ needs.await-preflight.outputs.source_ref }}");
    expect(semantic).toContain("Create semantic private draft");
    expect(config).toContain("draftRelease: true");
    expect(stage).toContain("Checkout verified source");
    expect(stage).toContain("ref: ${{ needs.await-preflight.outputs.source_ref }}");
    expect(stage).toContain('gh run download "${PREFLIGHT_RUN_ID}"');
    expect(stage).toContain("Stage verified release assets for release checks");
    expect(stage).toContain("node scripts/releaseArtifacts.mjs release-assets");
    expect(workflow).toContain("tauri-release-assets-");
    expect(workflow).toContain(
      "name: ${{ needs.await-preflight.outputs.release_artifact_name }}"
    );
    expect(compatibility).toContain("- await-preflight");
    expect(compatibility).toContain("- stage-preflight-release");
    expect(compatibility).toContain("source_ref: ${{ needs.await-preflight.outputs.source_ref }}");
    expect(compatibility).toContain(
      "release_artifact_name: ${{ needs.await-preflight.outputs.release_artifact_name }}"
    );
    expect(finalize).toContain("uses: ./.github/workflows/finalize-private-release.yml");
    expect(finalizeWorkflow).toContain("verify-and-upload-private-release:");
    expect(finalizeWorkflow).toContain("publish-public-release:");
    expect(finalizeWorkflow).toContain("finalize-private-release:");
    expect(finalizeWorkflow).toContain("--draft=false --latest=false");
    expect(finalizeWorkflow).toContain("cmp release-assets/SHA256SUMS.txt");
    expect(finalizeWorkflow).toContain("--verify-checksums");
    expect(compatibilityWorkflow).toContain("source_ref:");
    expect(compatibilityWorkflow).not.toContain("inputs.tag");
    expect(resumeWorkflow).toContain("workflow_dispatch:");
    expect(resumeWorkflow).toContain("actions: read");
    expect(resumeWorkflow).toContain("git merge-base --is-ancestor");
    expect(resumeWorkflow).toContain("Checkout immutable release source");
    expect(resumeWorkflow).toContain("run_quality: true");
    expect(resumeWorkflow).toContain("uses: ./.github/workflows/finalize-private-release.yml");
    expect(workflow).not.toContain("--clobber");
    expect(awaitIndex).toBeGreaterThan(-1);
    expect(stageIndex).toBeGreaterThan(awaitIndex);
    expect(compatibilityIndex).toBeGreaterThan(stageIndex);
    expect(semanticIndex).toBeGreaterThan(compatibilityIndex);
    expect(finalizeIndex).toBeGreaterThan(semanticIndex);
    expect(workflow.toLowerCase()).not.toContain("electron");

    expect(preflightWorkflow).toContain("name: Tauri Release Preflight");
    expect(preflightWorkflow).toContain("run-name: Tauri Release Preflight");
    expect(preflightWorkflow).toContain("  push:");
    expect(preflightWorkflow).toContain("      - main");
    expect(preflightWorkflow).toContain("workflow_dispatch:");
    expect(preflightWorkflow).toContain("source_ref:");
    expect(preflightWorkflow).toContain("pnpm run release:plan > release-plan.json");
    expect(preflightWorkflow).toContain("has_release=$(jq -r '.has_release' release-plan.json)");
    expect(preflightWorkflow).toContain("if: needs.plan-release.outputs.has_release == 'true'");
    expect(preflightWorkflow).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(preflightWorkflow).toContain("uses: ./.github/workflows/desktop-e2e-extended.yml");
    expect(preflightWorkflow).toContain("source_ref: ${{ needs.plan-release.outputs.source_ref }}");
    expect(preflightWorkflow).toContain("version: ${{ needs.plan-release.outputs.release_version }}");
    expect(preflightWorkflow).toContain("release-preflight-${{ needs.plan-release.outputs.source_ref }}");
    expect(preflightWorkflow).toContain("build_result");
    expect(preflightWorkflow).toContain("desktop_e2e_result");
    expect(preflightWorkflow).toContain("has_release: $has_release");
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
    const documentationIndex = workflow.indexOf("Sync public documentation from the released source");
    const summaryIndex = workflow.indexOf("Record public release summary");

    expect(draftIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(draftIndex);
    expect(verifyIndex).toBeGreaterThan(uploadIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
    expect(documentationIndex).toBeGreaterThan(publishIndex);
    expect(summaryIndex).toBeGreaterThan(documentationIndex);
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).toContain("group: public-release-rion-studio");
    expect(workflow).toContain("node scripts/syncPublicRepositoryDocs.mjs");
    expect(workflow).toContain('--repository "${PUBLIC_RELEASE_REPOSITORY}"');
    expect(workflow).toContain('--tag "${TAG}"');
    expect(workflow).toContain("GH_TOKEN: ${{ steps.public-token.outputs.token }}");
    expect(workflow).not.toContain("--clobber");
  });

  it("updates public documents atomically and verifies the resulting managed tree", async () => {
    const script = await readWorkflow("scripts/syncPublicRepositoryDocs.mjs");

    expect(script).toContain('api.request("releases/latest")');
    expect(script).toContain('api.request("git/blobs"');
    expect(script).toContain('api.request("git/trees"');
    expect(script).toContain('api.request("git/commits"');
    expect(script).toContain('body: { sha: createdCommit.sha, force: false }');
    expect(script).toContain("assertPublicDocumentsMatch(desiredEntries, updated.tree)");
    expect(script).toContain('sourcePath: "docs/public-repository/CONTRIBUTING.md"');
    expect(script).toContain('targetPath: ".github/CONTRIBUTING.md"');
    expect(script).not.toContain("releases/**");
    expect(script).not.toContain("ISSUE_TEMPLATE");
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
