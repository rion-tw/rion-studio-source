import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

/** Select a visible Chromium Views menu, above child WebContentsViews, by its
 * UI Automation name. This never invokes a product command or renderer bridge. */
export async function selectWindowsNativeMenuItem(input: Readonly<{
  processId: number;
  nativeWindowHandle: string;
  path: readonly string[];
  checked?: boolean;
}>): Promise<void> {
  if (process.platform !== "win32" || input.path.length === 0 || !/^[1-9]\d*$/u.test(input.nativeWindowHandle)) throw new Error("An exact Windows native menu path and HWND are required");
  await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$owner = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([long]$payload.nativeWindowHandle))
if ($null -eq $owner -or $owner.Current.ProcessId -ne [int]$payload.processId) { throw 'Native menu parent changed owner' }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function IsNativeMenuItem($item) {
  $inMenu = $false
  $ancestor = $walker.GetParent($item)
  while ($null -ne $ancestor -and -not $ancestor.Equals($owner)) {
    if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $false }
    if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu) { $inMenu = $true }
    $ancestor = $walker.GetParent($ancestor)
  }
  return $inMenu -and $null -ne $ancestor
}
$last = $payload.path.Count - 1
for ($index = 0; $index -le $last; $index++) {
  $name = [string]$payload.path[$index]
  $expiry = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $items = @($owner.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
      Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and
        $_.Current.ControlType.ProgrammaticName -in @('ControlType.MenuItem','ControlType.CheckBox','ControlType.RadioButton') -and
        (IsNativeMenuItem $_) })
    if ($items.Count -eq 1) { break }
    if ([DateTime]::UtcNow -gt $expiry) {
      $diagnostic = @($owner | ForEach-Object {
        @{ name=$_.Current.Name; class=$_.Current.ClassName; type=$_.Current.ControlType.ProgrammaticName;
          offscreen=$_.Current.IsOffscreen; items=@($_.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType.ProgrammaticName -match 'Menu|CheckBox' } |
            ForEach-Object { @{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;offscreen=$_.Current.IsOffscreen} }) }
      }) | ConvertTo-Json -Depth 6 -Compress
      throw "Exact visible native menu item '$name' unavailable ($($items.Count) matches): $diagnostic"
    }
    Start-Sleep -Milliseconds 50
  } while ($true)
  $target = $items[0]
  if ($index -lt $last) {
    $expand = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
  } else {
    $toggle = $null
    if ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
      if ($null -ne $payload.checked -and ([int]$toggle.Current.ToggleState -eq 1) -ne [bool]$payload.checked) {
        throw 'Native menu checkbox disagrees with the captured tab projection'
      }
      $toggle.Toggle()
    } else {
      $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $invoke.Invoke()
    }
  }
}
@{ selected = $payload.path } | ConvertTo-Json -Compress
`, { ...input, checked: input.checked ?? null }, { timeoutMilliseconds: 30_000 });
}
