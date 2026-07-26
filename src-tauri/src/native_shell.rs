use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const DIALOG_TITLE_ENV: &str = "RION_STUDIO_DIALOG_TITLE";
const DIALOG_DEFAULT_ENV: &str = "RION_STUDIO_DIALOG_DEFAULT";

pub fn pick_file(title: &str, extension: &str) -> Result<Option<PathBuf>, String> {
    run_dialog(DialogRequest::OpenFile {
        title,
        extension: safe_extension(extension)?,
    })
}

pub fn pick_directory(title: &str, default_path: &Path) -> Result<Option<PathBuf>, String> {
    run_dialog(DialogRequest::Directory {
        title,
        default_path,
    })
}

pub fn save_file(
    title: &str,
    default_name: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let extension = safe_extension(extension)?;
    let selected = run_dialog(DialogRequest::SaveFile {
        title,
        default_name,
    })?;
    Ok(selected.map(|path| ensure_extension(path, extension)))
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("/usr/bin/open").arg("-R").arg(path).status()
    } else {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The file manager could not reveal the requested path.".to_owned())
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "The external URL is invalid.".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS URLs may be opened externally.".to_owned());
    }
    let status = if cfg!(target_os = "macos") {
        Command::new("/usr/bin/open").arg(url).status()
    } else {
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The default browser could not open the requested URL.".to_owned())
    }
}

pub fn copy_text(value: &str) -> Result<(), String> {
    let mut child = if cfg!(target_os = "macos") {
        Command::new("/usr/bin/pbcopy")
            .stdin(Stdio::piped())
            .spawn()
    } else {
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$input | Set-Clipboard",
            ])
            .stdin(Stdio::piped())
            .spawn()
    }
    .map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Clipboard input is unavailable.".to_owned())?
        .write_all(value.as_bytes())
        .map_err(|error| error.to_string())?;
    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The operating system clipboard rejected the text.".to_owned())
    }
}

enum DialogRequest<'a> {
    Directory {
        title: &'a str,
        default_path: &'a Path,
    },
    OpenFile {
        title: &'a str,
        extension: &'a str,
    },
    SaveFile {
        title: &'a str,
        default_name: &'a str,
    },
}

fn run_dialog(request: DialogRequest<'_>) -> Result<Option<PathBuf>, String> {
    if cfg!(target_os = "macos") {
        run_macos_dialog(request)
    } else {
        run_windows_dialog(request)
    }
}

fn run_macos_dialog(request: DialogRequest<'_>) -> Result<Option<PathBuf>, String> {
    let (title, script, default_value) = match request {
        DialogRequest::Directory {
            title,
            default_path,
        } => (
            title,
            concat!(
                "set promptText to system attribute \"RION_STUDIO_DIALOG_TITLE\"\n",
                "set defaultPath to system attribute \"RION_STUDIO_DIALOG_DEFAULT\"\n",
                "try\n",
                "  set chosenPath to choose folder with prompt promptText default location (POSIX file defaultPath)\n",
                "  return POSIX path of chosenPath\n",
                "on error number -128\n",
                "  return \"\"\n",
                "end try"
            ),
            default_path.to_string_lossy().into_owned(),
        ),
        DialogRequest::OpenFile { title, extension } => (
            title,
            concat!(
                "set promptText to system attribute \"RION_STUDIO_DIALOG_TITLE\"\n",
                "set extensionName to system attribute \"RION_STUDIO_DIALOG_DEFAULT\"\n",
                "try\n",
                "  set chosenPath to choose file with prompt promptText of type {extensionName}\n",
                "  return POSIX path of chosenPath\n",
                "on error number -128\n",
                "  return \"\"\n",
                "end try"
            ),
            extension.to_owned(),
        ),
        DialogRequest::SaveFile {
            title,
            default_name,
        } => (
            title,
            concat!(
                "set promptText to system attribute \"RION_STUDIO_DIALOG_TITLE\"\n",
                "set defaultName to system attribute \"RION_STUDIO_DIALOG_DEFAULT\"\n",
                "try\n",
                "  set chosenPath to choose file name with prompt promptText default name defaultName\n",
                "  return POSIX path of chosenPath\n",
                "on error number -128\n",
                "  return \"\"\n",
                "end try"
            ),
            default_name.to_owned(),
        ),
    };
    run_capture(
        Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .env(DIALOG_TITLE_ENV, title)
            .env(DIALOG_DEFAULT_ENV, default_value),
    )
}

fn run_windows_dialog(request: DialogRequest<'_>) -> Result<Option<PathBuf>, String> {
    let (title, script, default_value) = match request {
        DialogRequest::Directory {
            title,
            default_path,
        } => (
            title,
            concat!(
                "Add-Type -AssemblyName System.Windows.Forms;",
                "$d=New-Object System.Windows.Forms.FolderBrowserDialog;",
                "$d.Description=$env:RION_STUDIO_DIALOG_TITLE;",
                "$d.SelectedPath=$env:RION_STUDIO_DIALOG_DEFAULT;",
                "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)",
                "{[Console]::Out.Write($d.SelectedPath)}"
            ),
            default_path.to_string_lossy().into_owned(),
        ),
        DialogRequest::OpenFile { title, extension } => (
            title,
            concat!(
                "Add-Type -AssemblyName System.Windows.Forms;",
                "$d=New-Object System.Windows.Forms.OpenFileDialog;",
                "$d.Title=$env:RION_STUDIO_DIALOG_TITLE;",
                "$e=$env:RION_STUDIO_DIALOG_DEFAULT;",
                "$d.Filter=\"$e files (*.$e)|*.$e|All files (*.*)|*.*\";",
                "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)",
                "{[Console]::Out.Write($d.FileName)}"
            ),
            extension.to_owned(),
        ),
        DialogRequest::SaveFile {
            title,
            default_name,
        } => (
            title,
            concat!(
                "Add-Type -AssemblyName System.Windows.Forms;",
                "$d=New-Object System.Windows.Forms.SaveFileDialog;",
                "$d.Title=$env:RION_STUDIO_DIALOG_TITLE;",
                "$d.FileName=$env:RION_STUDIO_DIALOG_DEFAULT;",
                "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)",
                "{[Console]::Out.Write($d.FileName)}"
            ),
            default_name.to_owned(),
        ),
    };
    run_capture(
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
            ])
            .arg(script)
            .env(DIALOG_TITLE_ENV, title)
            .env(DIALOG_DEFAULT_ENV, default_value),
    )
}

fn run_capture(command: &mut Command) -> Result<Option<PathBuf>, String> {
    let output = command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "The native dialog returned an invalid path.".to_owned())?;
    let value = value.trim();
    Ok((!value.is_empty()).then(|| PathBuf::from(value)))
}

fn safe_extension(extension: &str) -> Result<&str, String> {
    if extension.is_empty()
        || extension.len() > 16
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("The file extension is invalid.".to_owned());
    }
    Ok(extension)
}

fn ensure_extension(mut path: PathBuf, extension: &str) -> PathBuf {
    if path
        .extension()
        .is_some_and(|current| current.eq_ignore_ascii_case(extension))
    {
        return path;
    }
    path.set_extension(extension);
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_paths_receive_the_required_extension() {
        assert_eq!(
            ensure_extension(PathBuf::from("Rion diagnostics"), "zip"),
            PathBuf::from("Rion diagnostics.zip")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("portable.JSON"), "json"),
            PathBuf::from("portable.JSON")
        );
    }

    #[test]
    fn extensions_cannot_inject_native_dialog_scripts() {
        assert!(safe_extension("json").is_ok());
        assert!(safe_extension("json'; quit").is_err());
        assert!(safe_extension("").is_err());
    }

    #[test]
    fn external_urls_are_restricted_before_launch() {
        assert!(url::Url::parse("https://rion.tw").is_ok());
        assert!(!matches!(
            url::Url::parse("file:///private/etc/passwd")
                .unwrap()
                .scheme(),
            "http" | "https"
        ));
    }
}
