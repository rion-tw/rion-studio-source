use std::process::Command;

use serde_json::Value;

use crate::{Platform, PlatformError};

const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub fn query_system_font_names(platform: Platform) -> Result<Vec<String>, PlatformError> {
    match platform {
        Platform::Macos => query_macos(),
        Platform::Windows => query_windows(),
    }
}

fn query_macos() -> Result<Vec<String>, PlatformError> {
    let output = Command::new("/usr/sbin/system_profiler")
        .args(["SPFontsDataType", "-json"])
        .output()
        .map_err(operation)?;
    validate_output(output.status.success(), &output.stderr)?;
    let stdout = bounded_output(&output.stdout)?;
    let value = serde_json::from_slice::<Value>(stdout)
        .map_err(|error| PlatformError::Operation(format!("font query JSON: {error}")))?;
    let mut names = Vec::new();
    collect_macos_font_names(&value, &mut names);
    Ok(names)
}

fn query_windows() -> Result<Vec<String>, PlatformError> {
    let script = concat!(
        "Add-Type -AssemblyName System.Drawing;",
        "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ",
        "ForEach-Object { $_.Name }"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(operation)?;
    validate_output(output.status.success(), &output.stderr)?;
    let stdout = bounded_output(&output.stdout)?;
    Ok(String::from_utf8_lossy(stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

fn collect_macos_font_names(value: &Value, names: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_macos_font_names(item, names);
            }
        }
        Value::Object(object) => {
            for key in ["_name", "family"] {
                if let Some(name) = object.get(key).and_then(Value::as_str) {
                    names.push(name.to_owned());
                }
            }
            for child in object.values() {
                collect_macos_font_names(child, names);
            }
        }
        _ => {}
    }
}

fn bounded_output(bytes: &[u8]) -> Result<&[u8], PlatformError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        Err(PlatformError::Operation(
            "font query output exceeded 2 MiB".to_owned(),
        ))
    } else {
        Ok(bytes)
    }
}

fn validate_output(success: bool, stderr: &[u8]) -> Result<(), PlatformError> {
    if success {
        return Ok(());
    }
    let message = String::from_utf8_lossy(stderr);
    Err(PlatformError::Operation(format!(
        "font query failed: {}",
        message.trim().chars().take(256).collect::<String>()
    )))
}

fn operation(error: std::io::Error) -> PlatformError {
    PlatformError::Operation(format!("font query: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_nested_macos_names() {
        let value = serde_json::json!({
            "SPFontsDataType": [{"_name":"Arial", "typefaces":[{"family":"Arial Bold"}]}]
        });
        let mut names = Vec::new();
        collect_macos_font_names(&value, &mut names);
        assert_eq!(names, ["Arial", "Arial Bold"]);
    }

    #[test]
    fn rejects_unbounded_output() {
        assert!(bounded_output(&vec![0; MAX_OUTPUT_BYTES + 1]).is_err());
    }
}
