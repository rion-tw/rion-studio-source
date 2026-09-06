# Chromium platform data boundaries

CP-14 of the [cross-platform ledger](chromium-cross-platform-api-ledger.md),
reviewed against the 2026-09-06 worktree. This audit retains the native adapters
below. It does not introduce a new encryption format, permission policy, source
profile access, or runtime fallback.

## Retained effects and common callers

All platform paths below are in `crates/rion-platform/src`. Core paths are
relative to `crates/rion-core/src`.

| Boundary | Native implementation and shared caller | Decision |
| --- | --- | --- |
| Open file identity | filesystem.rs compares Unix device/inode with the opened handle; Windows uses volume/file index and rejects reparse-point/nonregular paths before reopening with FILE_FLAG_OPEN_REPARSE_POINT. session_transfer/section_04_vault_filesystem.rs, the WebView2 source reader and v23_role_initialization.rs call this boundary. | Retain. A string path comparison or browser File object does not prove the Rust-owned open handle still identifies the expected filesystem object. Caller-side path/type checks remain part of the contract. |
| Restricted permissions | filesystem.rs applies a protected current-user Windows DACL, including inherited children. Its non-Windows entry is deliberately a no-op; Core vault code separately sets Unix directories to 0700 and files to 0600 and repairs directory permissions before reads. Chrome staging and v23 initialization have their own bounded managed-directory setup. | Retain the native effects. Do not mistake the non-Windows facade for Unix permission enforcement or silently change recursive scope while deduplicating helpers. |
| Atomic replacement | filesystem.rs uses rename on Unix and ReplaceFileW/MoveFileExW on Windows, with namespaced native paths and the existing write-through flags. Core vault, portable export, diagnostics, telemetry and import storage share it. Core vault code additionally syncs Unix directories. | Retain under Rust authority. Preserve native file-sharing and replacement behavior; do not move persistence into renderer storage or Electron shell APIs. |
| Instance locks | app/section_01_event_queue_capacity.rs owns one fs2 exclusive lock on the managed data root and maps the platform contention error to APP_INSTANCE_LOCKED. | Already shared. The lock must span both shells and helpers' relevant Core ownership; a browser Session or Electron application lock is not a replacement for Rust's data lock. |
| Chrome discovery | chrome_profile.rs shares discovery, profile-name validation, fingerprinting and symlink rejection; only the default HOME/LOCALAPPDATA location differs. chrome_profile_import.rs owns bounded previews and source identity. | Retain the small path adapter. Discovery is a consented import precondition and never selects Chrome as the live engine. |
| Chrome close | system.rs selects AppleScript's graceful Chrome quit on macOS and the existing Windows PowerShell close request. ChromeProfileRequestQuit joins the command, then refreshes the source preview after a bounded lock-marker wait. | Retain the OS command boundary. A successful close command is not proof that all source data is unlocked; chrome_user_data_in_use detects the named Singleton markers, not a complete positive process identity. Subsequent source validation remains required. No external Chrome process was closed during this audit. |
| Chrome cookie decryption | chrome_cookie.rs reads the macOS Chrome Safe Storage key and handles the existing CBC payload; Windows unwraps Local State's DPAPI key and decodes supported AES-GCM values or legacy DPAPI. session_import/section_01_chrome_epoch_offset_seconds.rs lazily creates CookieDecryptor from the bounded source snapshot. | Retain for compatibility. v20 app-bound cookies are rejected before legacy decoding. This is source-format compatibility, separate from application transfer encryption. |
| Rion transfer encryption | protected_data.rs owns RSP2 bounds and domain/context binding. macOS uses its existing Keychain-managed key with AES-GCM; Windows uses DPAPI with the caller binding. session_transfer/section_03_vault.rs and chrome_profile_import_contract.rs share this API. | Retain. A replacement must preserve the exact existing envelope, key identity and caller context; using Electron safeStorage cannot be assumed to read these bytes or Chrome's cookie formats. |
| Legacy source migration | session_transfer's WebView2 reader and the retained WKWebView export boundary produce canonical transfer evidence; Chromium applies and verifies through the shared fresh helper. | Keep migration decoding distinct from ongoing Chrome import. CP-17 may retire the old runtime after its gates, but cannot drop required data-compatibility readers solely because the runtime changed. |

## Reachability and validation limits

The platform facade exports the same operations to Core and rion-node. Native
Windows implementations are guarded with cfg(windows), macOS key access with
cfg(target_os = "macos"), and unavailable crypto dispatches return errors rather
than silently executing the other platform's format. Windows API dependency
features include filesystem, security/authorization, cryptography and threading.
rion-node keeps system-webview-probe disabled; Tauri explicitly enables it.
This audit changes none of those native imports or cfg gates.

The shared algorithm tests can exercise Windows AES-GCM payloads on macOS, but
that does not execute Windows DPAPI, DACL, ReplaceFileW or file-sharing behavior.
The Windows-only tests in filesystem.rs cover long paths, existing readers and
recursive ACL protection; protected_data.rs has a native DPAPI context/tamper
round trip. Those tests still require the Windows CI host for this worktree.

The macOS encryption algorithm test uses an injected test key; it is not a claim
that the user's Keychain item was accessed. Session-transfer vault tests use a
fixture protector while exercising actual temporary files, permissions, identity
and replacement. No user Chrome cookies, profile secrets or Keychain values were
read as part of this audit.

The retained Chrome close path contains an existing bounded external-process and
source-lock observation loop. It must not be described as an event-only process
identity proof or copied into normal Chromium runtime correctness. This audit
makes no new polling exception and does not convert elapsed time into success.
