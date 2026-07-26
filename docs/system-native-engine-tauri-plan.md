# Rion Studio Tauri-only architecture and upgrade policy

## Current architecture

Tauri 2 is the only desktop shell. The renderer uses the typed `window.rionStudio`
API, the bridge invokes Tauri commands, and `rion-core` owns domain state and
SQLite transactions. Native runtime effects are implemented by WKWebView on
macOS 14+ and WebView2 on Windows 10/11.

The product has no alternate browser engine, external-browser fallback, general
remote-debugging endpoint, or separately packaged runtime helper. Capability gaps
fail closed and are reported through the shared contracts.

## Native release gates

Every signed macOS and Windows candidate must pass the native trusted-input,
runtime-restore, and file-operation harnesses before bundling and again against
the packaged executable. macOS candidates also require Developer ID signing,
notarization, and stapling. Windows candidates require a valid Authenticode
signature, a signer subject exactly matching the legacy release publisher, and a
signed NSIS updater artifact.

Local macOS results are not evidence for Windows. A release cannot be promoted
until both platform jobs and the in-place upgrade matrix pass.

## Legacy upgrade compatibility

The first two Tauri Stable releases publish `latest.json` for the Tauri updater
and the legacy `latest.yml` / `latest-mac.yml` manifests understood by existing
Electron installations. The manifests point directly to the signed Tauri NSIS
installer and notarized Tauri DMG; no Electron application is built or shipped.

Portable import and database migration continue to accept the historical
`"electron"` runtime value and normalize it to the system runtime. New records,
public creation contracts, and UI choices never expose that value.

Legacy manifests and value parsing may be removed only in a dedicated release
after both conditions are met:

1. At least two Tauri Stable versions have shipped with the compatibility files.
2. At least 90 days have elapsed since the first Tauri Stable release.

Historical release assets remain immutable. Release failures are corrected with
a higher-version hotfix; signed assets are never overwritten after publication.

## Developer workflow

`pnpm dev` computes a fingerprint from the OS version and native runtime sources.
When no matching local attestation exists, it runs the native behavior harness and
stores a non-versioned stamp below `target/rion-attestation` before starting Tauri.
`pnpm dev:degraded` is reserved for UI-only work and leaves trusted/background
input unavailable.

`pnpm run verify:system-only` is the negative architecture gate. It rejects retired
source roots, build configs, direct package dependencies, and runtime tokens outside
the explicit migration allowlist.
