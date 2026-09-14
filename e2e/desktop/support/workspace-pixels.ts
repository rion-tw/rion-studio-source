import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe, type ElectronDesktopE2eFullscreenToolbarRuntimeInspection } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

type Bounds = { x: number; y: number; width: number; height: number };
export async function captureWorkspacePixels(input: {
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection;
  reference: Bounds; region: Bounds; points: { x: number; y: number }[]; name: string;
}): Promise<{ samples: number[][]; labels: string[]; path: string }> {
  const { processId, platform } = await electronDesktopE2eProbe();
  const path = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, `${input.name}.png`);
  const payload = { ...input, path, processId, windowId: input.inspection.windowId };
  if (platform === "macos") {
    await focusVisibleMacosAppKitRuntime({ processId, windowId: payload.windowId });
    const request = path.replace(/\.png$/u, ".json");
    await writeFile(request, JSON.stringify(payload));
    const result = await promisify(execFile)("/usr/bin/xcrun", ["swift",
      resolve(import.meta.dirname, "workspace-pixels.swift"), request], { timeout: 30_000 });
    const evidence = { ...JSON.parse(result.stdout), path };
    await writeFile(path.replace(/\.png$/u, ".pixels.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  }
  const nativeWindowHandle = input.inspection.nativeWindowHandle!;
  await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle });
  const result = await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WorkspaceScreen {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
}
'@
$h = [IntPtr][int64]$payload.nativeWindowHandle
$origin = New-Object WorkspaceScreen+Point
if (-not [WorkspaceScreen]::ClientToScreen($h, [ref]$origin)) { throw 'client origin unavailable' }
$scale = [WorkspaceScreen]::GetDpiForWindow($h) / 96.0
$r = $payload.region
$image = New-Object Drawing.Bitmap ([int]($r.width*$scale)), ([int]($r.height*$scale))
$graphics = [Drawing.Graphics]::FromImage($image)
try {
 $graphics.CopyFromScreen([int]($origin.x+$r.x*$scale), [int]($origin.y+$r.y*$scale), 0, 0, $image.Size)
 $image.Save($payload.path, [Drawing.Imaging.ImageFormat]::Png)
 $samples = @($payload.points | ForEach-Object {
  $color = $image.GetPixel([int][Math]::Floor(($_.x-$r.x)*$scale), [int][Math]::Floor(($_.y-$r.y)*$scale))
  ,@([int]$color.R, [int]$color.G, [int]$color.B)
 })
 $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), ([int]$payload.processId)
 $nodes = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
 $labels = @($nodes | ForEach-Object { if ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name -match '^\d+(\.\d)?% × \d+(\.\d)?%$' -and -not $_.Current.IsOffscreen) { $_.Current.Name } })
 @{samples=$samples; labels=$labels} | ConvertTo-Json -Depth 10 -Compress
} finally { $graphics.Dispose(); $image.Dispose() }
`, { ...payload, nativeWindowHandle }, { timeoutMilliseconds: 30_000 });
  const evidence = { ...JSON.parse(result), path };
  await writeFile(path.replace(/\.png$/u, ".pixels.json"), JSON.stringify(evidence, null, 2));
  return evidence;
}
