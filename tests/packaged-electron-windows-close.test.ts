import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";
import { WINDOWS_PACKAGED_CLOSE_HANDLERS } from "../scripts/packagedElectronWindowsClose.mjs";

describe.runIf(process.platform === "win32")("packaged visible role close", () => {
  it("routes a modeled UIA button through a real guarded native window and preserves its survivor", async () => {
    const result = await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class RionQuietForm : Form {
  public Action ClickClose;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void WndProc(ref Message message) {
    if (message.Msg == 0x111 && message.WParam.ToInt64() == 42 && ClickClose != null) ClickClose();
    else base.WndProc(ref message);
  }
}
public static class RionCloseFixture {
  static RionQuietForm target, decoy;
  static IntPtr close, duplicate;
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateWindowEx(int ex, string cls, string text, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr id, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr window, bool enabled);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static void InvokeButton(IntPtr button) { SendMessage(button, 0xF5, IntPtr.Zero, IntPtr.Zero); }
  static Thread thread;
  static bool admitted;
  public static IntPtr Handle;
  public static readonly ManualResetEventSlim Ready = new ManualResetEventSlim();
  public static readonly ManualResetEventSlim NativeRejected = new ManualResetEventSlim();
  public static readonly ManualResetEventSlim Closed = new ManualResetEventSlim();
  public static bool DecoySurvived;
  public static void Start() {
    thread = new Thread(() => {
      target = new RionQuietForm { Text = "Rion guarded role fixture" };
      decoy = new RionQuietForm { Text = "Rion surviving fixture" };
      close = Button(42, 0);
      target.FormClosing += (sender, args) => {
        if (!admitted) { args.Cancel = true; NativeRejected.Set(); }
      };
      target.ClickClose = () => { admitted = true; target.Close(); };
      target.FormClosed += (sender, args) => { DecoySurvived = !decoy.IsDisposed; Closed.Set(); };
      target.Show(); target.Hide(); target.Show(); decoy.Show();
      Handle = target.Handle; Ready.Set(); Application.Run();
      decoy.Dispose(); target.Dispose();
    });
    thread.SetApartmentState(ApartmentState.STA); thread.Start();
  }
  static IntPtr Button(int id, int top) {
    var handle = CreateWindowEx(0, "BUTTON", "Close Game Window", 0x50000000,
      0, top, 180, 30, target.Handle, new IntPtr(id), IntPtr.Zero, IntPtr.Zero);
    if (handle == IntPtr.Zero) throw new Exception("native button creation failed: " + Marshal.GetLastWin32Error());
    return handle;
  }
  public static void Mode(int mode) {
    target.Invoke(new Action(() => {
      if (mode == 1) duplicate = Button(43, 60);
      else if (duplicate != IntPtr.Zero) { DestroyWindow(duplicate); duplicate = IntPtr.Zero; }
      EnableWindow(close, mode != 2);
    }));
  }
  public static void Stop() {
    if (decoy != null && !decoy.IsDisposed) decoy.BeginInvoke(new Action(Application.ExitThread));
    if (thread != null && !thread.Join(2000)) throw new Exception("fixture UI thread did not exit");
  }
}
'@
${WINDOWS_PACKAGED_CLOSE_HANDLERS}
function Rion-ButtonByName($window, [string]$name) {
  # Classified UIA-provider fixture: HWNDs, enabled/visible state and button
  # notifications are native. The packaged Chromium provider is checked in E2E.
  if ($name -ne 'Close Game Window') { return @() }
  foreach ($id in @(42, 43)) {
    $handle = [RionCloseFixture]::GetDlgItem([RionCloseFixture]::Handle, $id)
    if ($handle -eq [IntPtr]::Zero) { continue }
    $button = [pscustomobject]@{ Handle=$handle; Current=[pscustomobject]@{
      IsEnabled=[RionCloseFixture]::IsWindowEnabled($handle)
      IsOffscreen=(-not [RionCloseFixture]::IsWindowVisible($handle))
    }}
    $button | Add-Member ScriptMethod GetCurrentPattern {
      param($pattern)
      if ($pattern -ne [System.Windows.Automation.InvokePattern]::Pattern) { throw 'wrong action pattern' }
      $invoke = [pscustomobject]@{ Handle=$this.Handle }
      $invoke | Add-Member ScriptMethod Invoke { [RionCloseFixture]::InvokeButton($this.Handle) }
      return $invoke
    }
    $button
  }
}
[RionCloseFixture]::Start()
try {
  if (-not [RionCloseFixture]::Ready.Wait(2000)) { throw 'native fixture not ready' }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle([RionCloseFixture]::Handle)
  $pattern = $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  $pattern.Close()
  if (-not [RionCloseFixture]::NativeRejected.Wait(2000)) { throw 'native close guard not reached' }
  $oldBlocked = -not [RionCloseFixture]::Closed.IsSet
  $rejections = @()
  try { Rion-CloseRoleWindow $window ($PID + 1) } catch {
    if ($_.Exception.Message -ne 'exact native role close owner unavailable') { throw }
    $rejections += 'owner'
  }
  [RionCloseFixture]::Mode(1)
  try { Rion-CloseRoleWindow $window $PID } catch {
    if ($_.Exception.Message -ne 'exact visible role close button unavailable') { throw }
    $rejections += 'duplicate'
  }
  [RionCloseFixture]::Mode(2)
  try { Rion-CloseRoleWindow $window $PID } catch {
    if ($_.Exception.Message -ne 'role close button is not visibly actionable') { throw }
    $rejections += 'disabled'
  }
  if ([RionCloseFixture]::Closed.IsSet) { throw 'rejected action closed the window' }
  [RionCloseFixture]::Mode(0)
  Rion-CloseRoleWindow $window $PID
  if (-not [RionCloseFixture]::Closed.Wait(2000)) { throw 'visible close action did not close the native window' }
  @{ oldBlocked=$oldBlocked; closed=[RionCloseFixture]::Closed.IsSet;
     decoySurvived=[RionCloseFixture]::DecoySurvived; rejections=$rejections } | ConvertTo-Json -Compress
} finally { [RionCloseFixture]::Stop() }
`, {}, { timeoutMilliseconds: 8000 });
    expect(JSON.parse(result)).toEqual({
      oldBlocked: true, closed: true, decoySurvived: true,
      rejections: ["owner", "duplicate", "disabled"]
    });
  });
});
