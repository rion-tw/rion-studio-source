import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";
import { WINDOWS_PACKAGED_FOREGROUND_HANDLERS } from "../scripts/packagedElectronWindowsForeground.mjs";
import { WINDOWS_PROBE_CAPTION_HANDLERS } from "../scripts/electronWindowsProbeInitialClick.mjs";

describe.runIf(process.platform === "win32")("packaged native foreground ownership", () => {
  it("activates an exact native HWND without requiring a focusable UIA root", async () => {
    const result = await runEncodedPowerShellJson(String.raw`
${WINDOWS_PACKAGED_FOREGROUND_HANDLERS}
${WINDOWS_PROBE_CAPTION_HANDLERS}
Add-Type -AssemblyName System.Windows.Forms
$priorDpi = [RionProbeCaption]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($priorDpi -eq [IntPtr]::Zero) { throw 'Fixture DPI context is unavailable.' }
$target = New-Object System.Windows.Forms.Form
$other = New-Object System.Windows.Forms.Form
try {
  $target.Text = 'Rion exact foreground fixture'
  $other.Text = 'Rion foreground decoy fixture'
  # Leave a caption hit target between the icon and buttons at high DPI.
  $other.Width = 800
  $target.Show()
  # The hidden PowerShell startup overrides the first native ShowWindow call.
  # Establish a genuinely visible fixture; the production visibility guard stays strict.
  $target.Hide()
  $target.Show()
  $other.TopMost = $true
  $other.Show()
  [System.Windows.Forms.Application]::DoEvents()
  # A background runner has no foreground grant. Process one real caption
  # click before testing native activation, then require exact native readback.
  if ([RionPackagedForeground]::GetForegroundWindow() -ne $other.Handle) {
    [RionProbeCaption]::Click($other.Handle, [uint32]$PID) | Out-Null
    [System.Windows.Forms.Application]::DoEvents()
    # Arrange the fixture's active Form after the process receives input. These
    # Forms have no Application.Run context to perform startup activation; the
    # desktop can otherwise retain a null foreground between fixture processes.
    $other.Activate()
    # SendInput queues native input. Pump the fixture until Windows reports
    # exact activation; one immediate DoEvents can run before input is queued.
    # This deadline only fails the precondition, never grants foreground.
    $activationWait = [System.Diagnostics.Stopwatch]::StartNew()
    while ([RionPackagedForeground]::GetForegroundWindow() -ne $other.Handle -and
        $activationWait.ElapsedMilliseconds -lt 2000) {
      [System.Windows.Forms.Application]::DoEvents()
      [System.Threading.Thread]::Sleep(1)
    }
  }
  if ([RionPackagedForeground]::GetForegroundWindow() -ne $other.Handle) {
    $foreground = [RionPackagedForeground]::GetForegroundWindow()
    $foregroundOwner = [uint32]0
    [RionProbeCaption]::GetWindowThreadProcessId($foreground, [ref]$foregroundOwner) | Out-Null
    throw ('The foreground fixture did not receive native activation: ' +
      (@{ foreground=$foreground.ToInt64(); foregroundOwner=$foregroundOwner;
        target=$target.Handle.ToInt64(); other=$other.Handle.ToInt64(); owner=$PID;
        otherState=[string]$other.WindowState; capture=$other.Capture } | ConvertTo-Json -Compress))
  }
  $other.TopMost = $false
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
} finally {
  $other.Dispose(); $target.Dispose()
  [RionProbeCaption]::SetThreadDpiAwarenessContext($priorDpi) | Out-Null
}
`, {}, { timeoutMilliseconds: 8000 });
    expect(JSON.parse(result)).toEqual({
      oldRejected: true, exact: true,
      rejections: ["uia-owner", "native-owner", "hidden", "retired"]
    });
  });
});
