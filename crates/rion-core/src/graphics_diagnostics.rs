use std::collections::BTreeMap;

use chrono::Utc;
use serde_json::Value;

use crate::model::{
    BrowserGraphicsSettingsRecord, ExternalGraphicsDiagnosticsRecord,
    GraphicsDeviceDiagnosticsRecord, GraphicsDiagnosticsRecord, GraphicsVersionRecord,
    StateWebGraphicsRecord,
};

pub(crate) const WEB_GRAPHICS_PROBE_SOURCE: &str = r#"(async () => {
  const result = { webgl: "unavailable", webgl2: "unavailable", webgpu: "unavailable" };
  try {
    const canvas = document.createElement("canvas");
    const webgl2 = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    const webgl = webgl2 || canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    result.webgl2 = webgl2 ? "available" : "unavailable";
    result.webgl = webgl ? "available" : "unavailable";
    if (webgl) {
      const extension = webgl.getExtension("WEBGL_debug_renderer_info");
      if (extension) {
        result.renderer = String(webgl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || "");
        result.vendor = String(webgl.getParameter(extension.UNMASKED_VENDOR_WEBGL) || "");
      }
    }
    if (navigator.gpu && typeof navigator.gpu.requestAdapter === "function") {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      result.webgpu = adapter ? "available" : "unavailable";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
})()"#;

pub(crate) struct GraphicsDiagnosticsInput {
    pub applied_settings: BrowserGraphicsSettingsRecord,
    pub embedded_raw_json: String,
    pub embedded_error: Option<String>,
    pub external_roles: Vec<ExternalGraphicsDiagnosticsRecord>,
    pub feature_status_raw_json: String,
    pub gpu_info_raw_json: Option<String>,
    pub gpu_info_ready: bool,
    pub hardware_acceleration_enabled: Option<bool>,
    pub platform: rion_platform::Platform,
    pub saved_settings: BrowserGraphicsSettingsRecord,
    pub versions: GraphicsVersionRecord,
}

pub(crate) fn assemble(input: GraphicsDiagnosticsInput) -> GraphicsDiagnosticsRecord {
    let embedded = if let Some(error) = input.embedded_error {
        unavailable_probe(Some(error))
    } else {
        normalize_web_graphics(parse_json(&input.embedded_raw_json))
    };
    GraphicsDiagnosticsRecord {
        applied_switches: crate::bootstrap_settings::formatted_graphics_switches(
            &input.applied_settings,
            input.platform,
        ),
        restart_required: input.saved_settings != input.applied_settings,
        applied_settings: input.applied_settings,
        collected_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        embedded,
        external_roles: input.external_roles,
        feature_status: normalize_feature_status(parse_json(&input.feature_status_raw_json)),
        gpu_device: input
            .gpu_info_raw_json
            .as_deref()
            .map(parse_json)
            .and_then(read_gpu_device),
        gpu_info_ready: input.gpu_info_ready,
        hardware_acceleration_enabled: input.hardware_acceleration_enabled,
        platform: match input.platform {
            rion_platform::Platform::Macos => "darwin",
            rion_platform::Platform::Windows => "win32",
        }
        .to_owned(),
        saved_settings: input.saved_settings,
        versions: input.versions,
    }
}

pub(crate) fn normalize_web_graphics(value: Value) -> StateWebGraphicsRecord {
    let object = value.as_object();
    StateWebGraphicsRecord {
        error: object.and_then(|value| bounded_string(value.get("error"))),
        renderer: object.and_then(|value| bounded_string(value.get("renderer"))),
        vendor: object.and_then(|value| bounded_string(value.get("vendor"))),
        webgl: availability(object.and_then(|value| value.get("webgl"))),
        webgl2: availability(object.and_then(|value| value.get("webgl2"))),
        webgpu: availability(object.and_then(|value| value.get("webgpu"))),
    }
}

pub(crate) fn unavailable_probe(error: Option<String>) -> StateWebGraphicsRecord {
    StateWebGraphicsRecord {
        error: error.map(|value| value.chars().take(512).collect()),
        renderer: None,
        vendor: None,
        webgl: "unknown".to_owned(),
        webgl2: "unknown".to_owned(),
        webgpu: "unknown".to_owned(),
    }
}

fn normalize_feature_status(value: Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter_map(|(key, value)| {
            value.as_str().map(|value| {
                (
                    key.chars().take(128).collect(),
                    value.chars().take(256).collect(),
                )
            })
        })
        .take(256)
        .collect()
}

fn read_gpu_device(value: Value) -> Option<GraphicsDeviceDiagnosticsRecord> {
    let object = value.as_object()?;
    let devices = object.get("gpuDevice")?.as_array()?;
    let device = devices
        .iter()
        .find(|candidate| {
            candidate
                .as_object()
                .and_then(|value| value.get("active"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .or_else(|| devices.first())?
        .as_object()?;
    let auxiliary = object.get("auxAttributes").and_then(Value::as_object);
    Some(GraphicsDeviceDiagnosticsRecord {
        active: device.get("active").and_then(Value::as_bool),
        device_id: device.get("deviceId").and_then(Value::as_f64),
        device_string: bounded_string(device.get("deviceString")),
        driver_vendor: auxiliary.and_then(|value| bounded_string(value.get("driverVendor"))),
        driver_version: auxiliary.and_then(|value| bounded_string(value.get("driverVersion"))),
        vendor_id: device.get("vendorId").and_then(Value::as_f64),
        vendor_string: bounded_string(device.get("vendorString")),
    })
}

fn availability(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("available") => "available",
        Some("unavailable") => "unavailable",
        _ => "unknown",
    }
    .to_owned()
}

fn bounded_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(512).collect())
}

fn parse_json(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_malformed_web_gpu_and_device_payloads_without_panicking() {
        let probe = normalize_web_graphics(json!({
            "webgl": "available",
            "webgl2": 42,
            "webgpu": "future-value",
            "renderer": "ANGLE"
        }));
        assert_eq!(probe.webgl, "available");
        assert_eq!(probe.webgl2, "unknown");
        assert_eq!(probe.webgpu, "unknown");
        assert_eq!(probe.renderer.as_deref(), Some("ANGLE"));
        assert!(read_gpu_device(json!({"gpuDevice":"invalid"})).is_none());
        assert!(read_gpu_device(json!({"gpuDevice":[]})).is_none());
    }

    #[test]
    fn assembles_cross_platform_switches_and_restart_comparison_in_rust() {
        let mut applied = BrowserGraphicsSettingsRecord::aggressive_default();
        applied.backend.windows = "vulkan".to_owned();
        let diagnostics = assemble(GraphicsDiagnosticsInput {
            applied_settings: applied.clone(),
            embedded_raw_json: json!({
                "webgl":"available","webgl2":"available","webgpu":"unavailable"
            })
            .to_string(),
            embedded_error: None,
            external_roles: Vec::new(),
            feature_status_raw_json: json!({"webgl":"enabled", "ignored": 3}).to_string(),
            gpu_info_raw_json: Some(
                json!({
                    "gpuDevice":[{"active":true,"deviceString":"GPU"}],
                    "auxAttributes":{"driverVersion":"1.0"}
                })
                .to_string(),
            ),
            gpu_info_ready: true,
            hardware_acceleration_enabled: Some(true),
            platform: rion_platform::Platform::Windows,
            saved_settings: BrowserGraphicsSettingsRecord::from_legacy_mode("automatic"),
            versions: GraphicsVersionRecord {
                chromium: "140".to_owned(),
                electron: "40".to_owned(),
                node: "24".to_owned(),
            },
        });
        assert!(diagnostics.restart_required);
        assert!(
            diagnostics
                .applied_switches
                .contains(&"--use-angle=vulkan".to_owned())
        );
        assert_eq!(
            diagnostics.feature_status.get("webgl"),
            Some(&"enabled".to_owned())
        );
        assert_eq!(
            diagnostics
                .gpu_device
                .and_then(|device| device.driver_version)
                .as_deref(),
            Some("1.0")
        );
    }

    #[test]
    fn returns_partial_diagnostics_before_gpu_information_is_ready() {
        crate::v1_case!("resource-platform-a9825af9bf31", {
            let automatic = BrowserGraphicsSettingsRecord::from_legacy_mode("automatic");
            let diagnostics = assemble(GraphicsDiagnosticsInput {
                applied_settings: automatic.clone(),
                embedded_raw_json: json!({
                    "renderer": "ANGLE Metal Renderer",
                    "vendor": "Apple",
                    "webgl": "available",
                    "webgl2": "available",
                    "webgpu": "available"
                })
                .to_string(),
                embedded_error: None,
                external_roles: Vec::new(),
                feature_status_raw_json: "{}".to_owned(),
                gpu_info_raw_json: None,
                gpu_info_ready: false,
                hardware_acceleration_enabled: None,
                platform: rion_platform::Platform::Macos,
                saved_settings: automatic,
                versions: GraphicsVersionRecord {
                    chromium: "1".to_owned(),
                    electron: "1".to_owned(),
                    node: "1".to_owned(),
                },
            });
            assert!(!diagnostics.gpu_info_ready);
            assert_eq!(diagnostics.hardware_acceleration_enabled, None);
            assert!(diagnostics.feature_status.is_empty());
            assert!(diagnostics.gpu_device.is_none());
        });
    }
}
