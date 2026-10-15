use std::{ffi::CString, ptr};

#[cfg(feature = "desktop-e2e")]
use super::super::retain_native_action_fields;
use super::super::{MAX_NATIVE_FIELD_BYTES, MAX_NATIVE_JSON_BYTES, optional_native_string};
use super::*;

fn truth() -> serde_json::Value {
    serde_json::json!({
        "zoomed":false, "fullScreen":false, "minimized":false,
        "frameX":32, "frameY":31, "frameWidth":935, "frameHeight":677,
        "triggerEventType":6, "triggerKeyCode":65535, "triggerModifierFlags":0,
        "firstResponderCategory":"roleSurface", "physicalInputSequence":"12"
    })
}

fn debug_placement() -> serde_json::Value {
    let mut value = truth();
    let records: Vec<_> = (1..=128)
        .map(|sequence| {
            serde_json::json!({
                "sequence":sequence, "windowID":"window-1", "windowPointer":"0x1234",
                "reason":"notification:NSWindowDidResizeNotification:after",
                "capturedAtUnixSeconds":1792080000.0,
                "frame":{"x":32,"y":31,"width":935,"height":677},
                "contentLayoutRect":{"x":0,"y":8,"width":935,"height":637},
                "event":{"type":6,"flags":0,"location":{"x":400,"y":0},
                    "diagnosticPadding":"x".repeat(1200)}
            })
        })
        .collect();
    value["diagnosticResizeJournal"] = serde_json::json!({
        "journalVersion":1,"capacity":128,"sequence":128,"dropped":0,"records":records
    });
    value
}

fn decode(
    value: &serde_json::Value,
    action: &str,
    window: &str,
) -> Result<Option<serde_json::Value>, ()> {
    let bytes = CString::new(serde_json::to_vec(value).unwrap()).unwrap();
    // SAFETY: the CString owns this exact existing C ABI JSON argument through
    // the synchronous production parser, including its null terminator.
    unsafe { optional_placement_diagnostics(action, window, bytes.as_ptr()) }
}

#[cfg(feature = "desktop-e2e")]
fn event(placement: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"type":"action", "identity":{
        "logicalWindowId":"window-1","launchGeneration":"launch-1","nativeGeneration":1
    }, "action":{"type":"windowPlacementChanged", "sourceWindowId":"window-1",
        "placementDiagnostics":placement,"unownedField":"discard me"}})
}

#[test]
fn original_twelve_truth_fields_and_global_limits_remain_exact() {
    assert!(valid_placement_diagnostics(&truth()));
    assert_eq!(
        decode(&truth(), "windowPlacementChanged", "window-1"),
        Ok(Some(truth()))
    );
    assert!(!valid_placement_diagnostics(&debug_placement()));
    let mut extra = truth();
    extra["unknown"] = true.into();
    assert!(decode(&extra, "windowPlacementChanged", "window-1").is_err());
    for field in [
        "zoomed",
        "fullScreen",
        "minimized",
        "frameWidth",
        "frameHeight",
        "triggerEventType",
        "triggerKeyCode",
        "triggerModifierFlags",
        "firstResponderCategory",
        "physicalInputSequence",
    ] {
        let mut invalid = truth();
        invalid[field] = serde_json::Value::Null;
        assert!(
            decode(&invalid, "windowPlacementChanged", "window-1").is_err(),
            "{field}"
        );
    }
    let field = CString::new("x".repeat(MAX_NATIVE_FIELD_BYTES + 1)).unwrap();
    // SAFETY: the test CString is valid for both synchronous helper calls.
    assert!(unsafe { optional_native_string(field.as_ptr()) }.is_err());
    assert_eq!(
        unsafe {
            optional_placement_diagnostics("windowPlacementChanged", "window-1", ptr::null())
        },
        Ok(None)
    );
    let generic = CString::new(format!(
        "{{\"x\":\"{}\"}}",
        "x".repeat(MAX_NATIVE_JSON_BYTES)
    ))
    .unwrap();
    assert!(
        unsafe { optional_native_json(generic.as_ptr(), serde_json::Value::is_object) }.is_err()
    );
    let oversized_event = serde_json::json!({"other":"x".repeat(MAX_SERIALIZED_EVENT_BYTES)});
    assert!(serialize_native_event(&oversized_event).is_err());
}

#[test]
fn production_rejects_extra_placement_keys_even_when_the_debug_shape_is_valid() {
    assert!(!valid_placement_diagnostics(&debug_placement()));
    #[cfg(not(feature = "desktop-e2e"))]
    assert!(decode(&debug_placement(), "windowPlacementChanged", "window-1").is_err());
    assert!(decode(&debug_placement(), "windowFocusChanged", "window-1").is_err());
}

#[cfg(feature = "desktop-e2e")]
#[test]
fn existing_c_argument_parse_retain_and_emit_preserve_bounded_debug_and_exact_truth() {
    let original = debug_placement();
    let size = serde_json::to_vec(&original).unwrap().len();
    assert!(size > MAX_SERIALIZED_EVENT_BYTES);
    let parsed = decode(&original, "windowPlacementChanged", "window-1")
        .unwrap()
        .unwrap();
    let mut output = event(parsed);
    retain_native_action_fields(
        "windowPlacementChanged",
        output["action"].as_object_mut().unwrap(),
    );
    let serialized = serialize_native_event(&output).unwrap();
    let output: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(output["action"]["placementDiagnostics"], original);
    assert_eq!(output["action"].as_object().unwrap().len(), 3);
    let mut exact_truth = output["action"]["placementDiagnostics"].clone();
    exact_truth
        .as_object_mut()
        .unwrap()
        .remove("diagnosticResizeJournal");
    assert_eq!(exact_truth, truth());
    if std::env::var_os("RION_TEST_RESIZE_CHANNEL_FIXTURE").is_some() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.desktop-e2e-artifacts/native-resize-channel");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("rust-native-event.json"), serialized).unwrap();
    }
}

#[cfg(feature = "desktop-e2e")]
#[test]
fn debug_limit_and_owner_validation_never_change_truth_or_other_action_limits() {
    let original = debug_placement();
    for mutation in 0..9 {
        let mut invalid = original.clone();
        match mutation {
            0 => invalid["unknown"] = true.into(),
            1 => invalid["fullScreen"] = "false".into(),
            2 => invalid["physicalInputSequence"] = 12.into(),
            3 => invalid["diagnosticResizeJournal"]["capacity"] = 129.into(),
            4 => invalid["diagnosticResizeJournal"]["records"][0]["windowID"] = "other".into(),
            5 => invalid["diagnosticResizeJournal"]["records"][1]["sequence"] = 1.into(),
            6 => {
                invalid["diagnosticResizeJournal"]["records"][1]["windowPointer"] = "0x5678".into()
            }
            7 => invalid["diagnosticResizeJournal"]["records"][0]["diagnosticPadding"] =
                "x".repeat(MAX_RESIZE_DIAGNOSTICS_BYTES).into(),
            _ => invalid["diagnosticResizeJournal"]["records"].as_array_mut().unwrap()
                .push(serde_json::json!({"sequence":129,"windowID":"window-1","windowPointer":"0x1234"})),
        }
        assert!(
            decode(&invalid, "windowPlacementChanged", "window-1").is_err(),
            "{mutation}"
        );
    }
    assert!(decode(&original, "windowPlacementChanged", "other").is_err());
    let mut wrong_event = event(original.clone());
    wrong_event["action"]["type"] = "windowFocusChanged".into();
    assert!(serialize_native_event(&wrong_event).is_err());
    wrong_event = event(original.clone());
    wrong_event["action"]["sourceWindowId"] = "other".into();
    assert!(serialize_native_event(&wrong_event).is_err());
    wrong_event = event(original);
    wrong_event["identity"]["logicalWindowId"] = "other".into();
    assert!(serialize_native_event(&wrong_event).is_err());
    let ordinary =
        CString::new(format!("{}{}", truth(), " ".repeat(MAX_NATIVE_JSON_BYTES))).unwrap();
    // SAFETY: the ordinary JSON C argument remains alive through the call.
    assert!(
        unsafe {
            optional_placement_diagnostics("windowPlacementChanged", "window-1", ordinary.as_ptr())
        }
        .is_err()
    );
}

#[test]
fn invalid_native_json_and_utf8_are_terminal_parse_failures() {
    for bytes in [b"{".as_slice(), &[0xff]] {
        let value = CString::new(bytes).unwrap();
        // SAFETY: the CString remains alive through the parser call.
        assert!(
            unsafe {
                optional_placement_diagnostics("windowPlacementChanged", "window-1", value.as_ptr())
            }
            .is_err()
        );
    }
}
