//! Bounded BinaryCookies reader for a stopped legacy WebKit store.
//!
//! The format does not carry enough evidence to claim lossless SameSite,
//! partition, or session semantics. Production upgrade therefore imports only
//! structurally valid records, labels the result best-effort, and never upgrades
//! that result to a complete cookie transfer.
use super::Result;
use crate::session_transfer::{
    RoleSessionTransferBytesRecord as Bytes, RoleSessionTransferCookieExpiry as Expiry,
    RoleSessionTransferCookiePartitionEvidence as Partition,
    RoleSessionTransferCookieRecord as Cookie, RoleSessionTransferCookieSameSite as SameSite,
};
use std::collections::{BTreeMap, BTreeSet};

const COCOA_EPOCH_UNIX_SECONDS: f64 = 978_307_200.0;
const MAX_COOKIE_EXPIRY_UNIX_MS: i64 = 253_402_300_799_999;

#[derive(Debug)]
pub(crate) struct CookieCapture {
    pub cookies: Vec<Cookie>,
    pub skipped: usize,
    pub reasons: BTreeSet<&'static str>,
}

#[derive(Debug)]
#[cfg(any(test, feature = "session-migration-diagnostics"))]
pub(crate) struct CookieInspection {
    pub count: usize,
    pub expired: usize,
    pub flags: BTreeSet<u32>,
    pub errors: BTreeSet<&'static str>,
}

fn u32_at(data: &[u8], at: usize, big_endian: bool) -> Result<u32> {
    let raw = data
        .get(at..at.checked_add(4).ok_or("COOKIE_LENGTH_OVERFLOW")?)
        .ok_or("COOKIE_FILE_TRUNCATED")?
        .try_into()
        .map_err(|_| "COOKIE_FILE_TRUNCATED")?;
    Ok(if big_endian {
        u32::from_be_bytes(raw)
    } else {
        u32::from_le_bytes(raw)
    })
}

fn f64_at(data: &[u8], at: usize) -> Result<f64> {
    Ok(f64::from_le_bytes(
        data.get(at..at.checked_add(8).ok_or("COOKIE_LENGTH_OVERFLOW")?)
            .ok_or("COOKIE_RECORD_INVALID")?
            .try_into()
            .map_err(|_| "COOKIE_RECORD_INVALID")?,
    ))
}

fn record_string(record: &[u8], field: usize) -> Result<&[u8]> {
    let at = u32_at(record, field, false)? as usize;
    if at < 56 {
        return Err("COOKIE_STRING_INVALID");
    }
    let value = record.get(at..).ok_or("COOKIE_STRING_INVALID")?;
    let end = value
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("COOKIE_STRING_INVALID")?;
    Ok(&value[..end])
}

fn cookie_name_supported(value: &[u8]) -> bool {
    !value.is_empty()
        && value.iter().all(|byte| {
            byte.is_ascii()
                && !byte.is_ascii_control()
                && !byte.is_ascii_whitespace()
                && !b"()<>@,;:\\\"/[]?={}".contains(byte)
        })
}

fn cookie_value_supported(value: &[u8]) -> bool {
    std::str::from_utf8(value).is_ok()
        && !value.iter().any(|byte| matches!(*byte, 0 | b'\r' | b'\n'))
}

fn decode_record(record: &[u8], now_unix_ms: i64) -> Result<(Cookie, f64, bool, u32)> {
    if record.len() < 56 || u32_at(record, 0, false)? as usize != record.len() {
        return Err("COOKIE_RECORD_INVALID");
    }
    let flags = u32_at(record, 8, false)?;
    let raw_domain = record_string(record, 16)?;
    let name = record_string(record, 20)?;
    let path = record_string(record, 24)?;
    let value = record_string(record, 28)?;
    if !cookie_name_supported(name) || !cookie_value_supported(value) {
        return Err("COOKIE_VALUE_UNREPRESENTABLE");
    }
    let raw_domain =
        std::str::from_utf8(raw_domain).map_err(|_| "COOKIE_DOMAIN_UNREPRESENTABLE")?;
    let host_only = !raw_domain.starts_with('.');
    let domain = raw_domain.trim_start_matches('.').to_ascii_lowercase();
    let host = url::Host::parse(&domain).map_err(|_| "COOKIE_DOMAIN_UNREPRESENTABLE")?;
    if host.to_string() != domain || (!host_only && !matches!(host, url::Host::Domain(_))) {
        return Err("COOKIE_DOMAIN_UNREPRESENTABLE");
    }
    let path = std::str::from_utf8(path).map_err(|_| "COOKIE_PATH_UNREPRESENTABLE")?;
    if !path.starts_with('/') || path.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("COOKIE_PATH_UNREPRESENTABLE");
    }
    let expiry_seconds = f64_at(record, 40)?;
    let creation = f64_at(record, 48)?;
    if !expiry_seconds.is_finite() || !creation.is_finite() {
        return Err("COOKIE_EXPIRY_INVALID");
    }
    let expiry = if expiry_seconds <= 0.0 {
        Expiry::Session
    } else {
        let unix_ms = ((expiry_seconds + COCOA_EPOCH_UNIX_SECONDS) * 1_000.0).round();
        if !unix_ms.is_finite() || unix_ms < 0.0 || unix_ms > MAX_COOKIE_EXPIRY_UNIX_MS as f64 {
            return Err("COOKIE_EXPIRY_UNREPRESENTABLE");
        }
        let unix_ms = unix_ms as i64;
        if unix_ms <= now_unix_ms {
            return Err("COOKIE_EXPIRED_BEFORE_VERIFICATION");
        }
        Expiry::Absolute { unix_ms }
    };
    let has_comment = u32_at(record, 32, false)? != 0 || u32_at(record, 36, false)? != 0;
    Ok((
        Cookie {
            name: Bytes::from_bytes(name),
            value: Bytes::from_bytes(value),
            domain,
            path: path.to_owned(),
            host_only,
            secure: flags & 1 != 0,
            http_only: flags & 4 != 0,
            expiry,
            same_site: SameSite::Unspecified,
            partition: Partition::Unpartitioned,
            unsupported_attribute_codes: Vec::new(),
        },
        creation,
        has_comment,
        flags,
    ))
}

/// Decodes every independently representable record. File/page-table failures
/// remain fatal because record boundaries would then be guesses; record-local
/// failures are skipped and classified without exposing cookie contents.
pub(crate) fn capture(bytes: &[u8], now_unix_ms: i64) -> Result<CookieCapture> {
    if bytes.get(..4) != Some(b"cook") {
        return Err("COOKIE_FORMAT_UNKNOWN");
    }
    let pages = u32_at(bytes, 4, true)? as usize;
    if pages > 4096 {
        return Err("COOKIE_PAGE_LIMIT");
    }
    let table_end = 8usize
        .checked_add(pages.checked_mul(4).ok_or("COOKIE_LENGTH_OVERFLOW")?)
        .ok_or("COOKIE_LENGTH_OVERFLOW")?;
    let mut offset = table_end;
    let mut source_count = 0usize;
    let mut skipped = 0usize;
    let mut reasons = BTreeSet::from([
        "COOKIE_RAW_SOURCE_BEST_EFFORT",
        "COOKIE_HOST_ONLY_INFERRED",
        "COOKIE_SAMESITE_DEFAULTED_UNSPECIFIED",
        "COOKIE_PARTITION_EVIDENCE_UNPROVEN",
        "COOKIE_SESSION_SEMANTICS_BEST_EFFORT",
    ]);
    let mut cookies = BTreeMap::<(String, String, Vec<u8>), (Cookie, f64)>::new();
    for page_index in 0..pages {
        let length = u32_at(bytes, 8 + page_index * 4, true)? as usize;
        let end = offset.checked_add(length).ok_or("COOKIE_LENGTH_OVERFLOW")?;
        let page = bytes.get(offset..end).ok_or("COOKIE_FILE_TRUNCATED")?;
        if page.get(..4) != Some(&[0, 0, 1, 0]) {
            return Err("COOKIE_PAGE_FORMAT_UNKNOWN");
        }
        let records = u32_at(page, 4, false)? as usize;
        source_count = source_count
            .checked_add(records)
            .ok_or("COOKIE_COUNT_LIMIT")?;
        if source_count > 10_000 {
            return Err("COOKIE_COUNT_LIMIT");
        }
        let header_end = 12usize
            .checked_add(records.checked_mul(4).ok_or("COOKIE_LENGTH_OVERFLOW")?)
            .ok_or("COOKIE_LENGTH_OVERFLOW")?;
        if header_end > page.len() {
            return Err("COOKIE_FILE_TRUNCATED");
        }
        for index in 0..records {
            let result = (|| {
                let at = u32_at(page, 8 + index * 4, false)? as usize;
                let size = u32_at(page, at, false)? as usize;
                if at < header_end || size < 56 {
                    return Err("COOKIE_RECORD_INVALID");
                }
                let record = page
                    .get(at..at.checked_add(size).ok_or("COOKIE_LENGTH_OVERFLOW")?)
                    .ok_or("COOKIE_RECORD_INVALID")?;
                decode_record(record, now_unix_ms)
            })();
            match result {
                Ok((cookie, creation, has_comment, flags)) => {
                    if has_comment {
                        reasons.insert("COOKIE_COMMENT_ATTRIBUTES_SKIPPED");
                    }
                    if flags & !5 != 0 {
                        reasons.insert("COOKIE_UNKNOWN_FLAGS");
                    }
                    let key = (
                        cookie.domain.clone(),
                        cookie.path.clone(),
                        cookie
                            .name
                            .decoded_bytes()
                            .map_err(|_| "COOKIE_VALUE_UNREPRESENTABLE")?,
                    );
                    match cookies.get(&key) {
                        Some((_, prior_creation)) if *prior_creation >= creation => {
                            skipped += 1;
                            reasons.insert("COOKIE_DUPLICATE_SKIPPED");
                        }
                        previous => {
                            if previous.is_some() {
                                skipped += 1;
                                reasons.insert("COOKIE_DUPLICATE_SKIPPED");
                            }
                            cookies.insert(key, (cookie, creation));
                        }
                    }
                }
                Err(code) => {
                    skipped += 1;
                    reasons.insert(code);
                }
            }
        }
        offset = end;
    }
    if bytes.len() != offset {
        reasons.insert("COOKIE_FOOTER_ATTRIBUTES_UNPROVEN");
    }
    if source_count == 0 {
        reasons.insert("COOKIE_INVENTORY_EMPTY_UNPROVEN");
    }
    Ok(CookieCapture {
        cookies: cookies.into_values().map(|(cookie, _)| cookie).collect(),
        skipped,
        reasons,
    })
}

#[cfg(any(test, feature = "session-migration-diagnostics"))]
pub(crate) fn inspect(bytes: &[u8], now_unix_ms: i64) -> Result<CookieInspection> {
    let count = super::windows::binary_cookie_count(bytes)?;
    let mut result = CookieInspection {
        count,
        expired: 0,
        flags: BTreeSet::new(),
        errors: BTreeSet::new(),
    };
    let pages = u32_at(bytes, 4, true)? as usize;
    let mut offset = 8 + pages * 4;
    for page_index in 0..pages {
        let length = u32_at(bytes, 8 + page_index * 4, true)? as usize;
        let page = bytes
            .get(offset..offset + length)
            .ok_or("COOKIE_FILE_TRUNCATED")?;
        let records = u32_at(page, 4, false)? as usize;
        for index in 0..records {
            let at = u32_at(page, 8 + index * 4, false)? as usize;
            let flags = u32_at(page, at + 8, false)?;
            result.flags.insert(flags);
            if flags & !5 != 0 {
                result.errors.insert("COOKIE_UNKNOWN_FLAGS");
            }
            let expiry = f64::from_le_bytes(
                page.get(at + 40..at + 48)
                    .ok_or("COOKIE_RECORD_INVALID")?
                    .try_into()
                    .map_err(|_| "COOKIE_RECORD_INVALID")?,
            );
            if !expiry.is_finite() {
                return Err("COOKIE_EXPIRY_INVALID");
            }
            if (expiry + 978_307_200.0) * 1000.0 <= now_unix_ms as f64 {
                result.expired += 1;
            }
            // Validate all four byte fields; values never leave this reader.
            for field in [16, 20, 24, 28] {
                let start = at + u32_at(page, at + field, false)? as usize;
                let record_end = at + u32_at(page, at, false)? as usize;
                let value = page.get(start..record_end).ok_or("COOKIE_STRING_INVALID")?;
                let end = value
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or("COOKIE_STRING_INVALID")?;
                if std::str::from_utf8(&value[..end]).is_err() {
                    result.errors.insert("COOKIE_STRING_ENCODING_UNPROVEN");
                }
            }
        }
        offset += length;
    }
    // Explicit gaps, not guessed attributes. A future format whitelist must
    // prove these independently with native known-answer persisted fixtures.
    result.errors.extend([
        "COOKIE_HOST_ONLY_EVIDENCE_UNPROVEN",
        "COOKIE_SAMESITE_SEMANTICS_UNPROVEN",
        "COOKIE_PARTITION_EVIDENCE_UNPROVEN",
        "COOKIE_SESSION_COMPLETENESS_UNPROVEN",
    ]);
    if bytes.len() != offset {
        result.errors.insert("COOKIE_FOOTER_ATTRIBUTES_UNPROVEN");
    }
    if count == 0 {
        result.errors.insert("COOKIE_INVENTORY_EMPTY_UNPROVEN");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(flags: u32, expiry: f64) -> Vec<u8> {
        let mut record = vec![0u8; 56];
        for (field, text) in [
            (16, ".example.invalid"),
            (20, "sid"),
            (24, "/secure"),
            (28, "known-answer"),
        ] {
            let start = record.len() as u32;
            record[field..field + 4].copy_from_slice(&start.to_le_bytes());
            record.extend(text.as_bytes());
            record.push(0);
        }
        let size = record.len() as u32;
        record[..4].copy_from_slice(&size.to_le_bytes());
        record[8..12].copy_from_slice(&flags.to_le_bytes());
        record[40..48].copy_from_slice(&expiry.to_le_bytes());
        let mut page = vec![0, 0, 1, 0];
        page.extend(1u32.to_le_bytes());
        page.extend(16u32.to_le_bytes());
        page.extend(0u32.to_le_bytes());
        page.extend(record);
        let mut file = b"cook".to_vec();
        file.extend(1u32.to_be_bytes());
        file.extend((page.len() as u32).to_be_bytes());
        file.extend(page);
        file
    }
    #[test]
    fn best_effort_capture_preserves_supported_fields_and_labels_unknown_semantics() {
        let captured = capture(&fixture(5, 1_000_000_000.0), 1_900_000_000_000).unwrap();
        assert_eq!(captured.cookies.len(), 1);
        assert_eq!(captured.skipped, 0);
        let cookie = &captured.cookies[0];
        assert_eq!(cookie.name.decoded_bytes().unwrap(), b"sid");
        assert_eq!(cookie.value.decoded_bytes().unwrap(), b"known-answer");
        assert_eq!(cookie.domain, "example.invalid");
        assert_eq!(cookie.path, "/secure");
        assert!(!cookie.host_only);
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert_eq!(cookie.same_site, SameSite::Unspecified);
        assert_eq!(cookie.partition, Partition::Unpartitioned);
        for reason in [
            "COOKIE_RAW_SOURCE_BEST_EFFORT",
            "COOKIE_HOST_ONLY_INFERRED",
            "COOKIE_SAMESITE_DEFAULTED_UNSPECIFIED",
            "COOKIE_PARTITION_EVIDENCE_UNPROVEN",
        ] {
            assert!(captured.reasons.contains(reason));
        }
    }

    #[test]
    fn best_effort_capture_skips_an_expired_record_without_rejecting_the_file() {
        let captured = capture(&fixture(0, 1.0), 1_900_000_000_000).unwrap();
        assert!(captured.cookies.is_empty());
        assert_eq!(captured.skipped, 1);
        assert!(
            captured
                .reasons
                .contains("COOKIE_EXPIRED_BEFORE_VERIFICATION")
        );
    }
    #[test]
    fn binary_cookie_known_structure_never_invents_samesite_session_or_partition() {
        let bytes = fixture(5, 1_000_000_000.0);
        let inspected = inspect(&bytes, 1_900_000_000_000).unwrap();
        assert_eq!(inspected.count, 1);
        assert_eq!(inspected.expired, 0);
        assert_eq!(inspected.flags, BTreeSet::from([5]));
        for gap in [
            "COOKIE_SAMESITE_SEMANTICS_UNPROVEN",
            "COOKIE_SESSION_COMPLETENESS_UNPROVEN",
            "COOKIE_PARTITION_EVIDENCE_UNPROVEN",
            "COOKIE_HOST_ONLY_EVIDENCE_UNPROVEN",
        ] {
            assert!(inspected.errors.contains(gap));
        }
        assert_eq!(inspect(&bytes, 2_000_000_000_000).unwrap().expired, 1);
        assert!(
            inspect(&fixture(0x8000_0005, 1_000_000_000.0), 0)
                .unwrap()
                .errors
                .contains("COOKIE_UNKNOWN_FLAGS")
        );
    }
    #[test]
    fn corrupt_cookie_lengths_expiry_and_unknown_footer_fail_closed() {
        let bytes = fixture(5, 1_000_000_000.0);
        for end in 0..bytes.len() {
            assert!(inspect(&bytes[..end], 0).is_err(), "truncated at {end}");
        }
        assert_eq!(
            inspect(&fixture(5, f64::NAN), 0).unwrap_err(),
            "COOKIE_EXPIRY_INVALID"
        );
        let mut extended = bytes;
        extended.extend(b"unknown-attributes");
        assert!(
            inspect(&extended, 0)
                .unwrap()
                .errors
                .contains("COOKIE_FOOTER_ATTRIBUTES_UNPROVEN")
        );
        assert!(
            inspect(b"cook\0\0\0\0", 0)
                .unwrap()
                .errors
                .contains("COOKIE_INVENTORY_EMPTY_UNPROVEN")
        );
    }
}
