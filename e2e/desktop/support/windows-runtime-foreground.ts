import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

export async function focusWindowsRuntimeNativeWindow(input: Readonly<{
  processId: number; nativeWindowHandle: string;
  pointerTarget?: "reveal-edge" | "content";
}>, port = { platform: process.platform, run: runEncodedPowerShellJson }): Promise<void> {
  if (port.platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle) ||
      (input.pointerTarget !== undefined && !["reveal-edge", "content"].includes(input.pointerTarget))) {
    throw new Error("Native foreground requires exact Windows process and handle evidence");
  }
  await port.run(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionRuntimeForeground {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
  public static void MovePointer(IntPtr hwnd, bool edge) {
    Rect rect;
    if (!GetClientRect(hwnd, out rect) || rect.right - rect.left < 4 || rect.bottom - rect.top < 4)
      throw new InvalidOperationException("exact runtime client bounds unavailable");
    var point = new Point { x = (rect.left + rect.right) / 2,
      y = edge ? rect.top + 1 : (rect.top + rect.bottom) / 2 };
    if (!ClientToScreen(hwnd, ref point) || !SetCursorPos(point.x, point.y))
      throw new InvalidOperationException("native pointer move was not acknowledged");
    Point actual;
    if (!GetCursorPos(out actual) || actual.x != point.x || actual.y != point.y ||
        GetForegroundWindow() != hwnd)
      throw new InvalidOperationException("native pointer or foreground readback differs");
  }
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
if ($payload.pointerTarget -ne 'none') {
  [RionRuntimeForeground]::MovePointer($handle, $payload.pointerTarget -eq 'reveal-edge')
}
`, { ...input, pointerTarget: input.pointerTarget ?? "none" }, { timeoutMilliseconds: 30_000 });
}
