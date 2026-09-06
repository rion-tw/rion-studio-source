// Native dialog UI driver only; never used by the product runtime.
export const windowsNativeEditDeclarations = String.raw`
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)]
  private static extern IntPtr SendText(IntPtr hwnd, uint msg, UIntPtr count, string text,
    uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)]
  private static extern IntPtr ReadText(IntPtr hwnd, uint msg, UIntPtr count,
    System.Text.StringBuilder text, uint flags, uint timeout, out UIntPtr result);
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
