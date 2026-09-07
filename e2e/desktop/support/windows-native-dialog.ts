import { windowsNativeEditDeclarations } from "./windows-native-edit";

// Native common-dialog UI driver shared by upload and diagnostic cancellation.
export const windowsNativeDialogDeclarations = String.raw`
using System;
using System.Runtime.InteropServices;
public static class RionFileDialogOwnership {
${windowsNativeEditDeclarations}
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  private delegate bool WindowCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  public static void ClickVisibleControl(IntPtr dialog, IntPtr control, int targetPid) {
    uint pid, ownerPid;
    GetWindowThreadProcessId(dialog, out pid);
    GetWindowThreadProcessId(GetWindow(dialog, 4), out ownerPid);
    Rect bounds;
    if ((pid != targetPid && ownerPid != targetPid) || WindowClass(dialog) != "#32770" ||
        !IsChild(dialog, control) || !IsWindowVisible(dialog) || !IsWindowVisible(control) ||
        !IsWindowEnabled(control) || GetForegroundWindow() != dialog ||
        !GetWindowRect(control, out bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top)
      throw new InvalidOperationException("exact Windows file dialog controls are not visibly actionable");
    var point = new Point { X = bounds.Left + (bounds.Right - bounds.Left) / 2,
      Y = bounds.Top + (bounds.Bottom - bounds.Top) / 2 };
    IntPtr hit = WindowFromPoint(point);
    if (hit != control && !IsChild(control, hit))
      throw new InvalidOperationException("native file control is occluded at its click point");
    if (!SetCursorPos(point.X, point.Y) || GetForegroundWindow() != dialog)
      throw new InvalidOperationException("native file control lost foreground before click");
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static string WindowClass(IntPtr hwnd) {
    var name = new System.Text.StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    return name.ToString();
  }
  public static IntPtr[] OwnedWindows(int targetPid, bool dialogsOnly) {
    var matches = new System.Collections.Generic.List<IntPtr>();
    int inspected = 0;
    bool enumerated = EnumWindows((hwnd, parameter) => {
      if (++inspected > 4096) return false;
      uint pid, ownerPid;
      GetWindowThreadProcessId(hwnd, out pid);
      GetWindowThreadProcessId(GetWindow(hwnd, 4), out ownerPid);
      if (pid != targetPid && ownerPid != targetPid) return true;
      if (dialogsOnly && (!IsWindowVisible(hwnd) || WindowClass(hwnd) != "#32770")) return true;
      matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    if (!enumerated || inspected > 4096)
      throw new InvalidOperationException("native window enumeration failed or exceeded its bound");
    return matches.ToArray();
  }

}
`;
