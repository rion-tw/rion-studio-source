# Rion Studio Tauri-only architecture and upgrade policy

## Current architecture

Tauri 2 is the only desktop shell. The renderer uses the typed `window.rionStudio`
API, the bridge invokes Tauri commands, and `rion-core` owns domain state and
SQLite transactions. Native runtime effects are implemented by WKWebView on
macOS 14+ and WebView2 on Windows 10/11.

The product has no alternate browser engine, external-browser fallback, general
remote-debugging endpoint, or separately packaged runtime helper. Capability gaps
fail closed and are reported through the shared contracts.

## Stable data root and one-time migration

The stable data root is named `Rion Studio` under the platform application-data
directory. It contains `rion-studio.sqlite3`, logs, settings, legal acceptance,
role images, and the isolated `roles/{roleId}/browser` stores. The role-derived
WKWebsiteDataStore identifiers and the WebView2 browser-directory layout remain
stable, so moving the containing root does not create fresh login sessions.

Before AppCore opens SQLite or any role WebView, the shell checks the legacy
sibling directory named `rion-studio`. If no valid completion marker exists, it:

1. acquires the migration lock and both application instance locks;
2. uses SQLite online backup for databases and hash-verifies other persistent files;
3. validates database integrity, foreign keys, schema/count summaries, and role directories;
4. renames an existing unpublished `Rion Studio` test directory to a timestamped backup; and
5. atomically installs the verified staging directory and records its source fingerprint.

The old `rion-studio` directory is retained as a recovery source. A journal makes
interrupted installation recoverable, and the completion marker prevents a later
launch from overwriting newer Tauri data. Release builds reject arbitrary
`RION_STUDIO_USER_DATA_DIR` overrides; isolated overrides are limited to debug builds.

## Shell behavior parity

The main window starts hidden at 1440×900 (minimum 960×640) and is shown only after
the renderer bridge reports ready. macOS uses an overlay title bar, an 18×18 traffic
light position, transparency and AppKit vibrancy; Windows retains native window
controls. Startup failures render a bundled local error surface instead of leaving
a white window or exiting silently.

Runtime tabs are Tauri-owned. macOS receives bounded state/actions through an
AppKit controller attached to Tauri's `NSWindow`; Windows uses a local-only tab-strip
WebView with scoped commands. Both preserve live per-tab System WebViews while
activating, reordering, hiding, moving between displays and transferring
fullscreen state. Tab menus, audio state, shortcuts, fullscreen toolbar behavior,
workspace dividers, the application menu and the quick menu use Rust/Tauri state
and never expose these capabilities to remote pages.

## Platform release gates

Every macOS and Windows candidate must pass target-specific Rust lint/tests and
bundle successfully. The release workflow verifies package structure, updater
signatures, and upgrade compatibility without launching the application.
macOS candidates use the explicit ad-hoc signing identity (`-`) and are neither
Developer ID signed nor notarized. Windows candidates remain unsigned like the
legacy release. Both platforms still require Tauri-signed updater artifacts.

## Legacy upgrade compatibility

The first two Tauri Stable releases publish `latest.json` for the Tauri updater
and the legacy `latest.yml` / `latest-mac.yml` manifests understood by existing
Electron installations. The manifests point directly to the unsigned Tauri NSIS
installer and ad-hoc-signed Tauri macOS bundle in the DMG; no Electron application
is built or shipped. The Tauri updater artifacts retain their independent updater
signature on both platforms.

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

`pnpm dev` starts Tauri directly. Macro
input capability is classified from the supported OS and installed System WebView
runtime. Build, package, and CI do not launch the application as a validation
step. Use `pnpm run dev:renderer` for renderer-only UI development.

`pnpm run verify:system-only` is the negative architecture gate. It rejects retired
source roots, build configs, direct package dependencies, and runtime tokens outside
the explicit migration allowlist. It also validates the 57-entry parity ledger at
`docs/tauri-parity-ledger.json`; every legacy-shell test must identify either a
retired behavior, an existing Rust/Tauri equivalent, or a concrete replacement test.

The current cross-baseline audit status and remaining external validation are
recorded in `docs/refactor-regression-audit.md`. The machine-readable v2 ledger at
`tests/parity/refactor-behavior-ledger-v2.json` remains authoritative for individual
preserved and retired behaviors.
