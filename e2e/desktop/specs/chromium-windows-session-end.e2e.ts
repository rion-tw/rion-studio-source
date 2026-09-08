import { readFile, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browser, expect } from "@wdio/globals";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe } from "../support/electron-driver";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi } from "../support/ui";

// [journey:CHROMIUM-WINDOWS-SESSION-END-DRAIN-034]
// Native-message injection into the exact test app; not an actual OS sign-out.
describe("Windows native session-end drain", () => {
  it("routes WM_QUERYENDSESSION through one Electron listener and flushes Core", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.platform).toBe("windows");
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
    if (!directory) throw new Error("Session-end evidence directory is required");
    const target = await browser.electron.execute((electron) => {
      const windows = electron.BrowserWindow.getAllWindows().filter(window =>
        window.isVisible() && window.listenerCount("query-session-end") > 0);
      if (windows.length !== 1) throw new Error("Expected one exact session-end window");
      const window = windows[0]!;
      const handle = window.getNativeWindowHandle();
      return {
        windowId: window.id,
        webContentsId: window.webContents.id,
        hwnd: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
        listenerCount: window.listenerCount("query-session-end")
      };
    });
    expect(target.listenerCount).toBe(1);
    await writeFile(join(directory, "windows-session-end-target.json"), JSON.stringify({
      ...target, processId: probe.processId, actualOsSignOut: false,
      ingress: "Win32 WM_QUERYENDSESSION", directControllerCall: false
    }, null, 2));
    // Install the file event subscription before the native notification. The
    // runner separately validates the final-flush marker and exact process exit.
    const changeAbort = new AbortController();
    const changes = watch(directory, {
      signal: AbortSignal.any([changeAbort.signal, AbortSignal.timeout(30_000)])
    });
    const firstChange = changes.next();
    void firstChange.catch(() => undefined);
    process.env.RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT = "1";
    try {
      const receipt = await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionSessionEndNotification {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(
    IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$handle = [IntPtr]::new([Int64]$payload.hwnd)
$owner = [uint32]0
[RionSessionEndNotification]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
if ($owner -ne [uint32]$payload.processId -or -not [RionSessionEndNotification]::IsWindowVisible($handle)) {
  throw 'exact session-end PID/HWND is unavailable'
}
$result = [UIntPtr]::Zero
$delivered = [RionSessionEndNotification]::SendMessageTimeout(
  $handle, 0x0011, [UIntPtr]::Zero, [IntPtr]::new(2147483648), 2, 10000, [ref]$result)
if ($delivered -eq [IntPtr]::Zero) { throw 'WM_QUERYENDSESSION acknowledgement unavailable' }
if ($result -ne [UIntPtr]::Zero) { throw 'session-end was not fenced behind Core drain' }
[ordered]@{ processId = $owner; hwnd = [string]$payload.hwnd; message = 'WM_QUERYENDSESSION';
  acknowledged = $true; prevented = $true; actualOsSignOut = $false } | ConvertTo-Json -Compress
`, { ...target, processId: probe.processId }, { timeoutMilliseconds: 15_000 });
      await writeFile(join(directory, "windows-session-end-native-receipt.json"),
        JSON.stringify(JSON.parse(receipt), null, 2));
      const readMarker = async () => JSON.parse(await readFile(join(directory, "electron-final-flush.json"), "utf8"));
      let marker;
      try { marker = await readMarker(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!marker) {
        let change = await firstChange;
        while (!change.done) {
          if (change.value.filename === "electron-final-flush.json") {
            marker = await readMarker();
            break;
          }
          change = await changes.next();
        }
      }
      expect(marker).toMatchObject({ complete: true, pid: probe.processId,
        phase: "chromium-windows-session-end", runtimeTarget: "chromium-v23-windows" });
    } finally {
      changeAbort.abort();
      await changes.return?.();
    }
  });
});
