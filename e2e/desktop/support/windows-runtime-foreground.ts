import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

export async function focusWindowsRuntimeNativeWindow(input: Readonly<{
  processId: number; nativeWindowHandle: string;
}>, port = { platform: process.platform, run: runEncodedPowerShellJson }): Promise<void> {
  if (port.platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle)) {
    throw new Error("Native foreground requires exact Windows process and handle evidence");
  }
  await port.run(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionRuntimeForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$handle = [IntPtr][int64]$payload.nativeWindowHandle
$owner = [uint32]0
[RionRuntimeForeground]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
if ($owner -ne [uint32]$payload.processId -or
    -not [RionRuntimeForeground]::IsWindowVisible($handle)) {
  throw 'exact runtime HWND is no longer visible or owned by Rion'
}
if (-not [RionRuntimeForeground]::SetForegroundWindow($handle) -or
    [RionRuntimeForeground]::GetForegroundWindow() -ne $handle) {
  throw 'exact runtime HWND did not become foreground'
}
`, input, { timeoutMilliseconds: 30_000 });
}
