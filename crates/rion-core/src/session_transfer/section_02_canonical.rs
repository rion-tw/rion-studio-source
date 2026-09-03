#[derive(Debug, Clone, Copy)]
struct RoleSessionTransferValidationLimits {
    max_cookies: usize,
    max_local_storage_origins: usize,
    max_local_storage_entries: usize,
    max_total_bytes: usize,
}

const DEFAULT_VALIDATION_LIMITS: RoleSessionTransferValidationLimits =
    RoleSessionTransferValidationLimits {
        max_cookies: ROLE_SESSION_TRANSFER_MAX_COOKIES,
        max_local_storage_origins: ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ORIGINS,
        max_local_storage_entries: ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ENTRIES,
        max_total_bytes: ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES,
    };

#[derive(Debug)]
struct DecodedTransferBytes {
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct InventoryCounts {
    cookies: usize,
    local_storage_origins: usize,
    local_storage_entries: usize,
}

impl RoleSessionTransferEnvelopeRecord {
    pub fn from_json(bytes: &[u8]) -> CoreResult<Self> {
        validate_canonical_envelope_length(bytes.len())?;
        let envelope: Self = serde_json::from_slice(bytes).map_err(|_| {
            transfer_error(
                "ROLE_SESSION_TRANSFER_ENVELOPE_INVALID",
                "Session-transfer envelope decoding failed.",
            )
        })?;
        envelope.canonicalized()
    }

    pub fn validate(&self) -> CoreResult<()> {
        self.canonicalized().map(|_| ())
    }

    pub fn canonicalized(&self) -> CoreResult<Self> {
        canonicalize_with_limits(self, DEFAULT_VALIDATION_LIMITS).map(|(envelope, _)| envelope)
    }

    pub fn canonical_inventory_json(&self) -> CoreResult<Vec<u8>> {
        let (canonical, _) = canonicalize_with_limits(self, DEFAULT_VALIDATION_LIMITS)?;
        serialize_canonical(&canonical.inventory)
    }

    pub fn canonical_envelope_json(&self) -> CoreResult<Vec<u8>> {
        let (canonical, _) = canonicalize_with_limits(self, DEFAULT_VALIDATION_LIMITS)?;
        serialize_canonical(&canonical)
    }

    pub fn inventory_sha256(&self) -> CoreResult<String> {
        self.canonical_inventory_json().map(sha256_hex)
    }

    pub fn envelope_sha256(&self) -> CoreResult<String> {
        self.canonical_envelope_json().map(sha256_hex)
    }

    pub fn journal_evidence(&self) -> CoreResult<RoleSessionTransferJournalEvidence> {
        let (canonical, counts) = canonicalize_with_limits(self, DEFAULT_VALIDATION_LIMITS)?;
        let inventory_json = serialize_canonical(&canonical.inventory)?;
        let envelope_json = serialize_canonical(&canonical)?;
        Ok(RoleSessionTransferJournalEvidence {
            role_id: canonical.metadata.role_id,
            transfer_id: canonical.metadata.transfer_id,
            envelope_sha256: sha256_hex(envelope_json),
            inventory_sha256: sha256_hex(inventory_json),
            cookie_count: count_u64(counts.cookies)?,
            local_storage_origin_count: count_u64(counts.local_storage_origins)?,
            local_storage_entry_count: count_u64(counts.local_storage_entries)?,
        })
    }
}

fn canonicalize_with_limits(
    envelope: &RoleSessionTransferEnvelopeRecord,
    limits: RoleSessionTransferValidationLimits,
) -> CoreResult<(RoleSessionTransferEnvelopeRecord, InventoryCounts)> {
    validate_metadata(&envelope.metadata)?;
    let counts = validate_inventory(&envelope.inventory, limits)?;
    let mut canonical = envelope.clone();
    sort_inventory(&mut canonical.inventory)?;
    validate_canonical_envelope_length(serialized_length(&canonical)?)?;
    Ok((canonical, counts))
}

fn validate_metadata(metadata: &RoleSessionTransferMetadataRecord) -> CoreResult<()> {
    if metadata.version != ROLE_SESSION_TRANSFER_VERSION
        || i64::try_from(metadata.source_revision).is_err()
    {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_VERSION_UNSUPPORTED",
            "Session-transfer format or version is unsupported.",
        ));
    }
    validate_canonical_uuid(&metadata.transfer_id)?;
    validate_canonical_uuid(&metadata.role_id)?;
    let source_matches_platform = matches!(
        (metadata.platform, metadata.source_engine),
        (
            RoleSessionMigrationPlatform::Macos,
            RoleSessionMigrationEngine::Wkwebview
        ) | (
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2
        )
    );
    if !source_matches_platform || metadata.target_engine != RoleSessionMigrationEngine::Chromium {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_ENGINE_INVALID",
            "Session-transfer engine metadata is invalid.",
        ));
    }
    match (
        metadata.platform,
        metadata.source_engine,
        metadata.source_evidence.as_ref(),
    ) {
        (
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2,
            Some(evidence),
        ) => validate_webview2_source_evidence(evidence)?,
        (RoleSessionMigrationPlatform::Macos, RoleSessionMigrationEngine::Wkwebview, None) => {}
        _ => {
            return Err(transfer_error(
                "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
                "Session-transfer source evidence is invalid for its platform and engine.",
            ));
        }
    }
    Ok(())
}

fn validate_webview2_source_evidence(
    evidence: &RoleSessionTransferSourceEvidenceRecord,
) -> CoreResult<()> {
    if evidence.runtime_version.is_empty()
        || evidence.runtime_version.len() > 64
        || !evidence
            .runtime_version
            .bytes()
            .all(|byte| (b'!'..=b'~').contains(&byte))
        || !is_canonical_protocol_version(&evidence.protocol_version)
    {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
            "Session-transfer source evidence is invalid for its platform and engine.",
        ));
    }
    Ok(())
}

fn is_canonical_protocol_version(value: &str) -> bool {
    let Some((major, minor)) = value.split_once('.') else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && !minor.contains('.')
        && canonical_decimal_component(major)
        && canonical_decimal_component(minor)
}

fn canonical_decimal_component(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_digit()) && (value == "0" || !value.starts_with('0'))
}

fn validate_inventory(
    inventory: &RoleSessionTransferInventoryRecord,
    limits: RoleSessionTransferValidationLimits,
) -> CoreResult<InventoryCounts> {
    if inventory.cookies.len() > limits.max_cookies
        || inventory.local_storage.len() > limits.max_local_storage_origins
    {
        return Err(limit_error());
    }
    let mut total_bytes = 0_usize;
    for cookie in &inventory.cookies {
        validate_cookie(cookie, &mut total_bytes, limits.max_total_bytes)?;
    }

    let mut local_storage_entry_count = 0_usize;
    for origin in &inventory.local_storage {
        local_storage_entry_count = local_storage_entry_count
            .checked_add(origin.entries.len())
            .ok_or_else(limit_error)?;
        if local_storage_entry_count > limits.max_local_storage_entries {
            return Err(limit_error());
        }
        validate_origin(origin, &mut total_bytes, limits.max_total_bytes)?;
    }
    Ok(InventoryCounts {
        cookies: inventory.cookies.len(),
        local_storage_origins: inventory.local_storage.len(),
        local_storage_entries: local_storage_entry_count,
    })
}

fn sort_inventory(inventory: &mut RoleSessionTransferInventoryRecord) -> CoreResult<()> {
    inventory.cookies.sort_by(|left, right| {
        (
            left.domain.as_str(),
            left.path.as_str(),
            left.name.data.as_str(),
        )
            .cmp(&(
                right.domain.as_str(),
                right.path.as_str(),
                right.name.data.as_str(),
            ))
    });
    if inventory.cookies.windows(2).any(|pair| {
        pair[0].domain == pair[1].domain
            && pair[0].path == pair[1].path
            && pair[0].name.data == pair[1].name.data
    }) {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_COOKIE_DUPLICATE",
            "Session-transfer inventory contains a duplicate cookie identity.",
        ));
    }

    for origin in &mut inventory.local_storage {
        origin
            .entries
            .sort_by(|left, right| left.key.data.cmp(&right.key.data));
        if origin
            .entries
            .windows(2)
            .any(|pair| pair[0].key.data == pair[1].key.data)
        {
            return Err(transfer_error(
                "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_DUPLICATE",
                "Session-transfer inventory contains a duplicate LocalStorage key.",
            ));
        }
    }
    inventory
        .local_storage
        .sort_by(|left, right| left.origin.cmp(&right.origin));
    if inventory
        .local_storage
        .windows(2)
        .any(|pair| pair[0].origin == pair[1].origin)
    {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_ORIGIN_DUPLICATE",
            "Session-transfer inventory contains a duplicate LocalStorage origin.",
        ));
    }
    Ok(())
}

fn validate_cookie(
    cookie: &RoleSessionTransferCookieRecord,
    total_bytes: &mut usize,
    max_total_bytes: usize,
) -> CoreResult<()> {
    let name = decode_canonical_base64(
        &cookie.name,
        MAX_COOKIE_NAME_BYTES,
        RoleSessionTransferByteEncoding::Base64,
    )?;
    if name.bytes.is_empty() {
        return Err(cookie_error());
    }
    let value = decode_canonical_base64(
        &cookie.value,
        MAX_COOKIE_VALUE_BYTES,
        RoleSessionTransferByteEncoding::Base64,
    )?;
    if cookie.domain.is_empty()
        || cookie.domain.len() > MAX_COOKIE_DOMAIN_BYTES
        || cookie.domain.starts_with('.')
        || cookie.domain.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(cookie_error());
    }
    let host = Host::parse(&cookie.domain).map_err(|_| cookie_error())?;
    if host.to_string() != cookie.domain
        || (!cookie.host_only && !matches!(host, Host::Domain(_)))
        || cookie.path.is_empty()
        || cookie.path.len() > MAX_COOKIE_PATH_BYTES
        || !cookie.path.starts_with('/')
        || contains_control(&cookie.path)
    {
        return Err(cookie_error());
    }
    if let RoleSessionTransferCookieExpiry::Absolute { unix_ms } = cookie.expiry
        && !(0..=MAX_ABSOLUTE_EXPIRY_UNIX_MS).contains(&unix_ms)
    {
        return Err(cookie_error());
    }
    add_total(total_bytes, name.bytes.len(), max_total_bytes)?;
    add_total(total_bytes, value.bytes.len(), max_total_bytes)?;
    add_total(total_bytes, cookie.domain.len(), max_total_bytes)?;
    add_total(total_bytes, cookie.path.len(), max_total_bytes)?;

    match &cookie.partition {
        RoleSessionTransferCookiePartitionEvidence::Unpartitioned => {}
        RoleSessionTransferCookiePartitionEvidence::Partitioned { partition_key, .. } => {
            if let Some(partition_key) = partition_key {
                let evidence = decode_canonical_base64(
                    partition_key,
                    MAX_PARTITION_EVIDENCE_BYTES,
                    RoleSessionTransferByteEncoding::Base64,
                )?;
                add_total(total_bytes, evidence.bytes.len(), max_total_bytes)?;
            }
            return Err(transfer_error(
                "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED",
                "Partitioned cookie evidence cannot be migrated losslessly.",
            ));
        }
        RoleSessionTransferCookiePartitionEvidence::Unknown => {
            return Err(transfer_error(
                "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED",
                "Cookie partition evidence is incomplete.",
            ));
        }
    }
    if cookie.unsupported_attribute_codes.len() > MAX_UNSUPPORTED_ATTRIBUTES {
        return Err(limit_error());
    }
    for code in &cookie.unsupported_attribute_codes {
        if code.is_empty()
            || code.len() > MAX_UNSUPPORTED_ATTRIBUTE_CODE_BYTES
            || !code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(cookie_error());
        }
    }
    if !cookie.unsupported_attribute_codes.is_empty() {
        return Err(transfer_error(
            "ROLE_SESSION_TRANSFER_COOKIE_ATTRIBUTE_UNSUPPORTED",
            "Cookie attributes cannot be migrated losslessly.",
        ));
    }
    Ok(())
}

fn validate_origin(
    origin: &RoleSessionTransferLocalStorageOriginRecord,
    total_bytes: &mut usize,
    max_total_bytes: usize,
) -> CoreResult<()> {
    if origin.origin.is_empty()
        || origin.origin.len() > MAX_LOCAL_STORAGE_ORIGIN_BYTES
        || contains_control(&origin.origin)
        || origin.entries.is_empty()
    {
        return Err(origin_error());
    }
    let parsed = Url::parse(&origin.origin).map_err(|_| origin_error())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.origin().ascii_serialization() != origin.origin
    {
        return Err(origin_error());
    }
    add_total(total_bytes, origin.origin.len(), max_total_bytes)?;
    for entry in &origin.entries {
        let key = decode_canonical_base64(
            &entry.key,
            MAX_LOCAL_STORAGE_KEY_BYTES,
            RoleSessionTransferByteEncoding::Base64Utf16Le,
        )?;
        let value = decode_canonical_base64(
            &entry.value,
            MAX_LOCAL_STORAGE_VALUE_BYTES,
            RoleSessionTransferByteEncoding::Base64Utf16Le,
        )?;
        if key.bytes.len() % 2 != 0 || value.bytes.len() % 2 != 0 {
            return Err(origin_error());
        }
        add_total(total_bytes, key.bytes.len(), max_total_bytes)?;
        add_total(total_bytes, value.bytes.len(), max_total_bytes)?;
    }
    Ok(())
}

fn decode_canonical_base64(
    value: &RoleSessionTransferBytesRecord,
    max_bytes: usize,
    expected_encoding: RoleSessionTransferByteEncoding,
) -> CoreResult<DecodedTransferBytes> {
    if value.encoding != expected_encoding || value.data.len() > maximum_base64_length(max_bytes)? {
        return Err(bytes_error());
    }
    let bytes = BASE64_STANDARD
        .decode(&value.data)
        .map_err(|_| bytes_error())?;
    if bytes.len() > max_bytes || BASE64_STANDARD.encode(&bytes) != value.data {
        return Err(bytes_error());
    }
    Ok(DecodedTransferBytes { bytes })
}

fn maximum_base64_length(max_bytes: usize) -> CoreResult<usize> {
    max_bytes
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(limit_error)
}

fn add_total(total: &mut usize, value: usize, maximum: usize) -> CoreResult<()> {
    *total = total.checked_add(value).ok_or_else(limit_error)?;
    if *total > maximum {
        return Err(limit_error());
    }
    Ok(())
}

fn validate_canonical_uuid(value: &str) -> CoreResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| identity_error())?;
    if parsed.to_string() != value {
        return Err(identity_error());
    }
    Ok(())
}

fn contains_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn serialize_canonical<T: Serialize>(value: &T) -> CoreResult<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        transfer_error(
            "ROLE_SESSION_TRANSFER_SERIALIZATION_FAILED",
            "Session-transfer canonical serialization failed.",
        )
    })?;
    validate_canonical_envelope_length(bytes.len())?;
    Ok(bytes)
}

fn serialized_length<T: Serialize>(value: &T) -> CoreResult<usize> {
    // Validation deliberately performs a counting serialization before
    // protection so no canonical envelope can be accepted above RSP2's
    // plaintext ceiling, without allocating a second near-limit buffer.
    let mut counter = CanonicalLengthCounter { length: Some(0) };
    serde_json::to_writer(&mut counter, value).map_err(|_| {
        transfer_error(
            "ROLE_SESSION_TRANSFER_SERIALIZATION_FAILED",
            "Session-transfer canonical serialization failed.",
        )
    })?;
    counter.length.ok_or_else(limit_error)
}

struct CanonicalLengthCounter {
    length: Option<usize>,
}

impl std::io::Write for CanonicalLengthCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.length = self
            .length
            .and_then(|current| current.checked_add(bytes.len()));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validate_canonical_envelope_length(length: usize) -> CoreResult<()> {
    if length == 0 || length > ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES {
        return Err(limit_error());
    }
    Ok(())
}

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn count_u64(value: usize) -> CoreResult<u64> {
    u64::try_from(value).map_err(|_| limit_error())
}

fn transfer_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn identity_error() -> CoreError {
    transfer_error(
        "ROLE_SESSION_TRANSFER_IDENTITY_INVALID",
        "Session-transfer identity metadata is invalid.",
    )
}

fn bytes_error() -> CoreError {
    transfer_error(
        "ROLE_SESSION_TRANSFER_BYTES_INVALID",
        "Session-transfer byte encoding is invalid.",
    )
}

fn cookie_error() -> CoreError {
    transfer_error(
        "ROLE_SESSION_TRANSFER_COOKIE_INVALID",
        "Session-transfer cookie metadata is invalid.",
    )
}

fn origin_error() -> CoreError {
    transfer_error(
        "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_ORIGIN_INVALID",
        "Session-transfer LocalStorage origin metadata is invalid.",
    )
}

fn limit_error() -> CoreError {
    transfer_error(
        "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED",
        "Session-transfer inventory exceeds a bounded limit.",
    )
}
