use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
const RECONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DEVTOOLS_HTTP_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENT_QUEUE: usize = 256;
const MAX_COMMAND_QUEUE: usize = 256;

type CdpResponse = oneshot::Sender<CoreResult<Value>>;
type UrlRewriter = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
type CdpSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
pub(crate) struct CdnRequestRewriter {
    pub patterns: Vec<String>,
    pub rewrite: UrlRewriter,
}

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
    pub(crate) async fn connect(
        browser_user_data_dir: PathBuf,
        launch_url: String,
        timeout: Option<Duration>,
        cdn: Option<CdnRequestRewriter>,
    ) -> CoreResult<Self> {
        if !browser_user_data_dir.is_absolute() {
            return Err(CoreError::InvalidInput(
                "external Chrome user data path must be absolute".to_owned(),
            ));
        }
        let timeout = timeout.unwrap_or(DEFAULT_ATTACH_TIMEOUT);
        let deadline = Instant::now() + timeout;
        let socket = connect_devtools_socket(&browser_user_data_dir, &launch_url, deadline).await?;
        let (commands, command_receiver) = mpsc::channel(MAX_COMMAND_QUEUE);
        let (event_sender, events) = bounded(MAX_EVENT_QUEUE);
        tokio::spawn(run_cdp_session(
            socket,
            command_receiver,
            event_sender,
            cdn,
            browser_user_data_dir,
            launch_url,
        ));
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
    mut socket: CdpSocket,
    mut commands: mpsc::Receiver<CdpCommand>,
    events: Sender<CdpEvent>,
    cdn: Option<CdnRequestRewriter>,
    browser_user_data_dir: PathBuf,
    launch_url: String,
) {
    loop {
        let disconnected = run_cdp_connection(socket, &mut commands, &events, cdn.as_ref()).await;
        let Some(message) = disconnected else {
            return;
        };
        let deadline = Instant::now() + RECONNECT_TIMEOUT;
        match connect_devtools_socket(&browser_user_data_dir, &launch_url, deadline).await {
            Ok(reconnected) => socket = reconnected,
            Err(error) => {
                let _ = events.send_timeout(
                    CdpEvent::Disconnected {
                        message: format!("{message}; reconnect failed: {error}"),
                    },
                    Duration::from_millis(250),
                );
                return;
            }
        }
    }
}

async fn run_cdp_connection(
    socket: CdpSocket,
    commands: &mut mpsc::Receiver<CdpCommand>,
    events: &Sender<CdpEvent>,
    cdn: Option<&CdnRequestRewriter>,
) -> Option<String> {
    let (mut writer, mut reader) = socket.split();
    let mut next_id = 1_u64;
    let mut pending = HashMap::<u64, PendingRequest>::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(100));
    if let Some(cdn) = cdn {
        let enable = json!({
            "id":next_id,
            "method":"Fetch.enable",
            "params":{
                "patterns":cdn.patterns.iter().map(|url_pattern| json!({
                    "requestStage":"Request",
                    "urlPattern":url_pattern
                })).collect::<Vec<_>>()
            }
        });
        next_id += 1;
        if let Err(error) = writer.send(Message::Text(enable.to_string().into())).await {
            return Some(error.to_string());
        }
        let reload = json!({
            "id":next_id,
            "method":"Page.reload",
            "params":{"ignoreCache":true}
        });
        next_id += 1;
        if let Err(error) = writer.send(Message::Text(reload.to_string().into())).await {
            return Some(error.to_string());
        }
    }
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
                    for (_, request) in pending.drain() {
                        let _ = request.response.send(Err(CoreError::ShuttingDown));
                    }
                    return None;
                }
            },
            message = reader.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if let Some(payload) = create_cdn_continue_request(&text, cdn, next_id) {
                        next_id = next_id.wrapping_add(1).max(1);
                        if let Err(error) = writer.send(Message::Text(payload.to_string().into())).await {
                            break error.to_string();
                        }
                    }
                    handle_cdp_message(&text, &mut pending, events)
                },
                Some(Ok(Message::Binary(bytes))) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        if let Some(payload) = create_cdn_continue_request(text, cdn, next_id) {
                            next_id = next_id.wrapping_add(1).max(1);
                            if let Err(error) = writer.send(Message::Text(payload.to_string().into())).await {
                                break error.to_string();
                            }
                        }
                        handle_cdp_message(text, &mut pending, events);
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
    Some(disconnect_message)
}

async fn connect_devtools_socket(
    browser_user_data_dir: &Path,
    launch_url: &str,
    deadline: Instant,
) -> CoreResult<CdpSocket> {
    let port = wait_for_devtools_port(browser_user_data_dir, deadline).await?;
    let websocket_url = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CoreError::ExternalChrome(
                "unable to find the external Chrome game page".to_owned(),
            ));
        }
        match tokio::time::timeout(remaining, list_devtools_targets(port)).await {
            Ok(Ok(targets)) => {
                if let Some(target) = select_page_target(&targets, launch_url)
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
        tokio::time::sleep(ATTACH_POLL_INTERVAL).await;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let (socket, _) = tokio::time::timeout(remaining, connect_async(&websocket_url))
        .await
        .map_err(|_| CoreError::ExternalChrome("DevTools WebSocket timed out".to_owned()))?
        .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
    Ok(socket)
}

fn create_cdn_continue_request(
    text: &str,
    cdn: Option<&CdnRequestRewriter>,
    id: u64,
) -> Option<Value> {
    let cdn = cdn?;
    let payload = serde_json::from_str::<Value>(text).ok()?;
    if payload.get("method").and_then(Value::as_str) != Some("Fetch.requestPaused") {
        return None;
    }
    let params = payload.get("params")?;
    let request_id = params.get("requestId")?.as_str()?;
    let url = params.get("request")?.get("url")?.as_str()?;
    let is_document = params.get("resourceType").and_then(Value::as_str) == Some("Document");
    let rewritten = (!is_document).then(|| (cdn.rewrite)(url)).flatten();
    let mut request = json!({"requestId":request_id});
    if let Some(rewritten) = rewritten {
        request["url"] = Value::String(rewritten);
    }
    Some(json!({
        "id":id,
        "method":"Fetch.continueRequest",
        "params":request
    }))
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
    let response = read_devtools_http_response(&mut stream).await?;
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

async fn read_devtools_http_response(stream: &mut TcpStream) -> CoreResult<Vec<u8>> {
    let mut response = Vec::new();
    let mut expected_length = None;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
        if read == 0 {
            return Ok(response);
        }
        response.extend_from_slice(&buffer[..read]);
        if response.len() > MAX_DEVTOOLS_HTTP_RESPONSE_BYTES {
            return Err(CoreError::ExternalChrome(
                "Chrome DevTools HTTP response is too large".to_owned(),
            ));
        }

        if expected_length.is_none()
            && let Some(separator) = response.windows(4).position(|window| window == b"\r\n\r\n")
        {
            let headers = std::str::from_utf8(&response[..separator])
                .map_err(|error| CoreError::ExternalChrome(error.to_string()))?;
            let body = &response[separator + 4..];
            expected_length = content_length(headers)
                .map(|length| separator + 4 + length)
                .or_else(|| {
                    headers
                        .to_ascii_lowercase()
                        .contains("transfer-encoding: chunked")
                        .then(|| chunked_body_length(body).map(|length| separator + 4 + length))
                        .flatten()
                });
        }

        if let Some(length) = expected_length
            && response.len() >= length
        {
            response.truncate(length);
            return Ok(response);
        }
    }
}

fn content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().ok())
            .flatten()
    })
}

fn chunked_body_length(body: &[u8]) -> Option<usize> {
    let mut cursor = 0;
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let size_text = std::str::from_utf8(&body[cursor..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        cursor = line_end + 2;
        let chunk_end = cursor.checked_add(size)?;
        if body.len() < chunk_end + 2 || &body[chunk_end..chunk_end + 2] != b"\r\n" {
            return None;
        }
        cursor = chunk_end + 2;
        if size == 0 {
            return Some(cursor);
        }
    }
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
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use tempfile::tempdir;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

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
    fn continues_every_paused_request_and_rewrites_only_subresources() {
        let cdn = CdnRequestRewriter {
            patterns: vec!["https://source.test/*".to_owned()],
            rewrite: Arc::new(|url| Some(url.replace("source.test", "mirror.test"))),
        };
        let script = json!({
            "method":"Fetch.requestPaused",
            "params":{
                "requestId":"request-1","resourceType":"Script",
                "request":{"url":"https://source.test/app.js"}
            }
        });
        let rewritten = create_cdn_continue_request(&script.to_string(), Some(&cdn), 7).unwrap();
        assert_eq!(rewritten["method"], "Fetch.continueRequest");
        assert_eq!(rewritten["params"]["url"], "https://mirror.test/app.js");

        let document = json!({
            "method":"Fetch.requestPaused",
            "params":{
                "requestId":"request-2","resourceType":"Document",
                "request":{"url":"https://source.test/play"}
            }
        });
        let continued = create_cdn_continue_request(&document.to_string(), Some(&cdn), 8).unwrap();
        assert!(continued["params"].get("url").is_none());
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

    #[test]
    fn detects_complete_keep_alive_devtools_responses() {
        assert_eq!(
            content_length("HTTP/1.1 200 OK\r\nContent-Length: 1534"),
            Some(1534)
        );
        assert_eq!(
            content_length("HTTP/1.1 200 OK\r\ncontent-length: 2"),
            Some(2)
        );
        assert_eq!(chunked_body_length(b"4\r\ntest\r\n0\r\n\r\n"), Some(14));
        assert_eq!(chunked_body_length(b"4\r\ntes"), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconnects_and_keeps_the_bounded_command_session_usable() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let server_connections = Arc::clone(&connections);
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut prefix = [0_u8; 512];
                let read = loop {
                    let read = stream.peek(&mut prefix).await.unwrap();
                    if prefix[..read].windows(2).any(|window| window == b"\r\n") {
                        break read;
                    }
                    tokio::task::yield_now().await;
                };
                let request = String::from_utf8_lossy(&prefix[..read]);
                if request.starts_with("GET /json/list ") {
                    let mut headers = Vec::new();
                    let mut buffer = [0_u8; 512];
                    while !headers.windows(4).any(|window| window == b"\r\n\r\n") {
                        let read = stream.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            break;
                        }
                        headers.extend_from_slice(&buffer[..read]);
                    }
                    let body = json!([{
                        "id":"page-1",
                        "type":"page",
                        "url":"https://game.test/play",
                        "webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/devtools/page/1")
                    }])
                    .to_string();
                    stream
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    continue;
                }

                let index = server_connections.fetch_add(1, Ordering::SeqCst) + 1;
                tokio::spawn(async move {
                    let mut websocket = accept_async(stream).await.unwrap();
                    if let Some(Ok(Message::Text(text))) = websocket.next().await {
                        let payload = serde_json::from_str::<Value>(&text).unwrap();
                        websocket
                            .send(Message::Text(
                                json!({"id":payload["id"],"result":{"connection":index}})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    if index == 1 {
                        let _ = websocket.close(None).await;
                        return;
                    }
                    while let Some(Ok(Message::Text(text))) = websocket.next().await {
                        let payload = serde_json::from_str::<Value>(&text).unwrap();
                        websocket
                            .send(Message::Text(
                                json!({"id":payload["id"],"result":{"connection":index}})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                });
            }
        });

        let directory = tempdir().unwrap();
        std::fs::write(
            directory.path().join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/test"),
        )
        .unwrap();
        let session = ExternalChromeCdpSession::connect(
            directory.path().to_path_buf(),
            "https://game.test/play".to_owned(),
            Some(Duration::from_secs(2)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            session
                .send("Runtime.enable".to_owned(), None, None, None)
                .await
                .unwrap()["connection"],
            1
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while connections.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            session
                .send("Runtime.evaluate".to_owned(), None, None, None)
                .await
                .unwrap()["connection"],
            2
        );
        session.close();
        server.abort();
    }
}
