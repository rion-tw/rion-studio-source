import { runWorkspaceSwift } from "./compiled-workspace-swift";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe, type ElectronDesktopE2eFullscreenToolbarRuntimeInspection as Inspection } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

type Point = { x: number; y: number };
type NativeFrame = Point & { width:number; height:number; windowX:number; windowY:number; minimumWidth?:number; minimumHeight?:number };
/** Real native border input, held across read-only geometry/pixel evidence. */
export async function resizeWorkspaceWindow(input: {
  inspection: Inspection; edge: "right" | "bottom" | "bottomRight" | "left" | "top";
  moves: Point[]; rapid?: boolean; requireRequestedFrame?: boolean;
  whileHeld: (step: number, frame: NativeFrame, initialFrame: NativeFrame) => Promise<void>;
}): Promise<void> {
  const { processId, platform } = await electronDesktopE2eProbe();
  const windowId = input.inspection.windowId;
  const nativeWindowHandle = input.inspection.nativeWindowHandle;
  if (platform === "macos") await focusVisibleMacosAppKitRuntime({ processId, windowId });
  else await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle: nativeWindowHandle! });
  const action = async (phase: string, point: Point, expected?: Point): Promise<NativeFrame> => {
    const payload = { processId, windowId, nativeWindowHandle, phase, edge: input.edge, rapid: input.rapid ?? false, expected: expected ?? null, ...point };
    if (platform === "macos") {
      const request = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "resize-request.json");
      await writeFile(request, JSON.stringify(payload));
      const native = JSON.parse(await runWorkspaceSwift("workspace-window-resize", request));
      await appendFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "native-resize-events.jsonl"),
        JSON.stringify({ ...payload, native })+"\n");
      return native;
    }
    const native = JSON.parse(await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WorkspaceResize {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct MinMax { public Point reserved,maxSize,maxPosition,minTrack,maxTrack; }
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint message,IntPtr w,ref MinMax info,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
[WorkspaceResize]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
# Release this helper's held button even if a product failure retired the HWND.
# Do not move the pointer before release and accidentally resize a replacement.
if ($payload.phase -eq 'end') { [WorkspaceResize]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero) }
$h=[IntPtr]::new([long]$payload.nativeWindowHandle); $owner=[uint32]0
[WorkspaceResize]::GetWindowThreadProcessId($h,[ref]$owner) | Out-Null
if ($owner -ne [uint32]$payload.processId) { throw 'exact resize HWND changed' }
$r=New-Object WorkspaceResize+Rect
if (-not [WorkspaceResize]::GetWindowRect($h,[ref]$r)) { throw 'resize frame unavailable' }
$scale=[WorkspaceResize]::GetDpiForWindow($h)/96.0
$limits=New-Object WorkspaceResize+MinMax; $reply=[UIntPtr]::Zero
if ([WorkspaceResize]::SendMessageTimeout($h,0x24,[IntPtr]::Zero,[ref]$limits,2,5000,[ref]$reply) -eq [IntPtr]::Zero) { throw 'native resize constraints unavailable' }
$x=$payload.x*$scale; $y=$payload.y*$scale
if ($payload.phase -eq 'start') {
 $x=$r.right-2; $y=$r.bottom-2
 switch ($payload.edge) {
  'right' {$y=($r.top+$r.bottom)/2}
  'bottom' {$x=($r.left+$r.right)/2}
  'left' {$x=$r.left+2; $y=($r.top+$r.bottom)/2}
  'top' {$x=($r.left+$r.right)/2; $y=$r.top+2}
 }
}
if ($payload.phase -eq 'move') {
 $start=New-Object WorkspaceResize+Point
 if (-not [WorkspaceResize]::GetCursorPos([ref]$start)) { throw 'resize pointer unavailable' }
 $fractions=if ($payload.rapid) {@(0.25,0.9,0.4,1.0,0.25,1.0)} else {@((1.0/6),(2.0/6),(3.0/6),(4.0/6),(5.0/6))}
 foreach ($fraction in $fractions) {
  [WorkspaceResize]::SetCursorPos([int]($start.x+($x-$start.x)*$fraction),[int]($start.y+($y-$start.y)*$fraction)) | Out-Null
  [WorkspaceResize]::mouse_event(0x0001,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds $(if($payload.rapid){8}else{30})
 }
}
if ($payload.phase -ne 'end') {
 [WorkspaceResize]::SetCursorPos([int]$x,[int]$y) | Out-Null
 $flag=if($payload.phase -eq 'start'){0x0002}else{0x0001}
 [WorkspaceResize]::mouse_event($flag,0,0,0,[UIntPtr]::Zero)
}
Start-Sleep -Milliseconds 100 # Native input pacing, not a product completion boundary.
if (-not [WorkspaceResize]::GetWindowRect($h,[ref]$r)) { throw 'resized frame unavailable' }
# Test input acknowledgement: native input may still be queued after pacing.
# Admit only the exact requested frame, clamped to native tracking constraints;
# an intermediate frame must never establish the following pixel coordinates.
if ($payload.expected) {
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while ([Math]::Abs(($r.right-$r.left)/$scale-$payload.expected.x) -gt 1 -or
        [Math]::Abs(($r.bottom-$r.top)/$scale-$payload.expected.y) -gt 1) {
  if ($clock.ElapsedMilliseconds -gt 10000) { throw "native resize did not reach requested frame: $($payload.expected | ConvertTo-Json -Compress), actual $($r.right-$r.left)x$($r.bottom-$r.top), scale $scale" }
  Start-Sleep -Milliseconds 10
  if (-not [WorkspaceResize]::GetWindowRect($h,[ref]$r)) { throw 'resize acknowledgement frame unavailable' }
 }
}
@{x=$x/$scale;y=$y/$scale;windowX=$r.left/$scale;windowY=$r.top/$scale;width=($r.right-$r.left)/$scale;height=($r.bottom-$r.top)/$scale;minimumWidth=$limits.minTrack.x/$scale;minimumHeight=$limits.minTrack.y/$scale} | ConvertTo-Json -Compress
`, payload, { timeoutMilliseconds: 30_000 }));
    await appendFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "native-resize-events.jsonl"),
      JSON.stringify({ ...payload, native })+"\n");
    return native;
  };
  const initialFrame = await action("start", {x:0,y:0});
  let point: Point = initialFrame;
  const start = point;
  let failed = false;
  let primaryError: unknown;
  try {
    for (const [step, move] of input.moves.entries()) {
      point = { x: start.x + move.x, y: start.y + move.y };
      // macOS may clamp a reversal at the screen edge. The opt-in exact frame
      // acknowledgement applies to the first inward drag only.
      const expected = platform === "windows" || (input.requireRequestedFrame && step === 0) ? {
        x: Math.max(initialFrame.minimumWidth ?? 0, initialFrame.width +
          (input.edge === "left" ? -move.x : input.edge === "top" || input.edge === "bottom" ? 0 : move.x)),
        y: Math.max(initialFrame.minimumHeight ?? 0, initialFrame.height +
          (input.edge === "top" ? -move.y : input.edge === "left" || input.edge === "right" ? 0 : move.y))
      } : undefined;
      const frame = await action("move", point, expected);
      await input.whileHeld(step, frame, initialFrame);
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  try { await action("end", point); }
  catch (error) {
    if (failed) throw new AggregateError([primaryError, error], "Native resize and button cleanup failed", { cause: error });
    throw error;
  }
  if (failed) throw primaryError;
}
