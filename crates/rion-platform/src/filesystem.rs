use std::path::Path;

use crate::PlatformError;

#[cfg(not(windows))]
pub fn restrict_directory_to_current_user(_root: &Path) -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(windows)]
pub fn restrict_directory_to_current_user(root: &Path) -> Result<(), PlatformError> {
    use std::os::windows::ffi::OsStrExt;

    use windows::{
        Win32::{
            Foundation::{CloseHandle, GENERIC_ALL, HANDLE, HLOCAL, LocalFree},
            Security::{
                Authorization::{
                    EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, SetEntriesInAclW,
                    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
                },
                DACL_SECURITY_INFORMATION, GetTokenInformation,
                PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                TOKEN_QUERY, TOKEN_USER, TokenUser,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        },
        core::{PCWSTR, PWSTR},
    };

    fn apply_acl(
        path: &Path,
        acl: *const windows::Win32::Security::ACL,
    ) -> Result<(), PlatformError> {
        let path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let information = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        let status = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                information,
                None,
                None,
                Some(acl),
                None,
            )
        };
        if status.0 == 0 {
            Ok(())
        } else {
            Err(PlatformError::Operation(format!(
                "apply current-user data ACL: Windows error {}",
                status.0
            )))
        }
    }

    if !root.exists() {
        return Ok(());
    }
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|error| PlatformError::Operation(format!("open current-user token: {error}")))?;
    let outcome = (|| {
        let mut required = 0_u32;
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut required) };
        if required < std::mem::size_of::<TOKEN_USER>() as u32 {
            return Err(PlatformError::Operation(
                "current-user token did not expose a valid SID".to_owned(),
            ));
        }
        let mut token_user = vec![0_u8; required as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(token_user.as_mut_ptr().cast()),
                required,
                &mut required,
            )
        }
        .map_err(|error| {
            PlatformError::Operation(format!("read current-user token SID: {error}"))
        })?;
        let sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let entries = [EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL.0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: Default::default(),
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: PWSTR(sid.0.cast()),
            },
        }];
        let mut acl = std::ptr::null_mut();
        let status = unsafe { SetEntriesInAclW(Some(&entries), None, &mut acl) };
        if status.0 != 0 {
            return Err(PlatformError::Operation(format!(
                "create current-user data ACL: Windows error {}",
                status.0
            )));
        }
        struct LocalAcl(*mut windows::Win32::Security::ACL);
        impl Drop for LocalAcl {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(Some(HLOCAL(self.0.cast())));
                }
            }
        }
        let acl = LocalAcl(acl);
        apply_acl(root, acl.0)?;
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            for entry in std::fs::read_dir(&directory).map_err(|error| {
                PlatformError::Operation(format!(
                    "enumerate migrated data ACL at {}: {error}",
                    directory.display()
                ))
            })? {
                let entry = entry.map_err(|error| {
                    PlatformError::Operation(format!("read migrated data ACL entry: {error}"))
                })?;
                let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                    PlatformError::Operation(format!("inspect migrated data ACL entry: {error}"))
                })?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                apply_acl(&entry.path(), acl.0)?;
                if metadata.is_dir() {
                    directories.push(entry.path());
                }
            }
        }
        Ok(())
    })();
    let _ = unsafe { CloseHandle(token) };
    outcome
}

#[cfg(not(windows))]
pub fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    std::fs::rename(source, destination).map_err(|error| {
        PlatformError::Operation(format!(
            "failed to atomically replace {} with {}: {error}",
            destination.display(),
            source.display()
        ))
    })
}

#[cfg(windows)]
pub fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    use std::os::windows::ffi::OsStrExt;

    use windows::{
        Win32::Storage::FileSystem::{
            MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };

    fn api_path(path: &Path) -> Result<Vec<u16>, PlatformError> {
        const SEPARATOR: u16 = b'\\' as u16;
        const QUESTION_MARK: u16 = b'?' as u16;
        const DOT: u16 = b'.' as u16;

        let absolute = std::path::absolute(path).map_err(|error| {
            PlatformError::Operation(format!(
                "resolve absolute path for atomic file replacement: {error}"
            ))
        })?;
        let encoded = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
        let already_namespaced =
            encoded.starts_with(&[SEPARATOR, SEPARATOR, QUESTION_MARK, SEPARATOR])
                || encoded.starts_with(&[SEPARATOR, SEPARATOR, DOT, SEPARATOR]);
        let mut api_path = if already_namespaced {
            encoded
        } else if encoded.starts_with(&[SEPARATOR, SEPARATOR]) {
            "\\\\?\\UNC\\"
                .encode_utf16()
                .chain(encoded.into_iter().skip(2))
                .collect()
        } else {
            "\\\\?\\".encode_utf16().chain(encoded).collect()
        };
        api_path.push(0);
        Ok(api_path)
    }

    let source = api_path(source)?;
    let destination = api_path(destination)?;
    let flags = MOVE_FILE_FLAGS(MOVEFILE_REPLACE_EXISTING.0 | MOVEFILE_WRITE_THROUGH.0);
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }.map_err(
        |error| PlatformError::Operation(format!("atomic file replacement failed: {error}")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_file_without_exposing_a_partial_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.tmp");
        let destination = directory.path().join("result.json");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&destination, b"old").unwrap();

        atomic_replace_file(&source, &destination).unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());
    }

    #[cfg(windows)]
    #[test]
    fn replaces_a_file_beyond_the_legacy_windows_path_limit() {
        use std::os::windows::ffi::OsStrExt;

        let directory = tempfile::tempdir().unwrap();
        let long_directory = directory.path().join("a".repeat(120)).join("b".repeat(120));
        std::fs::create_dir_all(&long_directory).unwrap();
        let source = long_directory.join("source.tmp");
        let destination = long_directory.join("result.json");
        assert!(
            std::path::absolute(&source)
                .unwrap()
                .as_os_str()
                .encode_wide()
                .count()
                > 260
        );
        std::fs::write(&source, b"new").unwrap();

        atomic_replace_file(&source, &destination).unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());
    }
}
