$ErrorActionPreference = 'Stop'
# Native test driver only. The caller supplies the exact Electron HWND.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShortcutProbeInput {
  [StructLayout(LayoutKind.Sequential)] public struct Mouse {
    public int x, y; public uint data, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard {
    public ushort key, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct Payload {
    [FieldOffset(0)] public Mouse mouse;
    [FieldOffset(0)] public Keyboard keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type; public Payload payload;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint key, uint mode);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  public static bool Send(ushort key, bool up) {
    var input = new Input { type = 1, payload = new Payload {
      keyboard = new Keyboard { scan = (ushort)MapVirtualKey(key, 0), flags = 8u | (up ? 2u : 0u) }
    }};
    return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) == 1;
  }
}
'@
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $line | ConvertFrom-Json
  try {
    $handle = [IntPtr]::new([long]$request.handle)
    $ownerProcess = [uint32]0
    [ShortcutProbeInput]::GetWindowThreadProcessId($handle, [ref]$ownerProcess) | Out-Null
    if ($ownerProcess -ne [uint32]$request.processId) { throw 'Exact HWND/PID mismatch' }
    if ($request.focus) {
      [ShortcutProbeInput]::SetForegroundWindow($handle) | Out-Null
    }
    if ([ShortcutProbeInput]::GetForegroundWindow() -ne $handle) { throw 'Exact target is not foreground' }
    foreach ($key in $request.keys) {
      if (-not [ShortcutProbeInput]::Send([System.UInt16]$key.code, [bool]$key.up)) {
        throw 'SendInput did not insert the exact event'
      }
    }
    [Console]::Out.WriteLine((@{ id = $request.id; inserted = @($request.keys).Count } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $request.id; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
