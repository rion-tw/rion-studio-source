#[cfg(feature = "desktop-e2e")]
use std::ffi::CStr;
use std::ffi::c_char;

use super::{MAX_SERIALIZED_EVENT_BYTES, optional_native_json};

#[cfg(feature = "desktop-e2e")]
const MAX_RESIZE_DIAGNOSTICS_BYTES: usize = 512 * 1024;

/// This is the existing placement JSON C argument, never an additional action.
pub(super) unsafe fn optional_placement_diagnostics(
    action_type: &str,
    window_id: &str,
    value: *const c_char,
) -> Result<Option<serde_json::Value>, ()> {
    #[cfg(feature = "desktop-e2e")]
    if action_type == "windowPlacementChanged" && !value.is_null() {
        // SAFETY: inherited from the synchronous native callback's C argument.
        let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
        if bytes.len() > MAX_RESIZE_DIAGNOSTICS_BYTES {
            return Err(());
        }
        let parsed = serde_json::from_slice(bytes).map_err(|_| ())?;
        if valid_resize_placement_diagnostics(&parsed, window_id) {
            return Ok(Some(parsed));
        }
        // A diagnostic key cannot bypass validation by falling back to the
        // ordinary JSON path, including when its bytes fit the ordinary limit.
        if parsed.get("diagnosticResizeJournal").is_some() {
            return Err(());
        }
    }
    let _ = (action_type, window_id);
    // SAFETY: inherited from the synchronous native callback's C argument.
    unsafe { optional_native_json(value, valid_placement_diagnostics) }
}

pub(super) fn serialize_native_event(event: &serde_json::Value) -> Result<String, ()> {
    let serialized = serde_json::to_string(event).map_err(|_| ())?;
    let maximum = MAX_SERIALIZED_EVENT_BYTES;
    #[cfg(feature = "desktop-e2e")]
    let maximum = if let Some(action) = event.get("action")
        && event.get("type").and_then(serde_json::Value::as_str) == Some("action")
        && action.get("type").and_then(serde_json::Value::as_str) == Some("windowPlacementChanged")
        && let Some(window_id) = event["identity"]["logicalWindowId"].as_str()
        && action["sourceWindowId"].as_str() == Some(window_id)
        && valid_resize_placement_diagnostics(&action["placementDiagnostics"], window_id)
        && serde_json::to_vec(&action["placementDiagnostics"])
            .is_ok_and(|bytes| bytes.len() <= MAX_RESIZE_DIAGNOSTICS_BYTES)
    {
        maximum + MAX_RESIZE_DIAGNOSTICS_BYTES
    } else {
        maximum
    };
    (serialized.len() <= maximum)
        .then_some(serialized)
        .ok_or(())
}

#[cfg(feature = "desktop-e2e")]
fn valid_resize_placement_diagnostics(value: &serde_json::Value, window_id: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(journal) = object.get("diagnosticResizeJournal") else {
        return false;
    };
    // Reuse the exact twelve-field production validator; no truth field has a
    // separate debug interpretation, and only this one optional key is allowed.
    let truth = serde_json::Value::Object(
        object
            .iter()
            .filter(|(key, _)| key.as_str() != "diagnosticResizeJournal")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    valid_placement_diagnostics(&truth) && valid_resize_journal(journal, window_id)
}

#[cfg(feature = "desktop-e2e")]
fn valid_resize_journal(value: &serde_json::Value, window_id: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(records) = object.get("records").and_then(serde_json::Value::as_array) else {
        return false;
    };
    let Some(sequence) = object.get("sequence").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    if object.len() != 5
        || value["journalVersion"] != 1
        || value["capacity"] != 128
        || value["dropped"].as_u64().is_none()
        || records.len() > 128
    {
        return false;
    }
    let mut previous = 0;
    let mut pointer = None;
    records.iter().all(|record| {
        let Some(current) = record["sequence"].as_u64() else {
            return false;
        };
        let Some(window_pointer) = record["windowPointer"].as_str() else {
            return false;
        };
        let valid = current > previous
            && current <= sequence
            && record["windowID"].as_str() == Some(window_id)
            && window_pointer.starts_with("0x")
            && window_pointer.len() <= 18
            && u64::from_str_radix(&window_pointer[2..], 16).is_ok_and(|value| value > 0)
            && pointer.is_none_or(|value| value == window_pointer)
            && record["reason"]
                .as_str()
                .is_some_and(|value| !value.is_empty() && value.len() <= 128)
            && record["capturedAtUnixSeconds"]
                .as_f64()
                .is_some_and(|value| value.is_finite() && value > 0.0);
        previous = current;
        pointer = Some(window_pointer);
        valid
    }) && records
        .last()
        .is_none_or(|record| record["sequence"].as_u64() == Some(sequence))
}

#[cfg(test)]
mod tests;

pub(super) fn valid_placement_diagnostics(value: &serde_json::Value) -> bool {
    const FIELDS: [&str; 12] = [
        "zoomed",
        "fullScreen",
        "minimized",
        "frameX",
        "frameY",
        "frameWidth",
        "frameHeight",
        "triggerEventType",
        "triggerKeyCode",
        "triggerModifierFlags",
        "firstResponderCategory",
        "physicalInputSequence",
    ];
    let Some(value) = value.as_object() else {
        return false;
    };
    let finite = |field: &str| {
        value
            .get(field)
            .and_then(serde_json::Value::as_f64)
            .is_some_and(f64::is_finite)
    };
    let sequence = value
        .get("physicalInputSequence")
        .and_then(serde_json::Value::as_str);
    value.len() == FIELDS.len()
        && value.keys().all(|field| FIELDS.contains(&field.as_str()))
        && ["zoomed", "fullScreen", "minimized"].iter().all(|field| {
            value
                .get(*field)
                .and_then(serde_json::Value::as_bool)
                .is_some()
        })
        && ["frameX", "frameY", "frameWidth", "frameHeight"]
            .iter()
            .all(|field| finite(field))
        && value.get("frameWidth").and_then(serde_json::Value::as_f64) > Some(0.0)
        && value.get("frameHeight").and_then(serde_json::Value::as_f64) > Some(0.0)
        && value
            .get("triggerEventType")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        && value
            .get("triggerKeyCode")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|code| code <= u16::MAX.into())
        && value
            .get("triggerModifierFlags")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        && matches!(
            value
                .get("firstResponderCategory")
                .and_then(serde_json::Value::as_str),
            Some("roleSurface" | "nativeText" | "nativeChrome")
        )
        && sequence.is_some_and(|raw| {
            raw.parse::<u64>()
                .is_ok_and(|parsed| parsed.to_string() == raw)
        })
}
