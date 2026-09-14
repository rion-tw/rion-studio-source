Add-Type -AssemblyName System.Windows.Forms
$fixtureWindow = New-Object System.Windows.Forms.Form
$fixtureWindow.Text = 'Rion E2E external foreground fixture'
$fixtureWindow.Width = 480
$fixtureWindow.Height = 240
$fixtureWindow.StartPosition = 'CenterScreen'
[void]$fixtureWindow.ShowDialog()
$fixtureWindow.Dispose()
