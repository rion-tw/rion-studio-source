use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

use rion_platform::background_command;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

pub async fn pick_file(
    app: &AppHandle,
    window: &WebviewWindow,
    title: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let extension = safe_extension(extension)?;
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .add_filter(
            format!("{} files", extension.to_ascii_uppercase()),
            &[extension],
        )
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    receive_dialog_path(receiver).await
}

pub async fn pick_directory(
    app: &AppHandle,
    window: &WebviewWindow,
    title: &str,
    default_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .set_directory(default_path)
        .pick_folder(move |path| {
            let _ = sender.send(path);
        });
    receive_dialog_path(receiver).await
}

pub async fn save_file(
    app: &AppHandle,
    window: &WebviewWindow,
    title: &str,
    default_name: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let extension = safe_extension(extension)?;
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .set_file_name(default_name)
        .add_filter(
            format!("{} files", extension.to_ascii_uppercase()),
            &[extension],
        )
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = receive_dialog_path(receiver).await?;
    Ok(selected.map(|path| ensure_extension(path, extension)))
}

async fn receive_dialog_path(
    receiver: oneshot::Receiver<Option<FilePath>>,
) -> Result<Option<PathBuf>, String> {
    receiver
        .await
        .map_err(|_| "The native dialog closed without returning a result.".to_owned())?
        .map(|path| path.into_path().map_err(|error| error.to_string()))
        .transpose()
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        background_command("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .status()
    } else {
        background_command("explorer.exe")
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
        background_command("/usr/bin/open").arg(url).status()
    } else {
        background_command("rundll32.exe")
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
        background_command("/usr/bin/pbcopy")
            .stdin(Stdio::piped())
            .spawn()
    } else {
        background_command("powershell.exe")
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
