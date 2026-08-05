use std::{ffi::OsStr, process::Command};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds an app-owned system command without allowing a console window to be
/// created by the child process on Windows.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    {
        let mut command = command;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        command
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn windows_background_commands_use_create_no_window() {
        assert_eq!(super::CREATE_NO_WINDOW, 0x0800_0000);
    }
}
