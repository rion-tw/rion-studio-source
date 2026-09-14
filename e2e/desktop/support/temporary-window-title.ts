import { expect } from "@wdio/globals";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eFullscreenToolbarRuntime } from "./electron-driver";

export async function verifyTemporaryWindowTitle(input: Readonly<{
  platform: "macos" | "windows"; processId: number; windowId: string;
}>): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  if (input.platform === "macos") {
    expect(inspection.native.appKit?.windowNameOnScreen).toBe(false);
  } else {
    if (!inspection.nativeWindowHandle) throw new Error("Missing exact temporary HWND");
    const title = await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RionWindowTitle {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
}
'@
$handle = [IntPtr]::new([long]$payload.nativeHandle)
$owner = [uint32]0
[RionWindowTitle]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
if ($owner -ne [uint32]$payload.processId) { throw 'The exact title HWND owner changed' }
$title = New-Object System.Text.StringBuilder 256
[RionWindowTitle]::GetWindowText($handle, $title, 256) | Out-Null
@{ title = $title.ToString() } | ConvertTo-Json -Compress
`, { nativeHandle: inspection.nativeWindowHandle, processId: input.processId }, { timeoutMilliseconds: 10_000 });
    expect(JSON.parse(title)).toEqual({ title: "" });
  }
}
