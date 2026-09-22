// Native UI test input; UTF-16 packets avoid SendKeys/layout interpretation.
export const windowsNativeTextInputDeclarations = String.raw`
public static class RionFileNameKeyboard {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct Keyboard { public ushort key, scan; public uint flags, time; public System.UIntPtr extra; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct Mouse { public int x, y; public uint data, flags, time; public System.UIntPtr extra; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
  private struct Payload {
    [System.Runtime.InteropServices.FieldOffset(0)] public Keyboard keyboard;
    [System.Runtime.InteropServices.FieldOffset(0)] public Mouse mouse;
  }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct Input { public uint type; public Payload payload; }
  [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, Input[] inputs, int size);
  private static Input Key(ushort key, ushort scan, uint flags) {
    return new Input { type = 1, payload = new Payload { keyboard = new Keyboard {
      key = key, scan = scan, flags = flags
    } } };
  }
  public static void Replace(string text) {
    var inputs = new System.Collections.Generic.List<Input> {
      Key(0x11, 0, 0), Key(0x41, 0, 0), Key(0x41, 0, 2), Key(0x11, 0, 2)
    };
    foreach (char character in text) {
      inputs.Add(Key(0, character, 4));
      inputs.Add(Key(0, character, 6));
    }
    int size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Input));
    if (SendInput((uint)inputs.Count, inputs.ToArray(), size) != inputs.Count) {
      SendInput(2, new[] { Key(0x41, 0, 2), Key(0x11, 0, 2) }, size);
      throw new System.InvalidOperationException("native filename input was not fully submitted");
    }
  }
}
`;
