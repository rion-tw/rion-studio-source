use crate::{Platform, PlatformError};

pub fn decrypt_chrome_cookie(
    platform: Platform,
    encrypted_value: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    match platform {
        Platform::Macos => decrypt_mac_cookie(encrypted_value),
        Platform::Windows => decrypt_windows_cookie(encrypted_value),
    }
}

#[cfg(target_os = "macos")]
fn decrypt_mac_cookie(encrypted_value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use pbkdf2::pbkdf2_hmac;
    use sha1::Sha1;
    use std::process::Command;

    let result = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-w", "-s", "Chrome Safe Storage"])
        .output()
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    if !result.status.success() {
        return Err(PlatformError::Operation(
            "Chrome Safe Storage key is unavailable".to_owned(),
        ));
    }
    let password = String::from_utf8(result.stdout)
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let password = password.trim();
    if password.is_empty() {
        return Err(PlatformError::Operation(
            "Chrome Safe Storage key is unavailable".to_owned(),
        ));
    }
    let mut key = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    decrypt_mac_cookie_payload(encrypted_value, &key)
}

#[cfg(not(target_os = "macos"))]
fn decrypt_mac_cookie(_encrypted_value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "macOS Chrome cookie decryption requires macOS".to_owned(),
    ))
}

pub fn decrypt_mac_cookie_payload(
    encrypted_value: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes::Aes128;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};

    if encrypted_value.len() < 4 || key.len() != 16 {
        return Err(PlatformError::Operation(
            "Chrome cookie ciphertext is invalid".to_owned(),
        ));
    }
    let ciphertext = &encrypted_value[3..];
    let decryptor = cbc::Decryptor::<Aes128>::new_from_slices(key, &[0x20; 16])
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    if let Ok(value) = decryptor.decrypt_padded_vec_mut::<Pkcs7>(ciphertext) {
        return Ok(value);
    }

    use cbc::cipher::block_padding::NoPadding;
    let decryptor = cbc::Decryptor::<Aes128>::new_from_slices(key, &[0x20; 16])
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    let mut value = decryptor
        .decrypt_padded_vec_mut::<NoPadding>(ciphertext)
        .map_err(|_| PlatformError::Operation("Chrome cookie ciphertext is invalid".to_owned()))?;
    while value.last() == Some(&0) {
        value.pop();
    }
    Ok(value)
}

#[cfg(windows)]
fn decrypt_windows_cookie(encrypted_value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use std::slice;
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData},
    };

    let payload = encrypted_value
        .strip_prefix(b"v10")
        .or_else(|| encrypted_value.strip_prefix(b"v11"))
        .unwrap_or(encrypted_value);
    let mut input_bytes = payload.to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes
            .len()
            .try_into()
            .map_err(|_| PlatformError::Operation("Chrome cookie is too large".to_owned()))?,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&raw const input, None, None, None, None, 0, &raw mut output)
            .map_err(|error| PlatformError::Operation(error.to_string()))?;
    }
    let value = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    if value.is_empty() {
        return Err(PlatformError::Operation(
            "Windows DPAPI returned an empty Chrome cookie".to_owned(),
        ));
    }
    Ok(value)
}

#[cfg(not(windows))]
fn decrypt_windows_cookie(_encrypted_value: &[u8]) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::Operation(
        "Windows Chrome cookie decryption requires Windows".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use aes::Aes128;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};

    use super::*;

    #[test]
    fn decrypts_the_mac_chrome_aes_cbc_payload() {
        let key = [7_u8; 16];
        let encryptor = cbc::Encryptor::<Aes128>::new_from_slices(&key, &[0x20; 16]).unwrap();
        let ciphertext = encryptor.encrypt_padded_vec_mut::<Pkcs7>(b"cookie-value");
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(ciphertext);

        crate::v1_case!("portable-profile-3227bd16b554", {
            assert_eq!(
                decrypt_mac_cookie_payload(&encrypted, &key).unwrap(),
                b"cookie-value"
            );
        });
    }

    #[test]
    fn rejects_invalid_mac_ciphertext_without_panicking() {
        assert!(decrypt_mac_cookie_payload(b"v10bad", &[0; 16]).is_err());
        assert!(decrypt_mac_cookie_payload(b"v10", &[0; 15]).is_err());
    }
}
