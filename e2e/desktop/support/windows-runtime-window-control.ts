import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

/** Invoke the exact visible host control without enumerating gated Chromium pages. */
export async function pressWindowsRuntimeWindowControl(input: Readonly<{
  processId: number;
  nativeWindowHandle: string;
  command: "maximize" | "minimize" | "openLauncher" | "toggleFullscreen";
}>): Promise<void> {
  if (process.platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle)) {
    throw new Error("Native window control requires exact Windows HWND and process evidence");
  }
  const controlNames = input.command === "toggleFullscreen" ? ["Enter full screen", "Exit full screen"]
    : input.command === "openLauncher" ? ["Open role or workspace"] : input.command === "maximize"
    ? ["Maximize or restore Game Window", "Maximize window", "Restore window"] : ["Minimize Game Window", "Minimize window"];
  await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::FromHandle(
  [IntPtr]::new([long]$payload.nativeWindowHandle))
if ($null -eq $window -or $window.Current.ProcessId -ne [int]$payload.processId -or
    $window.Current.IsOffscreen) { throw 'Exact runtime window is no longer visible or owned' }
$condition = [System.Windows.Automation.Condition]::TrueCondition
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
$buttons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
  Where-Object { $payload.controlNames -contains $_.Current.Name -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
    $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
if ($buttons.Count -eq 1) { break }
if ([DateTime]::UtcNow -gt $expiry) { throw 'Exact visible runtime window control is not unique' }
Start-Sleep -Milliseconds 50
} while ($true)
if ($payload.command -eq 'toggleFullscreen') {
  # aria-pressed exposes the real fullscreen button as a UIA toggle button.
  $toggle = $buttons[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  $toggle.Toggle()
} else {
  $invoke = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
}
@{ submitted = $true } | ConvertTo-Json -Compress
`, { ...input, controlNames }, { timeoutMilliseconds: 30_000 });
}
