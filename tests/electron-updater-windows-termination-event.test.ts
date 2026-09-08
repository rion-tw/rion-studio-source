import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { windowsUpdaterProcessTerminationScript } from
  "../scripts/runElectronUpdaterTransactionProbe.mjs";

const execute = promisify(execFile);

describe.runIf(process.platform === "win32")("Windows updater termination event", () => {
  it.each([false, true])("checks native liveness after enumeration (live successor: %s)", async (liveSuccessor) => {
    // Replay the observed post-exit enumeration retaining an actual native
    // Process object. The process exit and HasExited are not simulated.
    const script = windowsUpdaterProcessTerminationScript(424242)
      .replace("$remaining = Find-RionProbeProcess 424242", `$remaining = $${liveSuccessor ? "successor" : "fixture"}`)
      .replaceAll("424242", "$fixture.Id");
    const result = execute("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $env:ComSpec
$start.Arguments = '/d /q /c set /p fixture_input='
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$fixture = [Diagnostics.Process]::Start($start)
$retainedHandle = $fixture.Handle
$successor = ${liveSuccessor ? "[Diagnostics.Process]::Start($start)" : "$null"}
try {
${script}
  if (-not $fixture.HasExited) { throw 'The pinned native fixture is still alive.' }
  Write-Output 'retained-handle-exit-verified'
} finally {
  if (-not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
  $fixture.Dispose()
  if ($successor) { $successor.Kill(); $successor.WaitForExit(); $successor.Dispose() }
}`
    ], { windowsHide: true, timeout: 8000 });
    if (liveSuccessor) {
      await expect(result).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Updater target root process survived termination.")
      });
    } else {
      expect((await result).stdout).toContain("retained-handle-exit-verified");
    }
  });

  it("awaits actual process exit after the external termination acknowledgement", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {
      windowsHide: true, stdio: "ignore"
    });
    const exited = once(child, "exit");
    try {
      const script = windowsUpdaterProcessTerminationScript(child.pid!);
      const taskkill = `  & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${child.pid} /T /F | Out-Null`;
      expect(script.split(taskkill)).toHaveLength(2);
      // Only the external request acknowledgement is simulated. PowerShell's
      // process lookup/wait and the fixture's later OS exit are real native work.
      const acknowledged = script.replace(taskkill, "  $global:LASTEXITCODE = 0");
      await execute("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", acknowledged
      ], { windowsHide: true, timeout: 8000 });
      await exited;
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  });

  it("preserves a rejected termination request instead of waiting toward success", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      windowsHide: true, stdio: ["pipe", "ignore", "ignore"]
    });
    const exited = once(child, "exit");
    try {
      const script = windowsUpdaterProcessTerminationScript(child.pid!);
      const taskkill = `  & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${child.pid} /T /F | Out-Null`;
      expect(script.split(taskkill)).toHaveLength(2);
      await expect(execute("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        script.replace(taskkill, "  $global:LASTEXITCODE = 17")
      ], { windowsHide: true, timeout: 8000 })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Updater target process tree did not terminate.")
      });
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  });
});
