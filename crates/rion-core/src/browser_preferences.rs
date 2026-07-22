use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::BrowserFontSettingsRecord,
};

const FONT_PATHS: &[(&str, &str)] = &[
    ("standard", "webkit.webprefs.fonts.standard.Zyyy"),
    ("serif", "webkit.webprefs.fonts.serif.Zyyy"),
    ("sansserif", "webkit.webprefs.fonts.sansserif.Zyyy"),
    ("fixed", "webkit.webprefs.fonts.fixed.Zyyy"),
    ("math", "webkit.webprefs.fonts.math.Zyyy"),
];

pub fn apply(
    app_user_data_dir: &Path,
    browser_user_data_dir: &Path,
    role_session_partition: Option<&str>,
    fonts: &BrowserFontSettingsRecord,
    zoom_factor: Option<f64>,
) -> CoreResult<Vec<PathBuf>> {
    validate_absolute_directory_path(browser_user_data_dir)?;
    validate_fonts(fonts)?;
    if let Some(zoom_factor) = zoom_factor
        && (!zoom_factor.is_finite() || zoom_factor <= 0.0)
    {
        return Err(CoreError::InvalidInput(
            "Chrome zoom factor must be greater than zero.".to_owned(),
        ));
    }

    let chrome_preferences = browser_user_data_dir.join("Default/Preferences");
    let mut updated = Vec::new();
    if apply_to_file(&chrome_preferences, fonts, zoom_factor)? {
        updated.push(chrome_preferences);
    }

    if let Some(partition) = role_session_partition {
        let partition = normalize_partition(partition)?;
        let electron_preferences = app_user_data_dir
            .join("Partitions")
            .join(partition)
            .join("Preferences");
        if apply_to_file(&electron_preferences, fonts, None)? {
            updated.push(electron_preferences);
        }
    }
    Ok(updated)
}

fn apply_to_file(
    preferences_path: &Path,
    fonts: &BrowserFontSettingsRecord,
    zoom_factor: Option<f64>,
) -> CoreResult<bool> {
    let (current, valid) = read_preferences(preferences_path)?;
    if current.is_none() && fonts.mode == "default" && zoom_factor.is_none_or(|value| value == 1.0)
    {
        return Ok(false);
    }

    let mut next = current.clone().unwrap_or_else(|| Value::Object(Map::new()));
    apply_fonts(&mut next, fonts);
    if let Some(zoom_factor) = zoom_factor {
        apply_zoom(&mut next, zoom_factor)?;
    }
    prune_empty_objects(&mut next);
    if valid && current.as_ref() == Some(&next) {
        return Ok(false);
    }
    write_atomically(preferences_path, &next)?;
    Ok(true)
}

fn read_preferences(path: &Path) -> CoreResult<(Option<Value>, bool)> {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value @ Value::Object(_)) => Ok((Some(value), true)),
            Ok(_) | Err(_) => Ok((Some(Value::Object(Map::new())), false)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((None, true)),
        Err(error) => Err(io_error(path, error)),
    }
}

fn apply_fonts(preferences: &mut Value, fonts: &BrowserFontSettingsRecord) {
    for (_, path) in FONT_PATHS {
        delete_path(preferences, &path.split('.').collect::<Vec<_>>());
    }
    if fonts.mode != "custom" {
        return;
    }
    for (role, path) in FONT_PATHS {
        if let Some(family) = fonts.families.get(*role) {
            set_path(
                preferences,
                &path.split('.').collect::<Vec<_>>(),
                Value::String(family.clone()),
            );
        }
    }
}

fn apply_zoom(preferences: &mut Value, zoom_factor: f64) -> CoreResult<()> {
    if zoom_factor == 1.0 {
        delete_path(preferences, &["partition", "default_zoom_level", "x"]);
    } else {
        let level = zoom_factor.ln() / 1.2_f64.ln();
        let number = Number::from_f64(level)
            .ok_or_else(|| CoreError::InvalidInput("Chrome zoom factor is invalid.".to_owned()))?;
        set_path(
            preferences,
            &["partition", "default_zoom_level", "x"],
            Value::Number(number),
        );
    }
    delete_path(preferences, &["partition", "per_host_zoom_levels", "x"]);
    Ok(())
}

fn set_path(target: &mut Value, path: &[&str], value: Value) {
    if path.is_empty() {
        *target = value;
        return;
    }
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let object = target.as_object_mut().expect("object was initialized");
    let child = object
        .entry(path[0].to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    set_path(child, &path[1..], value);
}

fn delete_path(target: &mut Value, path: &[&str]) {
    let Some(object) = target.as_object_mut() else {
        return;
    };
    if path.len() == 1 {
        object.remove(path[0]);
        return;
    }
    if let Some(child) = object.get_mut(path[0]) {
        delete_path(child, &path[1..]);
    }
}

fn prune_empty_objects(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for child in object.values_mut() {
        prune_empty_objects(child);
    }
    object.retain(|_, child| !child.as_object().is_some_and(Map::is_empty));
}

fn write_atomically(path: &Path, value: &Value) -> CoreResult<()> {
    let parent = path.parent().ok_or_else(|| {
        CoreError::InvalidInput("Browser Preferences path has no parent.".to_owned())
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    let temporary = parent.join(format!(".rion-preferences-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| io_error(&temporary, error))?;
        let mut raw = serde_json::to_vec_pretty(value)
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        raw.push(b'\n');
        file.write_all(&raw)
            .and_then(|_| file.sync_all())
            .map_err(|error| io_error(&temporary, error))?;
        fs::rename(&temporary, path).map_err(|error| io_error(path, error))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_absolute_directory_path(path: &Path) -> CoreResult<()> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "Browser user data path must be absolute.".to_owned(),
        ))
    }
}

fn validate_fonts(fonts: &BrowserFontSettingsRecord) -> CoreResult<()> {
    if !matches!(fonts.mode.as_str(), "default" | "custom")
        || fonts.families.iter().any(|(role, family)| {
            !FONT_PATHS.iter().any(|(candidate, _)| role == candidate)
                || family.trim().is_empty()
                || family.len() > 120
                || family
                    .chars()
                    .any(|character| character <= '\u{1f}' || character == '\u{7f}')
        })
    {
        return Err(CoreError::InvalidInput(
            "Browser font settings are invalid.".to_owned(),
        ));
    }
    Ok(())
}

fn normalize_partition(partition: &str) -> CoreResult<&str> {
    let partition = partition.strip_prefix("persist:").unwrap_or(partition);
    if partition.is_empty()
        || partition == "."
        || partition == ".."
        || partition.contains(['/', '\\'])
    {
        return Err(CoreError::InvalidInput(
            "Electron session partition is invalid.".to_owned(),
        ));
    }
    Ok(partition)
}

fn io_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::tempdir;

    use super::*;

    fn fonts(mode: &str) -> BrowserFontSettingsRecord {
        BrowserFontSettingsRecord {
            mode: mode.to_owned(),
            families: HashMap::from([
                ("standard".to_owned(), "Arial".to_owned()),
                ("fixed".to_owned(), "Courier New".to_owned()),
            ]),
        }
    }

    #[test]
    fn applies_fonts_to_chrome_and_electron_preferences() {
        let directory = tempdir().unwrap();
        let browser = directory.path().join("roles/r1/browser");
        let updated = apply(
            directory.path(),
            &browser,
            Some("persist:rion-role-r1"),
            &fonts("custom"),
            None,
        )
        .unwrap();

        assert_eq!(updated.len(), 2);
        for path in [
            browser.join("Default/Preferences"),
            directory.path().join("Partitions/rion-role-r1/Preferences"),
        ] {
            let value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            assert_eq!(
                value.pointer("/webkit/webprefs/fonts/standard/Zyyy"),
                Some(&Value::String("Arial".to_owned()))
            );
        }
    }

    #[test]
    fn combines_zoom_with_fonts_and_preserves_unrelated_preferences() {
        let directory = tempdir().unwrap();
        let browser = directory.path().join("browser");
        let path = browser.join("Default/Preferences");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"profile":{"name":"Role"},"partition":{"default_zoom_level":{"other":2,"x":4},"per_host_zoom_levels":{"x":{"game":1},"other":{"game":2}}}}"#,
        )
        .unwrap();

        apply(
            directory.path(),
            &browser,
            None,
            &fonts("custom"),
            Some(0.5),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            value.pointer("/profile/name"),
            Some(&Value::String("Role".to_owned()))
        );
        assert!(value.pointer("/partition/default_zoom_level/x").is_some());
        assert!(value.pointer("/partition/per_host_zoom_levels/x").is_none());
        assert!(
            value
                .pointer("/partition/per_host_zoom_levels/other")
                .is_some()
        );
    }

    #[test]
    fn default_settings_remove_managed_values_and_skip_missing_files() {
        let directory = tempdir().unwrap();
        let browser = directory.path().join("browser");
        assert!(
            apply(
                directory.path(),
                &browser,
                None,
                &fonts("default"),
                Some(1.0)
            )
            .unwrap()
            .is_empty()
        );

        let path = browser.join("Default/Preferences");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"webkit":{"webprefs":{"default_font_size":18,"fonts":{"standard":{"Zyyy":"Arial"}}}},"partition":{"default_zoom_level":{"x":-3}}}"#,
        )
        .unwrap();
        apply(
            directory.path(),
            &browser,
            None,
            &fonts("default"),
            Some(1.0),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            value.pointer("/webkit/webprefs/default_font_size"),
            Some(&Value::from(18))
        );
        assert!(value.pointer("/webkit/webprefs/fonts").is_none());
        assert!(value.pointer("/partition/default_zoom_level").is_none());
    }

    #[test]
    fn rejects_invalid_zoom_paths_and_partitions() {
        let directory = tempdir().unwrap();
        let browser = directory.path().join("browser");
        assert!(
            apply(
                directory.path(),
                &browser,
                None,
                &fonts("custom"),
                Some(0.0)
            )
            .is_err()
        );
        assert!(
            apply(
                directory.path(),
                Path::new("relative"),
                None,
                &fonts("custom"),
                None
            )
            .is_err()
        );
        assert!(
            apply(
                directory.path(),
                &browser,
                Some("persist:../escape"),
                &fonts("custom"),
                None
            )
            .is_err()
        );
    }
}
