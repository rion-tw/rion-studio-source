use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender, bounded};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::error::{CoreError, CoreResult};

const ATTACH_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_EVENT_QUEUE: usize = 256;
const MAX_COMMAND_QUEUE: usize = 256;

type CdpResponse = oneshot::Sender<CoreResult<Value>>;

enum CdpCommand {
    Send {
        method: String,
        params: Option<Value>,
        session_id: Option<String>,
        timeout: Duration,
        response: CdpResponse,
    },
    Close,
}

struct PendingRequest {
    deadline: Instant,
    method: String,
    response: CdpResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CdpEvent {
    Notification {
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    Disconnected {
        message: String,
    },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevToolsTarget {
    #[allow(dead_code)]
    id: String,
    #[serde(rename = "type")]
    target_type: Option<String>,
    url: Option<String>,
    web_socket_debugger_url: Option<String>,
}

pub struct ExternalChromeCdpSession {
    commands: mpsc::Sender<CdpCommand>,
    events: Mutex<Option<Receiver<CdpEvent>>>,
}

impl ExternalChromeCdpSession {
    pub async fn connect(
        browser_user_data_dir: PathBuf,
        launch_url: String,
        timeout: Option<Duration>,
    ) -> CoreResult<Self> {
        if !browser_user_data_dir.is_absolute() {
            return Err(CoreError::InvalidInput(
                "external Chrome user data path must be absolute".to_owned(),
            ));
        }
        let timeout = timeout.unwrap_or(DEFAULT_ATTACH_TIMEOUT);
        let deadline = Instant::now() + timeout;
        let port = wait_for_devtools_port(&browser_user_data_dir, deadline).await?;
        let websocket_url = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CoreError::ExternalChrome(
                    "unable to find the external Chrome game page".to_owned(),
                ));
            }
            match tokio::time::timeout(remaining, list_devtools_targets(port)).await {
                Ok(Ok(targets)) => {
                    if let Some(target) = select_page_target(&targets, &launch_url)
                        && let Some(url) = target.web_socket_debugger_url.clone()
                    {
                        break url;
                    }
                }
                Ok(Err(error)) if Instant::now() >= deadline => return Err(error),
                Ok(Err(_)) => {}
                Err(_) => {
                    return Err(CoreError::ExternalChrome(
                        "DevTools target discovery timed out".to_owned(),
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err(CoreError::ExternalChrome(
                    "unable to find the external Chrome game page".to_owned(),
                ));
            }
            tokio::time::sleep(ATTACH_POLL_INTERVAL).await;
        };

        let remaining = deadline.saturating_duration_since(Instant::now());
        let (socket, _) = tokio::time::timeout(remaining, connect_async(&websocket_url))
            .await
            .map_err(|_| CoreError::ExternalChrome("DevTools WebSocket timed out".to_owned()))?
            .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
        let (commands, command_receiver) = mpsc::channel(MAX_COMMAND_QUEUE);
        let (event_sender, events) = bounded(MAX_EVENT_QUEUE);
        tokio::spawn(run_cdp_session(socket, command_receiver, event_sender));
        Ok(Self {
            commands,
            events: Mutex::new(Some(events)),
        })
    }

    pub async fn send(
        &self,
        method: String,
        params: Option<Value>,
        timeout: Option<Duration>,
        session_id: Option<String>,
    ) -> CoreResult<Value> {
        if method.trim().is_empty() || method.len() > 200 {
            return Err(CoreError::InvalidInput("CDP method is invalid".to_owned()));
        }
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(CdpCommand::Send {
                method,
                params,
                session_id,
                timeout: timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
                response,
            })
            .await
            .map_err(|_| CoreError::ExternalChrome("DevTools WebSocket closed".to_owned()))?;
        receiver
            .await
            .map_err(|_| CoreError::ExternalChrome("DevTools WebSocket closed".to_owned()))?
    }

    pub fn take_events(&self) -> CoreResult<Receiver<CdpEvent>> {
        self.events
            .lock()
            .map_err(|_| CoreError::Internal("CDP event receiver lock poisoned".to_owned()))?
            .take()
            .ok_or_else(|| {
                CoreError::InvalidInput("CDP events may only be subscribed once".to_owned())
            })
    }

    pub fn close(&self) {
        let _ = self.commands.try_send(CdpCommand::Close);
    }
}

impl Drop for ExternalChromeCdpSession {
    fn drop(&mut self) {
        self.close();
    }
}

async fn run_cdp_session(
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    mut commands: mpsc::Receiver<CdpCommand>,
    events: Sender<CdpEvent>,
) {
    let (mut writer, mut reader) = socket.split();
    let mut next_id = 1_u64;
    let mut pending = HashMap::<u64, PendingRequest>::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(100));
    let disconnect_message = loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(CdpCommand::Send { method, params, session_id, timeout, response }) => {
                    let id = next_id;
                    next_id = next_id.wrapping_add(1).max(1);
                    let mut payload = json!({
                        "id": id,
                        "method": method,
                        "params": params.unwrap_or_else(|| json!({})),
                    });
                    if let Some(session_id) = session_id {
                        payload["sessionId"] = Value::String(session_id);
                    }
                    if let Err(error) = writer.send(Message::Text(payload.to_string().into())).await {
                        let _ = response.send(Err(CoreError::ExternalChrome(error.to_string())));
                        break error.to_string();
                    }
                    pending.insert(id, PendingRequest {
                        deadline: Instant::now() + timeout,
                        method,
                        response,
                    });
                }
                Some(CdpCommand::Close) | None => {
                    let _ = writer.send(Message::Close(None)).await;
                    break "DevTools WebSocket closed".to_owned();
                }
            },
            message = reader.next() => match message {
                Some(Ok(Message::Text(text))) => handle_cdp_message(&text, &mut pending, &events),
                Some(Ok(Message::Binary(bytes))) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        handle_cdp_message(text, &mut pending, &events);
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if let Err(error) = writer.send(Message::Pong(payload)).await {
                        break error.to_string();
                    }
                }
                Some(Ok(Message::Close(_))) | None => break "DevTools WebSocket closed".to_owned(),
                Some(Err(error)) => break error.to_string(),
                Some(Ok(_)) => {}
            },
            _ = expiry.tick() => expire_requests(&mut pending),
        }
    };

    for (_, request) in pending.drain() {
        let _ = request
            .response
            .send(Err(CoreError::ExternalChrome(disconnect_message.clone())));
    }
    let _ = events.send_timeout(
        CdpEvent::Disconnected {
            message: disconnect_message,
        },
        Duration::from_millis(250),
    );
}

fn handle_cdp_message(
    text: &str,
    pending: &mut HashMap<u64, PendingRequest>,
    events: &Sender<CdpEvent>,
) {
    let Ok(payload) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(id) = payload.get("id").and_then(Value::as_u64) {
        let Some(request) = pending.remove(&id) else {
            return;
        };
        let result = match payload.get("error") {
            Some(error) => Err(CoreError::ExternalChrome(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Chrome DevTools request failed")
                    .to_owned(),
            )),
            None => Ok(payload.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = request.response.send(result);
        return;
    }
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return;
    };
    let _ = events.try_send(CdpEvent::Notification {
        method: method.to_owned(),
        params: payload.get("params").cloned(),
        session_id: payload
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    });
}

fn expire_requests(pending: &mut HashMap<u64, PendingRequest>) {
    let now = Instant::now();
    let expired = pending
        .iter()
        .filter_map(|(id, request)| (request.deadline <= now).then_some(*id))
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(request) = pending.remove(&id) {
            let _ = request.response.send(Err(CoreError::ExternalChrome(format!(
                "Chrome DevTools request timed out: {}",
                request.method
            ))));
        }
    }
}

async fn wait_for_devtools_port(user_data_dir: &Path, deadline: Instant) -> CoreResult<u16> {
    let path = user_data_dir.join("DevToolsActivePort");
    loop {
        match std::fs::read_to_string(&path) {
            Ok(value) => return parse_devtools_port(&value),
            Err(error) if Instant::now() >= deadline => {
                return Err(CoreError::ExternalChrome(error.to_string()));
            }
            Err(_) => {}
        }
        tokio::time::sleep(ATTACH_POLL_INTERVAL).await;
    }
}

fn parse_devtools_port(value: &str) -> CoreResult<u16> {
    value
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| CoreError::ExternalChrome("Chrome DevTools port file is invalid".to_owned()))
}

async fn list_devtools_targets(port: u16) -> CoreResult<Vec<DevToolsTarget>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
    stream
        .write_all(
            format!(
                "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| CoreError::ExternalChrome("invalid DevTools HTTP response".to_owned()))?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return Err(CoreError::ExternalChrome(
            "unable to inspect Chrome DevTools targets".to_owned(),
        ));
    }
    let body = decode_http_body(headers, &response[separator + 4..])?;
    serde_json::from_slice(&body).map_err(|error| CoreError::ExternalChrome(error.to_string()))
}

fn decode_http_body(headers: &str, body: &[u8]) -> CoreResult<Vec<u8>> {
    if !headers
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return Ok(body.to_vec());
    }
    let mut decoded = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| CoreError::ExternalChrome("invalid chunked HTTP body".to_owned()))?;
        let size_text = std::str::from_utf8(&body[cursor..line_end])
            .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
        let size =
            usize::from_str_radix(size_text.split(';').next().unwrap_or_default().trim(), 16)
                .map_err(|_| CoreError::ExternalChrome("invalid chunked HTTP body".to_owned()))?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        let chunk_end = cursor.checked_add(size).ok_or_else(|| {
            CoreError::ExternalChrome("invalid chunked HTTP body size".to_owned())
        })?;
        if chunk_end + 2 > body.len() || &body[chunk_end..chunk_end + 2] != b"\r\n" {
            return Err(CoreError::ExternalChrome(
                "truncated chunked HTTP body".to_owned(),
            ));
        }
        decoded.extend_from_slice(&body[cursor..chunk_end]);
        cursor = chunk_end + 2;
    }
}

fn select_page_target<'a>(
    targets: &'a [DevToolsTarget],
    launch_url: &str,
) -> Option<&'a DevToolsTarget> {
    targets
        .iter()
        .filter(|target| {
            target.target_type.as_deref() == Some("page")
                && target.web_socket_debugger_url.is_some()
        })
        .find(|target| target.url.as_deref() == Some(launch_url))
        .or_else(|| {
            targets.iter().find(|target| {
                target.target_type.as_deref() == Some("page")
                    && target.web_socket_debugger_url.is_some()
                    && same_origin(target.url.as_deref(), launch_url)
            })
        })
}

fn same_origin(value: Option<&str>, expected: &str) -> bool {
    let (Ok(value), Ok(expected)) = (Url::parse(value.unwrap_or_default()), Url::parse(expected))
    else {
        return false;
    };
    value.origin() == expected.origin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_devtools_ports() {
        assert_eq!(parse_devtools_port("9222\n/browser/id").unwrap(), 9222);
        assert!(parse_devtools_port("0").is_err());
        assert!(parse_devtools_port("invalid").is_err());
    }

    #[test]
    fn selects_exact_url_before_same_origin() {
        let targets = vec![
            DevToolsTarget {
                id: "same-origin".to_owned(),
                target_type: Some("page".to_owned()),
                url: Some("https://game.test/other".to_owned()),
                web_socket_debugger_url: Some("ws://same".to_owned()),
            },
            DevToolsTarget {
                id: "exact".to_owned(),
                target_type: Some("page".to_owned()),
                url: Some("https://game.test/play".to_owned()),
                web_socket_debugger_url: Some("ws://exact".to_owned()),
            },
        ];
        assert_eq!(
            select_page_target(&targets, "https://game.test/play")
                .unwrap()
                .id,
            "exact"
        );
    }

    #[test]
    fn decodes_chunked_devtools_responses() {
        assert_eq!(
            decode_http_body(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked",
                b"4\r\n[1,2\r\n3\r\n,3]\r\n0\r\n\r\n",
            )
            .unwrap(),
            b"[1,2,3]"
        );
        assert!(
            decode_http_body("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", b"4\r\nabc",)
                .is_err()
        );
    }
}
