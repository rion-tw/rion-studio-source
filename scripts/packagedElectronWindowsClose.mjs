export const WINDOWS_PACKAGED_CLOSE_HANDLERS = String.raw`
function Rion-CloseRoleWindow($window, [uint32]$processId) {
  if ($processId -le 1 -or $window.Current.ProcessId -ne $processId -or
      [int64]$window.Current.NativeWindowHandle -eq 0) {
    throw "exact native role close owner unavailable"
  }
  $buttons = @(Rion-ButtonByName $window "Close Game Window")
  if ($buttons.Count -ne 1) { throw "exact visible role close button unavailable" }
  $button = $buttons[0]
  if (-not $button.Current.IsEnabled -or $button.Current.IsOffscreen) {
    throw "role close button is not visibly actionable"
  }
  # The visible chrome action enters the Rust-owned window-control lane.
  # WindowPattern.Close instead reaches the deliberately guarded native event.
  $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
}
`;
