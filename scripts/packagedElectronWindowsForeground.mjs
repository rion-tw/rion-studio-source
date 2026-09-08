// UIA identifies the exact window; native foreground ownership determines where
// trusted keyboard input goes. A top-level UIA element need not accept SetFocus.
export const WINDOWS_PACKAGED_FOREGROUND_HANDLERS = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionPackagedForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static void Activate(IntPtr hwnd, uint expectedPid) {
    uint owner;
    uint thread = GetWindowThreadProcessId(hwnd, out owner);
    bool visible = IsWindowVisible(hwnd);
    if (hwnd == IntPtr.Zero || expectedPid <= 1 ||
        thread == 0 || owner != expectedPid || !visible)
      throw new InvalidOperationException("Packaged HWND " + hwnd + " is not visible or owned by PID " + expectedPid +
        "; observed PID=" + owner + ", visible=" + visible + ".");
    if (GetForegroundWindow() != hwnd && !SetForegroundWindow(hwnd))
      throw new InvalidOperationException("Packaged HWND " + hwnd + " could not become foreground for PID " + expectedPid + ".");
    if (GetForegroundWindow() != hwnd ||
        GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != expectedPid)
      throw new InvalidOperationException("Packaged HWND " + hwnd + " lost exact foreground ownership for PID " + expectedPid + ".");
  }
}
'@
function Rion-ForegroundWindow($window, [uint32]$processId) {
  if ([uint32]$window.Current.ProcessId -ne $processId) {
    throw "packaged UIA window process identity differs"
  }
  [RionPackagedForeground]::Activate([IntPtr][int64]$window.Current.NativeWindowHandle, $processId)
}
`;
