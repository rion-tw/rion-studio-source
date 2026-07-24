use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use rion_platform::Platform;

use crate::model::{BootstrapPlanRecord, BrowserGraphicsSettingsRecord, ChromiumSwitchRecord};

const BASE_SWITCHES: &[&str] = &[
    "no-first-run",
    "no-default-browser-check",
    "disable-default-apps",
    "disable-component-extensions-with-background-pages",
    "metrics-recording-only",
    "no-service-autorun",
    "disable-search-engine-choice-screen",
];
const BACKGROUND_FEATURES_TO_DISABLE: &[&str] = &["MediaRouter", "OptimizationHints", "Translate"];

pub fn read_plan(
    user_data_dir: &Path,
    platform: Platform,
    current_enable_features: &str,
    current_disable_features: &str,
) -> BootstrapPlanRecord {
    let settings = load_graphics_settings(user_data_dir);
    let switches = chromium_switches(
        &settings,
        platform,
        current_enable_features,
        current_disable_features,
    );
    BootstrapPlanRecord {
        applied_graphics_settings: settings,
        switches,
    }
}

fn load_graphics_settings(user_data_dir: &Path) -> BrowserGraphicsSettingsRecord {
    read_sqlite_settings(&user_data_dir.join("rion-studio.sqlite3"))
        .or_else(|| read_legacy_settings(&user_data_dir.join("game-browser-settings.json")))
        .unwrap_or_else(BrowserGraphicsSettingsRecord::recommended_default)
}

pub fn formatted_graphics_switches(
    settings: &BrowserGraphicsSettingsRecord,
    platform: Platform,
) -> Vec<String> {
    graphics_switches(settings, platform)
        .into_iter()
        .map(|item| match item.value {
            Some(value) => format!("--{}={value}", item.name),
            None => format!("--{}", item.name),
        })
        .collect()
}

fn chromium_switches(
    settings: &BrowserGraphicsSettingsRecord,
    platform: Platform,
    current_enable_features: &str,
    current_disable_features: &str,
) -> Vec<ChromiumSwitchRecord> {
    let mut switches = BASE_SWITCHES
        .iter()
        .map(|name| switch(name, None))
        .collect::<Vec<_>>();
    for mut item in graphics_switches(settings, platform) {
        if item.name == "enable-features" {
            item.value = Some(merge_comma_separated(
                current_enable_features,
                item.value.as_deref(),
            ));
        }
        switches.push(item);
    }
    switches.push(switch(
        "disable-features",
        Some(merge_comma_separated(
            current_disable_features,
            BACKGROUND_FEATURES_TO_DISABLE.iter().copied(),
        )),
    ));
    switches
}

fn graphics_switches(
    settings: &BrowserGraphicsSettingsRecord,
    platform: Platform,
) -> Vec<ChromiumSwitchRecord> {
    let mut switches = Vec::new();
    if settings.prefer_high_performance_gpu {
        switches.push(switch("force-high-performance-gpu", None));
    }
    if settings.force_gpu_rasterization {
        switches.push(switch("enable-gpu-rasterization", None));
    }
    if !settings.gpu_blocklist_enabled {
        switches.push(switch("ignore-gpu-blocklist", None));
    }
    if settings.unsafe_web_gpu_enabled {
        switches.push(switch("enable-unsafe-webgpu", None));
    }
    if !settings.frame_rate_limit_enabled && matches!(platform, Platform::Windows) {
        switches.push(switch("disable-frame-rate-limit", None));
    }
    if !settings.vsync_enabled {
        switches.push(switch("disable-gpu-vsync", None));
    }
    if !settings.driver_bug_workarounds_enabled {
        switches.push(switch("disable-gpu-driver-bug-workarounds", None));
    }
    match platform {
        Platform::Macos if settings.backend.macos == "metal" => {
            switches.push(switch("use-angle", Some("metal".to_owned())));
        }
        Platform::Windows if settings.backend.windows == "vulkan" => {
            switches.push(switch("use-angle", Some("vulkan".to_owned())));
            switches.push(switch("use-vulkan", Some("native".to_owned())));
            switches.push(switch("enable-features", Some("Vulkan".to_owned())));
        }
        Platform::Windows if settings.backend.windows != "automatic" => {
            switches.push(switch("use-angle", Some(settings.backend.windows.clone())));
        }
        _ => {}
    }
    switches
}

fn switch(name: &str, value: Option<String>) -> ChromiumSwitchRecord {
    ChromiumSwitchRecord {
        name: name.to_owned(),
        value,
    }
}

fn merge_comma_separated<'a>(
    current: &'a str,
    additions: impl IntoIterator<Item = &'a str>,
) -> String {
    let mut output = Vec::<String>::new();
    for value in current.split(',').chain(additions) {
        let value = value.trim();
        if !value.is_empty() && !output.iter().any(|candidate| candidate == value) {
            output.push(value.to_owned());
        }
    }
    output.join(",")
}

fn read_sqlite_settings(path: &Path) -> Option<BrowserGraphicsSettingsRecord> {
    if !path.is_file() {
        return None;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let payload = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()??;
    read_settings(&serde_json::from_str(&payload).ok()?)
}

fn read_legacy_settings(path: &Path) -> Option<BrowserGraphicsSettingsRecord> {
    let payload = fs::read(path).ok()?;
    read_settings(&serde_json::from_slice(&payload).ok()?)
}

fn read_settings(value: &Value) -> Option<BrowserGraphicsSettingsRecord> {
    serde_json::from_value(value.get("graphics")?.clone()).ok()
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn reads_sqlite_as_the_authoritative_bootstrap_source() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"experimental"}}"#,
        )
        .unwrap();
        let connection = Connection::open(directory.path().join("rion-studio.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings(key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)",
                params![
                    "gameBrowserSettings",
                    r#"{"graphics":{"mode":"high_performance"}}"#
                ],
            )
            .unwrap();

        let settings =
            read_plan(directory.path(), Platform::Macos, "", "").applied_graphics_settings;
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("high_performance")
        );
    }

    #[test]
    fn reads_legacy_before_first_migration_and_defaults_invalid_values() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"experimental"}}"#,
        )
        .unwrap();
        let settings =
            read_plan(directory.path(), Platform::Macos, "", "").applied_graphics_settings;
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("experimental")
        );
        crate::v1_case!("browser-workspace-b4ce96870a1a", {
            assert_eq!(
                settings,
                BrowserGraphicsSettingsRecord::from_legacy_mode("experimental")
            );
        });

        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"unsafe"}}"#,
        )
        .unwrap();
        let settings =
            read_plan(directory.path(), Platform::Macos, "", "").applied_graphics_settings;
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("automatic")
        );
    }

    #[test]
    fn defaults_missing_and_invalid_startup_settings_to_recommended_profile() {
        let directory = tempdir().unwrap();
        let missing =
            read_plan(directory.path(), Platform::Macos, "", "").applied_graphics_settings;
        fs::write(
            directory.path().join("game-browser-settings.json"),
            b"{invalid",
        )
        .unwrap();
        let invalid =
            read_plan(directory.path(), Platform::Macos, "", "").applied_graphics_settings;

        crate::v1_case!("browser-workspace-77044f2f1365", {
            let recommended = BrowserGraphicsSettingsRecord::recommended_default();
            assert_eq!(missing, recommended);
            assert_eq!(invalid, recommended);
        });
        crate::v1_case!("resource-platform-1c4495725392", {
            let automatic = BrowserGraphicsSettingsRecord::from_legacy_mode("automatic");
            assert_eq!(
                BrowserGraphicsSettingsRecord::from_legacy_mode("automatic"),
                automatic
            );
            assert_eq!(
                BrowserGraphicsSettingsRecord::from_legacy_mode("high_performance"),
                BrowserGraphicsSettingsRecord {
                    prefer_high_performance_gpu: true,
                    ..automatic.clone()
                }
            );
            assert_eq!(
                BrowserGraphicsSettingsRecord::from_legacy_mode("unsafe"),
                automatic
            );
        });
    }

    #[test]
    fn applies_only_recommended_graphics_switches_on_macos_and_windows() {
        let directory = tempdir().unwrap();
        let recommended = BrowserGraphicsSettingsRecord::recommended_default();
        let expected = vec![switch("force-high-performance-gpu", None)];

        for platform in [Platform::Macos, Platform::Windows] {
            let plan = read_plan(directory.path(), platform, "", "");
            assert_eq!(plan.applied_graphics_settings, recommended);
            assert_eq!(
                graphics_switches(&plan.applied_graphics_settings, platform),
                expected
            );
        }
    }

    #[test]
    fn preserves_disabled_features_and_applies_safe_high_performance_switches() {
        let settings = BrowserGraphicsSettingsRecord::from_legacy_mode("high_performance");
        let switches = chromium_switches(
            &settings,
            Platform::Macos,
            "",
            "ExistingFeature,MediaRouter",
        );

        crate::v1_case!("browser-workspace-ec8bf4e43acc", {
            assert!(switches.contains(&switch("force-high-performance-gpu", None)));
            assert!(!switches.contains(&switch("ignore-gpu-blocklist", None)));
            assert!(switches.iter().any(|item| {
                item.name == "disable-features"
                    && item.value.as_deref()
                        == Some("ExistingFeature,MediaRouter,OptimizationHints,Translate")
            }));
        });
    }

    #[test]
    fn limits_unsafe_switches_to_explicit_experimental_mode() {
        let automatic = chromium_switches(
            &BrowserGraphicsSettingsRecord::from_legacy_mode("automatic"),
            Platform::Macos,
            "",
            "",
        );
        let experimental = chromium_switches(
            &BrowserGraphicsSettingsRecord::from_legacy_mode("experimental"),
            Platform::Macos,
            "",
            "",
        );

        crate::v1_case!("browser-workspace-cc817a22dbcc", {
            assert!(!automatic.contains(&switch("ignore-gpu-blocklist", None)));
            assert!(!automatic.contains(&switch("enable-unsafe-webgpu", None)));
            assert!(experimental.contains(&switch("force-high-performance-gpu", None)));
            assert!(experimental.contains(&switch("ignore-gpu-blocklist", None)));
            assert!(experimental.contains(&switch("enable-unsafe-webgpu", None)));
        });
    }

    #[test]
    fn builds_explicit_cross_platform_switch_plans_and_merges_feature_values() {
        let mut settings = BrowserGraphicsSettingsRecord::recommended_default();
        settings.backend.macos = "metal".to_owned();
        let macos = chromium_switches(
            &settings,
            Platform::Macos,
            "ExistingFeature",
            "ExistingDisabled",
        );
        assert!(macos.contains(&switch("use-angle", Some("metal".to_owned()))));
        assert!(macos.iter().any(|item| {
            item.name == "disable-features"
                && item.value.as_deref()
                    == Some("ExistingDisabled,MediaRouter,OptimizationHints,Translate")
        }));

        settings.backend.windows = "vulkan".to_owned();
        let windows = chromium_switches(&settings, Platform::Windows, "ExistingFeature", "");
        assert!(windows.contains(&switch("use-angle", Some("vulkan".to_owned()))));
        assert!(windows.contains(&switch("use-vulkan", Some("native".to_owned()))));
        assert!(windows.iter().any(|item| {
            item.name == "enable-features"
                && item.value.as_deref() == Some("ExistingFeature,Vulkan")
        }));
    }

    #[test]
    fn skips_the_unstable_unlimited_frame_rate_switch_on_macos() {
        let mut settings = BrowserGraphicsSettingsRecord::recommended_default();
        settings.frame_rate_limit_enabled = false;
        settings.vsync_enabled = false;

        let macos = graphics_switches(&settings, Platform::Macos);
        assert!(!macos.contains(&switch("disable-frame-rate-limit", None)));
        assert!(macos.contains(&switch("disable-gpu-vsync", None)));

        let windows = graphics_switches(&settings, Platform::Windows);
        assert!(windows.contains(&switch("disable-frame-rate-limit", None)));
        assert!(windows.contains(&switch("disable-gpu-vsync", None)));
    }
}
