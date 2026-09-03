import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const COMPATIBILITY_WORKFLOW =
  ".github/workflows/electron-updater-tauri-v22-compatibility.yml";

describe("Electron updater parent-only compatibility finalization", () => {
  it("finalizes macOS only after the sandbox and active-zero result are closed", async () => {
    const workflow = await source(COMPATIBILITY_WORKFLOW);
    const start = workflow.indexOf(
      "- name: Run macOS published-v22-input plus v23 layout replacement probe"
    );
    const end = workflow.indexOf(
      "- name: Run Windows published-v22-input plus v23 layout replacement probe",
      start
    );
    const runtime = workflow.slice(start, end);
    const sandboxStart = runtime.indexOf(
      '/usr/bin/sandbox-exec -p "${sandbox_profile}"'
    );
    const resultHashStart = runtime.indexOf(
      'isolation_result_sha256="$(sha256_file "${isolation_result}")"'
    );
    const finalizerStart = runtime.indexOf(
      "node scripts/finalizeMacosElectronUpdaterCompatibilityReceipt.mjs"
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sandboxStart).toBeGreaterThan(-1);
    expect(resultHashStart).toBeGreaterThan(sandboxStart);
    expect(finalizerStart).toBeGreaterThan(resultHashStart);
    expect(runtime).toContain(
      'sealed_output_root="${boundary_root}/terminal-receipt"'
    );
    expect(runtime).toContain('test ! -e "${sealed_output_root}"');
    expect(runtime).toContain(
      'isolation_result="${child_output_root}/macos-updater-process-isolation-result.json"'
    );
    expect(runtime).toContain(
      '"--isolation-attempt-nonce" "${attempt_nonce}"'
    );
    expect(runtime).toContain(
      '"--isolation-sandbox-profile-sha256" "${sandbox_profile_sha256}"'
    );
    expect(runtime).toContain(
      '--isolation-command-invocation-sha256 "${command_invocation_sha256}"'
    );
    expect(runtime).toContain(
      '"rion-darwin-isolated-command-invocation-v1"'
    );
    expect(runtime).toContain('"<self-sha256>"');
    for (const binding of [
      '--isolation-command-executable "${node_command}"',
      '--isolation-command-executable-sha256 "${command_executable_sha256}"',
      '--isolation-command-harness "${command_harness}"',
      '--isolation-command-harness-sha256 "${command_harness_sha256}"',
      '--isolation-result-sha256 "${isolation_result_sha256}"',
      '--prepared-input-receipt-sha256 "${prepared_receipt_sha256}"',
      '--sandbox-profile-sha256 "${sandbox_profile_sha256}"',
      '--tauri-v22-input-receipt-sha256 "${tauri_input_receipt_sha256}"',
      '--tauri-v22-lineage-receipt-sha256 "${tauri_lineage_receipt_sha256}"',
      '--sealed-output-root "${sealed_output_root}"'
    ]) {
      expect(runtime).toContain(binding);
    }
    expect(runtime).toContain(
      'command_harness="${workspace}/scripts/runElectronUpdaterTransactionProbe.mjs"'
    );
    expect(runtime).toContain('test ! -L "${node_command}"');
    expect(runtime).toContain('test ! -L "${command_harness}"');
    const childInvocation = runtime.slice(sandboxStart, resultHashStart);
    expect(childInvocation).not.toContain(
      "finalizeMacosElectronUpdaterCompatibilityReceipt.mjs"
    );
    expect(childInvocation).not.toContain("sealed_output_root");
  });

  it("keeps the Windows terminal receipt outside the isolated child boundary", async () => {
    const workflow = await source(COMPATIBILITY_WORKFLOW);
    const start = workflow.indexOf(
      "- name: Run Windows published-v22-input plus v23 layout replacement probe"
    );
    const end = workflow.indexOf(
      "- name: Upload the exact closed public Tauri v22 source lineage",
      start
    );
    const runtime = workflow.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(runtime).toContain(
      "-AdditionalWritablePaths @($env:RION_UPDATER_CI_FIXTURE_ROOT)"
    );
    expect(runtime).toContain("-AdditionalDeniedPaths @($parentIsolationRoot)");
    expect(runtime).toContain("-ProtectedSiblingParent $boundaryRoot");
    expect(runtime).toContain("-ResultPath $isolationResult");
    expect(runtime).toContain("-AttemptNonce $attemptNonce");
    expect(runtime).toContain(
      "-ResultCommandHarnessPath $commandHarness"
    );
    expect(runtime).toContain("-ResultInstallerPath $preparedArtifact");
    expect(runtime).toContain("-ResultForbiddenSourceListPath $preparedReceipt");
    expect(runtime).not.toContain("AllowEphemeralUpdaterSigningEnvironment");

    const childArgumentsStart = runtime.indexOf("$commandArguments = @(");
    const childArgumentsEnd = runtime.indexOf(
      ")\n          $invocationParts",
      childArgumentsStart
    );
    const isolatedRunnerStart = runtime.indexOf(
      "./scripts/runWindowsIsolatedProfile.ps1"
    );
    const finalizerStart = runtime.indexOf(
      "node scripts/finalizeWindowsElectronUpdaterCompatibilityReceipt.mjs"
    );
    expect(childArgumentsStart).toBeGreaterThan(-1);
    expect(childArgumentsEnd).toBeGreaterThan(childArgumentsStart);
    expect(finalizerStart).toBeGreaterThan(isolatedRunnerStart);
    const childArguments = runtime.slice(childArgumentsStart, childArgumentsEnd);
    expect(childArguments).toContain("--provisional-receipt");
    expect(childArguments).not.toContain("terminal-layout-probe-receipt.json");
    expect(childArguments).not.toContain("sealedOutputRoot");
    expect(runtime).toContain("--sealed-output-root $sealedOutputRoot");
    expect(runtime).toContain(
      "--isolation-command-invocation-sha256 $commandInvocationSha256"
    );
    for (const binding of [
      "--isolation-command-executable $pnpm",
      "--isolation-command-executable-sha256 $commandExecutableSha256",
      "--isolation-command-harness $commandHarness",
      "--isolation-command-harness-sha256 $commandHarnessSha256"
    ]) {
      expect(runtime).toContain(binding);
    }

    const jobEnvironment = workflow.slice(
      workflow.indexOf("    env:"),
      workflow.indexOf("    steps:")
    );
    expect(jobEnvironment).not.toContain("SEALED_OUTPUT");
    expect(jobEnvironment).not.toContain("TERMINAL_RECEIPT");
    expect(jobEnvironment).not.toContain("PARENT_ISOLATION_ROOT");
    expect(workflow).toContain(
      "RION_UPDATER_CI_FIXTURE_ROOT: ${{ runner.temp }}/rion-electron-updater-compatibility-boundary/child-runtime"
    );
    expect(workflow).toContain(
      "RION_UPDATER_PROVISIONAL_RECEIPT: ${{ runner.temp }}/rion-electron-updater-compatibility-boundary/child-runtime/provisional-layout-probe-receipt.json"
    );
    expect(workflow).toContain(
      "path: ${{ runner.temp }}/rion-electron-updater-compatibility-boundary/terminal-receipt/terminal-layout-probe-receipt.json"
    );
  });

  it("closes the temporary Windows entry environment and protects sibling creation", async () => {
    const [command, runner, jobRunner, ci, candidate, compatibility] =
      await Promise.all([
      source("scripts/invokeWindowsIsolatedProfileCommand.ps1"),
      source("scripts/runWindowsIsolatedProfile.ps1"),
      source("scripts/windowsJobObjectRunner.cs"),
      source(".github/workflows/ci.yml"),
      source(".github/workflows/electron-production-candidate.yml"),
      source(COMPATIBILITY_WORKFLOW)
    ]);
    expect(command).toContain("$closedEnvironment = [ordered]@{}");
    expect(command).toContain("foreach ($entry in @(Get-ChildItem Env:))");
    expect(command).toContain(
      'Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction Stop'
    );
    expect(command).toContain('$env:PSModulePath = Join-Path $PSHOME "Modules"');
    expect(command.indexOf("$closedEnvironment = [ordered]@{}"))
      .toBeLessThan(command.indexOf("& $envelope.commandPath"));
    for (const allowedName of [
      "CARGO_TARGET_DIR",
      "GITHUB_ACTIONS",
      "RION_STUDIO_E2E_ARTIFACT_ROOT",
      "RION_UPDATER_CI_FIXTURE_ROOT",
      "RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER"
    ]) {
      expect(command).toContain(`"${allowedName}"`);
    }
    for (const deniedName of [
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "GITHUB_ENV",
      "GITHUB_OUTPUT",
      "GITHUB_PATH",
      "GITHUB_STEP_SUMMARY",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NPM_TOKEN"
    ]) {
      expect(command).not.toContain(`"${deniedName}"`);
    }
    expect(command).toContain(
      "if ($envelope.allowEphemeralUpdaterSigningEnvironment -eq $true)"
    );
    expect(runner).toContain("if ($AllowEphemeralUpdaterSigningEnvironment)");
    expect(runner).toContain(
      '(Split-Path -Leaf $ephemeralPrivateKey) -ne "ephemeral-updater.key"'
    );
    expect(runner).toContain("$ephemeralPrivateKeyForChild");
    expect(runner).toContain("$ephemeralPrivateKeyPasswordForChild");
    expect(jobRunner).toContain(
      "string ephemeralUpdaterSigningKeyPath"
    );
    expect(jobRunner).toContain(
      "string ephemeralUpdaterSigningKeyPassword"
    );
    expect(jobRunner).toContain(
      'name.StartsWith("TAURI_SIGNING_", StringComparison.OrdinalIgnoreCase)'
    );
    expect(jobRunner).toContain(
      '"TAURI_SIGNING_PRIVATE_KEY_PATH="'
    );
    expect(jobRunner).toContain(
      '"TAURI_SIGNING_PRIVATE_KEY_PASSWORD="'
    );
    expect(ci.match(/-AllowEphemeralUpdaterSigningEnvironment/gu))
      .toHaveLength(1);
    expect(candidate).not.toContain("AllowEphemeralUpdaterSigningEnvironment");
    expect(compatibility).not.toContain(
      "-AllowEphemeralUpdaterSigningEnvironment"
    );

    const protectedBoundary = runner.indexOf(
      "Protect-EphemeralDirectory -Path $resolvedProtectedSiblingParent"
    );
    const protectedTraversal = runner.indexOf(
      'Grant-PathAccess $resolvedProtectedSiblingParent "RX"'
    );
    const writableGrants = runner.indexOf(
      "foreach ($path in $AdditionalWritablePaths)"
    );
    expect(runner).toContain(
      'throw "Every writable root must be a direct protected sibling child."'
    );
    expect(runner).toContain(
      'throw "The isolated result root must share the protected sibling parent."'
    );
    expect(protectedBoundary).toBeGreaterThan(-1);
    expect(protectedTraversal).toBeGreaterThan(protectedBoundary);
    expect(writableGrants).toBeGreaterThan(protectedTraversal);
  });

  it("publishes the isolated-profile result only after failure and cleanup gates", async () => {
    const runner = await source("scripts/runWindowsIsolatedProfile.ps1");
    expect(runner).toContain("[string] $ResultPath");
    expect(runner).toContain("[string] $ResultForbiddenSourceListPath");
    expect(runner).toContain("[string[]] $AdditionalDeniedPaths");
    const readableGrantLoop = runner.slice(
      runner.indexOf("foreach ($path in $AdditionalReadablePaths)"),
      runner.indexOf("foreach ($path in $AdditionalDeniedPaths)")
    );
    expect(readableGrantLoop).toContain('Grant-PathAccess $path "RX"');
    expect(readableGrantLoop).toContain("Deny-PathMutationRecursively $path");
    expect(runner).toContain('"/remove:d", "*$profileSid"');

    const fullDeny = runner.slice(
      runner.indexOf("function Deny-PathAccessRecursively"),
      runner.indexOf("function Deny-PathMutationRecursively")
    );
    expect(fullDeny).toContain("$deniedPaths.Add($resolved)");
    expect(fullDeny.indexOf("$deniedPaths.Add($resolved)"))
      .toBeLessThan(fullDeny.indexOf("Invoke-Icacls"));
    const mutationDeny = runner.slice(
      runner.indexOf("function Deny-PathMutationRecursively"),
      runner.indexOf("function Get-AttestedArtifactIdentity")
    );
    expect(mutationDeny).toContain("$mutationDeniedPaths.Add($resolved)");
    expect(mutationDeny.indexOf("$mutationDeniedPaths.Add($resolved)"))
      .toBeLessThan(mutationDeny.indexOf("Invoke-Icacls"));

    for (const field of [
      "activeProcessesAfterRootExit =",
      "attemptNonce = $AttemptNonce",
      "attestedInputs = $attestedInputs",
      "cleanupVerified = $true",
      "commandExitCode =",
      "commandInvocationSha256 = $commandInvocationSha256",
      "expectedTotalProcesses =",
      "totalProcesses ="
    ]) {
      expect(runner).toContain(field);
    }
    expect(runner).toContain("[IO.FileMode]::CreateNew");
    expect(runner).toContain("$stream.Flush($true)");
    const failureGate = runner.lastIndexOf("if ($failures.Count -gt 0)");
    const resultWrite = runner.lastIndexOf(
      "Write-IsolatedProfileResult -Path $resolvedResultPath"
    );
    expect(failureGate).toBeGreaterThan(-1);
    expect(resultWrite).toBeGreaterThan(failureGate);
  });
});

async function source(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}
