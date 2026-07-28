use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const ACTIVATION_ENDPOINT_FILE: &str = "rion-studio.activation.json";
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_ACTIVATION_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Deserialize, Serialize)]
struct ActivationEndpointRecord {
    host: String,
    pid: u32,
    port: u16,
    token: String,
    version: u8,
}

#[derive(Deserialize, Serialize)]
struct ActivationRequest {
    operation: String,
    token: String,
}

pub struct ActivationServer {
    endpoint_path: PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    token: String,
}

impl ActivationServer {
    pub fn start(
        user_data_dir: &Path,
        on_activate: impl Fn() + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let endpoint_path = user_data_dir.join(ACTIVATION_ENDPOINT_FILE);
        write_endpoint(
            &endpoint_path,
            &ActivationEndpointRecord {
                host: "127.0.0.1".to_owned(),
                pid: std::process::id(),
                port,
                token: token.clone(),
                version: 1,
            },
        )?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_token = token.clone();
        let on_activate = Arc::new(on_activate);
        let thread = thread::Builder::new()
            .name("rion-cross-shell-activation".to_owned())
            .spawn(move || {
                while !thread_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            handle_connection(stream, &thread_token, on_activate.as_ref());
                        }
                        Err(_) if thread_stop.load(Ordering::Acquire) => break,
                        Err(_) => {
                            // Nonblocking accept can surface platform-specific transient
                            // connection errors. Keep the activation endpoint alive until the
                            // owner explicitly drops the server instead of treating one such
                            // error as a permanent listener failure.
                            thread::sleep(Duration::from_millis(25));
                        }
                    }
                }
            })?;

        Ok(Self {
            endpoint_path,
            stop,
            thread: Some(thread),
            token,
        })
    }
}

impl Drop for ActivationServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if read_endpoint(&self.endpoint_path).is_ok_and(|endpoint| endpoint.token == self.token) {
            let _ = fs::remove_file(&self.endpoint_path);
        }
    }
}

pub fn forward_activation(user_data_dir: &Path) -> bool {
    let endpoint = match read_endpoint(&user_data_dir.join(ACTIVATION_ENDPOINT_FILE)) {
        Ok(endpoint) => endpoint,
        Err(_) => return false,
    };
    if !valid_endpoint(&endpoint) {
        return false;
    }
    let address = match format!("{}:{}", endpoint.host, endpoint.port).parse::<SocketAddr>() {
        Ok(address) => address,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&address, ACTIVATION_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(ACTIVATION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(ACTIVATION_TIMEOUT));
    let request = ActivationRequest {
        operation: "activate".to_owned(),
        token: endpoint.token,
    };
    let Ok(mut body) = serde_json::to_vec(&request) else {
        return false;
    };
    body.push(b'\n');
    if stream.write_all(&body).is_err() {
        return false;
    }
    let Ok(response) = read_message(&mut stream) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&response)
        .ok()
        .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
        == Some(true)
}

fn handle_connection(
    mut stream: TcpStream,
    expected_token: &str,
    on_activate: &(dyn Fn() + Send + Sync),
) {
    let _ = stream.set_read_timeout(Some(ACTIVATION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(ACTIVATION_TIMEOUT));
    let accepted = read_message(&mut stream)
        .ok()
        .and_then(|body| serde_json::from_slice::<ActivationRequest>(&body).ok())
        .is_some_and(|request| request.operation == "activate" && request.token == expected_token);
    if accepted {
        on_activate();
    }
    let response = if accepted {
        b"{\"ok\":true}\n".as_slice()
    } else {
        b"{\"ok\":false}\n".as_slice()
    };
    let _ = stream.write_all(response);
}

fn read_message(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut buffer = [0_u8; 1_024];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "activation message ended before a newline",
            ));
        }
        if let Some(newline) = buffer[..read].iter().position(|byte| *byte == b'\n') {
            body.extend_from_slice(&buffer[..newline]);
            if body.len() > MAX_ACTIVATION_MESSAGE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "activation message is too large",
                ));
            }
            return Ok(body);
        }
        body.extend_from_slice(&buffer[..read]);
        if body.len() > MAX_ACTIVATION_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "activation message is too large",
            ));
        }
    }
}

fn write_endpoint(path: &Path, endpoint: &ActivationEndpointRecord) -> io::Result<()> {
    let temporary_path =
        path.with_extension(format!("{}.{}.tmp", std::process::id(), Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    serde_json::to_writer(&mut file, endpoint).map_err(io::Error::other)?;
    file.sync_all()?;
    drop(file);
    let _ = fs::remove_file(path);
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    set_owner_only_permissions(path)?;
    Ok(())
}

fn read_endpoint(path: &Path) -> io::Result<ActivationEndpointRecord> {
    if fs::metadata(path)?.len() > MAX_ACTIVATION_MESSAGE_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation endpoint is too large",
        ));
    }
    serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)
}

fn valid_endpoint(endpoint: &ActivationEndpointRecord) -> bool {
    endpoint.version == 1
        && endpoint.host == "127.0.0.1"
        && endpoint.port > 0
        && endpoint.token.len() == 64
        && endpoint.token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn authenticated_activation_round_trips_and_cleans_up() {
        let user_data_dir = tempfile::tempdir().unwrap();
        let activations = Arc::new(AtomicUsize::new(0));
        let callback_activations = Arc::clone(&activations);
        let server = ActivationServer::start(user_data_dir.path(), move || {
            callback_activations.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        assert!(forward_activation(user_data_dir.path()));
        assert_eq!(activations.load(Ordering::SeqCst), 1);
        assert!(user_data_dir.path().join(ACTIVATION_ENDPOINT_FILE).exists());

        drop(server);
        assert!(!user_data_dir.path().join(ACTIVATION_ENDPOINT_FILE).exists());
        assert!(!forward_activation(user_data_dir.path()));
    }

    #[test]
    fn rejects_a_tampered_endpoint_token() {
        let user_data_dir = tempfile::tempdir().unwrap();
        let endpoint_path = user_data_dir.path().join(ACTIVATION_ENDPOINT_FILE);
        let server = ActivationServer::start(user_data_dir.path(), || {}).unwrap();
        let mut endpoint = read_endpoint(&endpoint_path).unwrap();
        endpoint.token = "0".repeat(64);
        write_endpoint(&endpoint_path, &endpoint).unwrap();

        assert!(!forward_activation(user_data_dir.path()));

        drop(server);
    }

    #[cfg(unix)]
    #[test]
    fn endpoint_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let user_data_dir = tempfile::tempdir().unwrap();
        let server = ActivationServer::start(user_data_dir.path(), || {}).unwrap();
        let mode = fs::metadata(user_data_dir.path().join(ACTIVATION_ENDPOINT_FILE))
            .unwrap()
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600);
        drop(server);
    }
}
