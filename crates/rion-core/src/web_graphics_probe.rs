use serde_json::Value;

use crate::model::StateWebGraphicsRecord;

pub(crate) const PROBE_SCHEMA_VERSION: u32 = 2;

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
      const adapter = await navigator.gpu.requestAdapter();
      result.webgpu = adapter ? "available" : "unavailable";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
})()"#;

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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn probe_schema_v2_uses_system_adapter_selection() {
        assert_eq!(PROBE_SCHEMA_VERSION, 2);
        assert!(WEB_GRAPHICS_PROBE_SOURCE.contains("requestAdapter()"));
        assert!(!WEB_GRAPHICS_PROBE_SOURCE.contains("powerPreference"));
        assert!(WEB_GRAPHICS_PROBE_SOURCE.contains("failIfMajorPerformanceCaveat: true"));
    }

    #[test]
    fn normalizes_available_unavailable_and_unknown_capabilities() {
        let probe = normalize_web_graphics(json!({
            "webgl": "available",
            "webgl2": "unavailable",
            "webgpu": "future-value",
            "renderer": "ANGLE",
            "vendor": "Vendor"
        }));
        assert_eq!(probe.webgl, "available");
        assert_eq!(probe.webgl2, "unavailable");
        assert_eq!(probe.webgpu, "unknown");
        assert_eq!(probe.renderer.as_deref(), Some("ANGLE"));
        assert_eq!(probe.vendor.as_deref(), Some("Vendor"));
    }

    #[test]
    fn unavailable_probe_bounds_errors_and_marks_capabilities_unknown() {
        let probe = unavailable_probe(Some("x".repeat(600)));
        assert_eq!(probe.error.as_ref().map(String::len), Some(512));
        assert_eq!(probe.webgl, "unknown");
        assert_eq!(probe.webgl2, "unknown");
        assert_eq!(probe.webgpu, "unknown");
    }
}
