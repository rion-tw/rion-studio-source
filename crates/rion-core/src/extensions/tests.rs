use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::{Cursor, Write};

fn field(number: u64, value: &[u8]) -> Vec<u8> {
    fn varint(mut n: u64, out: &mut Vec<u8>) {
        while n > 127 {
            out.push((n as u8 & 127) | 128);
            n >>= 7;
        }
        out.push(n as u8);
    }
    let mut out = Vec::new();
    varint((number << 3) | 2, &mut out);
    varint(value.len() as u64, &mut out);
    out.extend(value);
    out
}

fn signed_package(name: &str, data: &[u8]) -> (String, Vec<u8>) {
    use sha2::{Digest, Sha256};
    let keys: serde_json::Value =
        serde_json::from_str(include_str!("test-signing-key.json")).unwrap();
    let public = STANDARD
        .decode(keys["publicKey"].as_str().unwrap())
        .unwrap();
    let private = STANDARD
        .decode(keys["privateKey"].as_str().unwrap())
        .unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(data).unwrap();
    let zip = zip.finish().unwrap().into_inner();
    let signed = field(1, &Sha256::digest(&public)[..16]);
    let mut message = b"CRX3 SignedData\0".to_vec();
    message.extend((signed.len() as u32).to_le_bytes());
    message.extend(&signed);
    message.extend(&zip);
    let key = ring::signature::RsaKeyPair::from_pkcs8(&private).unwrap();
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        &message,
        &mut signature,
    )
    .unwrap();
    let mut proof = field(1, &public);
    proof.extend(field(2, &signature));
    let mut header = field(2, &proof);
    header.extend(field(10000, &signed));
    let mut crx = b"Cr24".to_vec();
    crx.extend(3_u32.to_le_bytes());
    crx.extend((header.len() as u32).to_le_bytes());
    crx.extend(header);
    crx.extend(zip);
    (crx::extension_id(&public), crx)
}

#[test]
fn signed_manifest_retains_store_identity() {
    let (id, bytes) = signed_package(
        "manifest.json",
        br#"{"manifest_version":3,"name":"Fixture","version":"1.0"}"#,
    );
    let root = tempfile::tempdir().unwrap();
    let (manifest, hash) = package::unpack(&bytes, &id, root.path()).unwrap();
    assert_eq!(
        crx::extension_id(&STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap()),
        id
    );
    assert_eq!(hash.len(), 64);
}

#[test]
fn modified_package_and_wrong_identity_are_rejected() {
    let (id, mut bytes) = signed_package("manifest.json", b"{}");
    assert!(crx::verify(&bytes, &"a".repeat(32)).is_err());
    *bytes.last_mut().unwrap() ^= 1;
    assert!(crx::verify(&bytes, &id).is_err());
    for length in 0..12 {
        assert!(crx::verify(&bytes[..length], &id).is_err());
    }
}

#[test]
fn package_paths_are_safe_on_both_native_platforms() {
    for name in [
        "../escape",
        "C:/escape",
        "a\\escape",
        "CON.txt",
        "a/../escape",
        "a./file",
        "a /file",
        "/escape",
    ] {
        let (id, bytes) = signed_package(name, b"bad");
        let root = tempfile::tempdir().unwrap();
        assert!(package::unpack(&bytes, &id, root.path()).is_err(), "{name}");
    }
}

#[test]
#[ignore = "External Chrome Web Store liveness boundary; run explicitly on a native host"]
fn live_store_download_and_signature() {
    let id = "ddkjiahejlhfcafbddmgiahcphecmpfh";
    let bytes = package::download(id, &AtomicBool::new(false)).unwrap();
    let root = tempfile::tempdir().unwrap();
    let (manifest, _) = package::unpack(&bytes, id, root.path()).unwrap();
    assert_eq!(manifest["manifest_version"], 3);
}
