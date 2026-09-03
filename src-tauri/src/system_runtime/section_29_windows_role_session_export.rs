#[cfg(any(windows, test))]
// Chromium commit d2305f0091ad41e3109aa3138ee1e460db538177
// (main@{#943026}, 98.0.4713.0) added backend emission of both
// partitionKey and partitionKeyOpaque. Older runtimes can silently omit the
// partition evidence that this source export must observe before publication.
const WEBVIEW2_EXPORT_PARTITION_EVIDENCE_MINIMUM_RUNTIME_MAJOR: u64 = 98;
#[cfg(any(windows, test))]
const WEBVIEW2_EXPORT_PROTOCOL_VERSION: &str = "1.3";

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Webview2RoleSessionSourceObservation {
    cookies: Vec<rion_core::RoleSessionTransferCookieRecord>,
    profile_path: PathBuf,
    source_evidence: rion_core::RoleSessionTransferSourceEvidenceRecord,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Webview2BrowserVersionResponse {
    protocol_version: String,
    product: String,
    revision: String,
    user_agent: String,
    js_version: String,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Webview2StorageCookiesResponse {
    cookies: Vec<Webview2NetworkCookie>,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Webview2NetworkCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: Value,
    size: i64,
    http_only: bool,
    secure: bool,
    session: bool,
    same_site: Option<Webview2CookieSameSite>,
    priority: Webview2CookiePriority,
    source_scheme: Webview2CookieSourceScheme,
    source_port: i64,
    partition_key: Option<Webview2CookiePartitionKey>,
    partition_key_opaque: Option<bool>,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize)]
enum Webview2CookieSameSite {
    Strict,
    Lax,
    None,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize, PartialEq, Eq)]
enum Webview2CookiePriority {
    Low,
    Medium,
    High,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize, PartialEq, Eq)]
enum Webview2CookieSourceScheme {
    Unset,
    NonSecure,
    Secure,
}

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Webview2CookiePartitionKey {
    top_level_site: String,
    has_cross_site_ancestor: bool,
}

#[cfg(any(windows, test))]
fn decode_webview2_export_observation(
    runtime_version: &str,
    profile_path: PathBuf,
    browser_version_json: &str,
    storage_cookies_json: &str,
) -> RuntimeResult<Webview2RoleSessionSourceObservation> {
    let browser_version: Webview2BrowserVersionResponse =
        serde_json::from_str(browser_version_json).map_err(|_| {
            webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_PROTOCOL_INCOMPLETE",
                "WebView2 did not provide the exact supported protocol-version evidence.",
            )
        })?;
    let source_evidence = validate_webview2_export_runtime(runtime_version, &browser_version)?;
    let response: Webview2StorageCookiesResponse = serde_json::from_str(storage_cookies_json)
        .map_err(|_| {
            webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_OBSERVATION_INCOMPLETE",
                "WebView2 cookie observation was incomplete or used an unknown schema.",
            )
        })?;
    if response.cookies.len() > rion_core::ROLE_SESSION_TRANSFER_MAX_COOKIES {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LIMIT_EXCEEDED",
            "WebView2 cookie observation exceeded the bounded transfer limit.",
        ));
    }
    let cookies = response
        .cookies
        .into_iter()
        .map(canonical_webview2_cookie)
        .collect::<RuntimeResult<Vec<_>>>()?;
    Ok(Webview2RoleSessionSourceObservation {
        cookies,
        profile_path,
        source_evidence,
    })
}

#[cfg(any(windows, test))]
fn validate_webview2_export_runtime(
    runtime_version: &str,
    browser_version: &Webview2BrowserVersionResponse,
) -> RuntimeResult<rion_core::RoleSessionTransferSourceEvidenceRecord> {
    let runtime_components = runtime_version.split('.').collect::<Vec<_>>();
    let runtime_is_canonical = runtime_components.len() == 4
        && runtime_components.iter().all(|component| {
            !component.is_empty()
                && component.bytes().all(|byte| byte.is_ascii_digit())
                && (*component == "0" || !component.starts_with('0'))
        });
    let runtime_major = runtime_components
        .first()
        .and_then(|component| component.parse::<u64>().ok());
    let product_version = browser_version
        .product
        .split_once('/')
        .map(|(_, version)| version);
    if !runtime_is_canonical
        || runtime_major
            .is_none_or(|major| major < WEBVIEW2_EXPORT_PARTITION_EVIDENCE_MINIMUM_RUNTIME_MAJOR)
        || browser_version.protocol_version != WEBVIEW2_EXPORT_PROTOCOL_VERSION
        || product_version != Some(runtime_version)
        || browser_version.revision.is_empty()
        || browser_version.user_agent.is_empty()
        || browser_version.js_version.is_empty()
    {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_RUNTIME_UNSUPPORTED",
            "The installed WebView2 runtime cannot prove the required export semantics.",
        ));
    }
    Ok(rion_core::RoleSessionTransferSourceEvidenceRecord {
        kind: rion_core::RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
        runtime_version: runtime_version.to_owned(),
        protocol_version: browser_version.protocol_version.clone(),
        partition_capability: rion_core::RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
    })
}

#[cfg(any(windows, test))]
fn canonical_webview2_cookie(
    cookie: Webview2NetworkCookie,
) -> RuntimeResult<rion_core::RoleSessionTransferCookieRecord> {
    if let Some(partition_key) = cookie.partition_key.as_ref() {
        let _ = (
            partition_key.top_level_site.as_str(),
            partition_key.has_cross_site_ancestor,
        );
    }
    if cookie.partition_key.is_some() || cookie.partition_key_opaque == Some(true) {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED",
            "WebView2 reported cookie partition evidence that the target cannot preserve.",
        ));
    }
    match cookie.priority {
        Webview2CookiePriority::Medium => {}
        Webview2CookiePriority::Low | Webview2CookiePriority::High => {
            return Err(webview2_export_cookie_attribute_error());
        }
    }
    let source_matches = match (cookie.secure, &cookie.source_scheme) {
        (true, Webview2CookieSourceScheme::Secure)
        | (false, Webview2CookieSourceScheme::NonSecure) => true,
        (_, Webview2CookieSourceScheme::Unset)
        | (true, Webview2CookieSourceScheme::NonSecure)
        | (false, Webview2CookieSourceScheme::Secure) => false,
    };
    let expected_port = if cookie.secure { 443 } else { 80 };
    if !source_matches || cookie.source_port != expected_port {
        return Err(webview2_export_cookie_attribute_error());
    }
    let expected_size = cookie
        .name
        .len()
        .checked_add(cookie.value.len())
        .and_then(|size| i64::try_from(size).ok())
        .ok_or_else(webview2_export_cookie_error)?;
    if cookie.size != expected_size || cookie.name.is_empty() {
        return Err(webview2_export_cookie_error());
    }
    let host_only = !cookie.domain.starts_with('.');
    let domain = if host_only {
        cookie.domain
    } else {
        cookie.domain[1..].to_owned()
    }
    .to_ascii_lowercase();
    let expiry = if cookie.session {
        if cookie.expires.as_f64() != Some(-1.0) {
            return Err(webview2_export_cookie_error());
        }
        rion_core::RoleSessionTransferCookieExpiry::Session
    } else {
        let seconds = cookie
            .expires
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(webview2_export_cookie_error)?;
        let milliseconds = seconds * 1_000.0;
        if milliseconds.fract() != 0.0 || milliseconds > i64::MAX as f64 {
            return Err(webview2_export_cookie_error());
        }
        rion_core::RoleSessionTransferCookieExpiry::Absolute {
            unix_ms: milliseconds as i64,
        }
    };
    Ok(rion_core::RoleSessionTransferCookieRecord {
        name: rion_core::RoleSessionTransferBytesRecord::from_bytes(cookie.name.as_bytes()),
        value: rion_core::RoleSessionTransferBytesRecord::from_bytes(cookie.value.as_bytes()),
        domain,
        path: cookie.path,
        host_only,
        secure: cookie.secure,
        http_only: cookie.http_only,
        expiry,
        same_site: match cookie.same_site {
            None => rion_core::RoleSessionTransferCookieSameSite::Unspecified,
            Some(Webview2CookieSameSite::None) => {
                rion_core::RoleSessionTransferCookieSameSite::None
            }
            Some(Webview2CookieSameSite::Lax) => rion_core::RoleSessionTransferCookieSameSite::Lax,
            Some(Webview2CookieSameSite::Strict) => {
                rion_core::RoleSessionTransferCookieSameSite::Strict
            }
        },
        partition: rion_core::RoleSessionTransferCookiePartitionEvidence::Unpartitioned,
        unsupported_attribute_codes: Vec::new(),
    })
}

#[cfg(any(windows, test))]
fn webview2_export_cookie_error() -> RuntimeError {
    webview2_export_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_INVALID",
        "WebView2 reported a cookie that cannot be represented losslessly.",
    )
}

#[cfg(any(windows, test))]
fn webview2_export_cookie_attribute_error() -> RuntimeError {
    webview2_export_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_ATTRIBUTE_UNSUPPORTED",
        "WebView2 reported cookie attributes that the target cannot preserve.",
    )
}

#[cfg(any(windows, test))]
fn webview2_export_error(code: &'static str, message: &'static str) -> RuntimeError {
    RuntimeError::new(code, message)
}

#[cfg(any(windows, test))]
fn webview2_export_keeper_navigation_allowed(url: &Url) -> bool {
    url.as_str() == "about:blank"
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsV22RoleSessionExportRequest {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub expected_source_revision: u64,
    pub expected_journal_revision: u64,
    pub occurred_at: String,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsV22RoleSessionExportReceipt {
    pub journal: rion_core::RoleSessionMigrationRecord,
    pub evidence: rion_core::RoleSessionTransferJournalEvidence,
    pub resumed_after_vault_publication: bool,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsV22RoleSessionExportNonSuccessReceipt {
    pub journal: rion_core::RoleSessionMigrationRecord,
    pub stable_error_code: String,
    pub evidence: Option<rion_core::RoleSessionTransferJournalEvidence>,
    pub replayed_from_durable_journal: bool,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsV22RoleSessionExportOutcome {
    Exported(WindowsV22RoleSessionExportReceipt),
    NonSuccess(WindowsV22RoleSessionExportNonSuccessReceipt),
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsV22RoleSessionExportFailure {
    pub code: &'static str,
    pub message: String,
}

#[cfg(windows)]
impl From<RuntimeError> for WindowsV22RoleSessionExportFailure {
    fn from(error: RuntimeError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Webview2SourceExportPlan {
    Capture,
    ResumePublishedVault,
    VerifyExported,
    ReplayKnownFailure,
}

#[cfg(any(windows, test))]
fn plan_webview2_source_export(
    journal: &rion_core::RoleSessionMigrationRecord,
    request: &WindowsV22RoleSessionExportRequest,
    pending_evidence: Option<&rion_core::RoleSessionTransferJournalEvidence>,
) -> RuntimeResult<Webview2SourceExportPlan> {
    validate_webview2_source_export_request(journal, request)?;
    match journal.phase {
        rion_core::RoleSessionMigrationPhase::V22Ready => {
            if let Some(evidence) = pending_evidence {
                validate_webview2_export_evidence_identity(journal, evidence)?;
                Ok(Webview2SourceExportPlan::ResumePublishedVault)
            } else {
                Ok(Webview2SourceExportPlan::Capture)
            }
        }
        rion_core::RoleSessionMigrationPhase::Exported if pending_evidence.is_none() => {
            Ok(Webview2SourceExportPlan::VerifyExported)
        }
        rion_core::RoleSessionMigrationPhase::Failed if pending_evidence.is_none() => {
            Ok(Webview2SourceExportPlan::ReplayKnownFailure)
        }
        _ => Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STATE_INVALID",
            "The WebView2 export journal is not in an exact resumable source phase.",
        )),
    }
}

#[cfg(any(windows, test))]
fn validate_webview2_source_export_request(
    journal: &rion_core::RoleSessionMigrationRecord,
    request: &WindowsV22RoleSessionExportRequest,
) -> RuntimeResult<()> {
    let canonical_uuid = |value: &str| {
        uuid::Uuid::parse_str(value)
            .ok()
            .is_some_and(|parsed| parsed.to_string() == value)
    };
    let canonical_occurred_at = chrono::DateTime::parse_from_rfc3339(&request.occurred_at)
        .ok()
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    let replayable_terminal = matches!(
        journal.phase,
        rion_core::RoleSessionMigrationPhase::Exported
            | rion_core::RoleSessionMigrationPhase::Failed
    );
    let journal_revision_matches = request.expected_journal_revision == journal.journal_revision
        || (replayable_terminal
            && request
                .expected_journal_revision
                .checked_add(1)
                .is_some_and(|revision| revision == journal.journal_revision));
    if !canonical_uuid(&request.role_id)
        || !canonical_uuid(&request.transfer_id)
        || !canonical_uuid(&request.transition_id)
        || request.role_id != journal.role_id
        || request.transfer_id != journal.transfer_id
        || request.expected_source_revision != journal.source_revision
        || !journal_revision_matches
        || canonical_occurred_at.as_deref() != Some(request.occurred_at.as_str())
        || journal.platform != rion_core::RoleSessionMigrationPlatform::Windows
        || journal.source_engine != rion_core::RoleSessionMigrationEngine::Webview2
        || journal.target_engine != rion_core::RoleSessionMigrationEngine::Chromium
    {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STALE",
            "The WebView2 export request no longer matches the authoritative journal revision.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_webview2_export_evidence_identity(
    journal: &rion_core::RoleSessionMigrationRecord,
    evidence: &rion_core::RoleSessionTransferJournalEvidence,
) -> RuntimeResult<()> {
    if evidence.role_id != journal.role_id || evidence.transfer_id != journal.transfer_id {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_EVIDENCE_STALE",
            "The durable WebView2 export evidence does not match its authoritative journal.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Webview2CommittedEvidenceState {
    None,
    Complete,
}

#[cfg(any(windows, test))]
fn webview2_committed_evidence_state(
    journal: &rion_core::RoleSessionMigrationRecord,
) -> RuntimeResult<Webview2CommittedEvidenceState> {
    match (
        journal.envelope_sha256.is_some(),
        journal.inventory_sha256.is_some(),
        journal.cookie_count.is_some(),
        journal.local_storage_origin_count.is_some(),
        journal.local_storage_entry_count.is_some(),
    ) {
        (false, false, false, false, false) => Ok(Webview2CommittedEvidenceState::None),
        (true, true, true, true, true) => Ok(Webview2CommittedEvidenceState::Complete),
        _ => Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_TERMINAL_RECEIPT_INVALID",
            "The durable WebView2 terminal receipt contains incomplete export evidence.",
        )),
    }
}

#[cfg(any(windows, test))]
fn validate_webview2_committed_export_evidence(
    journal: &rion_core::RoleSessionMigrationRecord,
    evidence: &rion_core::RoleSessionTransferJournalEvidence,
) -> RuntimeResult<()> {
    validate_webview2_export_evidence_identity(journal, evidence)?;
    if journal.envelope_sha256.as_deref() != Some(evidence.envelope_sha256.as_str())
        || journal.inventory_sha256.as_deref() != Some(evidence.inventory_sha256.as_str())
        || journal.cookie_count != Some(evidence.cookie_count)
        || journal.local_storage_origin_count != Some(evidence.local_storage_origin_count)
        || journal.local_storage_entry_count != Some(evidence.local_storage_entry_count)
    {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_EVIDENCE_STALE",
            "The authenticated WebView2 vault evidence does not match its durable journal.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum Webview2TerminalSourceExportReplay {
    Exported(rion_core::RoleSessionTransferJournalEvidence),
    Failed {
        stable_error_code: String,
        evidence: Option<rion_core::RoleSessionTransferJournalEvidence>,
    },
}

#[cfg(any(windows, test))]
fn replay_webview2_terminal_source_export(
    journal: &rion_core::RoleSessionMigrationRecord,
    request: &WindowsV22RoleSessionExportRequest,
    load_verified_vault: impl FnOnce() -> RuntimeResult<rion_core::RoleSessionTransferJournalEvidence>,
) -> RuntimeResult<Webview2TerminalSourceExportReplay> {
    match plan_webview2_source_export(journal, request, None)? {
        Webview2SourceExportPlan::VerifyExported => {
            if webview2_committed_evidence_state(journal)?
                != Webview2CommittedEvidenceState::Complete
            {
                return Err(webview2_export_error(
                    "ROLE_SESSION_TRANSFER_WEBVIEW2_TERMINAL_RECEIPT_INVALID",
                    "The durable WebView2 exported receipt has no complete vault evidence.",
                ));
            }
            let evidence = load_verified_vault()?;
            validate_webview2_committed_export_evidence(journal, &evidence)?;
            Ok(Webview2TerminalSourceExportReplay::Exported(evidence))
        }
        Webview2SourceExportPlan::ReplayKnownFailure => {
            let stable_error_code = journal.stable_error_code.clone().filter(|code| {
                !code.is_empty()
                    && journal.outcome == Some(rion_core::RoleSessionMigrationOutcome::Failed)
                    && journal.outcome_at.is_some()
            });
            let Some(stable_error_code) = stable_error_code else {
                return Err(webview2_export_error(
                    "ROLE_SESSION_TRANSFER_WEBVIEW2_TERMINAL_RECEIPT_INVALID",
                    "The durable WebView2 failed receipt is incomplete.",
                ));
            };
            let evidence = match webview2_committed_evidence_state(journal)? {
                Webview2CommittedEvidenceState::None => None,
                Webview2CommittedEvidenceState::Complete => {
                    let evidence = load_verified_vault()?;
                    validate_webview2_committed_export_evidence(journal, &evidence)?;
                    Some(evidence)
                }
            };
            Ok(Webview2TerminalSourceExportReplay::Failed {
                stable_error_code,
                evidence,
            })
        }
        Webview2SourceExportPlan::Capture | Webview2SourceExportPlan::ResumePublishedVault => {
            Err(webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STATE_INVALID",
                "The WebView2 export journal is not terminal.",
            ))
        }
    }
}

#[cfg(any(windows, test))]
fn webview2_export_transition(
    request: &WindowsV22RoleSessionExportRequest,
    evidence: &rion_core::RoleSessionTransferJournalEvidence,
) -> RuntimeResult<rion_core::RoleSessionMigrationTransitionInput> {
    let mut transition = rion_core::RoleSessionMigrationTransitionInput {
        role_id: request.role_id.clone(),
        transfer_id: request.transfer_id.clone(),
        transition_id: request.transition_id.clone(),
        expected_phase: rion_core::RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: request.expected_journal_revision,
        next_phase: rion_core::RoleSessionMigrationPhase::Exported,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: request.occurred_at.clone(),
    };
    evidence
        .apply_to_transition(&mut transition)
        .map_err(RuntimeError::core)?;
    Ok(transition)
}

#[cfg(windows)]
struct Webview2ExportKeeper {
    lifecycle: Arc<SurfaceLifecycleTracker>,
    webview: Webview,
    window: Window,
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    /// Starts one durable startup pass for every retained v22 WebView2 role.
    /// Journal creation is owned by Core and happens before this scheduler is
    /// called, so a crash before task execution remains resumable.
    pub fn schedule_windows_v22_role_session_export_resume(
        self: &Arc<Self>,
    ) -> RuntimeResult<()> {
        let journals = self
            .core
            .role_session_migrations()
            .map_err(RuntimeError::core)?
            .into_iter()
            .filter(|journal| {
                journal.platform == rion_core::RoleSessionMigrationPlatform::Windows
                    && matches!(
                        journal.phase,
                        rion_core::RoleSessionMigrationPhase::V22Ready
                            | rion_core::RoleSessionMigrationPhase::Exported
                    )
            })
            .collect::<Vec<_>>();
        for journal in journals {
            let runtime = Arc::clone(self);
            let _task = tauri::async_runtime::spawn(async move {
                let request = WindowsV22RoleSessionExportRequest {
                    role_id: journal.role_id.clone(),
                    transfer_id: journal.transfer_id.clone(),
                    transition_id: uuid::Uuid::new_v4().to_string(),
                    expected_source_revision: journal.source_revision,
                    expected_journal_revision: journal.journal_revision,
                    occurred_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                };
                let _outcome = runtime
                    .export_windows_v22_role_session_internal(request)
                    .await;
            });
        }
        Ok(())
    }

    /// Privileged Windows v22 source-export boundary. This method is Rust-only:
    /// it is not registered as a Tauri command and never returns secret bytes.
    pub async fn export_windows_v22_role_session_internal(
        &self,
        request: WindowsV22RoleSessionExportRequest,
    ) -> Result<WindowsV22RoleSessionExportOutcome, WindowsV22RoleSessionExportFailure> {
        self.export_windows_v22_role_session_inner(request)
            .await
            .map_err(Into::into)
    }

    async fn export_windows_v22_role_session_inner(
        &self,
        request: WindowsV22RoleSessionExportRequest,
    ) -> RuntimeResult<WindowsV22RoleSessionExportOutcome> {
        let core = Arc::clone(&self.core);
        let role_id = request.role_id.clone();
        let lease = tokio::task::spawn_blocking(move || {
            core.acquire_browser_operation(rion_core::BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "recoverableMutation".to_owned(),
            })
        })
        .await
        .map_err(|_| {
            webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_LEASE_CANCELLED",
                "The WebView2 export role-operation lease actor stopped.",
            )
        })?
        .map_err(RuntimeError::core)?;

        let result = self
            .export_windows_v22_role_session_under_lease(&request)
            .await;
        let completion = self
            .core
            .complete_browser_operation(&lease.id)
            .map_err(RuntimeError::core);
        match (result, completion) {
            (Ok(receipt), Ok(())) => Ok(receipt),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn export_windows_v22_role_session_under_lease(
        &self,
        request: &WindowsV22RoleSessionExportRequest,
    ) -> RuntimeResult<WindowsV22RoleSessionExportOutcome> {
        let journal = self
            .core
            .role_session_migration(request.role_id.clone())
            .map_err(RuntimeError::core)?
            .ok_or_else(|| {
                webview2_export_error(
                    "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_NOT_FOUND",
                    "The WebView2 source-export journal is unavailable.",
                )
            })?;
        validate_webview2_source_export_request(&journal, request)?;
        if matches!(
            journal.phase,
            rion_core::RoleSessionMigrationPhase::Exported
                | rion_core::RoleSessionMigrationPhase::Failed
        ) {
            let replay = replay_webview2_terminal_source_export(&journal, request, || {
                self.core
                    .verified_role_session_transfer_vault_evidence_internal(
                        request.role_id.clone(),
                        request.transfer_id.clone(),
                    )
                    .map_err(RuntimeError::core)
            })?;
            return match replay {
                Webview2TerminalSourceExportReplay::Exported(evidence) => {
                    Ok(WindowsV22RoleSessionExportOutcome::Exported(
                        WindowsV22RoleSessionExportReceipt {
                            journal,
                            evidence,
                            resumed_after_vault_publication: false,
                        },
                    ))
                }
                Webview2TerminalSourceExportReplay::Failed {
                    stable_error_code,
                    evidence,
                } => Ok(WindowsV22RoleSessionExportOutcome::NonSuccess(
                    WindowsV22RoleSessionExportNonSuccessReceipt {
                        journal,
                        stable_error_code,
                        evidence,
                        replayed_from_durable_journal: true,
                    },
                )),
            };
        }

        let pending = self
            .core
            .pending_role_session_transfer_vault_evidence_internal(
                request.role_id.clone(),
                request.transfer_id.clone(),
            )
            .map_err(RuntimeError::core)?;
        match plan_webview2_source_export(&journal, request, pending.as_ref())? {
            Webview2SourceExportPlan::ResumePublishedVault => {
                self.require_webview2_export_role_stopped(&request.role_id)?;
                let evidence = pending.expect("resume plan requires authenticated evidence");
                let transition = webview2_export_transition(request, &evidence)?;
                let journal = self
                    .core
                    .transition_role_session_migration(transition)
                    .map_err(RuntimeError::core)?;
                Ok(WindowsV22RoleSessionExportOutcome::Exported(
                    WindowsV22RoleSessionExportReceipt {
                        journal,
                        evidence,
                        resumed_after_vault_publication: true,
                    },
                ))
            }
            Webview2SourceExportPlan::Capture => self
                .capture_and_publish_windows_v22_role_session(&journal, request)
                .await
                .map(WindowsV22RoleSessionExportOutcome::Exported),
            Webview2SourceExportPlan::VerifyExported
            | Webview2SourceExportPlan::ReplayKnownFailure => unreachable!(),
        }
    }

    async fn capture_and_publish_windows_v22_role_session(
        &self,
        journal: &rion_core::RoleSessionMigrationRecord,
        request: &WindowsV22RoleSessionExportRequest,
    ) -> RuntimeResult<WindowsV22RoleSessionExportReceipt> {
        let paths = role_session_paths(&self.user_data_dir, &request.role_id)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let keeper = self.create_webview2_export_keeper(&request.role_id, &paths)?;
        let capture = async {
            install_platform_security_policy(&keeper.webview)?;
            if keeper.webview.url().map_err(RuntimeError::tauri)?.as_str() != "about:blank" {
                return Err(webview2_export_error(
                    "ROLE_SESSION_TRANSFER_WEBVIEW2_KEEPER_NAVIGATED",
                    "The privileged WebView2 export keeper left its opaque blank document.",
                ));
            }
            self.close_role_surfaces_for_webview2_export_event_bound(&request.role_id)
                .await?;
            let observation = capture_windows_webview2_role_session_source(&keeper.webview).await?;
            validate_webview2_export_profile_path(&paths.webview2, &observation.profile_path)?;
            Ok(observation)
        }
        .await;
        let cleanup = self
            .close_webview2_export_keeper(&request.role_id, keeper)
            .await;
        let observation = match (capture, cleanup) {
            (Ok(observation), Ok(())) => observation,
            (Err(error), _) => return Err(error),
            (Ok(_), Err(error)) => return Err(error),
        };
        let local_storage =
            rion_core::read_webview2_local_storage_source_internal(&observation.profile_path)
                .map_err(RuntimeError::core)?;
        let envelope = rion_core::RoleSessionTransferEnvelopeRecord {
            metadata: rion_core::RoleSessionTransferMetadataRecord {
                format: rion_core::RoleSessionTransferFormat::RionRoleSessionTransfer,
                version: rion_core::ROLE_SESSION_TRANSFER_VERSION,
                transfer_id: journal.transfer_id.clone(),
                role_id: journal.role_id.clone(),
                platform: journal.platform,
                source_engine: journal.source_engine,
                target_engine: journal.target_engine,
                source_revision: journal.source_revision,
                source_evidence: Some(observation.source_evidence),
            },
            inventory: rion_core::RoleSessionTransferInventoryRecord {
                cookies: observation.cookies,
                local_storage,
            },
        };
        let canonical = envelope
            .canonical_envelope_json()
            .map_err(RuntimeError::core)?;
        let evidence = self
            .core
            .write_role_session_transfer_vault_internal(&canonical)
            .map_err(RuntimeError::core)?;
        let transition = webview2_export_transition(request, &evidence)?;
        let journal = self
            .core
            .transition_role_session_migration(transition)
            .map_err(RuntimeError::core)?;
        Ok(WindowsV22RoleSessionExportReceipt {
            journal,
            evidence,
            resumed_after_vault_publication: false,
        })
    }

    fn create_webview2_export_keeper(
        &self,
        role_id: &str,
        paths: &SessionPaths,
    ) -> RuntimeResult<Webview2ExportKeeper> {
        let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let suffix = format!("{role_id}:{sequence}");
        let window_label = runtime_label("webview2-export-keeper-window", &suffix);
        let webview_label = runtime_label("webview2-export-keeper", &suffix);
        let window_app = self.app.clone();
        let window = self.create_window_bounded(role_id, move || {
            WindowBuilder::new(
                &window_app,
                window_label,
            )
            .inner_size(1.0, 1.0)
            .visible(false)
            .build()
        })?;
        let builder = self
            .webview_builder(
                webview_label,
                paths,
                None,
                WebviewSurfaceFeaturePolicy::Utility,
            )?
            .on_navigation(webview2_export_keeper_navigation_allowed);
        let webview = self
            .add_child_bounded(
                &window,
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
                role_id,
            )
            .inspect_err(|_| {
                let _ = window.close();
            })?;
        let lifecycle = self
            .install_surface_lifecycle_tracker(&webview)
            .inspect_err(|_| {
                let _ = webview.close();
                let _ = window.close();
            })?;
        Ok(Webview2ExportKeeper {
            lifecycle,
            webview,
            window,
        })
    }

    async fn close_webview2_export_keeper(
        &self,
        role_id: &str,
        keeper: Webview2ExportKeeper,
    ) -> RuntimeResult<()> {
        self.close_surface_event_bound(
            &keeper.webview,
            &keeper.lifecycle,
            role_id,
            SurfaceClosePlan {
                checkpoint_role_cookies: false,
                defer_navigation_to_preflight: false,
                release_boundary: SurfaceReleaseBoundary::DedicatedStore,
                requires_page_quiesce: false,
            },
        )
        .await?;
        keeper.window.close().map_err(RuntimeError::tauri)
    }

    fn require_webview2_export_role_stopped(&self, role_id: &str) -> RuntimeResult<()> {
        let state = self.state()?;
        let has_surface = state.has_native_role_surface(role_id)
            || state
                .native_resources
                .surface_registry
                .values()
                .chain(state.native_resources.retired_surface_registry.values())
                .any(|surface| surface.role_id.as_deref() == Some(role_id));
        if has_surface
            || state.close_coordinator.closing_roles.contains(role_id)
            || state.close_coordinator.quarantined_roles.contains(role_id)
        {
            return Err(webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_RESUME_SOURCE_CHANGED",
                "A live or indeterminate role surface prevents crash-resuming the published vault.",
            ));
        }
        Ok(())
    }

    async fn close_role_surfaces_for_webview2_export_event_bound(
        &self,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let has_live_surface = {
            let mut state = self.state()?;
            let has_live_surface = state.native_tab_id_for_role_surface(role_id).is_some();
            if !has_live_surface {
                if state.close_coordinator.quarantined_roles.contains(role_id) {
                    return Err(webview2_export_error(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "The exact role surface remains quarantined and cannot be exported.",
                    ));
                }
                return Ok(());
            }
            let tab_id = state
                .native_tab_id_for_role_surface(role_id)
                .expect("live role has a tab identity");
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || !state
                    .close_coordinator
                    .closing_roles
                    .insert(role_id.to_owned())
            {
                return Err(webview2_export_error(
                    "ROLE_SESSION_TRANSFER_WEBVIEW2_ROLE_CLOSE_BUSY",
                    "Another exact role close transaction is already active.",
                ));
            }
            has_live_surface
        };
        debug_assert!(has_live_surface);
        self.surface_recoveries.cancel_active_for_role(role_id);
        self.fence_and_drain_role_input_lane(role_id)?;
        self.core
            .clear_embedded_keys(role_id)
            .map_err(RuntimeError::core)?;
        self.discard_role_navigation_input_fences(role_id, "webview2-session-export");
        let result = self
            .close_marked_role_surfaces_for_webview2_export(role_id)
            .await;
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_roles.remove(role_id);
        }
        self.tab_close_changed.notify_all();
        result
    }

    async fn close_marked_role_surfaces_for_webview2_export(
        &self,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let (released, webview, lifecycle, popup_labels) = {
            let state = self.state()?;
            let tab_id = state
                .native_tab_id_for_role_surface(role_id)
                .cloned()
                .ok_or_else(|| {
                    webview2_export_error(
                        "SYSTEM_SURFACE_CLOSE_STALE",
                        "The role surface changed before export isolation began.",
                    )
                })?;
            let surface = state
                .native_resources
                .tabs
                .get(&tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
                    webview2_export_error(
                        "SYSTEM_SURFACE_CLOSE_STALE",
                        "The role surface changed before export isolation began.",
                    )
                })?;
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| popup_role_id.as_str() == role_id)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (
                ReleasedRoleSurface {
                    role_id: role_id.to_owned(),
                    surface_instance_id: surface.surface_instance_id.clone(),
                    tab_id,
                    webview_label: surface.webview.label().to_owned(),
                },
                surface.webview.clone(),
                Arc::clone(&surface.lifecycle),
                popup_labels,
            )
        };
        let surface_ids = self.managed_surface_ids_for_role(role_id)?;
        if surface_ids.is_empty() {
            self.close_surface_event_bound(
                &webview,
                &lifecycle,
                role_id,
                SurfaceClosePlan {
                    checkpoint_role_cookies: false,
                    defer_navigation_to_preflight: false,
                    release_boundary: SurfaceReleaseBoundary::SharedBrowserProcess,
                    requires_page_quiesce: true,
                },
            )
            .await?;
        } else {
            for instance_id in surface_ids {
                self.close_managed_surface_with_release_boundary_event_bound(
                    &instance_id,
                    role_id,
                    Some(SurfaceReleaseBoundary::SharedBrowserProcess),
                    false,
                )
                .await?;
            }
        }
        if !self.managed_surface_ids_for_role(role_id)?.is_empty() {
            return Err(webview2_export_error(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "The exact role surfaces did not reach their native release boundary.",
            ));
        }
        self.discard_role_navigation_input_fences(role_id, "webview2-export-native-release");
        self.retire_role_input_surface(role_id)?;
        for label in popup_labels {
            self.forget_popup(&label);
        }
        self.commit_released_role(&released)?;
        if self
            .presentation
            .tab_window(&released.tab_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?
            .is_none()
        {
            return self.refresh_role_placeholders(role_id, None);
        }
        self.create_available_placeholder(&released)?;
        self.refresh_role_placeholders(role_id, None)
    }
}

#[cfg(any(windows, test))]
fn validate_webview2_export_profile_path(
    expected_user_data_folder: &Path,
    observed_profile_path: &Path,
) -> RuntimeResult<()> {
    for path in [expected_user_data_folder, observed_profile_path] {
        let metadata = fs::symlink_metadata(path).map_err(|_| {
            webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID",
                "The exact WebView2 profile path is unavailable.",
            )
        })?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || webview2_export_metadata_is_reparse_point(&metadata)
        {
            return Err(webview2_export_error(
                "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID",
                "The exact WebView2 profile path is unavailable.",
            ));
        }
    }
    let expected = fs::canonicalize(expected_user_data_folder.join("Default")).map_err(|_| {
        webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID",
            "The exact WebView2 profile path is unavailable.",
        )
    })?;
    let observed = fs::canonicalize(observed_profile_path).map_err(|_| {
        webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID",
            "The exact WebView2 profile path is unavailable.",
        )
    })?;
    if observed != expected {
        return Err(webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID",
            "The observed WebView2 profile does not match the exact role store.",
        ));
    }
    Ok(())
}

#[cfg(all(any(windows, test), windows))]
fn webview2_export_metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(all(any(windows, test), not(windows)))]
fn webview2_export_metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}
