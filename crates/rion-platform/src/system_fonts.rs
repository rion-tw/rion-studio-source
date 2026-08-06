#[cfg(target_os = "macos")]
use serde_json::Value;

#[cfg(target_os = "macos")]
use crate::background_command;
use crate::{Platform, PlatformError};

#[cfg(target_os = "macos")]
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub fn query_system_font_names(platform: Platform) -> Result<Vec<String>, PlatformError> {
    match platform {
        Platform::Macos => query_macos(),
        Platform::Windows => query_windows(),
    }
}

#[cfg(target_os = "macos")]
fn query_macos() -> Result<Vec<String>, PlatformError> {
    let output = background_command("/usr/sbin/system_profiler")
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

#[cfg(not(target_os = "macos"))]
fn query_macos() -> Result<Vec<String>, PlatformError> {
    Err(PlatformError::Operation(
        "macOS font enumeration is unavailable on this platform".to_owned(),
    ))
}

#[cfg(windows)]
fn query_windows() -> Result<Vec<String>, PlatformError> {
    use windows::Win32::{
        Foundation::LPARAM,
        Graphics::Gdi::{
            DEFAULT_CHARSET, EnumFontFamiliesExW, GetDC, LOGFONTW, ReleaseDC, TEXTMETRICW,
        },
    };

    unsafe extern "system" fn collect_family(
        logfont: *const LOGFONTW,
        _text_metrics: *const TEXTMETRICW,
        _font_type: u32,
        context: LPARAM,
    ) -> i32 {
        if logfont.is_null() || context.0 == 0 {
            return 1;
        }
        let names = unsafe { &mut *(context.0 as *mut Vec<String>) };
        let face_name = unsafe { &(*logfont).lfFaceName };
        if let Some(name) = decode_windows_font_family(face_name) {
            names.push(name);
        }
        1
    }

    let hdc = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        return Err(PlatformError::Operation(
            "Windows font enumeration could not acquire a display context".to_owned(),
        ));
    }
    let request = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        ..Default::default()
    };
    let mut names = Vec::new();
    unsafe {
        EnumFontFamiliesExW(
            hdc,
            &request,
            Some(collect_family),
            LPARAM((&mut names as *mut Vec<String>) as isize),
            0,
        );
        ReleaseDC(None, hdc);
    }
    if names.is_empty() {
        return Err(PlatformError::Operation(
            "Windows font enumeration returned no font families".to_owned(),
        ));
    }
    Ok(names)
}

#[cfg(not(windows))]
fn query_windows() -> Result<Vec<String>, PlatformError> {
    Err(PlatformError::Operation(
        "Windows font enumeration is unavailable on this platform".to_owned(),
    ))
}

#[cfg(any(windows, test))]
fn decode_windows_font_family(face_name: &[u16]) -> Option<String> {
    let end = face_name
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(face_name.len());
    let name = String::from_utf16_lossy(&face_name[..end])
        .trim()
        .to_owned();
    (!name.is_empty() && !name.starts_with('@')).then_some(name)
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn bounded_output(bytes: &[u8]) -> Result<&[u8], PlatformError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        Err(PlatformError::Operation(
            "font query output exceeded 2 MiB".to_owned(),
        ))
    } else {
        Ok(bytes)
    }
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn operation(error: std::io::Error) -> PlatformError {
    PlatformError::Operation(format!("font query: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn collects_nested_macos_names() {
        let value = serde_json::json!({
            "SPFontsDataType": [{"_name":"Arial", "typefaces":[{"family":"Arial Bold"}]}]
        });
        let mut names = Vec::new();
        collect_macos_font_names(&value, &mut names);
        assert_eq!(names, ["Arial", "Arial Bold"]);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn rejects_unbounded_output() {
        assert!(bounded_output(&vec![0; MAX_OUTPUT_BYTES + 1]).is_err());
    }

    #[test]
    fn decodes_and_filters_windows_font_families() {
        let mut face = [0_u16; 32];
        let encoded = "Noto Sans".encode_utf16().collect::<Vec<_>>();
        face[..encoded.len()].copy_from_slice(&encoded);
        assert_eq!(
            decode_windows_font_family(&face).as_deref(),
            Some("Noto Sans")
        );

        let mut vertical = [0_u16; 32];
        let encoded = "@Vertical".encode_utf16().collect::<Vec<_>>();
        vertical[..encoded.len()].copy_from_slice(&encoded);
        assert_eq!(decode_windows_font_family(&vertical), None);
        assert_eq!(decode_windows_font_family(&[0; 32]), None);
    }
}
