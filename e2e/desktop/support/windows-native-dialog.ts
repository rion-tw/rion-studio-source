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
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
    public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public MouseInput Mouse; }
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, Input[] inputs, int size);
  public static object LastClick { get; private set; }
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
    // Keep bounds, hit testing and cursor readback in the same physical-pixel
    // space, independent of the PowerShell host's DPI-awareness default.
    IntPtr priorDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (priorDpi == IntPtr.Zero)
      throw new InvalidOperationException("native file dialog DPI context is unavailable");
    try { ClickExactVisibleControl(dialog, control, targetPid); }
    finally { SetThreadDpiAwarenessContext(priorDpi); }
  }
  private static void ClickExactVisibleControl(IntPtr dialog, IntPtr control, int targetPid) {
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
    Point actual;
    if (!SetCursorPos(point.X, point.Y) || !GetCursorPos(out actual))
      throw new InvalidOperationException("native file control pointer move was not acknowledged");
    IntPtr actualHit = WindowFromPoint(actual);
    LastClick = new { dialog = dialog.ToInt64(), control = control.ToInt64(),
      expectedX = point.X, expectedY = point.Y, actualX = actual.X, actualY = actual.Y,
      hit = actualHit.ToInt64(), foreground = GetForegroundWindow().ToInt64() };
    if (actual.X != point.X || actual.Y != point.Y ||
        (actualHit != control && !IsChild(control, actualHit)))
      throw new InvalidOperationException("native file control pointer readback differs from exact target");
    if (GetForegroundWindow() != dialog)
      throw new InvalidOperationException("native file control lost foreground before click");
    var inputs = new Input[] {
      new Input { Mouse = new MouseInput { Flags = 0x0002 } },
      new Input { Mouse = new MouseInput { Flags = 0x0004 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("native file control click was not fully submitted");
  }
  public static string WindowClass(IntPtr hwnd) {
    var name = new System.Text.StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    return name.ToString();
  }
  public static object DialogControlSnapshot(IntPtr dialog) {
    var controls = new System.Collections.Generic.List<object>();
    int inspected = 0;
    EnumChildWindows(dialog, (hwnd, parameter) => {
      if (++inspected > 128) return false;
      controls.Add(new {
        nativeWindowHandle = hwnd.ToInt64(), controlId = GetDlgCtrlID(hwnd),
        className = WindowClass(hwnd), visible = IsWindowVisible(hwnd),
        enabled = IsWindowEnabled(hwnd), exactChild = IsChild(dialog, hwnd)
      });
      return true;
    }, IntPtr.Zero);
    return new { truncated = inspected > 128, controls = controls.ToArray() };
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
