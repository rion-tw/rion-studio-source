import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop shell migration workflows", () => {
  it("runs Tauri compatibility, Electron packaging, and desktop E2E on both platforms", async () => {
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
      workflow.indexOf("  platform-validation:")
    );
    const platformChecks = workflow.slice(
      workflow.indexOf("  platform-validation:"),
      workflow.indexOf("  electron-platform-validation:")
    );
    const electronChecks = workflow.slice(
      workflow.indexOf("  electron-platform-validation:"),
      workflow.indexOf("  desktop-e2e:")
    );
    const desktopE2e = workflow.slice(workflow.indexOf("  desktop-e2e:"));

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain(
      "group: ci-${{ github.workflow }}-${{ inputs.ref || github.ref }}"
    );
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
    expect(platformChecks).not.toContain("id: desktop_smoke");
    expect(platformChecks).not.toContain("pnpm run test:e2e:desktop:");
    expect(electronChecks).toContain("Electron Chromium package validation");
    expect(electronChecks).toContain("pnpm run package:electron:mac");
    expect(electronChecks).toContain("pnpm run package:electron:win");
    expect(electronChecks).toContain("Prepare ephemeral Electron updater trust fixture");
    expect(electronChecks).toContain("pnpm run prepare:electron-updater:ci");
    expect(electronChecks).toContain(
      "Apply and verify ephemeral Electron updater fixture version"
    );
    expect(electronChecks).toContain(
      'pnpm run release:version -- "${RION_STUDIO_ELECTRON_PACKAGE_VERSION}"'
    );
    expect(electronChecks.indexOf("pnpm run prepare:electron-updater:ci"))
      .toBeLessThan(electronChecks.indexOf("pnpm run release:version"));
    expect(electronChecks.indexOf("pnpm run release:version"))
      .toBeLessThan(electronChecks.indexOf("pnpm run package:electron:mac"));
    expect(electronChecks.indexOf("pnpm run release:version"))
      .toBeLessThan(electronChecks.indexOf("pnpm run package:electron:win"));
    expect(electronChecks.indexOf("pnpm run release:version"))
      .toBeLessThan(electronChecks.indexOf("pnpm run verify:electron-runtime"));
    expect(electronChecks).toContain(
      "pnpm run build:electron-updater:previous-fixtures"
    );
    expect(electronChecks).toContain(
      "Verify packaged macOS Rust-owned updater transaction"
    );
    expect(electronChecks).toContain(
      "Verify packaged Windows Rust-owned updater transactions"
    );
    expect(electronChecks.match(/test:electron-updater:packaged/gu))
      .toHaveLength(2);
    expect(electronChecks).not.toContain("pnpm run package:electron:dir");
    expect(electronChecks).toContain("pnpm run verify:electron-package");
    expect(electronChecks).toContain(
      'release/electron/mac-arm64/Rion Studio.app'
    );
    expect(electronChecks).toContain("release/electron/win-unpacked");
    expect(electronChecks).not.toContain("without launching it");
    expect(electronChecks).toContain(
      "Verify exact Electron, Chromium, Rust Core, and AppKit ABI runtime"
    );
    expect(electronChecks).toContain("pnpm run verify:electron-runtime");
    expect(electronChecks).toContain("Verify macOS Electron distribution payloads");
    expect(electronChecks).toContain("hdiutil verify");
    expect(electronChecks).toContain("test ! -e release/electron/Rion.Studio-mac.dmg.blockmap");
    expect(electronChecks).toContain("Verify Windows Electron distribution payload");
    expect(electronChecks).toContain('Get-AuthenticodeSignature -LiteralPath $installer');
    expect(electronChecks).toContain("Windows Electron installer must remain Authenticode-unsigned");
    expect(electronChecks).toContain("Run macOS AppKit Chromium shell E2E");
    expect(electronChecks).toContain(
      "pnpm run test:e2e:desktop:chromium:macos-appkit"
    );
    expect(electronChecks).toContain("Run Windows Chromium shell E2E");
    expect(electronChecks).toContain(
      "pnpm run test:e2e:desktop:chromium:windows"
    );
    expect(electronChecks.match(/timeout-minutes: 90/gu)).toHaveLength(2);
    expect(electronChecks).toContain("Upload Chromium shell E2E diagnostics");
    expect(electronChecks).toContain(
      "Run packaged macOS AppKit Chromium Role black-box E2E"
    );
    expect(electronChecks).toContain(
      "Run packaged Windows Chromium Role black-box E2E"
    );
    expect(electronChecks.match(/runWindowsIsolatedProfile\.ps1/gu))
      .toHaveLength(2);
    expect(electronChecks.match(/runner\.environment == 'github-hosted'/gu))
      .toHaveLength(3);
    expect(electronChecks).not.toContain("APPDATA:");
    expect(electronChecks).not.toContain("LOCALAPPDATA:");
    expect(electronChecks).toContain(
      "pnpm run test:e2e:desktop:electron:packaged"
    );
    expect(electronChecks).toContain(
      "Upload packaged Chromium Role black-box E2E diagnostics"
    );
    expect(desktopE2e).toContain("id: desktop_smoke");
    expect(desktopE2e).toContain("pnpm run test:e2e:desktop:smoke");
    expect(desktopE2e).toContain("if: github.event_name == 'pull_request'");
    expect(desktopE2e).toContain("id: desktop_e2e");
    expect(desktopE2e).toContain("Run hosted full desktop E2E gate");
    expect(desktopE2e).toContain(
      "continue-on-error: ${{ github.event_name == 'push' && github.ref != 'refs/heads/main' }}"
    );
    expect(desktopE2e).toContain("timeout-minutes: 75");
    expect(desktopE2e).toContain("pnpm run test:e2e:desktop:full");
    expect(desktopE2e).toContain("include-hidden-files: true");
    expect(desktopE2e).toContain("path: |");
    expect(desktopE2e).toContain(".desktop-e2e-artifacts");
    expect(desktopE2e).toContain("!.desktop-e2e-artifacts/**/roles/*/browser/**");
    expect(electronChecks).toContain(
      "!.desktop-e2e-artifacts/**/user-data/**"
    );
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
    expect(electronChecks).not.toContain("needs:");
    expect(desktopE2e).not.toContain("needs:");
    expect(desktopE2e).not.toContain("renderer-assets-");
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
    expect(platformChecks).not.toContain("cargo check -p rion-tauri --all-targets");
    expect(platformChecks).toContain("cargo build -p rion-tauri");
    expect(platformChecks).toContain(
      "shared-key: platform-ci-${{ runner.os }}-${{ runner.arch }}"
    );
    expect(platformChecks).toContain('save-if: "false"');
    expect(desktopE2e).toContain(
      "shared-key: platform-ci-${{ runner.os }}-${{ runner.arch }}"
    );
    expect(desktopE2e).toContain('cache-on-failure: "true"');
    expect(desktopE2e).toContain(
      "save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"
    );
    expect(workflow.match(/shared-key: platform-ci-/gu)).toHaveLength(2);
    expect(workflow).not.toContain("shared-key: platform-tauri-");
    expect(workflow).not.toContain("pnpm exec tauri build");
    expect(workflow).not.toContain("pnpm run dist");
    expect(workflow).not.toContain("test:native:");
    expect(workflow).not.toContain("attestation");
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith("test:native:")))
      .toBe(false);
    expect(workflow).toContain("rust-concurrency-sanitizer:");
    expect(workflow).toContain("electron-platform-validation:");
    expect(workflow).toContain("electron-platform-ci-${{ runner.os }}-${{ runner.arch }}");
  });

  it("requires immutable real Tauri v22 artifacts before claiming cutover compatibility", async () => {
    const [
      workflow,
      previousFixtures,
      transactionProbe,
      windowsDerivation,
      prepareProbeCli,
      windowsReceiptFinalizer,
      macosReceiptFinalizer
    ] = await Promise.all([
      readWorkflow(
        ".github/workflows/electron-updater-tauri-v22-compatibility.yml"
      ),
      readFile("scripts/buildElectronUpdaterPreviousFixtures.mjs", "utf8"),
      readFile("scripts/runElectronUpdaterTransactionProbe.mjs", "utf8"),
      readFile("scripts/deriveTauriV22WindowsInstall.ps1", "utf8"),
      readFile(
        "scripts/prepareElectronUpdaterTransactionProbeInput.mjs",
        "utf8"
      ),
      readFile(
        "scripts/electronUpdaterCompatibilityReceiptFinalizer.mjs",
        "utf8"
      ),
      readFile(
        "scripts/electronUpdaterMacosCompatibilityReceiptFinalizer.mjs",
        "utf8"
      )
    ]);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("target_sha:");
    expect(workflow).toContain("target_version:");
    expect(workflow).toContain("prior_v23_version:");
    expect(workflow).toContain("target_updater_endpoint:");
    expect(workflow).toContain("tauri_source_sha:");
    expect(workflow).toContain("tauri_macos_archive_sha256:");
    expect(workflow).toContain("tauri_windows_installer_sha256:");
    expect(workflow).not.toContain("gh release download");
    expect(workflow).toContain('"repos/${RELEASE_REPOSITORY}/releases/assets/${asset_id}"');
    expect(workflow).toContain('Accept: application/octet-stream');
    expect(workflow).toContain("RELEASE_REPOSITORY: rion-tw/rion-studio");
    expect(workflow).toContain('gh api "repos/${RELEASE_REPOSITORY}/releases/tags/${RELEASE_TAG}"');
    expect(workflow).toContain("permissions:\n  actions: read\n  attestations: read\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("pnpm run verify:tauri-v22-updater-input");
    expect(workflow).toContain('--target-sha "${TARGET_SHA}"');
    expect(workflow).toContain(
      "package_probe::packaged_artifact_manifest_fail_closed_probe"
    );
    expect(workflow).toContain("RION_UPDATER_PROBE_PREVIOUS_APP");
    expect(workflow).toContain("RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER");
    expect(workflow).toContain(
      "RION_UPDATER_PRIOR_V23_VERSION: ${{ inputs.prior_v23_version }}"
    );
    expect(workflow).toContain(
      '--prior-v23-version "${RION_UPDATER_PRIOR_V23_VERSION}"'
    );
    expect(workflow).toContain(
      "--prior-v23-version $env:RION_UPDATER_PREVIOUS_V23_VERSION"
    );
    expect(workflow).not.toContain('--prior-v23-version "23.0.0"');
    expect(workflow).toContain("Verify retained AppKit");
    expect(workflow).toContain(
      'import { assertStableTauriV22PublicReleaseAssets } from "./scripts/publicReleaseRuntimePolicy.mjs";'
    );
    expect(workflow).toContain(
      "await assertStableTauriV22PublicReleaseAssets("
    );
    expect(workflow.indexOf("assertStableTauriV22PublicReleaseAssets")).toBeLessThan(
      workflow.indexOf('tar -xzf "${RION_TAURI_V22_ARTIFACT}"')
    );
    expect(workflow).toContain('previous_app="${previous_root}/Rion Studio.app"');
    expect(workflow).toContain('previous_executable="${previous_app}/Contents/MacOS/rion-tauri"');
    expect(workflow).toContain("deriveTauriV22WindowsInstall.ps1");
    expect(workflow).toContain("RION_TAURI_V22_RUNNING_EXECUTABLE");
    expect(workflow).toContain('-RepositoryAccess "RX"');
    expect(workflow).toContain('-ToolHomeAccess "None"');
    expect(workflow).toContain(
      "-AdditionalReadablePaths @($env:RION_TAURI_V22_ARTIFACT)"
    );
    expect(workflow).not.toContain("$env:APPDATA =");
    expect(workflow).not.toContain("$env:LOCALAPPDATA =");
    expect(windowsDerivation).toContain("temporary-local-windows-user-profile-v1");
    expect(windowsDerivation).toContain("Get-Item -LiteralPath $InstallDirectory");
    expect(windowsDerivation).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(workflow).toContain("createTauriV22PublicLineage");
    expect(workflow).toContain(
      "RUNNING_EXECUTABLE_DERIVATION: ${{ matrix.running_executable_derivation }}"
    );
    expect(workflow).not.toContain("matrix.running-executable-derivation");
    expect(workflow).toContain(
      "tauri-v22-public-lineage-${{ matrix.platform }}-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflow).toContain(
      "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8"
    );
    expect(workflow).toContain(
      "subject-path: ${{ runner.temp }}/rion-tauri-v22-lineage/tauri-v22-public-lineage-receipt.json"
    );
    expect(workflow).not.toMatch(/7z(?:\.exe)?\s/iu);
    expect(workflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY: ${{ secrets.RION_STUDIO_UPDATER_PUBLIC_KEY }}");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
    expect(workflow).toContain("terminal-layout-probe-receipt.json");
    expect(workflow).toContain("runWindowsIsolatedProfile.ps1");
    expect(workflow).toContain("runner.environment == 'github-hosted'");
    expect(workflow).toContain("-AdditionalReadablePaths @(");
    expect(workflow).toContain("$env:RION_TAURI_V22_INPUT_ROOT,");
    expect(workflow).toContain("$env:RION_UPDATER_PREPARED_INPUT_ROOT");
    expect(workflow).toContain(
      'echo "CARGO_TARGET_DIR=${child_root}/cargo-target"'
    );
    expect(workflow).toContain(
      'boundary_root="${RUNNER_TEMP}/rion-electron-updater-compatibility-boundary"'
    );
    expect(windowsDerivation).toContain(
      "tauriV22WindowsInstallContract.mjs"
    );
    expect(windowsDerivation).toContain(
      "[Microsoft.Win32.RegistryView]::Registry32"
    );
    expect(windowsDerivation).toContain(
      '$installRegistryPath = "Software\\rionstudio\\Rion Studio"'
    );
    expect(windowsDerivation).toContain(
      '$uninstallRegistryPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Rion Studio"'
    );
    expect(windowsDerivation).toContain(
      'mainBinaryName = [string] $uninstallRegistry.GetValue("MainBinaryName"'
    );
    expect(windowsDerivation).toContain("mainBinaryReparsePoint");
    expect(windowsDerivation).toContain("uninstallerReparsePoint");
    expect(workflow).toContain("Cutover eligible from this workflow alone: false");
    expect(workflow.indexOf("- name: Setup Node")).toBeLessThan(
      workflow.indexOf("- name: Validate exact Tauri v22 source identity")
    );
    expect(workflow).not.toContain("prepare:electron-updater:ci");
    expect(workflow).not.toContain("real Tauri v22 to Electron");
    expect(workflow).not.toContain("publish-public-release");
    expect(workflow).not.toContain("finalize-private-release");
    expect(previousFixtures).toContain('["V23", priorV23Version]');
    expect(previousFixtures).toContain(
      "RION_UPDATER_PREVIOUS_V23_VERSION=${priorV23Version}"
    );
    expect(previousFixtures).toContain("assertSemanticVersionIsNewer(");
    expect(previousFixtures).not.toContain("requiredV23SemanticVersion");
    expect(previousFixtures).not.toContain('["V22", "22.9.0"]');
    expect(transactionProbe).toContain(
      "writeElectronUpdaterCompatibilityProvisionalReceipt({"
    );
    expect(transactionProbe).toContain(
      "environment.RION_UPDATER_PREVIOUS_V23_VERSION"
    );
    expect(transactionProbe).not.toContain("sourceUpdaterInvoked: false");
    expect(transactionProbe).not.toContain("cutoverEligible: false");
    for (const finalizer of [windowsReceiptFinalizer, macosReceiptFinalizer]) {
      expect(finalizer).toContain("sourceUpdaterInvoked: false");
      expect(finalizer).toContain("cutoverEligible: false");
    }
    expect(transactionProbe).toContain(
      "createUpdaterProbeRuntimeEnvironment("
    );
    expect(transactionProbe).toContain(
      "Production-trust compatibility probes require a separately prepared signed input."
    );
    expect(transactionProbe).not.toContain(
      "prepareElectronUpdaterProbeInput"
    );
    expect(prepareProbeCli).toContain("prepareElectronUpdaterProbeInput");
    expect(prepareProbeCli).not.toContain("@electron/asar");
    expect(prepareProbeCli).not.toContain("runElectronUpdaterTransactionProbe");
    expect(prepareProbeCli).toContain(
      'console.error("Updater probe input preparation failed.")'
    );
    const compatibilityJob = workflow.slice(
      workflow.indexOf("  artifact-compatibility:"),
      workflow.indexOf("  attest-lineage:")
    );
    const attestationJob = workflow.slice(workflow.indexOf("  attest-lineage:"));
    expect(compatibilityJob).toContain(
      "permissions:\n      actions: read\n      attestations: read\n      contents: read"
    );
    expect(compatibilityJob).not.toContain("id-token: write");
    expect(compatibilityJob).not.toContain("attestations: write");
    for (const value of [
      "- artifact-compatibility",
      "attestations: write",
      "id-token: write"
    ]) expect(attestationJob).toContain(value);
    for (const value of ["environment:", "secrets.", "TAURI_SIGNING_PRIVATE_KEY"]) {
      expect(attestationJob).not.toContain(value);
    }
    expect(attestationJob).toContain("platform:\n          - darwin-aarch64\n          - windows-x86_64");
    expect(workflow.match(
      /tauri-v22-public-lineage-\$\{\{ matrix\.platform \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/gu
    )).toHaveLength(3);
    const compatibilityJobStart = workflow.indexOf("  artifact-compatibility:");
    const compatibilityJobEnvironment = workflow.slice(
      workflow.indexOf("    env:", compatibilityJobStart),
      workflow.indexOf("    steps:", compatibilityJobStart)
    );
    expect(compatibilityJobEnvironment).not.toContain(
      "TAURI_SIGNING_PRIVATE_KEY"
    );
    expect(workflow.match(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\./gu))
      .toHaveLength(1);
    const buildJob = workflow.slice(
      workflow.indexOf("  build-target-input:"),
      workflow.indexOf("  attest-signing-input:")
    );
    const sealingJob = workflow.slice(
      workflow.indexOf("  attest-signing-input:"),
      workflow.indexOf("  prepare-signed-input:")
    );
    const signingJob = workflow.slice(
      workflow.indexOf("  prepare-signed-input:"),
      workflow.indexOf("  artifact-compatibility:")
    );
    const macRuntime = workflow.slice(
      workflow.indexOf(
        "- name: Run macOS published-v22-input plus v23 layout replacement probe without private signing material"
      ),
      workflow.indexOf(
        "- name: Run Windows published-v22-input plus v23 layout replacement probe without private signing material"
      )
    );
    const windowsRuntime = workflow.slice(
      workflow.indexOf(
        "- name: Run Windows published-v22-input plus v23 layout replacement probe without private signing material"
      ),
      workflow.indexOf(
        "- name: Upload the exact closed public Tauri v22 source lineage for detached attestation"
      )
    );
    expect(buildJob).toContain("ref: ${{ inputs.target_sha }}");
    expect(buildJob).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(sealingJob).toContain(
      "ref: ${{ needs.authorize-control-plane.outputs.control_plane_sha }}"
    );
    expect(sealingJob).toContain("candidateSourceSha");
    expect(sealingJob).toContain("controlPlaneSha");
    expect(sealingJob).toContain("attest-build-provenance");
    expect(sealingJob).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(signingJob).toContain(
      "Verify attestation and every sealed input byte before private key entry"
    );
    expect(signingJob).toContain('--signer-digest "${CONTROL_PLANE_SHA}"');
    expect(signingJob).toContain('--source-digest "${CONTROL_PLANE_SHA}"');
    expect(signingJob).toContain("Unsigned compatibility archive bytes changed after attestation.");
    expect(signingJob).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
    );
    expect(signingJob).toContain("prepareElectronUpdaterTransactionProbeInput.mjs");
    const privateKeyStep = signingJob.indexOf(
      "- name: Prepare production-signed updater probe input from trusted control"
    );
    const postPrivateKeySteps = signingJob.slice(privateKeyStep);
    expect(privateKeyStep).toBeGreaterThan(-1);
    expect(postPrivateKeySteps).not.toContain("ref: ${{ inputs.target_sha }}");
    expect(postPrivateKeySteps).not.toContain("pnpm run package:electron");
    expect(postPrivateKeySteps).not.toContain("runElectronUpdaterTransactionProbe.mjs");
    for (const runtime of [macRuntime, windowsRuntime]) {
      expect(runtime).toContain("--prepared-input");
      expect(runtime).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
      expect(runtime).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    }
    expect(windowsRuntime).toContain('-RepositoryAccess "RX"');
    expect(windowsRuntime).toContain('-ToolHomeAccess "RX"');
    expect(windowsRuntime).not.toContain(
      "AllowEphemeralUpdaterSigningEnvironment"
    );
    expect(windowsRuntime).toContain(
      "-AdditionalWritablePaths @($env:RION_UPDATER_CI_FIXTURE_ROOT)"
    );
  });

  it("proves the Windows Electron NSIS payload before updater signing", async () => {
    const [
      candidate,
      ci,
      proofRunner,
      installerProof,
      isolatedProfileRunner
    ] =
      await Promise.all([
      readWorkflow(".github/workflows/electron-production-candidate.yml"),
      readWorkflow(".github/workflows/ci.yml"),
      readWorkflow("scripts/runWindowsElectronInstallerPayloadProof.ps1"),
      readWorkflow("scripts/installWindowsElectronPayloadForProof.ps1"),
      readWorkflow("scripts/runWindowsIsolatedProfile.ps1")
    ]);
    const buildStart = candidate.indexOf("  build:");
    const buildStepsStart = candidate.indexOf("    steps:", buildStart);
    const attestJobStart = candidate.indexOf(
      "  attest-signing-input:",
      buildStepsStart
    );
    const signJobStart = candidate.indexOf("  sign:", buildStepsStart);
    const buildEnvironment = candidate.slice(
      candidate.indexOf("    env:", buildStart),
      buildStepsStart
    );
    const proofStepStart = candidate.indexOf(
      "- name: Prove exact Windows NSIS payload matches the black-box package",
      buildStepsStart
    );
    const signingStepStart = candidate.indexOf(
      "- name: Sign updater payload and stage immutable platform candidate",
      proofStepStart
    );
    const uploadStepStart = candidate.indexOf(
      "- name: Upload exact verified platform candidate",
      signingStepStart
    );
    const proofStep = candidate.slice(proofStepStart, signingStepStart);
    const signingStep = candidate.slice(signingStepStart, uploadStepStart);
    const buildJob = candidate.slice(buildStart, attestJobStart);
    const signJob = candidate.slice(
      signJobStart,
      candidate.indexOf("  assemble:", signJobStart)
    );
    const windowsBlackBoxStep = candidate.slice(
      candidate.indexOf(
        "- name: Run exact Windows production candidate packaged Chromium black-box",
        buildStepsStart
      ),
      candidate.indexOf(
        "- name: Upload exact production candidate black-box evidence",
        buildStepsStart
      )
    );

    expect(buildStart).toBeGreaterThan(-1);
    expect(buildStepsStart).toBeGreaterThan(buildStart);
    expect(signJobStart).toBeGreaterThan(buildStepsStart);
    expect(attestJobStart).toBeGreaterThan(buildStepsStart);
    expect(signJobStart).toBeGreaterThan(attestJobStart);
    expect(proofStepStart).toBeGreaterThan(buildStepsStart);
    expect(signingStepStart).toBeGreaterThan(proofStepStart);
    expect(uploadStepStart).toBeGreaterThan(signingStepStart);
    expect(buildEnvironment).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(buildJob).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(buildJob).not.toContain("secrets.");
    expect(buildJob).toContain(
      'COPYFILE_DISABLE=1 tar -C "${RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT}"'
    );
    expect(proofStep).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(proofStep).toContain("if: runner.os == 'Windows'");
    expect(proofStep).toContain(
      "RION_WINDOWS_PROFILE_ISOLATION_ALLOWED: ${{ runner.environment == 'github-hosted' }}"
    );
    expect(signingStep).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
    );
    expect(signingStep).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}"
    );
    expect(signingStep).toContain(
      '"${RION_STUDIO_SIGNING_WINDOWS_PAYLOAD_PROOF}"'
    );
    expect(signJob).toContain("- attest-signing-input");
    expect(signJob).toContain(
      "Checkout the exact trusted default-branch signing control plane"
    );
    expect(signJob).toContain("persist-credentials: false");
    expect(signJob).toContain(
      "Install locked signing dependencies before private key entry"
    );
    expect(signJob).toContain("Download the exact unsigned package archive");
    expect(signJob).toContain("Download the exact packaged black-box evidence");
    expect(signJob).toContain("Verify trusted-control provenance and every sealed input byte");
    expect(signJob).toContain("Restore sealed unsigned package inputs before private key entry");
    expect(signJob).toContain("restoreElectronUnsignedInputArchive.mjs");
    expect(signJob).toContain(
      '--destination "${RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT}/release/electron"'
    );
    expect(signJob).not.toContain('tar -xzf "${archive}"');
    expect(signJob.indexOf("Restore sealed unsigned package inputs before private key entry"))
      .toBeLessThan(signJob.indexOf("TAURI_SIGNING_PRIVATE_KEY"));
    expect(signJob).toContain("test \"$(git rev-parse HEAD)\" = \"${CONTROL_PLANE_SHA}\"");
    expect(signJob).not.toContain("test \"$(git rev-parse HEAD)\" = \"${SOURCE_SHA}\"");
    expect(candidate).toContain("- authorize-control-plane\n      - validate\n      - sign");
    expect(candidate.match(/persist-credentials: false/gu)).toHaveLength(5);
    expect(windowsBlackBoxStep).toContain('-RepositoryAccess "RX"');
    expect(windowsBlackBoxStep).toContain('-ToolHomeAccess "None"');
    expect(windowsBlackBoxStep).toContain(
      "-AdditionalWritablePaths @($env:RION_STUDIO_E2E_ARTIFACT_ROOT)"
    );
    expect(windowsBlackBoxStep).toContain(
      "-AdditionalReadablePaths @($env:RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT)"
    );
    expect(windowsBlackBoxStep).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(candidate).toContain(
      'echo "RION_STUDIO_E2E_ARTIFACT_ROOT=${signing_root}/black-box"'
    );
    expect(candidate).toContain(
      'signing_root="${RUNNER_TEMP}/rion-electron-production-signing-input-${UPLOAD_NAME}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'
    );
    expect(isolatedProfileRunner).toContain(
      "Deny-PathMutationRecursively $resolvedRepository"
    );
    expect(proofStep).toContain("runWindowsElectronInstallerPayloadProof.ps1");
    expect(proofStep).toContain(
      '-UnsignedInputRoot "$env:RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT"'
    );
    expect(proofStep).toContain(
      '-ApplicationPath "$env:RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT\\release\\electron\\win-unpacked"'
    );
    expect(proofStep).toContain(
      '-ArtifactPath "$env:RION_STUDIO_ELECTRON_UNSIGNED_INPUT_ROOT\\release\\electron\\Rion.Studio-win.exe"'
    );

    expect(proofRunner).toContain('$env:CI -ne "true"');
    expect(proofRunner).toContain('$env:GITHUB_ACTIONS -ne "true"');
    expect(proofRunner).toContain(
      '.Name.StartsWith("TAURI_SIGNING_", [StringComparison]::OrdinalIgnoreCase)'
    );
    expect(installerProof).toContain(
      '.Name.StartsWith("TAURI_SIGNING_", [StringComparison]::OrdinalIgnoreCase)'
    );
    expect(proofRunner).toContain("-RepositoryAccess None");
    expect(proofRunner).toContain("-WorkingDirectory $gateRoot");
    expect(proofRunner).toContain("-AdditionalDeniedPaths @($application)");
    expect(proofRunner).toContain("-AdditionalReadablePaths @($inputRoot)");
    expect(proofRunner).toContain("-ToolHomeAccess None");
    expect(proofRunner).toContain("-ExpectedTotalProcesses 3");
    expect(proofRunner).toContain("-ResultPath $isolationResultPath");
    expect(proofRunner).toContain("-AttemptNonce $attemptNonce");
    expect(proofRunner).toContain("-ResultCommandHarnessPath $stagedHarness");
    expect(proofRunner).toContain("-ResultInstallerPath $stagedArtifact");
    expect(proofRunner).toContain(
      "-ResultForbiddenSourceListPath $forbiddenSourceFileList"
    );
    expect(proofRunner).toContain("--isolation-result $isolationResultPath");
    expect(proofRunner).toContain("--attempt-nonce $attemptNonce");
    expect(proofRunner).toContain("--command-path $pwsh");
    expect(proofRunner).toContain("--command-script $stagedHarness");
    expect(proofRunner).toContain(
      "--forbidden-source-file-list $forbiddenSourceFileList"
    );
    expect(proofRunner).toContain("write-forbidden-source-list");
    expect(installerProof).toContain(
      "foreach ($accessName in $forbiddenAccessMasks.Keys)"
    );
    expect(installerProof).toContain(
      "The isolated installer can $accessName a forbidden source-package path."
    );
    expect(installerProof).toContain(
      "instead of access denied."
    );
    expect(proofRunner).toContain(
      "Assert-NoAlternateDataStreams -Paths @($sourceEntries.FullName)"
    );
    expect(installerProof).toContain(
      "Get-Item -LiteralPath $installedEntry.FullName -Stream *"
    );

    const ciProofStepStart = ci.indexOf(
      "- name: Verify exact Windows NSIS installed payload"
    );
    const ciUpdaterStepStart = ci.indexOf(
      "- name: Verify packaged macOS Rust-owned updater transaction",
      ciProofStepStart
    );
    const ciProofStep = ci.slice(ciProofStepStart, ciUpdaterStepStart);
    expect(ciProofStepStart).toBeGreaterThan(-1);
    expect(ciUpdaterStepStart).toBeGreaterThan(ciProofStepStart);
    expect(ciProofStep).toContain("if: runner.os == 'Windows'");
    expect(ciProofStep).toContain(
      "RION_WINDOWS_PROFILE_ISOLATION_ALLOWED: ${{ runner.environment == 'github-hosted' }}"
    );
    expect(ciProofStep).toContain("runWindowsElectronInstallerPayloadProof.ps1");
    expect(ciProofStep).toContain(
      '-ApplicationPath "$env:GITHUB_WORKSPACE\\release\\electron\\win-unpacked"'
    );
    expect(ciProofStep).toContain(
      '-ArtifactPath "$env:GITHUB_WORKSPACE\\release\\electron\\Rion.Studio-win.exe"'
    );
    expect(ciProofStep).toContain("-SourceSha $sourceSha");
    expect(ciProofStep).toContain(
      '.Name.StartsWith("TAURI_SIGNING_", [StringComparison]::OrdinalIgnoreCase)'
    );
    expect(ciProofStep).toContain(
      '-Version "$env:RION_STUDIO_ELECTRON_PACKAGE_VERSION"'
    );

    const installerInvocationStart = installerProof.indexOf(
      "Invoke-BoundedInstaller -FilePath $artifact -ArgumentList @("
    );
    const installerInvocationEnd = installerProof.indexOf(
      "\n)",
      installerInvocationStart
    );
    expect(installerInvocationStart).toBeGreaterThan(-1);
    expect(installerInvocationEnd).toBeGreaterThan(installerInvocationStart);
    expect(installerProof.slice(installerInvocationStart, installerInvocationEnd + 2))
      .toBe([
        "Invoke-BoundedInstaller -FilePath $artifact -ArgumentList @(",
        '  "/S",',
        '  "/currentuser",',
        '  "/D=$expectedInstallDirectory"',
        ")"
      ].join("\n"));
    expect(installerProof).not.toContain("--force-run");
  });

  it("keeps extended desktop E2E on immutable hardware-runner evidence", async () => {
    const [workflow, runner, wdio] = await Promise.all([
      readWorkflow(".github/workflows/desktop-e2e-extended.yml"),
      readWorkflow("scripts/runDesktopE2e.mjs"),
      readWorkflow("e2e/desktop/wdio.conf.ts")
    ]);
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("workflow_call:");
    expect(workflow).toContain("runs-on: [self-hosted, Windows, X64, rion-desktop-e2e]");
    expect(workflow).toContain("runs-on: [self-hosted, macOS, ARM64, rion-desktop-e2e]");
    expect(workflow).toContain("Extended E2E ref must be a full immutable Git SHA");
    expect(workflow).toContain("RION_STUDIO_E2E_COMMIT: ${{ inputs.ref || github.sha }}");
    expect(workflow).toContain("pnpm run test:e2e:desktop:extended");
    expect(workflow).toContain(
      "pnpm run test:e2e:desktop:chromium:macos-appkit:hardware"
    );
    expect(workflow).toContain(
      "pnpm run test:e2e:desktop:chromium:windows:hardware"
    );
    expect(workflow.match(/timeout-minutes: 240/gu)).toHaveLength(2);
    expect(workflow.match(/include-hidden-files: true/gu)).toHaveLength(2);
    expect(workflow.match(/path: \|/gu)).toHaveLength(2);
    expect(workflow.match(/!.desktop-e2e-artifacts\/\*\*\/roles\/\*\/browser\/\*\*/gu))
      .toHaveLength(2);
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
    expect(candidateWorkflow).not.toContain("desktop-e2e-extended.yml");
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
    expect(finalizeWorkflow).toContain("-F draft=false -f make_latest=false");
    expect(finalizeWorkflow).toContain(
      "ref: ${{ needs.authorize-control-plane.outputs.control_sha }}"
    );
    expect(finalizeWorkflow).not.toContain("ref: ${{ inputs.tag }}");
    expect(finalizeWorkflow).toContain(
      'cmp "release-assets/${name}" "downloaded-assets/${name}"'
    );
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
    expect(preflightWorkflow).not.toContain("desktop-e2e-extended.yml");
    expect(preflightWorkflow).toContain("source_ref: ${{ needs.plan-release.outputs.source_ref }}");
    expect(preflightWorkflow).toContain("version: ${{ needs.plan-release.outputs.release_version }}");
    expect(preflightWorkflow).toContain("release-preflight-${{ needs.plan-release.outputs.source_ref }}");
    expect(preflightWorkflow).toContain("build_result");
    expect(preflightWorkflow).not.toContain("desktop_e2e_result");
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
    const publishIndex = workflow.indexOf("--draft=false --latest=false");
    const verifyIndex = workflow.indexOf("target-published.json");
    const leaseIndex = workflow.indexOf(
      "Acquire the durable public-latest publication lease"
    );
    const documentationIndex = workflow.indexOf(
      "Synchronize public documentation using trusted main control code"
    );
    const summaryIndex = workflow.indexOf(
      "Record the closed stable publication result"
    );

    expect(draftIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(draftIndex);
    expect(publishIndex).toBeGreaterThan(uploadIndex);
    expect(verifyIndex).toBeGreaterThan(publishIndex);
    expect(leaseIndex).toBeGreaterThan(verifyIndex);
    expect(documentationIndex).toBeGreaterThan(leaseIndex);
    expect(summaryIndex).toBeGreaterThan(documentationIndex);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).toContain("group: public-latest-rion-studio");
    expect(workflow).toContain("synchronizePublicDocuments");
    expect(workflow).toContain('repository: "rion-tw/rion-studio"');
    expect(workflow).toContain('tag: process.env.TAG');
    expect(workflow).toContain("GH_TOKEN: ${{ steps.public-token.outputs.token }}");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).not.toContain("gh release download");
  });

  it("keeps generic public promotion restricted to stable Tauri v22 assets", async () => {
    const [
      publish,
      finalize,
      restore,
      runtimePolicy,
      candidate,
      candidateProducer,
      readiness,
      updaterContract
    ] = await Promise.all([
      readWorkflow(".github/workflows/publish-public-release.yml"),
      readWorkflow(".github/workflows/finalize-private-release.yml"),
      readWorkflow(".github/workflows/restore-public-latest.yml"),
      readWorkflow("scripts/publicReleaseRuntimePolicy.mjs"),
      readWorkflow(".github/workflows/electron-production-candidate.yml"),
      readWorkflow("scripts/electronProductionCandidate.mjs"),
      readWorkflow(".github/workflows/electron-production-promotion-readiness.yml"),
      readWorkflow("docs/updater-transaction-contract.md")
    ]);

    expect(publish).not.toContain("workflow_dispatch:");
    expect(publish).toContain("release_contract:");
    expect(publish).toContain('RELEASE_CONTRACT: ${{ inputs.release_contract }}');
    expect(publish).toContain('test "${RELEASE_CONTRACT}" = "tauri-v22"');
    expect(publish.match(/--require-tauri-v22/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(finalize).toContain("release_contract: tauri-v22");
    expect(finalize.match(/--require-tauri-v22/gu)).toHaveLength(2);
    expect(restore).toContain("--require-tauri-v22");
    expect(runtimePolicy).toContain("electron-production-candidate-receipt.json");
    expect(runtimePolicy).toContain("/Contents/Resources/app.asar");
    expect(runtimePolicy).toContain("/Contents/Frameworks/Electron Framework.framework");
    expect(candidate).toContain("environment: electron-production-release");
    expect(candidate).toContain(
      "electron-production-candidate-${{ inputs.version }}-${{ inputs.source_sha }}-attempt-${{ github.run_attempt }}"
    );
    expect(candidate).toContain(
      "electron-production-macos-arm64-${{ inputs.version }}-${{ inputs.source_sha }}-attempt-${{ github.run_attempt }}"
    );
    expect(candidate).toContain(
      "electron-production-windows-x64-${{ inputs.version }}-${{ inputs.source_sha }}-attempt-${{ github.run_attempt }}"
    );
    expect(candidateProducer).toContain('status: "verified-not-published"');
    expect(candidate).not.toContain("publish-public-release.yml");
    for (const fragment of [
      "electronProductionPromotionReadinessCli.mjs verify",
      "Publication performed by this workflow: false",
      "attestations: read",
      "persist-credentials: false",
      "EXPECTED_REPOSITORY: rion-tw/rion-studio-source",
      'test "${DISPATCH_REF}" = "refs/heads/main"',
      'test "${DISPATCH_REF_PROTECTED}" = "true"',
      "@refs/heads/main",
      "ref: ${{ github.sha }}",
      'test "$(jq -r .head_repository.full_name <<< "${run_json}")" = "rion-tw/rion-studio-source"',
      'test "$(jq -r .head_branch <<< "${run_json}")" = "main"',
      'echo "${label}_control_sha=${control_sha}"',
      "electron-production-candidate-trusted-control-${VERSION}-${SOURCE_SHA}",
      "electron-production-candidate-trusted-control-${PRIOR_ELECTRON_VERSION}-${PRIOR_ELECTRON_SOURCE_SHA}",
      "--candidate-trusted-control-receipt candidate-trusted-control/",
      "--prior-candidate-trusted-control-receipt prior-candidate-trusted-control/",
      '--candidate-run-control-sha "${CANDIDATE_CONTROL_SHA}"',
      '--evidence-run-control-sha "${EVIDENCE_CONTROL_SHA}"',
      '--provisional-publication-run-control-sha "${PROVISIONAL_PUBLICATION_CONTROL_SHA}"',
      '--tauri-lineage-run-control-sha "${TAURI_LINEAGE_CONTROL_SHA}"',
      '--readiness-control-sha "${READINESS_CONTROL_SHA}"',
      '--signer-digest "${EVIDENCE_CONTROL_SHA}"',
      '--signer-digest "${PROVISIONAL_PUBLICATION_CONTROL_SHA}"',
      '--signer-digest "${TAURI_LINEAGE_CONTROL_SHA}"',
      'jq -e --arg invocation_uri "${invocation_uri}"'
    ]) expect(readiness).toContain(fragment);
    expect(readiness).not.toContain('.head_sha <<< "${run_json}")" = "${SOURCE_SHA}"');
    expect(readiness).not.toContain('--signer-digest "${SOURCE_SHA}"');
    expect(readiness).not.toContain('--source-digest "${SOURCE_SHA}"');
    const permissions = readiness.slice(
      readiness.indexOf("permissions:"),
      readiness.indexOf("\n\nconcurrency:")
    );
    expect(permissions.trim()).toBe([
      "permissions:",
      "  actions: read",
      "  attestations: read",
      "  contents: read"
    ].join("\n"));
    expect(readiness).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu);
    expect(readiness).not.toMatch(/gh release (?:create|edit|upload)/u);
    expect(updaterContract).toMatch(
      /no approved or enabled provisional publisher/u
    );
    expect(updaterContract).toMatch(
      /closed terminal-promotion schema and producer now exist/u
    );
    expect(updaterContract).toMatch(
      /every finalizer job is literal\s+`if: \$\{\{ false \}\}`/u
    );
    expect(updaterContract).toContain("sourceUpdaterInvoked: false");
    expect(updaterContract).toContain("terminal promotion receipt");
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
    expect(workflow).toContain("Capture exact source and target snapshots by immutable release ID");
    expect(workflow).toContain('releases/${release_id}');
    expect(workflow).toContain('releases/assets/${asset_id}');
    expect(workflow).toContain("deriveTauriV22ExpectedLatestState");
    expect(workflow).toContain(
      "electronProductionPublicLatestLeaseRemoteCli.mjs acquire"
    );
    expect(workflow).toContain(
      "Observe the exact held lease immediately before mutation"
    );
    expect(workflow).toContain(
      "Release the lease only for a safe acknowledgement and exact readback"
    );
    expect(workflow).toContain("--verify-checksums");
    expect(workflow).toContain("gh api --method PATCH --include");
    expect(workflow).toContain("-f make_latest=true");
    expect(workflow).not.toContain("gh release download");
  });
});

async function readWorkflow(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}
