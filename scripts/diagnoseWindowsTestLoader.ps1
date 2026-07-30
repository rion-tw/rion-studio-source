$ErrorActionPreference = "Stop"

$diagnosticsDirectory = Join-Path $PWD "diagnostics/windows-test-loader"
New-Item -ItemType Directory -Force -Path $diagnosticsDirectory | Out-Null

$testBinaries = @(
  Get-ChildItem -Path "target/debug/deps" -Filter "rion_studio_lib-*.exe" -File |
    Sort-Object LastWriteTimeUtc -Descending
)
if ($testBinaries.Count -eq 0) {
  throw "The rion-tauri Windows test executable was not found."
}

$testBinary = $testBinaries[0]
$binaryDestination = Join-Path $diagnosticsDirectory $testBinary.Name
Copy-Item -LiteralPath $testBinary.FullName -Destination $binaryDestination

$pdbPath = [System.IO.Path]::ChangeExtension($testBinary.FullName, ".pdb")
if (Test-Path -LiteralPath $pdbPath) {
  Copy-Item -LiteralPath $pdbPath -Destination $diagnosticsDirectory
}

$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
if (-not (Test-Path -LiteralPath $vswherePath)) {
  throw "vswhere.exe was not found on the Windows runner."
}

$visualStudioPath = (
  & $vswherePath `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath |
    Select-Object -First 1
)
if ([string]::IsNullOrWhiteSpace($visualStudioPath)) {
  throw "A Visual Studio installation with the x64 C++ tools was not found."
}

$dumpbin = (
  Get-ChildItem -Path (Join-Path $visualStudioPath "VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe") -File |
    Sort-Object FullName -Descending |
    Select-Object -First 1
)
if ($null -eq $dumpbin) {
  throw "dumpbin.exe was not found in the Visual Studio installation."
}

Write-Host "Inspecting Windows test executable: $($testBinary.FullName)"
Write-Host "Executable SHA-256: $((Get-FileHash -LiteralPath $testBinary.FullName -Algorithm SHA256).Hash)"
Write-Host "Using dumpbin: $($dumpbin.FullName)"

$imports = @(& $dumpbin.FullName /nologo /imports $testBinary.FullName 2>&1)
$dumpbinExitCode = $LASTEXITCODE
$imports | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "imports.txt")
if ($dumpbinExitCode -ne 0) {
  throw "dumpbin failed with exit code $dumpbinExitCode."
}

$dependents = @(& $dumpbin.FullName /nologo /dependents $testBinary.FullName 2>&1)
$dumpbinExitCode = $LASTEXITCODE
$dependents | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "dependents.txt")
if ($dumpbinExitCode -ne 0) {
  throw "dumpbin dependency inspection failed with exit code $dumpbinExitCode."
}

$vcruntimeReport = [System.Collections.Generic.List[string]]::new()
$vcruntimePath = Join-Path $testBinary.DirectoryName "VCRUNTIME140.dll"
if (-not (Test-Path -LiteralPath $vcruntimePath)) {
  $vcruntimePath = "VCRUNTIME140.dll"
}

$vcruntimeHandle = [IntPtr]::Zero
try {
  $vcruntimeHandle = [System.Runtime.InteropServices.NativeLibrary]::Load($vcruntimePath)
  $loadedModule = Get-Process -Id $PID -Module |
    Where-Object { $_.ModuleName -ieq "VCRUNTIME140.dll" } |
    Select-Object -First 1
  if ($null -ne $loadedModule) {
    $vcruntimeReport.Add("Path: $($loadedModule.FileName)")
    $vcruntimeReport.Add("File version: $($loadedModule.FileVersionInfo.FileVersion)")
  } else {
    $vcruntimeReport.Add("Path: $vcruntimePath")
  }

  foreach ($symbol in @(
    "__CxxFrameHandler3",
    "_CxxThrowException",
    "__current_exception",
    "__current_exception_context"
  )) {
    $address = [IntPtr]::Zero
    $available = [System.Runtime.InteropServices.NativeLibrary]::TryGetExport(
      $vcruntimeHandle,
      $symbol,
      [ref] $address
    )
    $vcruntimeReport.Add("${symbol}: $available")
  }
} catch {
  $vcruntimeReport.Add("Load error: $($_.Exception.Message)")
} finally {
  if ($vcruntimeHandle -ne [IntPtr]::Zero) {
    [System.Runtime.InteropServices.NativeLibrary]::Free($vcruntimeHandle)
  }
}
$vcruntimeReport | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "vcruntime.txt")
