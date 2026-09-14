import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browser, expect } from "@wdio/globals";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
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
$fixture = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-STA', '-File', ('"' + $payload.script + '"')) -PassThru
if (-not $fixture.WaitForInputIdle(15000)) { throw 'External focus fixture did not create its window' }
if (-not (New-Object -ComObject WScript.Shell).AppActivate($fixture.Id)) { throw 'External fixture activation failed' }
@{ processId = $fixture.Id } | ConvertTo-Json -Compress
`, { script: fileURLToPath(new URL("./launch-foreground-window.ps1", import.meta.url)) }, {
      timeoutMilliseconds: 20_000
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
