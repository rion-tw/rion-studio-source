import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

/** Evidence capture only; frame cadence never decides product completion. */
export async function captureWorkspaceTransitionFrames<T>(
  platform: "macos" | "windows", name: string, action: () => Promise<T>
): Promise<T> {
  let finished = false;
  let frame = 0;
  const frames = (async () => {
    while (!finished) {
      const path = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, `${name}-frame-${String(frame++).padStart(3,"0")}.png`);
      if (platform === "macos") await promisify(execFile)("/usr/sbin/screencapture", ["-x", path]);
      else await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$r=[Windows.Forms.SystemInformation]::VirtualScreen
$b=New-Object Drawing.Bitmap $r.Width,$r.Height
$g=[Drawing.Graphics]::FromImage($b)
try { $g.CopyFromScreen($r.X,$r.Y,0,0,$b.Size); $b.Save($payload.path,[Drawing.Imaging.ImageFormat]::Png) }
finally { $g.Dispose(); $b.Dispose() }
'{}'
`, {path}, {timeoutMilliseconds:30_000});
      if (!finished) await new Promise(done => setTimeout(done, 100));
    }
  })();
  try { return await action(); } finally { finished = true; await frames; }
}
