use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

use crate::{Platform, PlatformError};

const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOWS_CLOSE_SCRIPT: &str = r#"Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class RionStudioChromeCloser {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  public static void CloseChromeWindows() {
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      GetWindowThreadProcessId(hWnd, out var processId);
      if (processId == 0) return true;
      try {
        using var process = Process.GetProcessById((int)processId);
        if (string.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase)) PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
      } catch (ArgumentException) { }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[RionStudioChromeCloser]::CloseChromeWindows()"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHostDiagnostics {
    pub cpu_model: Option<String>,
    pub cpu_cores: usize,
    pub total_memory_bytes: u64,
    pub free_memory_bytes: u64,
}

pub fn collect_system_host_diagnostics() -> SystemHostDiagnostics {
    let refreshes = RefreshKind::nothing()
        .with_cpu(CpuRefreshKind::nothing().with_frequency())
        .with_memory(MemoryRefreshKind::nothing().with_ram());
    let mut system = System::new_with_specifics(refreshes);
    system.refresh_cpu_specifics(CpuRefreshKind::nothing().with_frequency());
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    SystemHostDiagnostics {
        cpu_model: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim().to_owned())
            .filter(|model| !model.is_empty()),
        cpu_cores: system.cpus().len().max(
            thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
        ),
        total_memory_bytes: system.total_memory(),
        free_memory_bytes: system.available_memory(),
    }
}

pub fn request_graceful_chrome_quit(platform: Platform) -> Result<(), PlatformError> {
    let (program, arguments) = graceful_chrome_quit_command(platform);
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let deadline = Instant::now() + CLOSE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(PlatformError::Operation(format!(
                    "Chrome close command exited with {status}"
                )));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PlatformError::Operation(
                    "Chrome close command timed out".to_owned(),
                ));
            }
            Err(error) => return Err(PlatformError::Operation(error.to_string())),
        }
    }
}

fn graceful_chrome_quit_command(platform: Platform) -> (&'static str, Vec<&'static str>) {
    match platform {
        Platform::Macos => (
            "/usr/bin/osascript",
            vec![
                "-e",
                r#"if application "Google Chrome" is running then tell application "Google Chrome" to quit"#,
            ],
        ),
        Platform::Windows => (
            "powershell.exe",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                WINDOWS_CLOSE_SCRIPT,
            ],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_graceful_platform_close_commands() {
        let mac = graceful_chrome_quit_command(Platform::Macos);
        assert_eq!(mac.0, "/usr/bin/osascript");
        assert!(mac.1.join(" ").contains("quit"));
        let windows = graceful_chrome_quit_command(Platform::Windows);
        assert_eq!(windows.0, "powershell.exe");
        assert!(WINDOWS_CLOSE_SCRIPT.contains("PostMessage"));
        assert!(!WINDOWS_CLOSE_SCRIPT.contains("TerminateProcess"));
    }
}
