//! Bounded CRX3 verification. No executable bytes are extracted before verification.
use ring::signature;
use sha2::{Digest, Sha256};

use super::{Result, failure};

pub(crate) struct VerifiedCrx<'a> {
    pub key: &'a [u8],
    pub archive: &'a [u8],
}

fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let byte = *bytes
            .get(*offset)
            .ok_or_else(|| failure("Invalid CRX header"))?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err(failure("Invalid CRX varint"));
        }
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(failure("Invalid CRX varint"))
}

fn fields(bytes: &[u8]) -> Result<Vec<(u64, &[u8])>> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = varint(bytes, &mut offset)?;
        if tag & 7 != 2 {
            return Err(failure("Unsupported CRX header field"));
        }
        let len = usize::try_from(varint(bytes, &mut offset)?)
            .map_err(|_| failure("CRX length overflow"))?;
        let end = offset
            .checked_add(len)
            .ok_or_else(|| failure("CRX length overflow"))?;
        let value = bytes
            .get(offset..end)
            .ok_or_else(|| failure("Truncated CRX header"))?;
        result.push((tag >> 3, value));
        offset = end;
    }
    Ok(result)
}

pub(crate) fn extension_id(key: &[u8]) -> String {
    Sha256::digest(key)[..16]
        .iter()
        .flat_map(|b| [b >> 4, b & 15])
        .map(|n| char::from(b'a' + n))
        .collect()
}

// DER SPKI wraps the PKCS#1 RSA public key expected by ring.
fn der_value<'a>(bytes: &'a [u8], offset: &mut usize, tag: u8) -> Result<&'a [u8]> {
    if bytes.get(*offset) != Some(&tag) {
        return Err(failure("Invalid signing key"));
    }
    *offset += 1;
    let first = *bytes
        .get(*offset)
        .ok_or_else(|| failure("Invalid signing key"))?;
    *offset += 1;
    let mut len = usize::from(first);
    if first & 128 != 0 {
        let count = usize::from(first & 127);
        if count == 0 || count > 4 {
            return Err(failure("Invalid signing key length"));
        }
        len = 0;
        for _ in 0..count {
            len = (len << 8)
                | usize::from(
                    *bytes
                        .get(*offset)
                        .ok_or_else(|| failure("Invalid signing key"))?,
                );
            *offset += 1;
        }
    }
    let end = offset
        .checked_add(len)
        .ok_or_else(|| failure("Invalid signing key length"))?;
    let value = bytes
        .get(*offset..end)
        .ok_or_else(|| failure("Invalid signing key length"))?;
    *offset = end;
    Ok(value)
}

pub(crate) fn verify<'a>(bytes: &'a [u8], expected_id: &str) -> Result<VerifiedCrx<'a>> {
    if bytes.len() < 12 || &bytes[..4] != b"Cr24" || bytes[4..8] != 3_u32.to_le_bytes() {
        return Err(failure("Only signed CRX3 packages are accepted"));
    }
    let size = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if size > 1024 * 1024 {
        return Err(failure("CRX header too large"));
    }
    let header = fields(
        bytes
            .get(12..12 + size)
            .ok_or_else(|| failure("Truncated CRX"))?,
    )?;
    let archive = bytes
        .get(12 + size..)
        .ok_or_else(|| failure("Truncated CRX"))?;
    let signed = header
        .iter()
        .filter(|(n, _)| *n == 10000)
        .collect::<Vec<_>>();
    if signed.len() != 1 {
        return Err(failure("Invalid CRX signed header"));
    }
    let signed = signed[0].1;
    let ids = fields(signed)?;
    if ids.len() != 1 || ids[0].0 != 1 || ids[0].1.len() != 16 {
        return Err(failure("Invalid CRX identity"));
    }
    let id: String = ids[0]
        .1
        .iter()
        .flat_map(|b| [b >> 4, b & 15])
        .map(|n| char::from(b'a' + n))
        .collect();
    if id != expected_id {
        return Err(failure("Store and CRX IDs differ"));
    }
    let mut message = b"CRX3 SignedData\0".to_vec();
    message.extend_from_slice(&(signed.len() as u32).to_le_bytes());
    message.extend_from_slice(signed);
    message.extend_from_slice(archive);
    for (kind, proof) in &header {
        if *kind != 2 {
            continue;
        }
        let proof = fields(proof)?;
        let key = proof.iter().find(|(n, _)| *n == 1).map(|(_, v)| *v);
        let sig = proof.iter().find(|(n, _)| *n == 2).map(|(_, v)| *v);
        let (Some(key), Some(sig)) = (key, sig) else {
            continue;
        };
        if extension_id(key) != expected_id {
            continue;
        }
        let sequence = der_value(key, &mut 0, 0x30)?;
        let mut cursor = 0;
        der_value(sequence, &mut cursor, 0x30)?;
        let bit_string = der_value(sequence, &mut cursor, 0x03)?;
        if bit_string.first() != Some(&0) {
            return Err(failure("Invalid RSA key"));
        }
        signature::UnparsedPublicKey::new(&signature::RSA_PKCS1_2048_8192_SHA256, &bit_string[1..])
            .verify(&message, sig)
            .map_err(|_| failure("Invalid CRX signature"))?;
        return Ok(VerifiedCrx { key, archive });
    }
    Err(failure("No matching RSA CRX signature"))
}
