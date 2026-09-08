import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";
import { WINDOWS_PACKAGED_FOREGROUND_HANDLERS } from "../scripts/packagedElectronWindowsForeground.mjs";

describe.runIf(process.platform === "win32")("packaged native foreground ownership", () => {
  it("activates an exact native HWND without requiring a focusable UIA root", async () => {
    const result = await runEncodedPowerShellJson(String.raw`
${WINDOWS_PACKAGED_FOREGROUND_HANDLERS}
Add-Type -AssemblyName System.Windows.Forms
$target = New-Object System.Windows.Forms.Form
$other = New-Object System.Windows.Forms.Form
try {
  $target.Text = 'Rion exact foreground fixture'
  $other.Text = 'Rion foreground decoy fixture'
  $target.Show()
  # The hidden PowerShell startup overrides the first native ShowWindow call.
  # Establish a genuinely visible fixture; the production visibility guard stays strict.
  $target.Hide()
  $target.Show()
  $other.Show()
  [System.Windows.Forms.Application]::DoEvents()
  # Replay the hosted UIA root's unsupported SetFocus boundary. HWND, owner,
  # visibility, foreground activation and readback use actual Windows objects.
  $projection = [pscustomobject]@{ Current = [pscustomobject]@{
    ProcessId = $PID; NativeWindowHandle = $target.Handle.ToInt64()
  }}
  $projection | Add-Member ScriptMethod SetFocus { throw 'Target element cannot receive focus.' }
  $oldRejected = $false
  try { $projection.SetFocus() } catch { $oldRejected = $true }
  Rion-ForegroundWindow $projection $PID
  $exact = [RionPackagedForeground]::GetForegroundWindow() -eq $target.Handle
  $rejections = @()
  try { Rion-ForegroundWindow $projection ($PID + 1) } catch { $rejections += 'uia-owner' }
  try { [RionPackagedForeground]::Activate($target.Handle, ($PID + 1)) } catch { $rejections += 'native-owner' }
  $target.Hide()
  try { Rion-ForegroundWindow $projection $PID } catch { $rejections += 'hidden' }
  $target.Close()
  try { Rion-ForegroundWindow $projection $PID } catch { $rejections += 'retired' }
  @{ oldRejected=$oldRejected; exact=$exact; rejections=$rejections } | ConvertTo-Json -Compress
} finally { $other.Dispose(); $target.Dispose() }
`, {}, { timeoutMilliseconds: 8000 });
    expect(JSON.parse(result)).toEqual({
      oldRejected: true, exact: true,
      rejections: ["uia-owner", "native-owner", "hidden", "retired"]
    });
  });
});
