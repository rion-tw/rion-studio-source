# pnpm 12's npm-generated PowerShell shim can target an extensionless PE file,
# return exit 0 and execute no command. Select and verify the actual .exe.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native pnpm selection requires Windows.' }
if (-not $env:PNPM_HOME -or -not $env:GITHUB_PATH) {
  throw 'Native pnpm selection requires the action installation and path file.'
}
$taskManifest = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$taskExpected = $taskManifest.packageManager -replace '^pnpm@', '' -replace '\+.*$', ''
$taskCandidates = @(
  (Join-Path $env:PNPM_HOME 'bin/pnpm.exe'),
  (Join-Path (Split-Path $env:PNPM_HOME -Parent) 'pnpm/pnpm.exe')
)
$taskExecutable = $taskCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $taskExecutable) { throw 'The action did not install a native pnpm executable.' }
$taskActual = & $taskExecutable --version
if ($LASTEXITCODE -ne 0 -or "$taskActual".Trim() -ne $taskExpected) {
  throw 'The native pnpm version does not match the repository pin.'
}
# Prove that a child command actually executes; exit 0 alone is insufficient.
$taskProof = & $taskExecutable exec node -p '"rion-pnpm-child-executed"'
if ($LASTEXITCODE -ne 0 -or "$taskProof".Trim() -ne 'rion-pnpm-child-executed') {
  throw 'The native pnpm entrypoint did not execute its child command.'
}
Add-Content -LiteralPath $env:GITHUB_PATH -Value (Split-Path $taskExecutable -Parent) -Encoding utf8
Write-Output "Verified native pnpm $taskActual and child execution."
