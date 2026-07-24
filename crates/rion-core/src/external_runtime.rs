use std::collections::HashMap;

use crate::model::{
    BrowserGraphicsSettingsRecord, BrowserRoleStatusRecord, BrowserWorkspaceStatusRecord,
    ExternalChromeDiagnosticsRecord, ExternalSessionRecord, StateNormalizedRectRecord,
    StatePixelBoundsRecord,
};

const BASE_SWITCHES: &[&str] = &[
    "no-first-run",
    "no-default-browser-check",
    "disable-default-apps",
    "disable-component-extensions-with-background-pages",
    "metrics-recording-only",
    "no-service-autorun",
    "disable-search-engine-choice-screen",
];
const BACKGROUND_FEATURES: &str = "MediaRouter,OptimizationHints,Translate";
const MACOS_SEAM_OVERLAP: i32 = 12;
const WINDOWS_SEAM_OVERLAP: i32 = 1;
pub(crate) const EXTERNAL_COMPAT_NOTICE: &str = "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";

pub(crate) fn resolve_launch_mode(override_mode: &str, global_mode: &str) -> &'static str {
    match override_mode {
        "embedded" => "embedded",
        "external" => "external",
        "auto" => "auto",
        _ => match global_mode {
            "external" => "external",
            "auto" => "auto",
            _ => "embedded",
        },
    }
}

pub(crate) fn should_fallback_to_external(mode: &str, error_code: &str) -> bool {
    mode == "auto" && error_code == "GAME_PAGE_LOAD_FAILED"
}

pub(crate) fn build_arguments(
    launch_url: &str,
    browser_user_data_dir: &str,
    bounds: &StatePixelBoundsRecord,
    proxy_server: Option<&str>,
    graphics: &BrowserGraphicsSettingsRecord,
    platform: rion_platform::Platform,
) -> Vec<String> {
    let mut arguments = vec![
        format!("--user-data-dir={browser_user_data_dir}"),
        "--profile-directory=Default".to_owned(),
        format!("--app={launch_url}"),
        format!("--window-position={},{}", bounds.x, bounds.y),
        format!("--window-size={},{}", bounds.width, bounds.height),
    ];
    arguments.extend(BASE_SWITCHES.iter().map(|switch| format!("--{switch}")));
    arguments.push(format!("--disable-features={BACKGROUND_FEATURES}"));
    if graphics.prefer_high_performance_gpu {
        arguments.push("--force-high-performance-gpu".to_owned());
    }
    if graphics.force_gpu_rasterization {
        arguments.push("--enable-gpu-rasterization".to_owned());
    }
    if !graphics.gpu_blocklist_enabled {
        arguments.push("--ignore-gpu-blocklist".to_owned());
    }
    if graphics.unsafe_web_gpu_enabled {
        arguments.push("--enable-unsafe-webgpu".to_owned());
    }
    if !graphics.frame_rate_limit_enabled && matches!(platform, rion_platform::Platform::Windows) {
        arguments.push("--disable-frame-rate-limit".to_owned());
    }
    if !graphics.vsync_enabled {
        arguments.push("--disable-gpu-vsync".to_owned());
    }
    if !graphics.driver_bug_workarounds_enabled {
        arguments.push("--disable-gpu-driver-bug-workarounds".to_owned());
    }
    match platform {
        rion_platform::Platform::Macos if graphics.backend.macos == "metal" => {
            arguments.push("--use-angle=metal".to_owned());
        }
        rion_platform::Platform::Windows if graphics.backend.windows == "vulkan" => {
            arguments.extend([
                "--use-angle=vulkan".to_owned(),
                "--use-vulkan=native".to_owned(),
                "--enable-features=Vulkan".to_owned(),
            ]);
        }
        rion_platform::Platform::Windows if graphics.backend.windows != "automatic" => {
            arguments.push(format!("--use-angle={}", graphics.backend.windows));
        }
        _ => {}
    }
    arguments.extend([
        "--remote-debugging-address=127.0.0.1".to_owned(),
        "--remote-debugging-port=0".to_owned(),
    ]);
    if let Some(proxy_server) = proxy_server.filter(|value| !value.trim().is_empty()) {
        arguments.push(format!("--proxy-server={proxy_server}"));
    }
    arguments
}

pub(crate) fn workspace_bounds(
    rects: &[StateNormalizedRectRecord],
    work_area: &StatePixelBoundsRecord,
    platform: rion_platform::Platform,
) -> Vec<StatePixelBoundsRecord> {
    let normalized = crate::layout::normalize_rect_edges(
        &rects
            .iter()
            .map(|rect| crate::model::LayoutRect {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            })
            .collect::<Vec<_>>(),
    );
    let bounds = normalized
        .iter()
        .map(|rect| normalized_bounds(rect, work_area))
        .collect::<Vec<_>>();
    let overlap = match platform {
        rion_platform::Platform::Macos => MACOS_SEAM_OVERLAP,
        rion_platform::Platform::Windows => WINDOWS_SEAM_OVERLAP,
    };
    seamless_bounds(bounds, overlap)
}

pub(crate) fn workspace_zoom_factor(
    mode: &str,
    workspace_percent: f64,
    role_percent: Option<f64>,
    viewport_width: i32,
) -> f64 {
    role_percent.unwrap_or_else(|| {
        if mode == "adaptive" {
            f64::from(crate::layout::adaptive_zoom_percent(
                f64::from(viewport_width),
                None,
            ))
        } else {
            workspace_percent
        }
    }) / 100.0
}

fn normalized_bounds(
    rect: &crate::model::LayoutRect,
    area: &StatePixelBoundsRecord,
) -> StatePixelBoundsRecord {
    let left = (rect.x * f64::from(area.width)).round() as i32;
    let top = (rect.y * f64::from(area.height)).round() as i32;
    let right = ((rect.x + rect.width) * f64::from(area.width)).round() as i32;
    let bottom = ((rect.y + rect.height) * f64::from(area.height)).round() as i32;
    StatePixelBoundsRecord {
        x: area.x.saturating_add(left),
        y: area.y.saturating_add(top),
        width: right.saturating_sub(left).max(1),
        height: bottom.saturating_sub(top).max(1),
    }
}

fn seamless_bounds(
    bounds: Vec<StatePixelBoundsRecord>,
    overlap: i32,
) -> Vec<StatePixelBoundsRecord> {
    if overlap <= 0 || bounds.len() < 2 {
        return bounds;
    }
    let mut result = bounds.clone();
    for left_index in 0..bounds.len() {
        let left = &bounds[left_index];
        let left_right = left.x.saturating_add(left.width);
        let left_bottom = left.y.saturating_add(left.height);
        for right in bounds.iter().skip(left_index + 1) {
            let right_edge = right.x.saturating_add(right.width);
            let right_bottom = right.y.saturating_add(right.height);
            let vertical_overlap = left_bottom.min(right_bottom) - left.y.max(right.y);
            let horizontal_overlap = left_right.min(right_edge) - left.x.max(right.x);
            if vertical_overlap > 0 {
                if left_right == right.x {
                    result[left_index].width = result[left_index].width.saturating_add(overlap);
                } else if right_edge == left.x {
                    result[left_index].x = result[left_index].x.saturating_sub(overlap);
                    result[left_index].width = result[left_index].width.saturating_add(overlap);
                }
            }
            if horizontal_overlap > 0 {
                if left_bottom == right.y {
                    result[left_index].height = result[left_index].height.saturating_add(overlap);
                } else if right_bottom == left.y {
                    result[left_index].y = result[left_index].y.saturating_sub(overlap);
                    result[left_index].height = result[left_index].height.saturating_add(overlap);
                }
            }
        }
    }
    result
}

pub(crate) fn role_statuses(
    embedded: impl Iterator<Item = crate::model::BrowserRuntimeRoleRecord>,
    external: &[ExternalSessionRecord],
) -> Vec<BrowserRoleStatusRecord> {
    let mut statuses = embedded
        .filter(|role| role.runtime == "embedded")
        .map(|role| BrowserRoleStatusRecord {
            role_id: role.role_id,
            state: role.state,
            launched_at: role.launched_at,
            notice: None,
            runtime_mode: "embedded".to_owned(),
            automation_state: None,
            overlay_state: None,
            page_health: None,
        })
        .chain(external.iter().map(|session| BrowserRoleStatusRecord {
            role_id: session.role.id.clone(),
            state: session.state.clone(),
            launched_at: session.launched_at.clone(),
            notice: session.notice.clone(),
            runtime_mode: "external".to_owned(),
            automation_state: (session.state == "running").then(|| {
                if session.automation_available {
                    "ready".to_owned()
                } else {
                    "unavailable".to_owned()
                }
            }),
            overlay_state: (session.state == "running").then(|| {
                if session.overlay_available {
                    "ready".to_owned()
                } else {
                    "unavailable".to_owned()
                }
            }),
            page_health: session.page_health.clone(),
        }))
        .collect::<Vec<_>>();
    statuses.sort_by(|left, right| left.role_id.cmp(&right.role_id));
    statuses
}

pub(crate) fn workspace_statuses(
    external: &[ExternalSessionRecord],
    embedded: impl Iterator<Item = crate::model::BrowserRuntimeWorkspaceRecord>,
) -> Vec<BrowserWorkspaceStatusRecord> {
    let mut states = embedded
        .map(|workspace| (workspace.workspace_id, workspace.state))
        .collect::<HashMap<_, _>>();
    for session in external {
        let Some(workspace_id) = &session.workspace_id else {
            continue;
        };
        let current = states.get(workspace_id).map(String::as_str);
        let next = if session.state == "stopping" || current == Some("stopping") {
            "stopping"
        } else if session.state == "launching" || current == Some("launching") {
            "launching"
        } else {
            "running"
        };
        states.insert(workspace_id.clone(), next.to_owned());
    }
    let mut statuses = states
        .into_iter()
        .map(|(workspace_id, state)| BrowserWorkspaceStatusRecord {
            workspace_id,
            state,
        })
        .collect::<Vec<_>>();
    statuses.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    statuses
}

pub(crate) fn diagnostics(
    session: &ExternalSessionRecord,
    external_role_count: usize,
    chrome: Option<serde_json::Value>,
) -> ExternalChromeDiagnosticsRecord {
    ExternalChromeDiagnosticsRecord {
        automation_state: if session.automation_available {
            "ready".to_owned()
        } else {
            "unavailable".to_owned()
        },
        bounds: session.bounds.clone(),
        captured_at: chrono::Utc::now().to_rfc3339(),
        external_role_count: external_role_count.try_into().unwrap_or(u32::MAX),
        page_health: session.page_health.clone(),
        physical_bounds: session.physical_bounds.clone(),
        role_id: session.role.id.clone(),
        runtime_mode: "external".to_owned(),
        workspace_id: session.workspace_id.clone(),
        zoom_factor: session.zoom_factor,
        chrome_json: chrome.map(|value| value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graphics() -> BrowserGraphicsSettingsRecord {
        BrowserGraphicsSettingsRecord::from_legacy_mode("automatic")
    }

    #[test]
    fn resolves_role_override_before_global_launch_mode() {
        let cases = [
            ("embedded", "external", "embedded"),
            ("external", "embedded", "external"),
            ("auto", "embedded", "auto"),
            ("inherit", "external", "external"),
            ("inherit", "auto", "auto"),
            ("inherit", "invalid", "embedded"),
        ];
        for (override_mode, global_mode, expected) in cases {
            assert_eq!(
                resolve_launch_mode(override_mode, global_mode),
                expected,
                "{override_mode}/{global_mode}"
            );
        }
        crate::v1_case!("browser-workspace-c4177d56c920", {
            assert_eq!(resolve_launch_mode("inherit", "auto"), "auto");
            assert!(should_fallback_to_external("auto", "GAME_PAGE_LOAD_FAILED"));
            assert!(!should_fallback_to_external(
                "auto",
                "ELECTRON_EFFECT_FAILED"
            ));
            assert_eq!(
                EXTERNAL_COMPAT_NOTICE,
                "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support."
            );
        });
        crate::v1_case!("browser-workspace-5edde963f133", {
            assert_eq!(resolve_launch_mode("embedded", "auto"), "embedded");
            assert!(!should_fallback_to_external(
                "embedded",
                "GAME_PAGE_LOAD_FAILED"
            ));
        });
        crate::v1_case!("browser-workspace-0dc6bcf3e5e5", {
            assert_eq!(resolve_launch_mode("external", "embedded"), "external");
            assert!(!should_fallback_to_external(
                "external",
                "GAME_PAGE_LOAD_FAILED"
            ));
        });
    }

    #[test]
    fn builds_platform_specific_external_arguments() {
        let bounds = StatePixelBoundsRecord {
            x: -100,
            y: 20,
            width: 1200,
            height: 800,
        };
        let mac = build_arguments(
            "https://example.test",
            "/tmp/profile",
            &bounds,
            Some("http://127.0.0.1:8888"),
            &graphics(),
            rion_platform::Platform::Macos,
        );
        assert!(mac.contains(&"--window-position=-100,20".to_owned()));
        assert!(mac.contains(&"--proxy-server=http://127.0.0.1:8888".to_owned()));
        assert!(mac.contains(&"--remote-debugging-port=0".to_owned()));

        let mut windows_graphics = graphics();
        windows_graphics.backend.windows = "vulkan".to_owned();
        let windows = build_arguments(
            "https://example.test",
            r"C:\profile",
            &bounds,
            None,
            &windows_graphics,
            rion_platform::Platform::Windows,
        );
        assert!(windows.contains(&"--use-angle=vulkan".to_owned()));
        assert!(windows.contains(&"--use-vulkan=native".to_owned()));

        let mut unlimited_graphics = graphics();
        unlimited_graphics.frame_rate_limit_enabled = false;
        unlimited_graphics.vsync_enabled = false;
        let mac_unlimited = build_arguments(
            "https://example.test",
            "/tmp/profile",
            &bounds,
            None,
            &unlimited_graphics,
            rion_platform::Platform::Macos,
        );
        assert!(!mac_unlimited.contains(&"--disable-frame-rate-limit".to_owned()));
        assert!(mac_unlimited.contains(&"--disable-gpu-vsync".to_owned()));
        let windows_unlimited = build_arguments(
            "https://example.test",
            r"C:\profile",
            &bounds,
            None,
            &unlimited_graphics,
            rion_platform::Platform::Windows,
        );
        assert!(windows_unlimited.contains(&"--disable-frame-rate-limit".to_owned()));
        assert!(windows_unlimited.contains(&"--disable-gpu-vsync".to_owned()));

        crate::v1_case!("external-chrome-cdn-1025b47f22b8", {
            let visible = build_arguments(
                "https://example.com/play",
                "/tmp/rion/role-1/browser",
                &StatePixelBoundsRecord {
                    x: -1280,
                    y: -120,
                    width: 1280,
                    height: 720,
                },
                None,
                &graphics(),
                rion_platform::Platform::Macos,
            );
            assert_eq!(
                visible,
                [
                    "--user-data-dir=/tmp/rion/role-1/browser",
                    "--profile-directory=Default",
                    "--app=https://example.com/play",
                    "--window-position=-1280,-120",
                    "--window-size=1280,720",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-default-apps",
                    "--disable-component-extensions-with-background-pages",
                    "--metrics-recording-only",
                    "--no-service-autorun",
                    "--disable-search-engine-choice-screen",
                    "--disable-features=MediaRouter,OptimizationHints,Translate",
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=0",
                ]
                .map(str::to_owned)
            );
        });

        let assert_native_foreground = |platform| {
            let arguments = build_arguments(
                "https://example.test",
                "/tmp/profile",
                &StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 720,
                },
                None,
                &graphics(),
                platform,
            );
            for forbidden in [
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
            ] {
                assert!(!arguments.contains(&forbidden.to_owned()));
            }
        };
        crate::v1_case!("external-chrome-cdn-25cf6eecdf9b", {
            assert_native_foreground(rion_platform::Platform::Windows);
        });
        crate::v1_case!("external-chrome-cdn-224f1ddc3afc", {
            assert_native_foreground(rion_platform::Platform::Macos);
        });
        crate::v1_case!("external-chrome-cdn-10f9effd6657", {
            // Foreground scheduling is intentionally platform-neutral; Linux
            // used the same switch set in v1 even though 2.x ships macOS/Windows.
            assert_native_foreground(rion_platform::Platform::Macos);
        });

        crate::v1_case!("external-chrome-cdn-03a2ed8859e6", {
            let automatic = build_arguments(
                "https://example.test",
                "/tmp/profile",
                &bounds,
                None,
                &BrowserGraphicsSettingsRecord::from_legacy_mode("automatic"),
                rion_platform::Platform::Macos,
            );
            assert!(!automatic.contains(&"--ignore-gpu-blocklist".to_owned()));
            let high = build_arguments(
                "https://example.test",
                "/tmp/profile",
                &bounds,
                None,
                &BrowserGraphicsSettingsRecord::from_legacy_mode("high_performance"),
                rion_platform::Platform::Macos,
            );
            assert!(high.contains(&"--force-high-performance-gpu".to_owned()));
            let experimental = build_arguments(
                "https://example.test",
                "/tmp/profile",
                &bounds,
                None,
                &BrowserGraphicsSettingsRecord::from_legacy_mode("experimental"),
                rion_platform::Platform::Macos,
            );
            for selected in [
                "--force-high-performance-gpu",
                "--ignore-gpu-blocklist",
                "--enable-unsafe-webgpu",
            ] {
                assert!(experimental.contains(&selected.to_owned()));
            }
        });

        for (case_id, platform, profile) in [
            (
                "external-chrome-cdn-729079731e06",
                rion_platform::Platform::Macos,
                "/profiles/role-1/browser",
            ),
            (
                "external-chrome-cdn-9495a0b69e1a",
                rion_platform::Platform::Windows,
                r"C:\profiles\role-1\browser",
            ),
        ] {
            let arguments = build_arguments(
                "https://example.com/play",
                profile,
                &StatePixelBoundsRecord {
                    x: 100,
                    y: 50,
                    width: 1200,
                    height: 800,
                },
                None,
                &graphics(),
                platform,
            );
            crate::v1_case!(case_id, {
                assert!(arguments.contains(&format!("--user-data-dir={profile}")));
                assert!(arguments.contains(&"--window-position=100,50".to_owned()));
                assert!(arguments.contains(&"--window-size=1200,800".to_owned()));
            });
        }
    }

    #[test]
    fn tiles_workspace_bounds_with_platform_seam_overlap() {
        let area = StatePixelBoundsRecord {
            x: 100,
            y: 50,
            width: 1200,
            height: 800,
        };
        let rects = vec![
            StateNormalizedRectRecord {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        ];
        let mac = workspace_bounds(&rects, &area, rion_platform::Platform::Macos);
        assert_eq!(mac[0].width, 612);
        assert_eq!(mac[1].x, 700);
        let windows = workspace_bounds(&rects, &area, rion_platform::Platform::Windows);
        assert_eq!(windows[0].width, 601);
        crate::v1_case!("browser-workspace-441d225256bd", {
            assert_eq!(mac[0].x, area.x);
            assert_eq!(mac[0].width, 612);
            assert_eq!(mac[1].x, 700);
            assert_eq!(mac[1].width, 600);
            assert_eq!(windows[0].width, 601);
            assert_eq!(windows[1].x, 700);
        });

        let selected = StatePixelBoundsRecord {
            x: 1200,
            y: 24,
            width: 1920,
            height: 1040,
        };
        let full = workspace_bounds(
            &[StateNormalizedRectRecord {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }],
            &selected,
            rion_platform::Platform::Macos,
        );
        crate::v1_case!("browser-workspace-ef59508664f5", {
            assert_eq!(full[0].x, selected.x);
            assert_eq!(full[0].y, selected.y);
            assert_eq!(full[0].width, selected.width);
            assert_eq!(full[0].height, selected.height);
        });

        let negative_selected = StatePixelBoundsRecord {
            x: -984,
            y: -200,
            width: 984,
            height: 1280,
        };
        let negative = workspace_bounds(&rects, &negative_selected, rion_platform::Platform::Macos);
        crate::v1_case!("browser-workspace-f4f8ee648a41", {
            assert_eq!(negative[0].x, -984);
            assert_eq!(negative[0].y, -200);
            assert_eq!(negative[1].x, -492);
            assert_eq!(negative[0].height, 1280);
            assert_eq!(negative[1].height, 1280);
        });
    }

    #[test]
    fn preserves_v1_workspace_zoom_normalization_and_platform_bounds() {
        crate::v1_case!("external-chrome-cdn-41104fe22829", {
            assert_eq!(workspace_zoom_factor("adaptive", 100.0, None, 1200), 0.9);
        });
        crate::v1_case!("external-chrome-cdn-b7dad53e3d01", {
            assert_eq!(
                workspace_zoom_factor("adaptive", 100.0, Some(120.0), 640),
                1.2
            );
        });
        crate::v1_case!("external-chrome-cdn-fe4e3fc66af5", {
            assert_eq!(
                (0..8)
                    .map(|_| workspace_zoom_factor("adaptive", 100.0, None, 640))
                    .collect::<Vec<_>>(),
                vec![0.5; 8]
            );
        });

        let two = [
            StateNormalizedRectRecord {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        ];
        let mac_area = StatePixelBoundsRecord {
            x: 2000,
            y: 40,
            width: 1600,
            height: 900,
        };
        let mac = workspace_bounds(&two, &mac_area, rion_platform::Platform::Macos);
        crate::v1_case!("external-chrome-cdn-451027e6e4c4", {
            assert_eq!(
                bounds_tuples(&seamless_bounds(
                    two.iter()
                        .map(|rect| {
                            normalized_bounds(
                                &crate::model::LayoutRect {
                                    x: rect.x,
                                    y: rect.y,
                                    width: rect.width,
                                    height: rect.height,
                                },
                                &mac_area,
                            )
                        })
                        .collect(),
                    0,
                )),
                [(2000, 40, 800, 900), (2800, 40, 800, 900),]
            );
        });
        crate::v1_case!("external-chrome-cdn-088c03213669", {
            assert_eq!(
                bounds_tuples(&mac),
                [(2000, 40, 812, 900), (2800, 40, 800, 900),]
            );
            let first_args = build_arguments(
                "https://example.test",
                "/profiles/role-1/browser",
                &mac[0],
                None,
                &graphics(),
                rion_platform::Platform::Macos,
            );
            assert!(first_args.contains(&"--window-size=812,900".to_owned()));
        });

        let four = [
            StateNormalizedRectRecord {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            },
            StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            },
            StateNormalizedRectRecord {
                x: 0.0,
                y: 0.5,
                width: 0.5,
                height: 0.5,
            },
            StateNormalizedRectRecord {
                x: 0.5,
                y: 0.5,
                width: 0.5,
                height: 0.5,
            },
        ];
        let rounded_area = StatePixelBoundsRecord {
            x: 2000,
            y: 40,
            width: 1601,
            height: 901,
        };
        let base = four
            .iter()
            .map(|rect| {
                normalized_bounds(
                    &crate::model::LayoutRect {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    },
                    &rounded_area,
                )
            })
            .collect::<Vec<_>>();
        crate::v1_case!("external-chrome-cdn-260d1dd5c330", {
            assert_eq!(
                bounds_tuples(&base),
                [
                    (2000, 40, 801, 451),
                    (2801, 40, 800, 451),
                    (2000, 491, 801, 450),
                    (2801, 491, 800, 450),
                ]
            );
        });

        let physical_area = StatePixelBoundsRecord {
            x: -1920,
            y: -80,
            width: 2001,
            height: 1127,
        };
        let physical = workspace_bounds(&four, &physical_area, rion_platform::Platform::Windows);
        crate::v1_case!("external-chrome-cdn-63f2448645f3", {
            assert_eq!(
                bounds_tuples(&physical),
                [
                    (-1920, -80, 1002, 565),
                    (-919, -80, 1000, 565),
                    (-1920, 484, 1002, 563),
                    (-919, 484, 1000, 563),
                ]
            );
        });

        let almost_shared = (0..8)
            .map(|index| {
                let column = index % 4;
                let row = index / 4;
                let x = if column == 2 {
                    0.50002
                } else {
                    column as f64 / 4.0
                };
                let y = if row == 1 { 0.50002 } else { 0.0 };
                let right = if column == 1 {
                    0.49998
                } else {
                    (column + 1) as f64 / 4.0
                };
                let bottom = if row == 0 { 0.49998 } else { 1.0 };
                StateNormalizedRectRecord {
                    x,
                    y,
                    width: right - x,
                    height: bottom - y,
                }
            })
            .collect::<Vec<_>>();
        let normalized = crate::layout::normalize_rect_edges(
            &almost_shared
                .iter()
                .map(|rect| crate::model::LayoutRect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                })
                .collect::<Vec<_>>(),
        );
        let area = StatePixelBoundsRecord {
            x: 2000,
            y: 40,
            width: 1603,
            height: 903,
        };
        let tiled = normalized
            .iter()
            .map(|rect| normalized_bounds(rect, &area))
            .collect::<Vec<_>>();
        crate::v1_case!("external-chrome-cdn-61437ef4ad1c", {
            assert_eq!(
                bounds_tuples(&tiled),
                [
                    (2000, 40, 401, 452),
                    (2401, 40, 401, 452),
                    (2802, 40, 400, 452),
                    (3202, 40, 401, 452),
                    (2000, 492, 401, 451),
                    (2401, 492, 401, 451),
                    (2802, 492, 400, 451),
                    (3202, 492, 401, 451),
                ]
            );
        });

        let mac_grid = workspace_bounds(
            &four,
            &StatePixelBoundsRecord {
                x: 0,
                y: 24,
                width: 1600,
                height: 900,
            },
            rion_platform::Platform::Macos,
        );
        crate::v1_case!("external-chrome-cdn-d4ad1ab8a4d7", {
            assert_eq!(
                bounds_tuples(&mac_grid),
                [
                    (0, 24, 812, 462),
                    (800, 24, 800, 462),
                    (0, 474, 812, 450),
                    (800, 474, 800, 450),
                ]
            );
        });
    }

    fn bounds_tuples(bounds: &[StatePixelBoundsRecord]) -> Vec<(i32, i32, i32, i32)> {
        bounds
            .iter()
            .map(|bounds| (bounds.x, bounds.y, bounds.width, bounds.height))
            .collect()
    }

    #[test]
    fn projects_embedded_and_external_runtime_statuses_from_rust_state() {
        let embedded_role = crate::model::BrowserRuntimeRoleRecord {
            role_id: "embedded-role".to_owned(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some("tab-1".to_owned()),
            state: "running".to_owned(),
            launched_at: Some("2026-07-23T00:00:00Z".to_owned()),
        };
        let embedded_workspace = crate::model::BrowserRuntimeWorkspaceRecord {
            workspace_id: "embedded-workspace".to_owned(),
            name: "Embedded".to_owned(),
            runtime: "embedded".to_owned(),
            display_id: Some(1),
            exclusive_display: true,
            tab_id: Some("tab-1".to_owned()),
            role_ids: vec!["embedded-role".to_owned()],
            state: "running".to_owned(),
        };
        let external: ExternalSessionRecord = serde_json::from_value(serde_json::json!({
            "role": {
                "id": "external-role",
                "gameId": "game-1",
                "name": "External",
                "launchUrl": "https://example.test",
                "notes": "",
                "createdAt": "2026-07-23T00:00:00Z",
                "updatedAt": "2026-07-23T00:00:00Z"
            },
            "bounds": { "x": 0, "y": 0, "width": 800, "height": 600 },
            "physicalBounds": { "x": 0, "y": 0, "width": 1600, "height": 1200 },
            "workspaceId": "external-workspace",
            "zoomFactor": 1.0,
            "state": "running",
            "launchedAt": "2026-07-23T00:00:01Z",
            "notice": EXTERNAL_COMPAT_NOTICE,
            "automationAvailable": true,
            "cdnActive": false,
            "pageHealth": "healthy",
            "pageHidden": false
        }))
        .unwrap();

        let roles = role_statuses(
            std::iter::once(embedded_role),
            std::slice::from_ref(&external),
        );
        assert_eq!(
            roles
                .iter()
                .map(|role| (role.role_id.as_str(), role.runtime_mode.as_str()))
                .collect::<Vec<_>>(),
            vec![("embedded-role", "embedded"), ("external-role", "external")]
        );
        assert_eq!(roles[1].automation_state.as_deref(), Some("ready"));
        assert_eq!(roles[1].overlay_state.as_deref(), Some("unavailable"));
        assert_eq!(roles[1].page_health.as_deref(), Some("healthy"));
        crate::v1_case!("browser-workspace-25ad1cb1ef25", {
            let external_status = roles
                .iter()
                .find(|role| role.role_id == "external-role")
                .unwrap();
            assert_eq!(external_status.runtime_mode, "external");
        });
        crate::v1_case!("browser-workspace-13aaf9ae3e44", {
            let external_status = roles
                .iter()
                .find(|role| role.role_id == "external-role")
                .unwrap();
            assert_eq!(external_status.runtime_mode, "external");
            assert_eq!(external_status.state, "running");
            assert_eq!(external_status.page_health.as_deref(), Some("healthy"));
            assert_eq!(
                external_status.notice.as_deref(),
                Some(EXTERNAL_COMPAT_NOTICE)
            );
        });

        let workspaces = workspace_statuses(
            std::slice::from_ref(&external),
            std::iter::once(embedded_workspace),
        );
        assert_eq!(
            workspaces
                .iter()
                .map(|workspace| (workspace.workspace_id.as_str(), workspace.state.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("embedded-workspace", "running"),
                ("external-workspace", "running")
            ]
        );

        let captured = diagnostics(&external, 1, Some(serde_json::json!({"pid": 42})));
        crate::v1_case!("browser-workspace-d81b9d5accb5", {
            assert_eq!(captured.role_id, "external-role");
            assert_eq!(captured.workspace_id.as_deref(), Some("external-workspace"));
            assert_eq!(captured.runtime_mode, "external");
            assert_eq!(captured.page_health.as_deref(), Some("healthy"));
            assert_eq!(captured.chrome_json.as_deref(), Some("{\"pid\":42}"));
        });
        crate::v1_case!("external-chrome-cdn-1744c4b8c66b", {
            let serialized = serde_json::to_string(&captured).unwrap();
            assert!(!serialized.contains("https://example.test"));
            assert!(!serialized.contains("/profiles/"));
            assert_eq!(
                (
                    captured.bounds.x,
                    captured.bounds.y,
                    captured.bounds.width,
                    captured.bounds.height,
                ),
                (0, 0, 800, 600)
            );
            let physical = captured.physical_bounds.as_ref().unwrap();
            assert_eq!(
                (physical.x, physical.y, physical.width, physical.height),
                (0, 0, 1600, 1200)
            );
            assert_eq!(captured.zoom_factor, 1.0);
        });
    }
}
