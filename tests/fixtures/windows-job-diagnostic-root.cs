using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

// Compile as WindowsApplication: the pre-release Job owns one GUI-subsystem
// root, with no console bootstrap. A real cmd descendant starts only after stdin.
internal static class WindowsJobDiagnosticRoot {
  [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();

  private static int Main() {
    try {
      if (GetConsoleWindow() != IntPtr.Zero) {
        throw new InvalidOperationException("GUI diagnostic root unexpectedly owns a console.");
      }
      if (Console.OpenStandardInput().ReadByte() < 0) return 2;
      var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/d /c exit 0") {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true
      };
      using (var child = Process.Start(start)) {
        if (child == null) throw new InvalidOperationException("Native descendant did not start.");
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (Exception error) {
      Console.Error.WriteLine(error);
      return 1;
    }
  }
}
