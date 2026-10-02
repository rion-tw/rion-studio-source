import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

const keyboard = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionNumLock {
  [DllImport("user32.dll")] private static extern short GetKeyState(int key);
  [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static bool Enabled() { return (GetKeyState(0x90) & 1) != 0; }
  public static void Toggle() {
    keybd_event(0x90, 0x45, 1, UIntPtr.Zero);
    keybd_event(0x90, 0x45, 3, UIntPtr.Zero);
  }
}
'@
$previous = [RionNumLock]::Enabled()
if ($null -ne $payload.enabled -and $previous -ne [bool]$payload.enabled) {
  [RionNumLock]::Toggle()
}
@{ previous = $previous } | ConvertTo-Json -Compress
`;

async function state(enabled?: boolean): Promise<boolean> {
  const result = JSON.parse(await runEncodedPowerShellJson(keyboard,
    { enabled: enabled ?? null }, { timeoutMilliseconds: 10_000 }));
  if (typeof result.previous !== "boolean") throw new Error("Windows NumLock state unavailable");
  return result.previous;
}

async function setState(enabled: boolean): Promise<void> {
  await state(enabled);
  if (await state() !== enabled) throw new Error(`Windows NumLock did not become ${enabled}`);
}

/** Numeric keypad input requires NumLock. Keep this native test precondition
 * until the application receipt, then restore it even when the assertion fails. */
export async function withWindowsNumLock<T>(action: () => Promise<T>): Promise<T> {
  if (process.platform !== "win32") throw new Error("NumLock fixture requires Windows");
  const previous = await state();
  try {
    await setState(true);
    return await action();
  } finally {
    await setState(previous);
  }
}
