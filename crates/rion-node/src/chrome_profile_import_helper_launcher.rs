use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, ExitStatus, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use rion_core::{CoreError, CoreResult};
use sha2::{Digest, Sha256};

const REQUEST_MAGIC: &[u8; 8] = b"RCHREQ01";
const RESPONSE_MAGIC: &[u8; 8] = b"RCHRES01";
const FIXED_HELPER_SWITCH: &str = "--rion-internal-chrome-profile-helper";
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_SECRET_BYTES: usize = rion_core::CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES + 32;
const RESPONSE_HEADER_BYTES: usize = 20;
const PRE_SPAWN_CANCELLATION_CAPACITY: usize = 4_096;

#[derive(Default)]
pub(crate) struct HelperProcessRegistry {
    state: Mutex<HelperProcessRegistryState>,
    drained: Condvar,
}

#[derive(Default)]
struct HelperProcessRegistryState {
    draining: bool,
    active: HashMap<String, Arc<HelperProcessControl>>,
    pre_cancelled: HashSet<String>,
    pre_cancelled_order: VecDeque<String>,
}

pub(crate) struct HelperLaunchRegistration {
    cancellation_id: String,
    registry: Arc<HelperProcessRegistry>,
    control: Arc<HelperProcessControl>,
}

#[derive(Default)]
struct HelperProcessControl {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl HelperProcessRegistry {
    pub(crate) fn register(
        self: &Arc<Self>,
        cancellation_id: String,
    ) -> CoreResult<HelperLaunchRegistration> {
        let mut state = self.state.lock().map_err(|_| registry_error())?;
        if state.draining {
            return Err(launcher_error(
                "CHROME_PROFILE_IMPORT_HELPER_LAUNCHER_DRAINING",
                "The native helper launcher is draining and rejects new children.",
            ));
        }
        if state.active.contains_key(&cancellation_id) {
            return Err(launcher_error(
                "CHROME_PROFILE_IMPORT_HELPER_CANCELLATION_ID_CONFLICT",
                "The native helper cancellation identity is already active.",
            ));
        }
        let control = Arc::new(HelperProcessControl::default());
        if state.pre_cancelled.remove(&cancellation_id) {
            state
                .pre_cancelled_order
                .retain(|queued| queued != &cancellation_id);
            control.cancelled.store(true, Ordering::Release);
        }
        state
            .active
            .insert(cancellation_id.clone(), Arc::clone(&control));
        Ok(HelperLaunchRegistration {
            cancellation_id,
            registry: Arc::clone(self),
            control,
        })
    }

    pub(crate) fn cancel(&self, cancellation_id: &str) -> CoreResult<bool> {
        let control = {
            let mut state = self.state.lock().map_err(|_| registry_error())?;
            if let Some(control) = state.active.get(cancellation_id).cloned() {
                Some(control)
            } else if state.draining {
                return Ok(false);
            } else {
                if state.pre_cancelled.insert(cancellation_id.to_owned()) {
                    while state.pre_cancelled_order.len() >= PRE_SPAWN_CANCELLATION_CAPACITY {
                        if let Some(expired) = state.pre_cancelled_order.pop_front() {
                            state.pre_cancelled.remove(&expired);
                        }
                    }
                    state
                        .pre_cancelled_order
                        .push_back(cancellation_id.to_owned());
                }
                None
            }
        };
        if let Some(control) = control {
            control.cancel();
        }
        Ok(true)
    }

    pub(crate) fn cancel_all_and_wait(&self) -> CoreResult<()> {
        let controls = {
            let mut state = self.state.lock().map_err(|_| registry_error())?;
            state.draining = true;
            state.pre_cancelled.clear();
            state.pre_cancelled_order.clear();
            state.active.values().cloned().collect::<Vec<_>>()
        };
        for control in controls {
            control.cancel();
        }
        let mut state = self.state.lock().map_err(|_| registry_error())?;
        while !state.active.is_empty() {
            state = self.drained.wait(state).map_err(|_| registry_error())?;
        }
        Ok(())
    }
}

impl Drop for HelperLaunchRegistration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.state.lock()
            && state
                .active
                .get(&self.cancellation_id)
                .is_some_and(|control| Arc::ptr_eq(control, &self.control))
        {
            state.active.remove(&self.cancellation_id);
            self.registry.drained.notify_all();
        }
    }
}

impl HelperProcessControl {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn attach(&self, mut child: Child) -> CoreResult<(u32, ChildStdin, ChildStdout)> {
        let child_id = child.id();
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(pipe_error());
        };
        let Some(stdout) = child.stdout.take() else {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(pipe_error());
        };
        let mut active = match self.child.lock() {
            Ok(active) => active,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(registry_error());
            }
        };
        if active.is_some() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(registry_error());
        }
        if self.is_cancelled() {
            let _ = child.kill();
        }
        *active = Some(child);
        Ok((child_id, stdin, stdout))
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock()
            && let Some(child) = child.as_mut()
        {
            let _ = child.kill();
        }
    }

    fn terminate(&self) {
        if let Ok(mut child) = self.child.lock()
            && let Some(child) = child.as_mut()
        {
            let _ = child.kill();
        }
    }

    /// stdout EOF must precede this event-bound process fence. The fixed helper
    /// never closes stdout itself, so EOF means native process teardown has
    /// begun; `wait` removes the ordinary EOF/exit observation race.
    fn wait_after_stdout_eof(&self) -> CoreResult<ExitStatus> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| registry_error())?
            .take()
            .ok_or_else(registry_error)?;
        if self.is_cancelled() {
            let _ = child.kill();
        }
        child.wait().map_err(|_| exit_unknown_error())
    }
}

#[derive(Debug)]
pub(crate) struct HelperProcessResult {
    pub outcome: String,
    pub metadata: Vec<u8>,
    pub secret: Vec<u8>,
    pub exit_evidence_sha256: String,
}

pub(crate) fn launch(
    mut metadata: Vec<u8>,
    mut secret: Vec<u8>,
    registration: HelperLaunchRegistration,
    helper_application_path: Option<String>,
) -> CoreResult<HelperProcessResult> {
    let mut request = match encode_request(&metadata, &secret) {
        Ok(request) => request,
        Err(error) => {
            metadata.fill(0);
            secret.fill(0);
            return Err(error);
        }
    };
    metadata.fill(0);
    if registration.control.is_cancelled() {
        request.fill(0);
        secret.fill(0);
        return Err(cancelled_error());
    }
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(_) => {
            request.fill(0);
            secret.fill(0);
            return Err(launcher_error(
                "CHROME_PROFILE_IMPORT_HELPER_EXECUTABLE_UNAVAILABLE",
                "The native launcher could not resolve the packaged helper executable.",
            ));
        }
    };
    let helper_application_argument =
        match helper_application_argument(helper_application_path.as_deref()) {
            Ok(argument) => argument,
            Err(error) => {
                request.fill(0);
                secret.fill(0);
                return Err(error);
            }
        };
    let mut command = rion_platform::background_command(executable);
    if let Some(argument) = helper_application_argument {
        command.arg(argument);
    }
    let child = match command
        .arg(FIXED_HELPER_SWITCH)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            request.fill(0);
            secret.fill(0);
            return Err(launcher_error(
                "CHROME_PROFILE_IMPORT_HELPER_SPAWN_FAILED",
                "The fresh Chromium helper process could not be started.",
            ));
        }
    };
    let (child_id, mut stdin, mut stdout) = match registration.control.attach(child) {
        Ok(attached) => attached,
        Err(error) => {
            request.fill(0);
            secret.fill(0);
            return Err(error);
        }
    };
    let write_result = if registration.control.is_cancelled() {
        Err(cancelled_error())
    } else {
        stdin
            .write_all(&request)
            .and_then(|()| stdin.flush())
            .map_err(|_| {
                launcher_error(
                    "CHROME_PROFILE_IMPORT_HELPER_PIPE_FAILED",
                    "The fresh Chromium helper request pipe closed before acknowledgement.",
                )
            })
    };
    drop(stdin);
    request.fill(0);
    secret.fill(0);
    if write_result.is_err() {
        registration.control.terminate();
    }

    let maximum_response = RESPONSE_HEADER_BYTES + MAX_METADATA_BYTES + MAX_SECRET_BYTES;
    let mut response = Vec::new();
    let read_result = read_bounded_response_to_eof(
        &mut stdout,
        maximum_response,
        &mut response,
        &registration.control,
    );
    drop(stdout);
    if read_result.is_err() {
        registration.control.terminate();
    }
    let status = match registration.control.wait_after_stdout_eof() {
        Ok(status) => status,
        Err(_) => {
            response.fill(0);
            return Err(exit_unknown_error());
        }
    };
    if registration.control.is_cancelled() {
        response.fill(0);
        return Err(cancelled_error());
    }
    if let Err(error) = write_result {
        response.fill(0);
        return Err(error);
    }
    let response_oversized = match read_result {
        Ok(oversized) => oversized,
        Err(error) => {
            response.fill(0);
            return Err(error);
        }
    };
    if response_oversized || !status.success() {
        response.fill(0);
        return Err(launcher_error(
            "CHROME_PROFILE_IMPORT_HELPER_EXIT_UNKNOWN",
            "The fresh Chromium helper did not exit with an exact clean acknowledgement.",
        ));
    }
    let response_digest = Sha256::digest(&response);
    let mut result = decode_response(response)?;
    if registration.control.is_cancelled() {
        result.metadata.fill(0);
        result.secret.fill(0);
        return Err(cancelled_error());
    }
    let mut exit_evidence = Sha256::new();
    exit_evidence.update(b"rion-chrome-profile-helper-exit-v1\0");
    exit_evidence.update(child_id.to_be_bytes());
    exit_evidence.update([0_u8]);
    exit_evidence.update(response_digest);
    result.exit_evidence_sha256 = hex_digest(exit_evidence.finalize().as_slice());
    Ok(result)
}

fn helper_application_argument(path: Option<&str>) -> CoreResult<Option<String>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let application = Path::new(path);
    if path.is_empty()
        || path.contains('\0')
        || !application.is_absolute()
        || !application
            .metadata()
            .is_ok_and(|metadata| metadata.is_file())
    {
        return Err(launcher_error(
            "CHROME_PROFILE_IMPORT_HELPER_APPLICATION_PATH_INVALID",
            "The unpackaged Chromium helper requires an absolute existing app entry.",
        ));
    }
    Ok(Some(format!("--app={path}")))
}

fn read_bounded_response_to_eof(
    stdout: &mut ChildStdout,
    maximum_response: usize,
    response: &mut Vec<u8>,
    control: &HelperProcessControl,
) -> CoreResult<bool> {
    let retained_limit = maximum_response.saturating_add(1);
    let mut chunk = [0_u8; 8 * 1024];
    let mut oversized = false;
    loop {
        let read = match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => {
                chunk.fill(0);
                return Err(launcher_error(
                    "CHROME_PROFILE_IMPORT_HELPER_PIPE_FAILED",
                    "The fresh Chromium helper response pipe closed without an exact receipt.",
                ));
            }
        };
        let retain = retained_limit.saturating_sub(response.len()).min(read);
        response.extend_from_slice(&chunk[..retain]);
        chunk[..read].fill(0);
        if !oversized && response.len() > maximum_response {
            oversized = true;
            control.terminate();
        }
    }
    chunk.fill(0);
    Ok(oversized)
}

fn encode_request(metadata: &[u8], secret: &[u8]) -> CoreResult<Vec<u8>> {
    validate_lengths(metadata.len(), secret.len())?;
    let metadata_len = u32::try_from(metadata.len()).map_err(|_| limit_error())?;
    let secret_len = u32::try_from(secret.len()).map_err(|_| limit_error())?;
    let mut request = Vec::with_capacity(16 + metadata.len() + secret.len());
    request.extend_from_slice(REQUEST_MAGIC);
    request.extend_from_slice(&metadata_len.to_be_bytes());
    request.extend_from_slice(&secret_len.to_be_bytes());
    request.extend_from_slice(metadata);
    request.extend_from_slice(secret);
    Ok(request)
}

fn decode_response(mut response: Vec<u8>) -> CoreResult<HelperProcessResult> {
    let parsed = (|| {
        if response.len() < RESPONSE_HEADER_BYTES || &response[..8] != RESPONSE_MAGIC {
            return Err(protocol_error());
        }
        let outcome = match response[8] {
            0 => "applied",
            1 => "failed",
            2 => "indeterminate",
            _ => return Err(protocol_error()),
        };
        if response[9..12] != [0, 0, 0] {
            return Err(protocol_error());
        }
        let metadata_len = u32::from_be_bytes(response[12..16].try_into().unwrap()) as usize;
        let secret_len = u32::from_be_bytes(response[16..20].try_into().unwrap()) as usize;
        validate_lengths(metadata_len, secret_len)?;
        let expected = RESPONSE_HEADER_BYTES
            .checked_add(metadata_len)
            .and_then(|value| value.checked_add(secret_len))
            .ok_or_else(limit_error)?;
        if response.len() != expected {
            return Err(protocol_error());
        }
        let metadata_start = RESPONSE_HEADER_BYTES;
        let secret_start = metadata_start + metadata_len;
        Ok(HelperProcessResult {
            outcome: outcome.to_owned(),
            metadata: response[metadata_start..secret_start].to_vec(),
            secret: response[secret_start..].to_vec(),
            exit_evidence_sha256: String::new(),
        })
    })();
    response.fill(0);
    parsed
}

fn validate_lengths(metadata_len: usize, secret_len: usize) -> CoreResult<()> {
    if metadata_len == 0 || metadata_len > MAX_METADATA_BYTES || secret_len > MAX_SECRET_BYTES {
        return Err(limit_error());
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 0x0f) as usize] as char);
    }
    value
}

fn limit_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_LIMIT_EXCEEDED",
        "The fresh Chromium helper message exceeds its bounded native limit.",
    )
}

fn protocol_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID",
        "The fresh Chromium helper returned a non-canonical acknowledgement.",
    )
}

fn pipe_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_PIPE_FAILED",
        "The fresh Chromium helper pipe is unavailable.",
    )
}

fn cancelled_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_CANCELLED",
        "The fresh Chromium helper process was cancelled.",
    )
}

fn registry_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_REGISTRY_FAILED",
        "The native helper process registry is unavailable.",
    )
}

fn exit_unknown_error() -> CoreError {
    launcher_error(
        "CHROME_PROFILE_IMPORT_HELPER_EXIT_UNKNOWN",
        "The native launcher could not establish the helper process exit outcome.",
    )
}

fn launcher_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANCELLATION_FIXTURE_ENV: &str = "RION_HELPER_CANCELLATION_FIXTURE";

    fn response(outcome: u8, metadata: &[u8], secret: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(RESPONSE_MAGIC);
        bytes.extend_from_slice(&[outcome, 0, 0, 0]);
        bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&(secret.len() as u32).to_be_bytes());
        bytes.extend_from_slice(metadata);
        bytes.extend_from_slice(secret);
        bytes
    }

    #[test]
    #[ignore]
    fn cancellation_fixture_process() {
        if std::env::var_os(CANCELLATION_FIXTURE_ENV).is_none() {
            return;
        }
        let mut request = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut request);
        request.fill(0);
    }

    #[test]
    fn request_is_bounded_and_keeps_secret_out_of_the_fixed_argument() {
        let bytes = encode_request(br#"{"kind":"verify"}"#, &[7; 32]).unwrap();
        assert_eq!(&bytes[..8], REQUEST_MAGIC);
        assert_eq!(FIXED_HELPER_SWITCH, "--rion-internal-chrome-profile-helper");
        assert!(!FIXED_HELPER_SWITCH.contains("verify"));
    }

    #[test]
    fn unpackaged_helper_application_argument_is_absolute_and_non_secret() {
        let executable = std::env::current_exe().unwrap();
        let path = executable.to_str().unwrap();
        assert_eq!(
            helper_application_argument(Some(path)).unwrap(),
            Some(format!("--app={path}"))
        );
        assert_eq!(
            helper_application_argument(Some("relative-entry.js"))
                .unwrap_err()
                .code(),
            "CHROME_PROFILE_IMPORT_HELPER_APPLICATION_PATH_INVALID"
        );
        assert_eq!(helper_application_argument(None).unwrap(), None);
    }

    #[test]
    fn response_requires_exact_magic_outcome_lengths_and_no_trailing_bytes() {
        let parsed = decode_response(response(0, br#"{"ok":true}"#, b"backup")).unwrap();
        assert_eq!(parsed.outcome, "applied");
        assert_eq!(parsed.metadata, br#"{"ok":true}"#);
        assert_eq!(parsed.secret, b"backup");

        let mut trailing = response(0, b"{}", b"");
        trailing.push(0);
        assert_eq!(
            decode_response(trailing).unwrap_err().code(),
            "CHROME_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID"
        );
        assert_eq!(
            decode_response(response(9, b"{}", b"")).unwrap_err().code(),
            "CHROME_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID"
        );
    }

    #[test]
    fn cancellation_registry_remembers_pre_spawn_abort_and_drains_by_release_event() {
        let registry = Arc::new(HelperProcessRegistry::default());
        let cancellation_id = "11111111-1111-4111-8111-111111111111".to_owned();
        assert!(registry.cancel(&cancellation_id).unwrap());
        let registration = registry.register(cancellation_id.clone()).unwrap();
        assert!(registration.control.is_cancelled());

        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let drain_registry = Arc::clone(&registry);
        let drain = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            drain_registry.cancel_all_and_wait()
        });
        started_receiver.recv().unwrap();
        drop(registration);
        drain.join().unwrap().unwrap();
        assert_eq!(
            registry
                .register("22222222-2222-4222-8222-222222222222".to_owned())
                .err()
                .unwrap()
                .code(),
            "CHROME_PROFILE_IMPORT_HELPER_LAUNCHER_DRAINING"
        );
    }

    #[test]
    fn consumed_pre_spawn_identity_can_be_reused_without_stale_eviction() {
        let registry = Arc::new(HelperProcessRegistry::default());
        let cancellation_id = "44444444-4444-4444-8444-444444444444".to_owned();
        assert!(registry.cancel(&cancellation_id).unwrap());
        let consumed = registry.register(cancellation_id.clone()).unwrap();
        assert!(consumed.control.is_cancelled());
        drop(consumed);

        assert!(registry.cancel(&cancellation_id).unwrap());
        for sequence in 1..PRE_SPAWN_CANCELLATION_CAPACITY {
            let distinct = uuid::Uuid::from_u128(sequence as u128).to_string();
            assert!(registry.cancel(&distinct).unwrap());
        }
        let replayed = registry.register(cancellation_id).unwrap();
        assert!(replayed.control.is_cancelled());
    }

    #[test]
    fn cancellation_terminates_and_reaps_the_exact_child_after_stdout_eof() {
        let registry = Arc::new(HelperProcessRegistry::default());
        let cancellation_id = "33333333-3333-4333-8333-333333333333".to_owned();
        let registration = registry.register(cancellation_id.clone()).unwrap();
        let child = rion_platform::background_command(std::env::current_exe().unwrap())
            .arg("--ignored")
            .arg("cancellation_fixture_process")
            .arg("--nocapture")
            .env(CANCELLATION_FIXTURE_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child_id = child.id();
        let (attached_id, stdin, mut stdout) = registration.control.attach(child).unwrap();
        assert_eq!(attached_id, child_id);
        assert!(registry.cancel(&cancellation_id).unwrap());
        let drain_registry = Arc::clone(&registry);
        let drain = std::thread::spawn(move || drain_registry.cancel_all_and_wait());
        drop(stdin);

        let mut response = Vec::new();
        stdout.read_to_end(&mut response).unwrap();
        drop(stdout);
        response.fill(0);
        let status = registration.control.wait_after_stdout_eof().unwrap();
        assert!(!status.success());
        assert!(registration.control.is_cancelled());
        drop(registration);
        drain.join().unwrap().unwrap();
        assert!(registry.state.lock().unwrap().active.is_empty());
        assert!(!registry.cancel(&cancellation_id).unwrap());
    }
}
