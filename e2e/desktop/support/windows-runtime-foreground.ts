import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

export async function focusWindowsRuntimeNativeWindow(input: Readonly<{
  processId: number; nativeWindowHandle: string;
  pointerTarget?: "reveal-edge" | "content" | "content-click";
}>, port = { platform: process.platform, run: runEncodedPowerShellJson }): Promise<void> {
  if (port.platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle) ||
      (input.pointerTarget !== undefined && !["reveal-edge", "content", "content-click"].includes(input.pointerTarget))) {
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
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int x, y;
    public uint data, flags, time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type;
    public MouseInput mouse;
  }
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, Input[] inputs, int size);
  public static void ClickPointer(IntPtr hwnd) {
    Point point;
    if (!GetCursorPos(out point) || GetForegroundWindow() != hwnd ||
        GetAncestor(WindowFromPoint(point), 2) != hwnd)
      throw new InvalidOperationException("exact runtime content is not under the native pointer");
    var inputs = new Input[] {
      new Input { type = 0, mouse = new MouseInput { flags = 0x0002 } },
      new Input { type = 0, mouse = new MouseInput { flags = 0x0004 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("native content click was not fully submitted");
  }

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
  if ($payload.pointerTarget -eq 'content-click') {
    [RionRuntimeForeground]::ClickPointer($handle)
  }
}
`, { ...input, pointerTarget: input.pointerTarget ?? "none" }, { timeoutMilliseconds: 30_000 });
}
