param([Parameter(Mandatory)][string]$ReadyEventName, [Parameter(Mandatory)][string]$ReadyPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$ready = [Threading.EventWaitHandle]::OpenExisting($ReadyEventName)
$fixtureWindow = New-Object System.Windows.Forms.Form
$fixtureWindow.Text = 'Rion E2E external foreground fixture'
$fixtureWindow.Width = 800
$fixtureWindow.Height = 240
$fixtureWindow.StartPosition = 'CenterScreen'
$fixtureWindow.TopMost = $true
try {
  # Hidden PowerShell startup can suppress the first native ShowWindow call.
  $fixtureWindow.Show()
  $fixtureWindow.Hide()
  $fixtureWindow.Show()
  [System.Windows.Forms.Application]::DoEvents()
  [IO.File]::WriteAllText($ReadyPath, (@{
    processId=$PID; nativeWindowHandle=$fixtureWindow.Handle.ToInt64()
  } | ConvertTo-Json -Compress))
  [void]$ready.Set()
  [System.Windows.Forms.Application]::Run($fixtureWindow)
} finally { $fixtureWindow.Dispose(); $ready.Dispose() }
