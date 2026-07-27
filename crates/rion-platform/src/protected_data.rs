use crate::{Platform, PlatformError};

#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_ACCOUNT: &str = "Rion Studio";
#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_SERVICE: &str = "com.rionstudio.launcher.session-transfer";
#[cfg(target_os = "macos")]
const MAC_ENVELOPE_PREFIX: &[u8] = b"RSP1";

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

#[cfg(target_os = "macos")]
fn mac_keychain_key() -> Result<[u8; 32], PlatformError> {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::OsRng};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::process::Command;

    let existing = Command::new("/usr/bin/security")
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
        let added = Command::new("/usr/bin/security")
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
        Vec::with_capacity(MAC_ENVELOPE_PREFIX.len() + nonce.len() + ciphertext.len());
    envelope.extend_from_slice(MAC_ENVELOPE_PREFIX);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

#[cfg(target_os = "macos")]
fn unprotect_macos(protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};

    let payload = protected.strip_prefix(MAC_ENVELOPE_PREFIX).ok_or_else(|| {
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

#[cfg(windows)]
fn protect_windows(plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
    crypt_protect(plaintext)
}

#[cfg(windows)]
fn unprotect_windows(protected: &[u8]) -> Result<Vec<u8>, PlatformError> {
    crypt_unprotect(protected)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cross_platform_protection_on_the_current_host() {
        let unavailable = if cfg!(target_os = "macos") {
            Platform::Windows
        } else {
            Platform::Macos
        };
        assert!(protect_session_transfer(unavailable, b"secret").is_err());
    }
}
