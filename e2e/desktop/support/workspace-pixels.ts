import { runWorkspaceSwift } from "./compiled-workspace-swift";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe, type ElectronDesktopE2eFullscreenToolbarRuntimeInspection } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

type Bounds = { x: number; y: number; width: number; height: number };
export async function captureWorkspacePixels(input: {
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection;
  reference: Bounds; region: Bounds; points: { x: number; y: number }[]; name: string;
  observeOnly?: boolean;
  windowEdges?: boolean;
  expectedLabels?: readonly string[];
}): Promise<{ samples: number[][]; labels: string[]; path: string }> {
  const { processId, platform } = await electronDesktopE2eProbe();
  const path = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, `${input.name}.png`);
  const payload = { ...input, path, processId, windowId: input.inspection.windowId };
  if (platform === "macos") {
    if (!input.observeOnly) await focusVisibleMacosAppKitRuntime({ processId, windowId: payload.windowId });
    const request = path.replace(/\.png$/u, ".json");
    await writeFile(request, JSON.stringify(payload));
    const result = await runWorkspaceSwift("workspace-pixels", request);
    const evidence = { ...JSON.parse(result), path };
    await writeFile(path.replace(/\.png$/u, ".pixels.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  }
  const nativeWindowHandle = input.inspection.nativeWindowHandle!;
  if (!input.observeOnly) await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle });
  const result = await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WorkspaceScreen {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
# GetDpiForWindow reports the host's real DPI whatever this process is, so the
# origin and the capture must be read in that same physical space. PowerShell is
# DPI-unaware by default and would otherwise virtualize both.
[WorkspaceScreen]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$h = [IntPtr][int64]$payload.nativeWindowHandle
$origin = New-Object WorkspaceScreen+Point
if (-not [WorkspaceScreen]::ClientToScreen($h, [ref]$origin)) { throw 'client origin unavailable' }
$scale = [WorkspaceScreen]::GetDpiForWindow($h) / 96.0
$condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), ([int]$payload.processId)
function Read-WorkspaceLabels {
 $nodes = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
 @($nodes | ForEach-Object { if ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name -match '^\d+(\.\d)?% × \d+(\.\d)?%$' -and -not $_.Current.IsOffscreen) { $_.Current.Name } })
}
$labels = @(Read-WorkspaceLabels)
if ($null -ne $payload.expectedLabels) {
 $expectedLabels = @($payload.expectedLabels | Sort-Object) -join '|'
 $labelClock = [Diagnostics.Stopwatch]::StartNew()
 while ((@($labels | Sort-Object) -join '|') -ne $expectedLabels) {
  if ($labelClock.ElapsedMilliseconds -gt 10000) { throw "Native size labels did not match Core: expected $expectedLabels; actual $($labels -join '|')" }
  Start-Sleep -Milliseconds 50 # E2E accessibility observation, not a product state transition.
  $labels = @(Read-WorkspaceLabels)
 }
}
$r = $payload.region
$frame = New-Object WorkspaceScreen+Rect
$client = New-Object WorkspaceScreen+Rect
$pointer = New-Object WorkspaceScreen+Point
[WorkspaceScreen]::GetCursorPos([ref]$pointer) | Out-Null
if (-not [WorkspaceScreen]::GetWindowRect($h, [ref]$frame) -or
    -not [WorkspaceScreen]::GetClientRect($h, [ref]$client)) { throw 'capture native bounds unavailable' }
$image = New-Object Drawing.Bitmap ([int]($r.width*$scale)), ([int]($r.height*$scale))
$graphics = [Drawing.Graphics]::FromImage($image)
try {
 $graphics.CopyFromScreen([int]($origin.x+$r.x*$scale), [int]($origin.y+$r.y*$scale), 0, 0, $image.Size)
 $image.Save($payload.path, [Drawing.Imaging.ImageFormat]::Png)
 $samples = @($payload.points | ForEach-Object {
  $color = $image.GetPixel([int][Math]::Floor(($_.x-$r.x)*$scale), [int][Math]::Floor(($_.y-$r.y)*$scale))
  ,@([int]$color.R, [int]$color.G, [int]$color.B)
 })
 @{samples=$samples; labels=$labels; native=@{frame=$frame;client=$client;origin=$origin;scale=$scale;pointer=$pointer;leftButton=[WorkspaceScreen]::GetAsyncKeyState(1);foreground=[WorkspaceScreen]::GetForegroundWindow().ToInt64()};region=$r;points=$payload.points} | ConvertTo-Json -Depth 10 -Compress
} finally { $graphics.Dispose(); $image.Dispose() }
`, { ...payload, nativeWindowHandle, expectedLabels: input.expectedLabels ?? null }, { timeoutMilliseconds: 30_000 });
  const evidence = { ...JSON.parse(result), path };
  await writeFile(path.replace(/\.png$/u, ".pixels.json"), JSON.stringify(evidence, null, 2));
  return evidence;
}
