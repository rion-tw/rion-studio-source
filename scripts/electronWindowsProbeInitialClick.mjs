import { runEncodedPowerShellJson } from "./encodedPowerShell.mjs";

/** One visible caption click establishes the probe's foreground precondition. */
export async function clickWindowsProbeCaption({ processId, nativeWindowHandle },
  port = { platform: process.platform, run: runEncodedPowerShellJson }) {
  if (port.platform !== "win32" || !Number.isSafeInteger(processId) || processId <= 1 ||
      !/^[1-9][0-9]*$/u.test(nativeWindowHandle)) {
    throw new Error("Probe activation requires an exact Windows process and HWND.");
  }
  return JSON.parse(await port.run(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionProbeCaption {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int x, y; public uint data, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouse; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] input, int size);
  public static Point Click(IntPtr hwnd, uint expectedPid) {
    uint owner; Rect rect; var origin = new Point();
    GetWindowThreadProcessId(hwnd, out owner);
    if (owner != expectedPid || !IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out rect) ||
        !ClientToScreen(hwnd, ref origin) || origin.y <= rect.top)
      throw new InvalidOperationException("The exact visible probe caption is unavailable.");
    var point = new Point { x = (rect.left + rect.right) / 2, y = (rect.top + origin.y) / 2 };
    var packed = new IntPtr(unchecked((int)(((uint)point.y & 0xffff) << 16 | ((uint)point.x & 0xffff))));
    if (GetAncestor(WindowFromPoint(point), 2) != hwnd || SendMessage(hwnd, 0x0084, IntPtr.Zero, packed).ToInt64() != 2)
      throw new InvalidOperationException("The exact probe title bar is occluded or no longer under the pointer target.");
    Point actual;
    if (!SetCursorPos(point.x, point.y) || !GetCursorPos(out actual) ||
        actual.x != point.x || actual.y != point.y || GetAncestor(WindowFromPoint(actual), 2) != hwnd)
      throw new InvalidOperationException("The probe caption pointer target changed.");
    var inputs = new Input[] {
      new Input { mouse = new MouseInput { flags = 0x0002 } },
      new Input { mouse = new MouseInput { flags = 0x0004 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("The visible probe caption click was not fully submitted.");
    return point;
  }
}
'@
$priorDpi = [RionProbeCaption]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($priorDpi -eq [IntPtr]::Zero) { throw 'Probe caption DPI context is unavailable.' }
try {
  $point = [RionProbeCaption]::Click([IntPtr][int64]$payload.nativeWindowHandle, [uint32]$payload.processId)
  @{ processId=$payload.processId; nativeWindowHandle=$payload.nativeWindowHandle; x=$point.x; y=$point.y; submittedEventCount=2 } | ConvertTo-Json -Compress
} finally {
  [RionProbeCaption]::SetThreadDpiAwarenessContext($priorDpi) | Out-Null
}
`, { processId, nativeWindowHandle }, { timeoutMilliseconds: 30_000 }));
}
