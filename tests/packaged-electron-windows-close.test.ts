import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";
import { WINDOWS_PACKAGED_CLOSE_HANDLERS } from "../scripts/packagedElectronWindowsClose.mjs";

const NATIVE_CLOSE_FIXTURE = String.raw`
$fixtureClock = [System.Diagnostics.Stopwatch]::StartNew()
function Trace-CloseFixture([string]$stage) {
  [Console]::Error.WriteLine(('close-fixture {0}ms: {1}' -f $fixtureClock.ElapsedMilliseconds, $stage))
}
$clientApartment = [Threading.Thread]::CurrentThread.GetApartmentState().ToString()
Trace-CloseFixture ('UIA client apartment: ' + $clientApartment)
if ($clientApartment -ne 'MTA') { throw 'UIA client must use its own MTA thread' }
Trace-CloseFixture 'load assemblies'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Trace-CloseFixture 'compile native fixture'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
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
  static readonly object lifecycle = new object();
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static RionQuietForm target, decoy, dispatcher;
  static IntPtr close, duplicate, targetHandle, decoyHandle;
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateWindowEx(int ex, string cls, string text, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr id, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr window, bool enabled);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static void InvokeButton(IntPtr button) { SendMessage(button, 0xF5, IntPtr.Zero, IntPtr.Zero); }
  static Thread thread;
  static bool threadStarted, stopRequested, pumpRunning, admitted;
  static Exception failure;
  static readonly ManualResetEventSlim failed = new ManualResetEventSlim();
  public static IntPtr Handle;
  public static readonly ManualResetEventSlim Ready = new ManualResetEventSlim();
  public static readonly ManualResetEventSlim NativeRejected = new ManualResetEventSlim();
  public static readonly ManualResetEventSlim Closed = new ManualResetEventSlim();
  public static string GuiApartment;
  public static bool PumpReady, Joined, TargetDestroyed, DecoyDestroyed, DecoySurvived;
  static void Trace(string stage) { Console.Error.WriteLine("close-fixture-native " + clock.ElapsedMilliseconds + "ms: " + stage); }
  static void Fail(Exception error) {
    lock (lifecycle) { if (failure == null) failure = error; }
    failed.Set();
  }
  static void ThrowFailure() {
    lock (lifecycle) {
      if (failure != null) throw new InvalidOperationException("native fixture thread failed", failure);
    }
  }
  public static void Start(bool failBeforePump) {
    lock (lifecycle) {
      if (thread != null) throw new InvalidOperationException("native fixture already started");
      thread = new Thread(() => Run(failBeforePump));
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start(); threadStarted = true;
    }
  }
  static void Run(bool failBeforePump) {
    try {
      GuiApartment = Thread.CurrentThread.GetApartmentState().ToString();
      Trace("GUI apartment: " + GuiApartment);
      if (GuiApartment != "STA") throw new InvalidOperationException("fixture GUI must be STA");
      lock (lifecycle) { if (stopRequested) return; }
      target = new RionQuietForm { Text = "Rion guarded role fixture" };
      decoy = new RionQuietForm { Text = "Rion surviving fixture" };
      targetHandle = target.Handle; decoyHandle = decoy.Handle;
      close = Button(42, 0);
      target.FormClosing += (sender, args) => {
        if (!admitted) { args.Cancel = true; Trace("native FormClosing rejected"); NativeRejected.Set(); }
      };
      target.ClickClose = () => { admitted = true; target.Close(); };
      target.FormClosed += (sender, args) => {
        DecoySurvived = !decoy.IsDisposed && IsWindow(decoyHandle);
        Trace("native FormClosed; survivor present"); Closed.Set();
      };
      if (failBeforePump) throw new InvalidOperationException("injected native initialization failure before pump");
      target.Show(); target.Hide(); target.Show(); decoy.Show();
      lock (lifecycle) {
        if (stopRequested) return;
        Handle = targetHandle; dispatcher = decoy;
        dispatcher.BeginInvoke(new Action(() => {
          bool stopping;
          lock (lifecycle) {
            pumpRunning = true; PumpReady = true; stopping = stopRequested;
            Trace("message pump dispatched ready callback"); Ready.Set();
          }
          if (stopping) Application.ExitThread();
        }));
      }
      Application.Run();
    } catch (Exception error) { Fail(error); }
    finally {
      lock (lifecycle) { dispatcher = null; pumpRunning = false; }
      try {
        if (decoy != null) decoy.Dispose();
        if (target != null) target.Dispose();
        TargetDestroyed = targetHandle == IntPtr.Zero || !IsWindow(targetHandle);
        DecoyDestroyed = decoyHandle == IntPtr.Zero || !IsWindow(decoyHandle);
        Trace("GUI disposed exact owned windows");
      } catch (Exception error) { Fail(error); }
    }
  }
  public static void WaitUntilReady(int milliseconds) {
    int result = WaitHandle.WaitAny(new WaitHandle[] { Ready.WaitHandle, failed.WaitHandle }, milliseconds);
    ThrowFailure();
    if (result == WaitHandle.WaitTimeout) throw new TimeoutException("native fixture not ready");
    lock (lifecycle) {
      if (result != 0 || !pumpRunning || stopRequested) throw new InvalidOperationException("native fixture pump unavailable");
    }
  }
  static IntPtr Button(int id, int top) {
    var handle = CreateWindowEx(0, "BUTTON", "Close window", 0x50000000,
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
    Thread ownedThread;
    Exception dispatchFailure = null;
    lock (lifecycle) {
      stopRequested = true; ownedThread = threadStarted ? thread : null;
      // Initialization/the ready callback owns stopRequested until the pump runs.
      // Only an established live dispatcher is eligible for cross-thread enqueue.
      if (pumpRunning && dispatcher != null) {
        try { dispatcher.BeginInvoke(new Action(Application.ExitThread)); }
        catch (Exception error) { dispatchFailure = error; }
      }
    }
    if (ownedThread != null && !ownedThread.Join(2000)) throw new TimeoutException("fixture UI thread did not exit");
    Joined = ownedThread == null || !ownedThread.IsAlive;
    Trace("GUI thread joined");
    if (dispatchFailure != null) throw new InvalidOperationException("fixture stop dispatch failed", dispatchFailure);
    ThrowFailure();
  }
}
'@
${WINDOWS_PACKAGED_CLOSE_HANDLERS}
function Rion-ButtonByName($window, [string]$name) {
  # Classified UIA-provider fixture: HWNDs, enabled/visible state and button
  # notifications are native. The packaged Chromium provider is checked in E2E.
  if ($name -ne 'Close window') { return @() }
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
$primaryFailure = $null
$cleanupFailure = $null
try {
  Trace-CloseFixture 'start native fixture'
  [RionCloseFixture]::Start([bool]$payload.failBeforePump)
  Trace-CloseFixture 'wait for dispatched native ready callback'
  [RionCloseFixture]::WaitUntilReady(2000)
  Trace-CloseFixture 'native ready; FromHandle begin'
  $window = [System.Windows.Automation.AutomationElement]::FromHandle([RionCloseFixture]::Handle)
  Trace-CloseFixture 'FromHandle complete; WindowPattern lookup begin'
  $pattern = $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  Trace-CloseFixture 'WindowPattern lookup complete; WindowPattern.Close begin'
  $pattern.Close()
  Trace-CloseFixture 'WindowPattern.Close returned; native rejection ACK wait begin'
  if (-not [RionCloseFixture]::NativeRejected.Wait(2000)) { throw 'native close guard not reached' }
  Trace-CloseFixture 'native rejection ACK complete; owner guard begin'
  $oldBlocked = -not [RionCloseFixture]::Closed.IsSet
  $rejections = @()
  try { Rion-CloseRoleWindow $window ($PID + 1) } catch {
    if ($_.Exception.Message -ne 'exact native role close owner unavailable') { throw }
    $rejections += 'owner'
  }
  Trace-CloseFixture 'owner guard complete; duplicate mode begin'
  [RionCloseFixture]::Mode(1)
  Trace-CloseFixture 'duplicate mode complete; duplicate guard begin'
  try { Rion-CloseRoleWindow $window $PID } catch {
    if ($_.Exception.Message -ne 'exact visible role close button unavailable') { throw }
    $rejections += 'duplicate'
  }
  Trace-CloseFixture 'duplicate guard complete; disabled mode begin'
  [RionCloseFixture]::Mode(2)
  Trace-CloseFixture 'disabled mode complete; disabled guard begin'
  try { Rion-CloseRoleWindow $window $PID } catch {
    if ($_.Exception.Message -ne 'role close button is not visibly actionable') { throw }
    $rejections += 'disabled'
  }
  Trace-CloseFixture 'disabled guard complete; normal mode begin'
  if ([RionCloseFixture]::Closed.IsSet) { throw 'rejected action closed the window' }
  [RionCloseFixture]::Mode(0)
  Trace-CloseFixture 'normal mode complete; exact visible close begin'
  Rion-CloseRoleWindow $window $PID
  Trace-CloseFixture 'exact visible close returned; native closed ACK wait begin'
  if (-not [RionCloseFixture]::Closed.Wait(2000)) { throw 'visible close action did not close the native window' }
  Trace-CloseFixture 'native closed ACK complete'
} catch {
  $primaryFailure = $_
} finally {
  Trace-CloseFixture 'stop native fixture begin'
  try { [RionCloseFixture]::Stop(); Trace-CloseFixture 'stop native fixture complete' }
  catch { $cleanupFailure = $_; Trace-CloseFixture ('stop native fixture failed: ' + $_.Exception.ToString()) }
}
if ([bool]$payload.failBeforePump) {
  if ($null -eq $primaryFailure -or $primaryFailure.Exception.ToString() -notlike '*injected native initialization failure before pump*') {
    throw 'the injected initialization failure was not preserved'
  }
  if ($null -eq $cleanupFailure -or $cleanupFailure.Exception.ToString() -notlike '*injected native initialization failure before pump*') {
    throw 'the fixture thread failure was not observable after cleanup'
  }
  @{ primaryFailure=$primaryFailure.Exception.ToString(); cleanupFailure=$cleanupFailure.Exception.ToString();
     ready=[RionCloseFixture]::Ready.IsSet; clientApartment=$clientApartment;
     guiApartment=[RionCloseFixture]::GuiApartment; joined=[RionCloseFixture]::Joined;
     targetDestroyed=[RionCloseFixture]::TargetDestroyed; decoyDestroyed=[RionCloseFixture]::DecoyDestroyed } | ConvertTo-Json -Compress
} else {
  # Cleanup failure remains separate evidence and cannot replace the first failure.
  if ($null -ne $primaryFailure) { throw $primaryFailure }
  if ($null -ne $cleanupFailure) { throw $cleanupFailure }
  @{ oldBlocked=$oldBlocked; closed=[RionCloseFixture]::Closed.IsSet;
     decoySurvived=[RionCloseFixture]::DecoySurvived; rejections=$rejections;
     clientApartment=$clientApartment; guiApartment=[RionCloseFixture]::GuiApartment;
     pumpReady=[RionCloseFixture]::PumpReady; joined=[RionCloseFixture]::Joined;
     targetDestroyed=[RionCloseFixture]::TargetDestroyed; decoyDestroyed=[RionCloseFixture]::DecoyDestroyed } | ConvertTo-Json -Compress
}
`;

async function runNativeCloseFixture(failBeforePump: boolean): Promise<unknown> {
  // Native ACKs/cleanup retain their 2-second bounds. The unchanged outer bound
  // includes PowerShell/.NET startup; elapsed time never makes this fixture pass.
  const result = await runEncodedPowerShellJson(NATIVE_CLOSE_FIXTURE,
    { failBeforePump }, { timeoutMilliseconds: 20_000, apartmentState: "MTA" }
  ).catch((error: Error & {
    killed?: boolean; signal?: string; code?: number; stderr?: string;
  }) => {
    throw new Error(`Guarded native close fixture failed: ${JSON.stringify({
      killed: error.killed, signal: error.signal, code: error.code, stages: error.stderr
    })}`, { cause: error });
  });
  return JSON.parse(result);
}

describe.runIf(process.platform === "win32")("packaged visible role close", () => {
  it("routes a modeled UIA button through a real guarded native window and preserves its survivor", async () => {
    expect(await runNativeCloseFixture(false)).toEqual({
      oldBlocked: true, closed: true, decoySurvived: true,
      rejections: ["owner", "duplicate", "disabled"],
      clientApartment: "MTA", guiApartment: "STA", pumpReady: true, joined: true,
      targetDestroyed: true, decoyDestroyed: true
    });
  });

  it("preserves a pre-pump initialization failure and joins cleanup of its exact native windows", async () => {
    expect(await runNativeCloseFixture(true)).toEqual({
      primaryFailure: expect.stringContaining("injected native initialization failure before pump"),
      cleanupFailure: expect.stringContaining("injected native initialization failure before pump"),
      ready: false, clientApartment: "MTA", guiApartment: "STA", joined: true,
      targetDestroyed: true, decoyDestroyed: true
    });
  });
});
