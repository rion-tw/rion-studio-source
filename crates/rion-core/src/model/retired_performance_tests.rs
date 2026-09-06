use super::CoreCommand;

#[test]
fn retired_performance_commands_are_rejected() {
    for command in [
        serde_json::json!({ "type": "telemetrySnapshot" }),
        serde_json::json!({
            "type": "telemetryRecord",
            "sample": { "metric": "rendererRaf", "durationMs": 16.0, "count": 1 }
        }),
    ] {
        assert!(serde_json::from_value::<CoreCommand>(command).is_err());
    }
}
