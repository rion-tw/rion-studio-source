//! Bounded decoder for the macOS 26 public export's observed version-1 format.
//! References and OS evidence are in docs/validation/session-migration-diagnostics.md.
use super::Result;
#[cfg(feature = "session-migration-diagnostics")]
use crate::session_transfer::{
    RoleSessionTransferBytesRecord as Bytes, RoleSessionTransferLocalStorageEntryRecord as Entry,
    RoleSessionTransferLocalStorageOriginRecord as Origin,
};
#[cfg(feature = "session-migration-diagnostics")]
use std::collections::BTreeSet;

pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    pub(crate) fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or("WEBKIT_LENGTH_OVERFLOW")?;
        let slice = self.bytes.get(self.offset..end).ok_or("WEBKIT_TRUNCATED")?;
        self.offset = end;
        Ok(slice)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub(crate) fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().map_err(|_| "WEBKIT_TRUNCATED")?,
        ))
    }
    #[cfg(feature = "session-migration-diagnostics")]
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| "WEBKIT_TRUNCATED")?,
        ))
    }
    pub(crate) fn string(&mut self) -> Result<Vec<u16>> {
        let length = self.u32()? as usize;
        if length > 1024 * 1024 {
            return Err("WEBKIT_STRING_LIMIT");
        }
        match self.u8()? {
            1 => Ok(self.take(length)?.iter().map(|v| u16::from(*v)).collect()),
            0 => Ok(self
                .take(length * 2)?
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect()),
            _ => Err("WEBKIT_STRING_ENCODING_UNKNOWN"),
        }
    }
    fn origin(&mut self) -> Result<String> {
        let scheme = String::from_utf16(&self.string()?).map_err(|_| "WEBKIT_ORIGIN_INVALID")?;
        let host = String::from_utf16(&self.string()?).map_err(|_| "WEBKIT_ORIGIN_INVALID")?;
        let port = match self.u8()? {
            0 => None,
            1 => Some(u16::from_le_bytes(
                self.take(2)?.try_into().map_err(|_| "WEBKIT_TRUNCATED")?,
            )),
            _ => return Err("WEBKIT_PORT_ENCODING_UNKNOWN"),
        };
        let text = format!(
            "{scheme}://{host}{}",
            port.map(|p| format!(":{p}")).unwrap_or_default()
        );
        let url = url::Url::parse(&text).map_err(|_| "WEBKIT_ORIGIN_INVALID")?;
        if !["http", "https"].contains(&scheme.as_str())
            || url.origin().ascii_serialization() != text
        {
            return Err("WEBKIT_ORIGIN_INVALID");
        }
        Ok(text)
    }
    pub(crate) fn client_origin(&mut self) -> Result<String> {
        let top = self.origin()?;
        let client = self.origin()?;
        if top != client {
            return Err("WEBKIT_PARTITIONED_LOCAL_STORAGE_UNSUPPORTED");
        }
        Ok(client)
    }
    pub(crate) fn finish(&self) -> Result<()> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err("WEBKIT_TRAILING_DATA")
        }
    }
}

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn decode_export(bytes: &[u8]) -> Result<Vec<Origin>> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("WEBKIT_EXPORT_LIMIT");
    }
    let mut reader = Cursor::new(bytes);
    if reader.u32()? != 1 || reader.u64()? != 1 || reader.u64()? != 32 {
        return Err("WEBKIT_EXPORT_FORMAT_UNSUPPORTED");
    }
    let count = reader.u64()?;
    if count > 4096 {
        return Err("WEBKIT_ORIGIN_LIMIT");
    }
    let mut origins = BTreeSet::new();
    let mut output = Vec::new();
    let mut total = 0_u64;
    for _ in 0..count {
        let origin = reader.client_origin()?;
        if !origins.insert(origin.clone()) {
            return Err("WEBKIT_DUPLICATE_ORIGIN");
        }
        let count = reader.u64()?;
        total = total.checked_add(count).ok_or("WEBKIT_ENTRY_LIMIT")?;
        if total > 100_000 {
            return Err("WEBKIT_ENTRY_LIMIT");
        }
        let mut keys = BTreeSet::new();
        let mut entries = Vec::new();
        for _ in 0..count {
            let key = reader.string()?;
            if !keys.insert(key.clone()) {
                return Err("WEBKIT_DUPLICATE_KEY");
            }
            entries.push(Entry {
                key: Bytes::from_utf16_le_code_units(&key),
                value: Bytes::from_utf16_le_code_units(&reader.string()?),
            });
        }
        output.push(Origin { origin, entries });
    }
    reader.finish()?;
    output.sort_by(|a, b| a.origin.cmp(&b.origin));
    Ok(output)
}

/// macOS hashed origin files use the same pair of security origins. Unsupported
/// layouts (including checksums/version prefixes) fail rather than guessing.
pub(crate) fn decode_origin(bytes: &[u8]) -> Result<String> {
    let mut cursor = Cursor::new(bytes);
    let origin = cursor.client_origin()?;
    cursor.finish()?;
    Ok(origin)
}
