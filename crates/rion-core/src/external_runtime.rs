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
    if !graphics.frame_rate_limit_enabled {
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
    let bounds = rects
        .iter()
        .map(|rect| normalized_bounds(rect, work_area))
        .collect::<Vec<_>>();
    let overlap = match platform {
        rion_platform::Platform::Macos => MACOS_SEAM_OVERLAP,
        rion_platform::Platform::Windows => WINDOWS_SEAM_OVERLAP,
    };
    seamless_bounds(bounds, overlap)
}

fn normalized_bounds(
    rect: &StateNormalizedRectRecord,
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
            "workspaceId": "external-workspace",
            "zoomFactor": 1.0,
            "state": "running",
            "launchedAt": "2026-07-23T00:00:01Z",
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
        assert_eq!(roles[1].page_health.as_deref(), Some("healthy"));

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
    }
}
