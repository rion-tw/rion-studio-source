use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, RSA_PKCS1_SHA256, RsaKeyPair},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    sync::atomic::AtomicBool,
};

struct SignedPackage {
    id: String,
    bytes: Vec<u8>,
    developer_key: Vec<u8>,
    publisher_hash: [u8; 32],
}

const LEGACY_MANIFEST: &[u8] = br#"{"manifest_version":3,"name":"Legacy fixture","version":"1.0"}"#;

#[derive(Clone, Copy, Default)]
struct PackageOptions {
    legacy_developer: bool,
    include_publisher: bool,
    corrupt_publisher: bool,
    include_corrupt_extra_rsa: bool,
}

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

fn proof(public_key: &[u8], signature: &[u8]) -> Vec<u8> {
    let mut proof = field(1, public_key);
    proof.extend(field(2, signature));
    proof
}

fn rsa_signature(private_key: &[u8], message: &[u8]) -> Vec<u8> {
    let key = RsaKeyPair::from_pkcs8(private_key).unwrap();
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        message,
        &mut signature,
    )
    .unwrap();
    signature
}

fn signed_package(name: &str, data: &[u8], options: PackageOptions) -> SignedPackage {
    signed_package_entries(&[(name, data)], options)
}

fn signed_package_entries(entries: &[(&str, &[u8])], options: PackageOptions) -> SignedPackage {
    let keys: serde_json::Value =
        serde_json::from_str(include_str!("test-signing-key.json")).unwrap();
    let key = |name: &str| STANDARD.decode(keys[name].as_str().unwrap()).unwrap();
    let developer_key_name = if options.legacy_developer {
        "legacyPublicKey"
    } else {
        "publicKey"
    };
    let developer_private_name = if options.legacy_developer {
        "legacyPrivateKey"
    } else {
        "privateKey"
    };
    let developer_key = key(developer_key_name);
    let developer_private = key(developer_private_name);
    let publisher_key = key("publisherPublicKey");
    let publisher_private = key("publisherPrivateKey");

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        // CRX signatures cover the byte-exact ZIP archive. Pin the creator
        // system so this fixture is identical on macOS and Windows.
        zip.start_file(
            *name,
            zip::write::SimpleFileOptions::default().system(zip::System::Unix),
        )
        .unwrap();
        zip.write_all(data).unwrap();
    }
    let archive = zip.finish().unwrap().into_inner();

    let signed_header = field(1, &Sha256::digest(&developer_key)[..16]);
    let mut message = b"CRX3 SignedData\0".to_vec();
    message.extend((signed_header.len() as u32).to_le_bytes());
    message.extend(&signed_header);
    message.extend(&archive);

    let developer_signature = if options.legacy_developer {
        assert_eq!(entries, &[("manifest.json", LEGACY_MANIFEST)]);
        key("legacySignature")
    } else {
        rsa_signature(&developer_private, &message)
    };
    let mut header = field(2, &proof(&developer_key, &developer_signature));
    if options.include_corrupt_extra_rsa {
        let extra_key = key("publicKey");
        let corrupt_signature = vec![
            0;
            RsaKeyPair::from_pkcs8(&key("privateKey"))
                .unwrap()
                .public()
                .modulus_len()
        ];
        header.extend(field(2, &proof(&extra_key, &corrupt_signature)));
    }
    if options.include_publisher {
        let random = SystemRandom::new();
        let publisher_pair =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &publisher_private, &random)
                .unwrap();
        let mut publisher_signature = publisher_pair
            .sign(&random, &message)
            .unwrap()
            .as_ref()
            .to_vec();
        if options.corrupt_publisher {
            publisher_signature[0] ^= 1;
        }
        header.extend(field(3, &proof(&publisher_key, &publisher_signature)));
    }
    header.extend(field(10000, &signed_header));

    let mut bytes = b"Cr24".to_vec();
    bytes.extend(3_u32.to_le_bytes());
    bytes.extend((header.len() as u32).to_le_bytes());
    bytes.extend(header);
    bytes.extend(archive);
    SignedPackage {
        id: crx::extension_id(&developer_key),
        bytes,
        developer_key,
        publisher_hash: Sha256::digest(publisher_key).into(),
    }
}

fn valid_options() -> PackageOptions {
    PackageOptions {
        include_publisher: true,
        ..PackageOptions::default()
    }
}

fn unpack_fixture(
    fixture: &SignedPackage,
    destination: &std::path::Path,
    cancelled: &AtomicBool,
    maximum_unpacked: u64,
) -> error::Result<(serde_json::Value, String, package::PackageDisplayMetadata)> {
    package::unpack_with_test_publisher(
        &fixture.bytes,
        &fixture.id,
        destination,
        cancelled,
        fixture.publisher_hash,
        maximum_unpacked,
    )
}

#[test]
fn dual_proof_2048_package_retains_store_identity() {
    let fixture = signed_package(
        "manifest.json",
        br#"{"manifest_version":3,"name":"Fixture","version":"1.0"}"#,
        valid_options(),
    );
    let root = tempfile::tempdir().unwrap();
    let (manifest, hash, metadata) = unpack_fixture(
        &fixture,
        root.path(),
        &AtomicBool::new(false),
        package::MAX_UNPACKED,
    )
    .unwrap();
    let manifest_key = STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
    assert_eq!(manifest_key, fixture.developer_key);
    assert_eq!(crx::extension_id(&manifest_key), fixture.id);
    assert_eq!(hash.len(), 64);
    assert!(metadata.size_bytes > 0);
}

#[test]
fn package_metadata_resolves_default_locale_prefers_48px_icon_and_measures_files() {
    let manifest = br#"{"manifest_version":3,"name":"__MSG_extensionName__","description":"__MSG_extensionDescription__","default_locale":"en","version":"1.0","icons":{"16":"icons/icon16.png","48":"icons/icon48.png","128":"icons/icon128.png"}}"#;
    let messages = br#"{"extensionName":{"message":"Localized fixture"},"extensionDescription":{"message":"Localized description"}}"#;
    let icon16 = b"small";
    let icon48 = b"preferred";
    let icon128 = b"large";
    let fixture = signed_package_entries(
        &[
            ("manifest.json", manifest),
            ("_locales/en/messages.json", messages),
            ("icons/icon16.png", icon16),
            ("icons/icon48.png", icon48),
            ("icons/icon128.png", icon128),
        ],
        valid_options(),
    );
    let root = tempfile::tempdir().unwrap();
    let (unpacked_manifest, _, metadata) = unpack_fixture(
        &fixture,
        root.path(),
        &AtomicBool::new(false),
        package::MAX_UNPACKED,
    )
    .unwrap();
    assert_eq!(
        package::display_name(&unpacked_manifest, root.path(), &fixture.id),
        "Localized fixture"
    );
    assert_eq!(metadata.description, "Localized description");
    let expected_icon = format!("data:image/png;base64,{}", STANDARD.encode(icon48));
    assert_eq!(
        metadata.icon_data_url.as_deref(),
        Some(expected_icon.as_str())
    );
    let expected_size: u64 = [
        "manifest.json",
        "_locales/en/messages.json",
        "icons/icon16.png",
        "icons/icon48.png",
        "icons/icon128.png",
    ]
    .iter()
    .map(|path| fs::metadata(root.path().join(path)).unwrap().len())
    .sum();
    assert_eq!(metadata.size_bytes, expected_size);
}

#[test]
fn package_metadata_bounds_description_and_falls_back_to_a_safe_raster_icon() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("icons")).unwrap();
    fs::write(root.path().join("icons/icon.webp"), b"unsupported").unwrap();
    fs::write(root.path().join("icons/icon16.png"), b"fallback").unwrap();
    fs::write(
        root.path().join("icons/icon128.png"),
        vec![0; 512 * 1024 + 1],
    )
    .unwrap();
    let manifest = serde_json::json!({
        "manifest_version": 3,
        "name": "Fixture",
        "description": "x".repeat(450),
        "version": "1.0",
        "icons": {
            "16": "icons/icon16.png",
            "48": "../outside.png",
            "64": "icons/icon.webp",
            "128": "icons/icon128.png"
        }
    });
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let metadata = package::installed_metadata(root.path()).unwrap();
    assert_eq!(metadata.description.chars().count(), 400);
    let expected_icon = format!("data:image/png;base64,{}", STANDARD.encode(b"fallback"));
    assert_eq!(
        metadata.icon_data_url.as_deref(),
        Some(expected_icon.as_str())
    );
    fs::remove_file(root.path().join("icons/icon16.png")).unwrap();
    assert!(
        package::installed_metadata(root.path())
            .unwrap()
            .icon_data_url
            .is_none()
    );
}

#[test]
fn publisher_authorizes_matching_legacy_1024_developer_key() {
    let fixture = signed_package(
        "manifest.json",
        LEGACY_MANIFEST,
        PackageOptions {
            legacy_developer: true,
            ..valid_options()
        },
    );
    let verified =
        crx::verify_with_publisher_key_hash(&fixture.bytes, &fixture.id, fixture.publisher_hash)
            .unwrap();
    assert_eq!(verified.key, fixture.developer_key);
}

#[test]
fn missing_or_invalid_publisher_proof_is_rejected() {
    for options in [
        PackageOptions::default(),
        PackageOptions {
            legacy_developer: true,
            ..PackageOptions::default()
        },
        PackageOptions {
            corrupt_publisher: true,
            ..valid_options()
        },
    ] {
        let manifest = if options.legacy_developer {
            LEGACY_MANIFEST
        } else {
            b"{}"
        };
        let fixture = signed_package("manifest.json", manifest, options);
        let error = crx::verify_with_publisher_key_hash(
            &fixture.bytes,
            &fixture.id,
            fixture.publisher_hash,
        )
        .unwrap_err();
        assert_eq!(error.code(), "EXTENSIONS_SIGNATURE_INVALID");
    }
    let test_publisher = signed_package("manifest.json", b"{}", valid_options());
    assert!(crx::verify(&test_publisher.bytes, &test_publisher.id).is_err());
}

#[test]
fn wrong_identity_modified_archive_and_truncated_headers_are_rejected() {
    let fixture = signed_package("manifest.json", b"{}", valid_options());
    assert!(
        crx::verify_with_publisher_key_hash(
            &fixture.bytes,
            &"a".repeat(32),
            fixture.publisher_hash,
        )
        .is_err()
    );
    let mut modified = fixture.bytes.clone();
    *modified.last_mut().unwrap() ^= 1;
    assert!(
        crx::verify_with_publisher_key_hash(&modified, &fixture.id, fixture.publisher_hash)
            .is_err()
    );
    for length in 0..12 {
        assert!(
            crx::verify_with_publisher_key_hash(
                &fixture.bytes[..length],
                &fixture.id,
                fixture.publisher_hash,
            )
            .is_err()
        );
    }
}

#[test]
fn any_corrupt_additional_proof_rejects_the_package() {
    let fixture = signed_package(
        "manifest.json",
        LEGACY_MANIFEST,
        PackageOptions {
            legacy_developer: true,
            include_corrupt_extra_rsa: true,
            ..valid_options()
        },
    );
    assert!(
        crx::verify_with_publisher_key_hash(&fixture.bytes, &fixture.id, fixture.publisher_hash,)
            .is_err()
    );
}

#[test]
fn non_mv3_and_incomplete_manifests_are_classified_as_unsupported() {
    for manifest in [
        br#"{"manifest_version":2,"name":"Old","version":"1.0"}"#.as_slice(),
        br#"{"manifest_version":3,"name":"Incomplete"}"#.as_slice(),
    ] {
        let fixture = signed_package("manifest.json", manifest, valid_options());
        let root = tempfile::tempdir().unwrap();
        let error = unpack_fixture(
            &fixture,
            root.path(),
            &AtomicBool::new(false),
            package::MAX_UNPACKED,
        )
        .unwrap_err();
        assert_eq!(error.code(), "EXTENSIONS_MANIFEST_UNSUPPORTED");
    }
}

#[test]
fn unpack_limit_is_preflighted_before_any_file_is_written() {
    let manifest = br#"{"manifest_version":3,"name":"Fixture","version":"1.0"}"#;
    let fixture = signed_package("manifest.json", manifest, valid_options());
    for (maximum, accepted) in [
        (manifest.len() as u64, true),
        (manifest.len() as u64 - 1, false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let result = unpack_fixture(&fixture, root.path(), &AtomicBool::new(false), maximum);
        assert_eq!(result.is_ok(), accepted);
        if !accepted {
            assert_eq!(result.unwrap_err().code(), "EXTENSIONS_UNPACKED_TOO_LARGE");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
    assert_eq!(package::MAX_PACKAGE, 128 * 1024 * 1024);
    assert_eq!(package::MAX_UNPACKED, 512 * 1024 * 1024);
}

#[test]
fn compressed_limit_checks_declared_and_actual_bytes_at_the_boundary() {
    let cancelled = AtomicBool::new(false);
    let mut exact = Cursor::new(vec![0; 8]);
    assert_eq!(
        package::read_download(&mut exact, Some(8), &cancelled, 8)
            .unwrap()
            .len(),
        8
    );
    let mut declared_too_large = Cursor::new(vec![0; 1]);
    assert_eq!(
        package::read_download(&mut declared_too_large, Some(9), &cancelled, 8)
            .unwrap_err()
            .code(),
        "EXTENSIONS_PACKAGE_TOO_LARGE"
    );
    let mut actual_too_large = Cursor::new(vec![0; 9]);
    assert_eq!(
        package::read_download(&mut actual_too_large, None, &cancelled, 8)
            .unwrap_err()
            .code(),
        "EXTENSIONS_PACKAGE_TOO_LARGE"
    );
}

#[test]
fn zip_bomb_declared_total_is_rejected_before_extraction() {
    let bomb = vec![0; 1024 * 1024];
    let fixture = signed_package("payload.bin", &bomb, valid_options());
    let root = tempfile::tempdir().unwrap();
    let error = unpack_fixture(&fixture, root.path(), &AtomicBool::new(false), 1024).unwrap_err();
    assert_eq!(error.code(), "EXTENSIONS_UNPACKED_TOO_LARGE");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn cancellation_prevents_unpack_and_staging_is_temp_owned() {
    let fixture = signed_package(
        "manifest.json",
        br#"{"manifest_version":3,"name":"Fixture","version":"1.0"}"#,
        valid_options(),
    );
    let root = tempfile::tempdir().unwrap();
    let cancelled = AtomicBool::new(true);
    let error = match prepare_downloaded(
        root.path(),
        &fixture.id,
        "cancelled-operation",
        &cancelled,
        &fixture.bytes,
    ) {
        Err(error) => error,
        Ok(_) => panic!("cancelled package preparation succeeded"),
    };
    assert_eq!(error.code(), "EXTENSIONS_CANCELLED");
    assert_eq!(
        fs::read_dir(root.path().join("extensions"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn failed_preparation_removes_its_staging_tempdir() {
    let fixture = signed_package(
        "manifest.json",
        br#"{"manifest_version":3,"name":"Fixture","version":"1.0"}"#,
        valid_options(),
    );
    let root = tempfile::tempdir().unwrap();
    let result = prepare_downloaded(
        root.path(),
        &fixture.id,
        "failed-operation",
        &AtomicBool::new(false),
        &fixture.bytes,
    );
    assert!(result.is_err());
    assert_eq!(
        fs::read_dir(root.path().join("extensions"))
            .unwrap()
            .count(),
        0
    );
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
        let fixture = signed_package(name, b"bad", valid_options());
        let root = tempfile::tempdir().unwrap();
        assert!(
            unpack_fixture(
                &fixture,
                root.path(),
                &AtomicBool::new(false),
                package::MAX_UNPACKED,
            )
            .is_err(),
            "{name}"
        );
    }
}

#[test]
#[ignore = "External Chrome Web Store liveness boundary; run explicitly on a native host"]
fn live_adblock_download_signature_and_unpack() {
    let id = "gighmmpiobklfepjocnamgkkbiglidom";
    let bytes = package::download(id, &AtomicBool::new(false)).unwrap();
    let root = tempfile::tempdir().unwrap();
    let (manifest, _, metadata) =
        package::unpack(&bytes, id, root.path(), &AtomicBool::new(false)).unwrap();
    assert_eq!(manifest["manifest_version"], 3);
    assert!(metadata.size_bytes > 0);
    assert_eq!(
        crx::extension_id(&STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap()),
        id
    );
}
