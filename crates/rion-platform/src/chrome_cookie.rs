use std::path::Path;

use crate::{Platform, PlatformError};

pub struct CookieDecryptor {
    platform: Platform,
    #[cfg(target_os = "macos")]
    mac_keys: Vec<[u8; 16]>,
    #[cfg(windows)]
    windows_key: Option<Vec<u8>>,
}

impl CookieDecryptor {
    pub fn chrome(
        platform: Platform,
        local_state_path: Option<&Path>,
        encrypted_sample: &[u8],
    ) -> Result<Self, PlatformError> {
        let local_state = local_state_path
            .filter(|path| path.is_file())
            .map(std::fs::read)
            .transpose()
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        Self::chrome_from_local_state(platform, local_state.as_deref(), encrypted_sample)
    }

    pub fn chrome_from_local_state(
        platform: Platform,
        local_state: Option<&[u8]>,
        encrypted_sample: &[u8],
    ) -> Result<Self, PlatformError> {
        Self::new(platform, local_state, encrypted_sample)
    }

    fn new(
        platform: Platform,
        local_state: Option<&[u8]>,
        encrypted_sample: &[u8],
    ) -> Result<Self, PlatformError> {
        match platform {
            Platform::Macos => {
                #[cfg(target_os = "macos")]
                {
                    let mac_keys = cached_mac_cookie_keys(encrypted_sample)?;
                    Ok(Self { platform, mac_keys })
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = (local_state, encrypted_sample);
                    Err(PlatformError::Operation(
                        "macOS cookie decryption requires macOS".to_owned(),
                    ))
                }
            }
            Platform::Windows => {
                #[cfg(windows)]
                {
                    let _ = encrypted_sample;
                    let windows_key = local_state.map(load_windows_master_key).transpose()?;
                    Ok(Self {
                        platform,
                        windows_key,
                    })
                }
                #[cfg(not(windows))]
                {
                    let _ = (local_state, encrypted_sample);
                    Err(PlatformError::Operation(
                        "Windows cookie decryption requires Windows".to_owned(),
                    ))
                }
            }
        }
    }

    pub fn decrypt(&self, encrypted_value: &[u8]) -> Result<Vec<u8>, PlatformError> {
        reject_app_bound_cookie(encrypted_value)?;
        match self.platform {
            Platform::Macos => {
                #[cfg(target_os = "macos")]
                {
                    decrypt_mac_cookie_with_keys(encrypted_value, &self.mac_keys)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Err(PlatformError::Operation(
                        "macOS cookie decryption requires macOS".to_owned(),
                    ))
                }
            }
            Platform::Windows => {
                #[cfg(windows)]
                {
                    if encrypted_value.starts_with(b"v10") || encrypted_value.starts_with(b"v11") {
                        let key = self.windows_key.as_deref().ok_or_else(|| {
                            PlatformError::Operation(
                                "Chrome encryption key is unavailable".to_owned(),
                            )
                        })?;
                        decrypt_windows_aes_gcm_payload(encrypted_value, key)
                    } else {
                        crypt_unprotect(encrypted_value)
                    }
                }
                #[cfg(not(windows))]
                {
                    Err(PlatformError::Operation(
                        "Windows cookie decryption requires Windows".to_owned(),
                    ))
                }
            }
        }
    }
}

pub fn decrypt_chrome_cookie(
    platform: Platform,
    encrypted_value: &[u8],
    local_state_path: Option<&Path>,
) -> Result<Vec<u8>, PlatformError> {
    CookieDecryptor::chrome(platform, local_state_path, encrypted_value)?.decrypt(encrypted_value)
}

fn reject_app_bound_cookie(encrypted_value: &[u8]) -> Result<(), PlatformError> {
    if encrypted_value.starts_with(b"v20") {
        Err(PlatformError::Operation(
            "Chrome app-bound cookie encryption is unsupported".to_owned(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn cached_mac_cookie_keys(encrypted_sample: &[u8]) -> Result<Vec<[u8; 16]>, PlatformError> {
    use pbkdf2::pbkdf2_hmac;
    use sha1::Sha1;
    use std::sync::{Mutex, OnceLock};

    type MacCookieKeyCache = OnceLock<Mutex<Vec<[u8; 16]>>>;
    static CHROME_KEYS: MacCookieKeyCache = OnceLock::new();
    let cache = &CHROME_KEYS;
    let cache = cache.get_or_init(|| Mutex::new(Vec::new()));
    let known = cache
        .lock()
        .map_err(|_| PlatformError::Operation("Cookie key cache is unavailable".to_owned()))?
        .clone();
    for key in known {
        if decrypt_mac_cookie_payload(encrypted_sample, &key).is_ok() {
            return Ok(vec![key]);
        }
    }

    for service in ["Chrome Safe Storage"] {
        let result = crate::background_command("/usr/bin/security")
            .args(["find-generic-password", "-w", "-s", service])
            .output()
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        if !result.status.success() {
            continue;
        }
        let password = String::from_utf8(result.stdout)
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
        let mut key = [0_u8; 16];
        pbkdf2_hmac::<Sha1>(password.trim().as_bytes(), b"saltysalt", 1003, &mut key);
        if decrypt_mac_cookie_payload(encrypted_sample, &key).is_ok() {
            let mut known = cache.lock().map_err(|_| {
                PlatformError::Operation("Cookie key cache is unavailable".to_owned())
            })?;
            if !known.contains(&key) {
                known.push(key);
            }
            return Ok(vec![key]);
        }
    }
    Err(PlatformError::Operation(
        "Browser Safe Storage key is unavailable or did not decrypt this cookie".to_owned(),
    ))
}

#[cfg(target_os = "macos")]
fn decrypt_mac_cookie_with_keys(
    encrypted_value: &[u8],
    keys: &[[u8; 16]],
) -> Result<Vec<u8>, PlatformError> {
    for key in keys {
        if let Ok(plaintext) = decrypt_mac_cookie_payload(encrypted_value, key) {
            return Ok(plaintext);
        }
    }
    Err(PlatformError::Operation(
        "Browser Safe Storage key did not decrypt this cookie".to_owned(),
    ))
}

pub fn decrypt_mac_cookie_payload(
    encrypted_value: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes::Aes128;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};

    let ciphertext = encrypted_value
        .strip_prefix(b"v10")
        .or_else(|| encrypted_value.strip_prefix(b"v11"))
        .ok_or_else(|| {
            PlatformError::Operation("Chrome cookie ciphertext is invalid".to_owned())
        })?;
    let decryptor = cbc::Decryptor::<Aes128>::new_from_slices(key, &[0x20; 16])
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    decryptor
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| PlatformError::Operation("Chrome cookie ciphertext is invalid".to_owned()))
}

#[cfg(windows)]
fn load_windows_master_key(raw: &[u8]) -> Result<Vec<u8>, PlatformError> {
    let encrypted_key = serde_json::from_slice::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/os_crypt/encrypted_key")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            PlatformError::Operation("Chrome encryption key is unavailable".to_owned())
        })?;
    use base64::Engine as _;
    let encrypted_key = base64::engine::general_purpose::STANDARD
        .decode(encrypted_key)
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let encrypted_key = encrypted_key.strip_prefix(b"DPAPI").ok_or_else(|| {
        PlatformError::Operation("Chrome encryption key format is unsupported".to_owned())
    })?;
    crypt_unprotect(encrypted_key)
}

pub fn decrypt_windows_aes_gcm_payload(
    encrypted_value: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};

    let payload = encrypted_value
        .strip_prefix(b"v10")
        .or_else(|| encrypted_value.strip_prefix(b"v11"))
        .ok_or_else(|| {
            PlatformError::Operation("Chrome cookie ciphertext is invalid".to_owned())
        })?;
    if key.len() != 32 || payload.len() < 12 + 16 {
        return Err(PlatformError::Operation(
            "Chrome cookie ciphertext is invalid".to_owned(),
        ));
    }
    let (nonce, ciphertext) = payload.split_at(12);
    Aes256Gcm::new_from_slice(key)
        .map_err(|error| PlatformError::Operation(error.to_string()))?
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| PlatformError::Operation("Chrome cookie authentication failed".to_owned()))
}

#[cfg(windows)]
fn crypt_unprotect(value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData},
    };

    let mut input_bytes = value.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len().try_into().map_err(|_| {
            PlatformError::Operation("Chrome encrypted value is too large".to_owned())
        })?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&raw const input, None, None, None, None, 0, &raw mut output)
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
    if result.is_empty() {
        Err(PlatformError::Operation(
            "Windows DPAPI returned no data".to_owned(),
        ))
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
    use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};

    use super::*;

    #[test]
    fn decrypts_mac_cbc_payload() {
        let key = [7_u8; 16];
        let encryptor = cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &[0x20; 16]).unwrap();
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(encryptor.encrypt_padded_vec_mut::<Pkcs7>(b"cookie-value"));
        assert_eq!(
            decrypt_mac_cookie_payload(&encrypted, &key).unwrap(),
            b"cookie-value"
        );
    }

    #[test]
    fn decrypts_windows_aes_gcm_payload() {
        let key = [9_u8; 32];
        let nonce = [4_u8; 12];
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(nonce);
        encrypted.extend(
            Aes256Gcm::new_from_slice(&key)
                .unwrap()
                .encrypt((&nonce).into(), b"cookie".as_slice())
                .unwrap(),
        );
        assert_eq!(
            decrypt_windows_aes_gcm_payload(&encrypted, &key).unwrap(),
            b"cookie"
        );
    }

    #[test]
    fn rejects_app_bound_prefix_without_trying_legacy_decryption() {
        assert!(decrypt_windows_aes_gcm_payload(b"v20payload", &[0; 32]).is_err());
    }
}
