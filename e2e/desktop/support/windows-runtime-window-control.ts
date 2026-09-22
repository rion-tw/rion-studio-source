import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

/** Invoke the exact visible host control without enumerating gated Chromium pages. */
export async function pressWindowsRuntimeWindowControl(input: Readonly<{
  processId: number;
  nativeWindowHandle: string;
  command: "maximize" | "minimize";
}>): Promise<void> {
  if (process.platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle)) {
    throw new Error("Native window control requires exact Windows HWND and process evidence");
  }
  const controlName = input.command === "maximize"
    ? "Maximize or restore Game Window" : "Minimize Game Window";
  await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::FromHandle(
  [IntPtr]::new([long]$payload.nativeWindowHandle))
if ($null -eq $window -or $window.Current.ProcessId -ne [int]$payload.processId -or
    $window.Current.IsOffscreen) { throw 'Exact runtime window is no longer visible or owned' }
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, [string]$payload.controlName)
$buttons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
  Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
    $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
if ($buttons.Count -ne 1) { throw 'Exact visible runtime window control is not unique' }
$invoke = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
@{ submitted = $true } | ConvertTo-Json -Compress
`, { ...input, controlName }, { timeoutMilliseconds: 30_000 });
}
