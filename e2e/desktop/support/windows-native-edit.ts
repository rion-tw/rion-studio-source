// Native dialog UI driver only; never used by the product runtime.
export const windowsNativeEditDeclarations = String.raw`
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)]
  private static extern IntPtr SendText(IntPtr hwnd, uint msg, UIntPtr count, string text,
    uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)]
  private static extern IntPtr ReadText(IntPtr hwnd, uint msg, UIntPtr count,
    System.Text.StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  private delegate bool EnumChildCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(
    IntPtr parent, EnumChildCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(
    IntPtr hwnd, System.Text.StringBuilder name, int capacity);
  public static IntPtr[] ExactDialogControls(IntPtr dialog, int controlId, string className) {
    var dialogClass = new System.Text.StringBuilder(256);
    if (dialog == IntPtr.Zero || GetClassName(dialog, dialogClass, dialogClass.Capacity) == 0 ||
        dialogClass.ToString() != "#32770")
      throw new InvalidOperationException("exact native common dialog is unavailable");
    var matches = new System.Collections.Generic.List<IntPtr>();
    int inspected = 0;
    // Enumerate only real HWND children of the already owner-admitted dialog.
    // UIA descendant traversal can enter shell list providers unrelated to the
    // two standard controls and block before returning any bounded evidence.
    EnumChildWindows(dialog, (hwnd, parameter) => {
      if (++inspected > 2048) return false;
      if (GetDlgCtrlID(hwnd) != controlId || !IsChild(dialog, hwnd)) return true;
      var name = new System.Text.StringBuilder(256);
      if (GetClassName(hwnd, name, name.Capacity) != 0 && name.ToString() == className)
        matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    if (inspected > 2048)
      throw new InvalidOperationException("native common dialog control bound exceeded");
    return matches.ToArray();
  }
  public static void SetExactFileName(IntPtr dialog, IntPtr edit, string text) {
    if (edit == IntPtr.Zero || !IsChild(dialog, edit) || GetForegroundWindow() != dialog)
      throw new InvalidOperationException("exact native file-name ownership lost");
    UIntPtr result;
    // External UI acknowledgement deadline: failure or unknown acknowledgement never succeeds.
    if (SendText(edit, 0x000C, UIntPtr.Zero, text, 0x22, 2000, out result) == IntPtr.Zero ||
        result == UIntPtr.Zero)
      throw new InvalidOperationException("native file-name write was not acknowledged");
    var readback = new System.Text.StringBuilder(text.Length + 2);
    if (ReadText(edit, 0x000D, new UIntPtr((uint)readback.Capacity), readback, 0x22, 2000,
        out result) == IntPtr.Zero || !String.Equals(readback.ToString(), text, StringComparison.Ordinal))
      throw new InvalidOperationException("native file-name readback differs from fixture path");
    if (!IsChild(dialog, edit) || GetForegroundWindow() != dialog)
      throw new InvalidOperationException("exact native file-name ownership changed");
  }
`;
