import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browser, expect } from "@wdio/globals";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { WINDOWS_PROBE_CAPTION_HANDLERS } from "../../../scripts/electronWindowsProbeInitialClick.mjs";
import { electronDesktopE2eGameWindowRuntime } from "./electron-driver";
import { fixtureRequest } from "./fixture";

const execute = promisify(execFile);
const foregroundApi = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LaunchForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
}
'@
`;

async function foregroundProcessId(processId: number): Promise<number> {
  if (process.platform === "darwin") {
    const { stdout } = await execute("/usr/bin/xcrun", ["swift",
      fileURLToPath(new URL("./macos-application-observation.swift", import.meta.url)),
      String(processId)
    ], { timeout: 15_000 });
    return (JSON.parse(stdout) as { foregroundProcessId: number }).foregroundProcessId;
  }
  const output = await runEncodedPowerShellJson(foregroundApi + String.raw`
$foregroundPid = [uint32]0
[void][LaunchForeground]::GetWindowThreadProcessId([LaunchForeground]::GetForegroundWindow(), [ref]$foregroundPid)
@{ processId = $foregroundPid } | ConvertTo-Json -Compress
`, {}, { timeoutMilliseconds: 15_000 });
  return (JSON.parse(output) as { processId: number }).processId;
}

/** Move to a real external application before releasing deterministic navigation. */
export async function leaveLaunchInBackground(input: Readonly<{
  fixtureId: string; processId: number; windowId: string;
}>): Promise<() => Promise<void>> {
  const origin = process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!;
  const waiting = await fetch(`${origin}/api/gates/${input.fixtureId}/waiting`, {
    signal: AbortSignal.timeout(45_000)
  });
  expect(waiting.ok).toBe(true);
  await browser.waitUntil(async () =>
    (await electronDesktopE2eGameWindowRuntime(input.windowId)).currentRuntime?.focused === true,
  { timeout: 15_000, timeoutMsg: "Explicit launch did not claim foreground before navigation completed" });
  let externalProcessId: number;
  if (process.platform === "darwin") {
    const { stdout } = await execute("/usr/bin/osascript", [
      "-e", 'tell application "Finder" to activate',
      "-e", 'tell application "System Events" to get unix id of process "Finder"'
    ], { timeout: 10_000 });
    externalProcessId = Number(stdout.trim());
  } else {
    const output = await runEncodedPowerShellJson(String.raw`
${foregroundApi}
${WINDOWS_PROBE_CAPTION_HANDLERS}
$eventName = 'Local\RionLaunchForeground-' + [Guid]::NewGuid().ToString('N')
$ready = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $eventName)
$fixture = $null
try {
 $fixture = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ('"' + $payload.script + '"'), '-ReadyEventName', $eventName, '-ReadyPath', ('"' + $payload.readyPath + '"')) -RedirectStandardError ($payload.readyPath + '.stderr.log') -PassThru
 if (-not $ready.WaitOne(15000)) { throw 'External focus fixture did not signal its visible window' }
 $window = Get-Content -LiteralPath $payload.readyPath -Raw | ConvertFrom-Json
 if ($window.processId -ne $fixture.Id) { throw 'External focus fixture identity changed' }
 [RionProbeCaption]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
 $handle = [IntPtr][int64]$window.nativeWindowHandle
 [RionProbeCaption]::Click($handle, [uint32]$fixture.Id) | Out-Null
 $ack = [Diagnostics.Stopwatch]::StartNew()
 while ([LaunchForeground]::GetForegroundWindow() -ne $handle) {
  if ($ack.ElapsedMilliseconds -gt 2000) { throw 'External fixture caption click did not activate its exact HWND' }
  Start-Sleep -Milliseconds 10
 }
 @{ processId = $fixture.Id } | ConvertTo-Json -Compress
} catch {
 if ($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
 throw
} finally { $ready.Dispose() }
`, {
      script: fileURLToPath(new URL("./launch-foreground-window.ps1", import.meta.url)),
      readyPath: join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, `launch-foreground-${input.windowId}-ready.json`)
    }, {
      timeoutMilliseconds: 25_000
    });
    externalProcessId = (JSON.parse(output) as { processId: number }).processId;
  }
  expect(externalProcessId).toBeGreaterThan(1);
  expect(externalProcessId).not.toBe(input.processId);
  expect(await foregroundProcessId(input.processId)).toBe(externalProcessId);
  await fixtureRequest("/api/release", { roleId: input.fixtureId });
  return async () => {
    try {
      // Call only after the authoritative launch/navigation completion is observed.
      const completedForegroundProcessId = await foregroundProcessId(input.processId);
      const runtime = await electronDesktopE2eGameWindowRuntime(input.windowId);
      await writeFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!,
        `launch-foreground-${input.fixtureId}-${input.windowId}-${runtime.currentRuntime?.windowGeneration}.json`), JSON.stringify({
        ...input, externalProcessId, completedForegroundProcessId, runtime
      }, null, 2));
      expect(completedForegroundProcessId).toBe(externalProcessId);
      expect(runtime.currentRuntime?.focused).toBe(false);
    } finally {
      if (process.platform === "win32") {
        await runEncodedPowerShellJson(String.raw`
$fixture = Get-Process -Id $payload.processId -ErrorAction Stop
[void]$fixture.CloseMainWindow()
@{ closed = $true } | ConvertTo-Json -Compress
`, { processId: externalProcessId }, { timeoutMilliseconds: 10_000 });
      }
    }
  };
}
