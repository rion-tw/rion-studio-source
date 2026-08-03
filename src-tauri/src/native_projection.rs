use std::sync::Mutex;

use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
struct ProjectionState {
    captured_at: String,
    payload: Value,
    revision: u64,
}

/// Stores the authoritative JSON payload and assigns a revision only when its
/// semantic value changes. Getters and events therefore serialize the same
/// envelope instead of racing independent snapshots.
#[derive(Default)]
pub(crate) struct RevisionedJsonProjection {
    state: Mutex<Option<ProjectionState>>,
}

impl RevisionedJsonProjection {
    pub(crate) fn resolve_object(&self, payload: Value) -> Value {
        self.resolve_object_ignoring(payload, &[])
    }

    pub(crate) fn resolve_object_ignoring(&self, payload: Value, ignored_keys: &[&str]) -> Value {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return projection_envelope(0, chrono::Utc::now().to_rfc3339(), payload),
        };
        let next = match state.as_ref() {
            Some(current)
                if semantic_payload(&current.payload, ignored_keys)
                    == semantic_payload(&payload, ignored_keys) =>
            {
                current.clone()
            }
            previous => ProjectionState {
                captured_at: chrono::Utc::now().to_rfc3339(),
                payload,
                revision: previous
                    .map(|current| current.revision)
                    .unwrap_or_default()
                    .saturating_add(1),
            },
        };
        *state = Some(next.clone());
        projection_envelope(next.revision, next.captured_at, next.payload)
    }

    pub(crate) fn current_revision(&self) -> u64 {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|state| state.revision))
            .unwrap_or_default()
    }

    pub(crate) fn current(&self) -> Option<Value> {
        self.state.lock().ok().and_then(|state| {
            state.as_ref().map(|current| {
                projection_envelope(
                    current.revision,
                    current.captured_at.clone(),
                    current.payload.clone(),
                )
            })
        })
    }
}

fn semantic_payload(payload: &Value, ignored_keys: &[&str]) -> Value {
    let mut payload = payload.clone();
    if let Some(object) = payload.as_object_mut() {
        for key in ignored_keys {
            object.remove(*key);
        }
    }
    payload
}

fn projection_envelope(revision: u64, captured_at: String, payload: Value) -> Value {
    let mut object = payload.as_object().cloned().unwrap_or_else(Map::new);
    object.insert("revision".to_owned(), Value::from(revision));
    object.insert("capturedAt".to_owned(), Value::from(captured_at));
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::RevisionedJsonProjection;

    #[test]
    fn unchanged_payload_replays_the_same_revision_and_changed_payload_advances() {
        let projection = RevisionedJsonProjection::default();
        let first = projection.resolve_object(json!({ "items": [1] }));
        let replay = projection.resolve_object(json!({ "items": [1] }));
        let changed = projection.resolve_object(json!({ "items": [1, 2] }));

        assert_eq!(first, replay);
        assert_eq!(first["revision"], 1);
        assert_eq!(changed["revision"], 2);
        assert_eq!(projection.current_revision(), 2);
    }

    #[test]
    fn ignored_observation_metadata_does_not_advance_or_replace_the_projection() {
        let projection = RevisionedJsonProjection::default();
        let native = projection
            .resolve_object_ignoring(json!({ "cause": "native", "items": [1] }), &["cause"]);
        let getter = projection
            .resolve_object_ignoring(json!({ "cause": "getter", "items": [1] }), &["cause"]);

        assert_eq!(native, getter);
        assert_eq!(getter["cause"], "native");
    }
}
