use crate::{Platform, PlatformError};

#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_ACCOUNT: &str = "Rion Studio";
#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_SERVICE: &str = "com.rionstudio.launcher.session-transfer";
#[cfg(target_os = "macos")]
const MAC_V1_ENVELOPE_PREFIX: &[u8] = b"RSP1";

const SESSION_TRANSFER_V2_ENVELOPE_PREFIX: &[u8; 4] = b"RSP2";
const SESSION_TRANSFER_V2_DOMAIN: &[u8] = b"com.rionstudio.launcher.session-transfer\0RSP2";
pub const SESSION_TRANSFER_V2_MAX_CONTEXT_BYTES: usize = 4 * 1024;
pub const SESSION_TRANSFER_V2_MAX_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
pub const SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES: usize = 65 * 1024 * 1024;
#[cfg(any(target_os = "macos", test))]
const AES_GCM_NONCE_BYTES: usize = 12;
#[cfg(any(target_os = "macos", test))]
const AES_GCM_TAG_BYTES: usize = 16;

const V2_CONTEXT_EMPTY_ERROR: &str = "Session-transfer v2 context must not be empty";
const V2_CONTEXT_TOO_LARGE_ERROR: &str = "Session-transfer v2 context is too large";
const V2_PLAINTEXT_EMPTY_ERROR: &str = "Session-transfer v2 plaintext must not be empty";
const V2_PLAINTEXT_TOO_LARGE_ERROR: &str = "Session-transfer v2 plaintext is too large";
const V2_ENVELOPE_INVALID_ERROR: &str = "Session-transfer v2 envelope is invalid";
const V2_ENVELOPE_TOO_LARGE_ERROR: &str = "Session-transfer v2 envelope is too large";
#[cfg(any(target_os = "macos", windows, test))]
const V2_PROTECTION_FAILED_ERROR: &str = "Session-transfer v2 protection failed";
#[cfg(any(target_os = "macos", windows, test))]
const V2_AUTHENTICATION_FAILED_ERROR: &str = "Session-transfer v2 authentication failed";
#[cfg(target_os = "macos")]
const V2_KEY_ACCESS_FAILED_ERROR: &str = "Session-transfer v2 key access failed";

pub fn protect_session_transfer(
    platform: Platform,
    plaintext: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    match platform {
        Platform::Macos => protect_macos(plaintext),
        Platform::Windows => protect_windows(plaintext),
    }
}

pub fn unprotect_session_transfer(
    platform: Platform,
    protected: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    match platform {
        Platform::Macos => unprotect_macos(protected),
        Platform::Windows => unprotect_windows(protected),
    }
}

/// Protects a complete session-transfer inventory and binds it to its caller context.
///
/// The context must identify the exact logical transfer (for example, its role and
/// transfer IDs). It is authenticated but is not stored in the envelope, so callers
/// must provide the same bytes when unprotecting it.
pub fn protect_session_transfer_v2(
    platform: Platform,
    context: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    validate_v2_context(context)?;
    validate_v2_plaintext_len(plaintext.len())?;
    let binding = session_transfer_v2_binding(context);
    let envelope = match platform {
        Platform::Macos => protect_macos_v2(&binding, plaintext),
        Platform::Windows => protect_windows_v2(&binding, plaintext),
    }?;
    validate_v2_envelope_len(envelope.len())?;
    Ok(envelope)
}

/// Unprotects an RSP2 inventory only when its caller context matches exactly.
pub fn unprotect_session_transfer_v2(
    platform: Platform,
    context: &[u8],
    protected: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    validate_v2_context(context)?;
    validate_v2_envelope_len(protected.len())?;
    let payload = strip_v2_envelope_prefix(protected)?;
    let binding = session_transfer_v2_binding(context);
    let plaintext = match platform {
        Platform::Macos => unprotect_macos_v2(&binding, payload),
        Platform::Windows => unprotect_windows_v2(&binding, payload),
    }?;
    validate_v2_plaintext_len(plaintext.len())?;
    Ok(plaintext)
}

fn operation(message: &'static str) -> PlatformError {
    PlatformError::Operation(message.to_owned())
}

fn validate_v2_context(context: &[u8]) -> Result<(), PlatformError> {
    if context.is_empty() {
        return Err(operation(V2_CONTEXT_EMPTY_ERROR));
    }
    if context.len() > SESSION_TRANSFER_V2_MAX_CONTEXT_BYTES {
        return Err(operation(V2_CONTEXT_TOO_LARGE_ERROR));
    }
    Ok(())
}

fn validate_v2_plaintext_len(length: usize) -> Result<(), PlatformError> {
    if length == 0 {
        return Err(operation(V2_PLAINTEXT_EMPTY_ERROR));
    }
    if length > SESSION_TRANSFER_V2_MAX_PLAINTEXT_BYTES {
        return Err(operation(V2_PLAINTEXT_TOO_LARGE_ERROR));
    }
    Ok(())
}

fn validate_v2_envelope_len(length: usize) -> Result<(), PlatformError> {
    if length == 0 {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    if length > SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES {
        return Err(operation(V2_ENVELOPE_TOO_LARGE_ERROR));
    }
    Ok(())
}

fn session_transfer_v2_binding(context: &[u8]) -> Vec<u8> {
    let context_length = u32::try_from(context.len())
        .expect("validated session-transfer v2 context length must fit in u32");
    let mut binding = Vec::with_capacity(SESSION_TRANSFER_V2_DOMAIN.len() + 4 + context.len());
    binding.extend_from_slice(SESSION_TRANSFER_V2_DOMAIN);
    binding.extend_from_slice(&context_length.to_be_bytes());
    binding.extend_from_slice(context);
    binding
}

fn strip_v2_envelope_prefix(envelope: &[u8]) -> Result<&[u8], PlatformError> {
    if envelope.len() < SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len() {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    // Compare every public format byte before branching so malformed prefixes
    // do not gain an avoidable byte-by-byte validation oracle.
    let prefix_matches = envelope[..SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len()]
        .iter()
        .zip(SESSION_TRANSFER_V2_ENVELOPE_PREFIX)
        .fold(0_u8, |difference, (actual, expected)| {
            difference | (actual ^ expected)
        })
        == 0;
    if !prefix_matches {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    let payload = &envelope[SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len()..];
    if payload.is_empty() {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    Ok(payload)
}

#[cfg(target_os = "macos")]
fn mac_keychain_key() -> Result<[u8; 32], PlatformError> {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::OsRng};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let existing = crate::background_command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-w",
            "-a",
            MAC_KEYCHAIN_ACCOUNT,
            "-s",
            MAC_KEYCHAIN_SERVICE,
        ])
        .output()
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let encoded = if existing.status.success() {
        String::from_utf8(existing.stdout)
            .map_err(|error| PlatformError::Operation(error.to_string()))?
            .trim()
            .to_owned()
    } else {
        let key = Aes256Gcm::generate_key(&mut OsRng);
        let encoded = STANDARD.encode(key);
        let added = crate::background_command("/usr/bin/security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                MAC_KEYCHAIN_ACCOUNT,
                "-s",
                MAC_KEYCHAIN_SERVICE,
                "-w",
                &encoded,
            ])
            .output()
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        if !added.status.success() {
            return Err(PlatformError::Operation(
                "Could not protect the Chrome import key in macOS Keychain".to_owned(),
            ));
        }
        encoded
    };
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    decoded.try_into().map_err(|_| {
        PlatformError::Operation("The macOS session-transfer key is invalid".to_owned())
    })
}

#[cfg(target_os = "macos")]
fn protect_macos(plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{
        Aes256Gcm, KeyInit,
        aead::{Aead, AeadCore, OsRng},
    };

    let key = mac_keychain_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| PlatformError::Operation("Session-transfer encryption failed".to_owned()))?;
    let mut envelope =
        Vec::with_capacity(MAC_V1_ENVELOPE_PREFIX.len() + nonce.len() + ciphertext.len());
    envelope.extend_from_slice(MAC_V1_ENVELOPE_PREFIX);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

#[cfg(target_os = "macos")]
fn unprotect_macos(protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};

    let payload = protected
        .strip_prefix(MAC_V1_ENVELOPE_PREFIX)
        .ok_or_else(|| {
            PlatformError::Operation("Session-transfer envelope is invalid".to_owned())
        })?;
    if payload.len() < 12 + 16 {
        return Err(PlatformError::Operation(
            "Session-transfer envelope is invalid".to_owned(),
        ));
    }
    let (nonce, ciphertext) = payload.split_at(12);
    Aes256Gcm::new_from_slice(&mac_keychain_key()?)
        .map_err(|error| PlatformError::Operation(error.to_string()))?
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| PlatformError::Operation("Session-transfer authentication failed".to_owned()))
}

#[cfg(target_os = "macos")]
fn protect_macos_v2(binding: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    let key = mac_keychain_key().map_err(|_| operation(V2_KEY_ACCESS_FAILED_ERROR))?;
    protect_aes_gcm_v2_with_key(&key, binding, plaintext)
}

#[cfg(target_os = "macos")]
fn unprotect_macos_v2(binding: &[u8], payload: &[u8]) -> Result<Vec<u8>, PlatformError> {
    if payload.len() < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES + 1 {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    let key = mac_keychain_key().map_err(|_| operation(V2_KEY_ACCESS_FAILED_ERROR))?;
    unprotect_aes_gcm_v2_with_key(&key, binding, payload)
}

#[cfg(any(target_os = "macos", test))]
fn protect_aes_gcm_v2_with_key(
    key: &[u8; 32],
    binding: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{
        Aes256Gcm, KeyInit,
        aead::{Aead, AeadCore, OsRng, Payload},
    };

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| operation(V2_PROTECTION_FAILED_ERROR))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: binding,
            },
        )
        .map_err(|_| operation(V2_PROTECTION_FAILED_ERROR))?;
    let mut envelope = Vec::with_capacity(
        SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len() + nonce.len() + ciphertext.len(),
    );
    envelope.extend_from_slice(SESSION_TRANSFER_V2_ENVELOPE_PREFIX);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

#[cfg(any(target_os = "macos", test))]
fn unprotect_aes_gcm_v2_with_key(
    key: &[u8; 32],
    binding: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{
        Aes256Gcm, KeyInit,
        aead::{Aead, Payload},
    };

    if payload.len() < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES + 1 {
        return Err(operation(V2_ENVELOPE_INVALID_ERROR));
    }
    let (nonce, ciphertext) = payload.split_at(AES_GCM_NONCE_BYTES);
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| operation(V2_AUTHENTICATION_FAILED_ERROR))?
        .decrypt(
            nonce.into(),
            Payload {
                msg: ciphertext,
                aad: binding,
            },
        )
        .map_err(|_| operation(V2_AUTHENTICATION_FAILED_ERROR))
}

#[cfg(not(target_os = "macos"))]
fn protect_macos(_plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "macOS Keychain protection requires macOS".to_owned(),
    ))
}

#[cfg(not(target_os = "macos"))]
fn unprotect_macos(_protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "macOS Keychain protection requires macOS".to_owned(),
    ))
}

#[cfg(not(target_os = "macos"))]
fn protect_macos_v2(_binding: &[u8], _plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(operation(
        "Session-transfer v2 macOS protection requires macOS",
    ))
}

#[cfg(not(target_os = "macos"))]
fn unprotect_macos_v2(_binding: &[u8], _payload: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(operation(
        "Session-transfer v2 macOS protection requires macOS",
    ))
}

#[cfg(windows)]
fn protect_windows(plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    crypt_protect(plaintext)
}

#[cfg(windows)]
fn unprotect_windows(protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    crypt_unprotect(protected)
}

#[cfg(windows)]
fn protect_windows_v2(binding: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    let protected = crypt_protect_v2(plaintext, binding)?;
    let mut envelope =
        Vec::with_capacity(SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len() + protected.len());
    envelope.extend_from_slice(SESSION_TRANSFER_V2_ENVELOPE_PREFIX);
    envelope.extend_from_slice(&protected);
    Ok(envelope)
}

#[cfg(windows)]
fn unprotect_windows_v2(binding: &[u8], payload: &[u8]) -> Result<Vec<u8>, PlatformError> {
    crypt_unprotect_v2(payload, binding)
}

#[cfg(windows)]
fn crypt_protect(value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let mut input_bytes = value.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len().try_into().map_err(|_| {
            PlatformError::Operation("Session-transfer payload is too large".to_owned())
        })?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &raw const input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    }
    let result = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    (!result.is_empty())
        .then_some(result)
        .ok_or_else(|| PlatformError::Operation("Windows DPAPI returned no data".to_owned()))
}

#[cfg(windows)]
fn crypt_unprotect(value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let mut input_bytes = value.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len().try_into().map_err(|_| {
            PlatformError::Operation("Session-transfer payload is too large".to_owned())
        })?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &raw const input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    }
    let result = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    (!result.is_empty())
        .then_some(result)
        .ok_or_else(|| PlatformError::Operation("Windows DPAPI returned no data".to_owned()))
}

#[cfg(windows)]
fn crypt_protect_v2(value: &[u8], binding: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let mut input_bytes = value.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes
            .len()
            .try_into()
            .map_err(|_| operation(V2_PLAINTEXT_TOO_LARGE_ERROR))?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut entropy_bytes = binding.to_vec();
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes
            .len()
            .try_into()
            .map_err(|_| operation(V2_CONTEXT_TOO_LARGE_ERROR))?,
        pbData: entropy_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protect_result = unsafe {
        CryptProtectData(
            &raw const input,
            None,
            Some(&raw const entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
    };
    if protect_result.is_err() {
        if !output.pbData.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            }
        }
        return Err(operation(V2_PROTECTION_FAILED_ERROR));
    }
    let result = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    (!result.is_empty())
        .then_some(result)
        .ok_or_else(|| operation(V2_PROTECTION_FAILED_ERROR))
}

#[cfg(windows)]
fn crypt_unprotect_v2(value: &[u8], binding: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let mut input_bytes = value.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes
            .len()
            .try_into()
            .map_err(|_| operation(V2_ENVELOPE_TOO_LARGE_ERROR))?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut entropy_bytes = binding.to_vec();
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes
            .len()
            .try_into()
            .map_err(|_| operation(V2_CONTEXT_TOO_LARGE_ERROR))?,
        pbData: entropy_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let unprotect_result = unsafe {
        CryptUnprotectData(
            &raw const input,
            None,
            Some(&raw const entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
    };
    if unprotect_result.is_err() {
        if !output.pbData.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            }
        }
        return Err(operation(V2_AUTHENTICATION_FAILED_ERROR));
    }
    let result = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    (!result.is_empty())
        .then_some(result)
        .ok_or_else(|| operation(V2_AUTHENTICATION_FAILED_ERROR))
}

#[cfg(not(windows))]
fn protect_windows(_plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "Windows DPAPI protection requires Windows".to_owned(),
    ))
}

#[cfg(not(windows))]
fn unprotect_windows(_protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "Windows DPAPI protection requires Windows".to_owned(),
    ))
}

#[cfg(not(windows))]
fn protect_windows_v2(_binding: &[u8], _plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(operation(
        "Session-transfer v2 Windows protection requires Windows",
    ))
}

#[cfg(not(windows))]
fn unprotect_windows_v2(_binding: &[u8], _payload: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(operation(
        "Session-transfer v2 Windows protection requires Windows",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_operation_error(error: PlatformError, expected: &str) {
        assert!(
            matches!(error, PlatformError::Operation(message) if message == expected),
            "expected operation error: {expected}",
        );
    }

    #[test]
    fn rejects_cross_platform_protection_on_the_current_host() {
        let unavailable = if cfg!(target_os = "macos") {
            Platform::Windows
        } else {
            Platform::Macos
        };
        assert!(protect_session_transfer(unavailable, b"secret").is_err());
    }

    #[test]
    fn v2_aes_gcm_envelope_is_context_bound_and_tamper_evident() {
        let key = [0x5a; 32];
        let binding = session_transfer_v2_binding(b"role:one\0transfer:42");
        let envelope = protect_aes_gcm_v2_with_key(&key, &binding, b"complete inventory").unwrap();
        assert_eq!(
            &envelope[..SESSION_TRANSFER_V2_ENVELOPE_PREFIX.len()],
            SESSION_TRANSFER_V2_ENVELOPE_PREFIX,
        );
        let payload = strip_v2_envelope_prefix(&envelope).unwrap();
        assert_eq!(
            unprotect_aes_gcm_v2_with_key(&key, &binding, payload).unwrap(),
            b"complete inventory",
        );

        let wrong_binding = session_transfer_v2_binding(b"role:two\0transfer:42");
        assert_operation_error(
            unprotect_aes_gcm_v2_with_key(&key, &wrong_binding, payload).unwrap_err(),
            V2_AUTHENTICATION_FAILED_ERROR,
        );

        let mut tampered = envelope;
        let last = tampered.len() - 1;
        tampered[last] ^= 0x80;
        assert_operation_error(
            unprotect_aes_gcm_v2_with_key(
                &key,
                &binding,
                strip_v2_envelope_prefix(&tampered).unwrap(),
            )
            .unwrap_err(),
            V2_AUTHENTICATION_FAILED_ERROR,
        );
    }

    #[test]
    fn v2_rejects_invalid_inputs_with_stable_errors_before_platform_dispatch() {
        assert_operation_error(
            protect_session_transfer_v2(Platform::Macos, b"", b"inventory").unwrap_err(),
            V2_CONTEXT_EMPTY_ERROR,
        );
        assert_operation_error(
            protect_session_transfer_v2(Platform::Macos, b"transfer", b"").unwrap_err(),
            V2_PLAINTEXT_EMPTY_ERROR,
        );
        assert_operation_error(
            unprotect_session_transfer_v2(Platform::Windows, b"transfer", b"").unwrap_err(),
            V2_ENVELOPE_INVALID_ERROR,
        );
        assert_operation_error(
            strip_v2_envelope_prefix(b"RSP1not-v2").unwrap_err(),
            V2_ENVELOPE_INVALID_ERROR,
        );
        assert_operation_error(
            validate_v2_context(&vec![0; SESSION_TRANSFER_V2_MAX_CONTEXT_BYTES + 1]).unwrap_err(),
            V2_CONTEXT_TOO_LARGE_ERROR,
        );
        assert_operation_error(
            validate_v2_plaintext_len(SESSION_TRANSFER_V2_MAX_PLAINTEXT_BYTES + 1).unwrap_err(),
            V2_PLAINTEXT_TOO_LARGE_ERROR,
        );
        assert_operation_error(
            validate_v2_envelope_len(SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES + 1).unwrap_err(),
            V2_ENVELOPE_TOO_LARGE_ERROR,
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_v2_round_trip_is_context_bound_and_tamper_evident() {
        let context = b"role:windows\0transfer:7";
        let envelope =
            protect_session_transfer_v2(Platform::Windows, context, b"inventory").unwrap();
        assert_eq!(
            unprotect_session_transfer_v2(Platform::Windows, context, &envelope).unwrap(),
            b"inventory",
        );
        assert_operation_error(
            unprotect_session_transfer_v2(Platform::Windows, b"role:other\0transfer:7", &envelope)
                .unwrap_err(),
            V2_AUTHENTICATION_FAILED_ERROR,
        );

        let mut tampered = envelope;
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_operation_error(
            unprotect_session_transfer_v2(Platform::Windows, context, &tampered).unwrap_err(),
            V2_AUTHENTICATION_FAILED_ERROR,
        );
    }
}
