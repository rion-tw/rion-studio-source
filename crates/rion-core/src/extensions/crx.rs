//! Bounded CRX3 verification. No executable bytes are extracted before verification.

use ring::signature;
use sha2::{Digest, Sha256};

use super::{ExtensionPackageError, error::Result};

const MAX_HEADER_SIZE: usize = 1024 * 1024;
// Chromium's production Chrome Web Store publisher SPKI hash for required CRX3 proofs.
const PRODUCTION_PUBLISHER_KEY_HASH: [u8; 32] = [
    0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe, 0x24, 0x97, 0xcc, 0x9b, 0x04,
    0x25, 0x4c, 0x65, 0x8f, 0x79, 0xf2, 0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf,
];
const RSA_ALGORITHM_IDENTIFIER: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];
const P256_ALGORITHM_IDENTIFIER: &[u8] = &[
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
    0x03, 0x01, 0x07,
];

#[derive(Debug)]
pub(crate) struct VerifiedCrx<'a> {
    pub key: &'a [u8],
    pub archive: &'a [u8],
}

#[derive(Clone, Copy)]
enum ProofKind {
    Rsa,
    Ecdsa,
}

struct Proof<'a> {
    kind: ProofKind,
    key: &'a [u8],
    signature: &'a [u8],
    developer: bool,
    publisher: bool,
}

fn invalid<T>() -> Result<T> {
    Err(ExtensionPackageError::SignatureInvalid)
}

fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let Some(byte) = bytes.get(*offset).copied() else {
            return invalid();
        };
        *offset += 1;
        if shift == 63 && byte > 1 {
            return invalid();
        }
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    invalid()
}

fn fields(bytes: &[u8]) -> Result<Vec<(u64, &[u8])>> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = varint(bytes, &mut offset)?;
        if tag == 0 || tag & 7 != 2 {
            return invalid();
        }
        let len = usize::try_from(varint(bytes, &mut offset)?)
            .map_err(|_| ExtensionPackageError::SignatureInvalid)?;
        let end = offset
            .checked_add(len)
            .ok_or(ExtensionPackageError::SignatureInvalid)?;
        let Some(value) = bytes.get(offset..end) else {
            return invalid();
        };
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

fn der_value<'a>(bytes: &'a [u8], offset: &mut usize, tag: u8) -> Result<&'a [u8]> {
    if bytes.get(*offset) != Some(&tag) {
        return invalid();
    }
    *offset += 1;
    let Some(first) = bytes.get(*offset).copied() else {
        return invalid();
    };
    *offset += 1;
    let mut len = usize::from(first);
    if first & 128 != 0 {
        let count = usize::from(first & 127);
        if count == 0 || count > std::mem::size_of::<usize>() {
            return invalid();
        }
        len = 0;
        for index in 0..count {
            let Some(byte) = bytes.get(*offset).copied() else {
                return invalid();
            };
            if index == 0 && byte == 0 {
                return invalid();
            }
            len = len
                .checked_shl(8)
                .and_then(|value| value.checked_add(usize::from(byte)))
                .ok_or(ExtensionPackageError::SignatureInvalid)?;
            *offset += 1;
        }
        if len < 128 {
            return invalid();
        }
    }
    let end = offset
        .checked_add(len)
        .ok_or(ExtensionPackageError::SignatureInvalid)?;
    let Some(value) = bytes.get(*offset..end) else {
        return invalid();
    };
    *offset = end;
    Ok(value)
}

// Ring accepts the key material contained by the SPKI bit string, so validate the
// complete algorithm identifier before returning that material.
fn spki_key(bytes: &[u8], kind: ProofKind) -> Result<&[u8]> {
    let mut outer_offset = 0;
    let sequence = der_value(bytes, &mut outer_offset, 0x30)?;
    if outer_offset != bytes.len() {
        return invalid();
    }
    let mut sequence_offset = 0;
    let algorithm = der_value(sequence, &mut sequence_offset, 0x30)?;
    let expected = match kind {
        ProofKind::Rsa => RSA_ALGORITHM_IDENTIFIER,
        ProofKind::Ecdsa => P256_ALGORITHM_IDENTIFIER,
    };
    if algorithm != expected {
        return invalid();
    }
    let bit_string = der_value(sequence, &mut sequence_offset, 0x03)?;
    if sequence_offset != sequence.len() || bit_string.first() != Some(&0) {
        return invalid();
    }
    bit_string
        .get(1..)
        .ok_or(ExtensionPackageError::SignatureInvalid)
}

fn proof(bytes: &[u8], kind: ProofKind) -> Result<(&[u8], &[u8])> {
    let fields = fields(bytes)?;
    let keys = fields
        .iter()
        .filter(|(number, _)| *number == 1)
        .collect::<Vec<_>>();
    let signatures = fields
        .iter()
        .filter(|(number, _)| *number == 2)
        .collect::<Vec<_>>();
    if fields.len() != 2 || keys.len() != 1 || signatures.len() != 1 {
        return invalid();
    }
    let key = keys[0].1;
    let signature = signatures[0].1;
    if key.is_empty() || signature.is_empty() {
        return invalid();
    }
    spki_key(key, kind)?;
    Ok((key, signature))
}

pub(crate) fn verify<'a>(bytes: &'a [u8], expected_id: &str) -> Result<VerifiedCrx<'a>> {
    verify_with_publisher_key_hash(bytes, expected_id, PRODUCTION_PUBLISHER_KEY_HASH)
}

fn verify_with_publisher_key_hash_impl<'a>(
    bytes: &'a [u8],
    expected_id: &str,
    publisher_key_hash: [u8; 32],
) -> Result<VerifiedCrx<'a>> {
    if bytes.len() < 12 || &bytes[..4] != b"Cr24" || bytes[4..8] != 3_u32.to_le_bytes() {
        return invalid();
    }
    let size = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| ExtensionPackageError::SignatureInvalid)?,
    ) as usize;
    if size > MAX_HEADER_SIZE {
        return invalid();
    }
    let header_end = 12_usize
        .checked_add(size)
        .ok_or(ExtensionPackageError::SignatureInvalid)?;
    let header = fields(
        bytes
            .get(12..header_end)
            .ok_or(ExtensionPackageError::SignatureInvalid)?,
    )?;
    let archive = bytes
        .get(header_end..)
        .ok_or(ExtensionPackageError::SignatureInvalid)?;
    if archive.is_empty() {
        return invalid();
    }

    let signed_headers = header
        .iter()
        .filter(|(number, _)| *number == 10000)
        .collect::<Vec<_>>();
    if signed_headers.len() != 1 {
        return invalid();
    }
    let signed_header = signed_headers[0].1;
    let signed_fields = fields(signed_header)?;
    if signed_fields.len() != 1 || signed_fields[0].0 != 1 || signed_fields[0].1.len() != 16 {
        return invalid();
    }
    let signed_id: String = signed_fields[0]
        .1
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 15])
        .map(|nibble| char::from(b'a' + nibble))
        .collect();
    if signed_id != expected_id {
        return invalid();
    }

    let mut proofs = Vec::new();
    for (field, encoded_proof) in &header {
        let kind = match *field {
            2 => ProofKind::Rsa,
            3 => ProofKind::Ecdsa,
            _ => continue,
        };
        let (key, signature) = proof(encoded_proof, kind)?;
        proofs.push(Proof {
            kind,
            key,
            signature,
            developer: extension_id(key) == signed_id,
            publisher: Sha256::digest(key).as_slice() == publisher_key_hash,
        });
    }
    let developer_keys = proofs
        .iter()
        .filter(|proof| proof.developer)
        .map(|proof| proof.key)
        .collect::<Vec<_>>();
    if developer_keys.len() != 1 || !proofs.iter().any(|proof| proof.publisher) {
        return invalid();
    }

    let mut message = b"CRX3 SignedData\0".to_vec();
    message.extend_from_slice(
        &u32::try_from(signed_header.len())
            .map_err(|_| ExtensionPackageError::SignatureInvalid)?
            .to_le_bytes(),
    );
    message.extend_from_slice(signed_header);
    message.extend_from_slice(archive);

    for proof in &proofs {
        let key = spki_key(proof.key, proof.kind)?;
        let verified = match proof.kind {
            ProofKind::Rsa => {
                let normal =
                    signature::UnparsedPublicKey::new(&signature::RSA_PKCS1_2048_8192_SHA256, key)
                        .verify(&message, proof.signature)
                        .is_ok();
                normal
                    || (proof.developer
                        && signature::UnparsedPublicKey::new(
                            &signature::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
                            key,
                        )
                        .verify(&message, proof.signature)
                        .is_ok())
            }
            ProofKind::Ecdsa => {
                signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, key)
                    .verify(&message, proof.signature)
                    .is_ok()
            }
        };
        if !verified {
            return invalid();
        }
    }

    Ok(VerifiedCrx {
        key: developer_keys[0],
        archive,
    })
}

#[cfg(test)]
pub(super) fn verify_with_publisher_key_hash<'a>(
    bytes: &'a [u8],
    expected_id: &str,
    publisher_key_hash: [u8; 32],
) -> Result<VerifiedCrx<'a>> {
    verify_with_publisher_key_hash_impl(bytes, expected_id, publisher_key_hash)
}

#[cfg(not(test))]
fn verify_with_publisher_key_hash<'a>(
    bytes: &'a [u8],
    expected_id: &str,
    publisher_key_hash: [u8; 32],
) -> Result<VerifiedCrx<'a>> {
    verify_with_publisher_key_hash_impl(bytes, expected_id, publisher_key_hash)
}
