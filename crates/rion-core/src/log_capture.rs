use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::LazyLock,
};

use chrono::Utc;
use regex::Regex;
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::model::{LogCaptureRecord, LogEntry, LogErrorDetails, LogLevel};

const CAPTURE_QUEUE_CAPACITY: usize = 256;
const MAX_DEPTH: usize = 5;
const MAX_KEYS: usize = 40;
const MAX_STRING_CHARS: usize = 4_000;

static SENSITIVE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(authorization|cookie|password|passwd|secret|session|token|api[-_]?key)")
        .expect("sensitive log key regex is valid")
});
static SENSITIVE_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:token|access_token|auth|key|secret|session)=)[^&#\s]*")
        .expect("sensitive log query regex is valid")
});

pub struct LogCaptureRuntime {
    current_level: LogLevel,
    pending: VecDeque<LogCaptureRecord>,
    sequence: u64,
    session_id: String,
    user_data_dir: PathBuf,
}

impl LogCaptureRuntime {
    pub fn new(user_data_dir: PathBuf, current_level: LogLevel) -> Self {
        Self {
            current_level,
            pending: VecDeque::with_capacity(CAPTURE_QUEUE_CAPACITY),
            sequence: 0,
            session_id: Uuid::new_v4().to_string(),
            user_data_dir,
        }
    }

    pub fn current_level(&self) -> LogLevel {
        self.current_level
    }

    pub fn set_level(&mut self, level: LogLevel) {
        self.current_level = level;
    }

    pub fn capture(&mut self, captures: Vec<LogCaptureRecord>) -> Vec<LogEntry> {
        for capture in captures {
            if self.pending.len() >= CAPTURE_QUEUE_CAPACITY {
                let discard_index = self
                    .pending
                    .iter()
                    .position(|candidate| {
                        matches!(candidate.level, LogLevel::Debug | LogLevel::Info)
                    })
                    .unwrap_or(0);
                self.pending.remove(discard_index);
            }
            self.pending.push_back(capture);
        }

        let mut entries = Vec::with_capacity(self.pending.len());
        while let Some(capture) = self.pending.pop_front() {
            if level_value(capture.level) < level_value(self.current_level) {
                continue;
            }
            self.sequence = self.sequence.saturating_add(1);
            let context = capture
                .context_raw_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(
                    |value| match sanitize_value(value, &self.user_data_dir, 0) {
                        Value::Object(values) => {
                            Some(values.into_iter().collect::<BTreeMap<_, _>>())
                        }
                        _ => None,
                    },
                );
            entries.push(LogEntry {
                id: format!("{}:{}", self.session_id, self.sequence),
                timestamp: Utc::now().to_rfc3339(),
                level: capture.level,
                source: capture.source,
                event: sanitize_text(&capture.event, &self.user_data_dir)
                    .chars()
                    .take(120)
                    .collect(),
                message: sanitize_text(&capture.message, &self.user_data_dir),
                session_id: self.session_id.clone(),
                context,
                error: capture
                    .error
                    .map(|error| sanitize_error(error, &self.user_data_dir, 0)),
            });
        }
        entries
    }
}

fn level_value(level: LogLevel) -> u8 {
    match level {
        LogLevel::Debug => 10,
        LogLevel::Info => 20,
        LogLevel::Warn => 30,
        LogLevel::Error => 40,
    }
}

fn sanitize_error(error: LogErrorDetails, user_data_dir: &Path, depth: usize) -> LogErrorDetails {
    LogErrorDetails {
        name: sanitize_text(&error.name, user_data_dir),
        message: sanitize_text(&error.message, user_data_dir),
        stack: error
            .stack
            .map(|stack| sanitize_text(&stack, user_data_dir)),
        cause: (depth < MAX_DEPTH)
            .then(|| {
                error
                    .cause
                    .map(|cause| Box::new(sanitize_error(*cause, user_data_dir, depth + 1)))
            })
            .flatten(),
    }
}

fn sanitize_value(value: Value, user_data_dir: &Path, depth: usize) -> Value {
    if depth >= MAX_DEPTH {
        return Value::String("<MAX_DEPTH>".to_owned());
    }
    match value {
        Value::String(value) => Value::String(sanitize_text(&value, user_data_dir)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(MAX_KEYS)
                .map(|value| sanitize_value(value, user_data_dir, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .take(MAX_KEYS)
                .map(|(key, value)| {
                    let value = if SENSITIVE_KEY.is_match(&key) {
                        Value::String("<REDACTED>".to_owned())
                    } else {
                        sanitize_value(value, user_data_dir, depth + 1)
                    };
                    (key, value)
                })
                .collect(),
        ),
        primitive => primitive,
    }
}

fn sanitize_text(value: &str, user_data_dir: &Path) -> String {
    let mut text = value
        .chars()
        .filter(|character| {
            !matches!(
                *character as u32,
                0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f
            )
        })
        .collect::<String>();
    for (path, replacement) in [
        (Some(user_data_dir.to_path_buf()), "<USER_DATA>"),
        (home_directory(), "<HOME>"),
        (Some(std::env::temp_dir()), "<TEMP>"),
    ] {
        if let Some(path) = path.and_then(|path| path.to_str().map(str::to_owned))
            && !path.is_empty()
        {
            text = text.replace(&path, replacement);
        }
    }
    text = SENSITIVE_QUERY
        .replace_all(&text, "$1<REDACTED>")
        .into_owned();
    if let Ok(mut url) = Url::parse(&text)
        && (url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some())
    {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        text = url.to_string();
    }
    let mut characters = text.chars();
    let truncated = characters
        .by_ref()
        .take(MAX_STRING_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogSource;

    fn capture(level: LogLevel, context_raw_json: Option<&str>) -> LogCaptureRecord {
        LogCaptureRecord {
            level,
            source: LogSource::Main,
            event: "event".to_owned(),
            message: "https://user:pass@example.com/play?token=abc#secret".to_owned(),
            context_raw_json: context_raw_json.map(str::to_owned),
            error: None,
        }
    }

    #[test]
    fn owns_session_sequence_filtering_and_redaction() {
        let mut runtime = LogCaptureRuntime::new(PathBuf::from("/users/test/Rion"), LogLevel::Info);
        let entries = runtime.capture(vec![
            capture(LogLevel::Debug, None),
            capture(
                LogLevel::Info,
                Some(
                    r#"{
                      "authorization":"secret",
                      "nested":{
                        "token":"abc",
                        "url":"https://user:pass@example.com/play?token=abc#secret"
                      },
                      "path":"/users/test/Rion/logs"
                    }"#,
                ),
            ),
        ]);
        crate::v1_case!("logging-9ee67b0d531a", {
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].id.split(':').count(), 2);
            assert_eq!(entries[0].message, "https://example.com/play");
            assert_eq!(
                entries[0].context.as_ref().unwrap()["authorization"],
                "<REDACTED>"
            );
            assert_eq!(
                entries[0].context.as_ref().unwrap()["nested"]["token"],
                "<REDACTED>"
            );
            assert_eq!(
                entries[0].context.as_ref().unwrap()["nested"]["url"],
                "https://example.com/play"
            );
            assert_eq!(
                entries[0].context.as_ref().unwrap()["path"],
                "<USER_DATA>/logs"
            );
        });
    }

    #[test]
    fn sanitizes_capture_cycles_long_strings_error_causes_and_cookie_diagnostics() {
        crate::v1_case!("logging-8d2b57184a63", {
            let cause = LogErrorDetails {
                name: "Error".to_owned(),
                message: "token failure in /app/data".to_owned(),
                stack: None,
                cause: None,
            };
            let mut runtime = LogCaptureRuntime::new(PathBuf::from("/app/data"), LogLevel::Info);
            let entries = runtime.capture(vec![LogCaptureRecord {
                level: LogLevel::Error,
                source: LogSource::Main,
                event: "cycle".to_owned(),
                message: "x".repeat(5_000),
                context_raw_json: Some(r#"{"self":"<CIRCULAR>"}"#.to_owned()),
                error: Some(LogErrorDetails {
                    name: "Error".to_owned(),
                    message: "outer".to_owned(),
                    stack: None,
                    cause: Some(Box::new(cause)),
                }),
            }]);
            assert_eq!(entries[0].message.chars().count(), 4_001);
            assert_eq!(entries[0].context.as_ref().unwrap()["self"], "<CIRCULAR>");
            assert_eq!(
                entries[0]
                    .error
                    .as_ref()
                    .unwrap()
                    .cause
                    .as_ref()
                    .unwrap()
                    .message,
                "token failure in <USER_DATA>"
            );
        });

        crate::v1_case!("logging-863617eb2d4b", {
            let mut runtime = LogCaptureRuntime::new(PathBuf::from("/tmp/rion"), LogLevel::Info);
            let entries = runtime.capture(vec![capture(
                LogLevel::Info,
                Some(r#"{"sourceItemCount":4,"flushFailed":true,"sessionStorage":"opaque-token"}"#),
            )]);
            let context = entries[0].context.as_ref().unwrap();
            assert_eq!(context["sourceItemCount"], 4);
            assert_eq!(context["flushFailed"], true);
            assert_eq!(context["sessionStorage"], "<REDACTED>");
        });
    }

    #[test]
    fn bounds_the_capture_queue_and_preserves_higher_severity_entries() {
        let mut runtime = LogCaptureRuntime::new(PathBuf::from("/tmp/rion"), LogLevel::Info);
        let mut captures = (0..CAPTURE_QUEUE_CAPACITY)
            .map(|_| capture(LogLevel::Info, None))
            .collect::<Vec<_>>();
        captures.push(capture(LogLevel::Error, None));
        let entries = runtime.capture(captures);
        assert_eq!(entries.len(), CAPTURE_QUEUE_CAPACITY);
        assert!(matches!(entries.last().unwrap().level, LogLevel::Error));
    }
}
