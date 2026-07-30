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

$headers = @(& $dumpbin.FullName /nologo /headers $testBinary.FullName 2>&1)
$dumpbinExitCode = $LASTEXITCODE
$headers | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "headers.txt")
if ($dumpbinExitCode -ne 0) {
  throw "dumpbin header inspection failed with exit code $dumpbinExitCode."
}

$importMap = [ordered]@{}
$currentDll = $null
$readingSymbols = $false
foreach ($line in $imports) {
  if ($line -match '^\s{4}(?<dll>[A-Za-z0-9_.-]+\.dll)\s*$') {
    $currentDll = $Matches.dll
    $readingSymbols = $false
    if (-not $importMap.Contains($currentDll)) {
      $importMap[$currentDll] = [System.Collections.Generic.List[string]]::new()
    }
    continue
  }
  if ($null -ne $currentDll -and $line -match 'Index of first forwarder reference') {
    $readingSymbols = $true
    continue
  }
  if ($readingSymbols -and $line -match '^\s+[0-9A-F]+\s+(?<symbol>[^\s]+)\s*$') {
    $importMap[$currentDll].Add($Matches.symbol)
    continue
  }
  if ($line -match '^\s*Summary\s*$') {
    $currentDll = $null
    $readingSymbols = $false
  }
}

$importReport = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $importMap.GetEnumerator()) {
  $dll = $entry.Key
  $candidate = Join-Path $testBinary.DirectoryName $dll
  if (-not (Test-Path -LiteralPath $candidate)) {
    $candidate = $dll
  }
  $handle = [IntPtr]::Zero
  try {
    $handle = [System.Runtime.InteropServices.NativeLibrary]::Load($candidate)
    $importReport.Add("${dll}: loaded")
    foreach ($symbol in $entry.Value) {
      $address = [IntPtr]::Zero
      $available = [System.Runtime.InteropServices.NativeLibrary]::TryGetExport(
        $handle,
        $symbol,
        [ref] $address
      )
      $importReport.Add("  ${symbol}: $available")
    }
  } catch {
    $importReport.Add("${dll}: load failed: $($_.Exception.Message)")
  } finally {
    if ($handle -ne [IntPtr]::Zero) {
      [System.Runtime.InteropServices.NativeLibrary]::Free($handle)
    }
  }
}
$importReport | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "import-probe.txt")

$manifestReport = [System.Collections.Generic.List[string]]::new()
$mt = Get-ChildItem `
  -Path (Join-Path ${env:ProgramFiles(x86)} "Windows Kits/10/bin/*/x64/mt.exe") `
  -File `
  -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if ($null -eq $mt) {
  $manifestReport.Add("mt.exe was not found; the embedded manifest could not be extracted.")
} else {
  $manifestPath = Join-Path $diagnosticsDirectory "application-manifest.xml"
  $manifestOutput = @(
    & $mt.FullName `
      -nologo `
      "-inputresource:$($testBinary.FullName);#1" `
      "-out:$manifestPath" 2>&1
  )
  $manifestExitCode = $LASTEXITCODE
  $manifestReport.Add("mt.exe: $($mt.FullName)")
  $manifestReport.Add("exit code: $manifestExitCode")
  foreach ($line in $manifestOutput) {
    $manifestReport.Add($line.ToString())
  }
  if ($manifestExitCode -eq 0 -and (Test-Path -LiteralPath $manifestPath)) {
    $manifestSource = Get-Content -LiteralPath $manifestPath -Raw
    $hasCommonControlsV6 =
      $manifestSource.Contains('name="Microsoft.Windows.Common-Controls"') -and
      $manifestSource.Contains('version="6.0.0.0"')
    $manifestReport.Add("Common Controls v6 dependency: $hasCommonControlsV6")
  } else {
    $manifestReport.Add("Common Controls v6 dependency: False")
  }
}
$manifestReport | Tee-Object -FilePath (Join-Path $diagnosticsDirectory "manifest.txt")
