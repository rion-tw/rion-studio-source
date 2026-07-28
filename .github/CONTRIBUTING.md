# Contributing

## Developer Notes

### Stack

- Tauri 2 + React + TypeScript
- Vite for the renderer build
- Rust core for SQLite, macros, platform work, WebView2 and WKWebView
- Vitest for unit tests

### Commands

```bash
pnpm install
pnpm run dev
pnpm run dev:renderer # Optional renderer-only UI development
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run package
```

### Runtime Data

The Rust core stores metadata in `rion-studio.sqlite3` below the canonical
`Rion Studio` application-data directory (`~/Library/Application Support/Rion Studio`
on macOS and `%APPDATA%\\Rion Studio` on Windows).

Before AppCore starts, the first Tauri launch checks for the legacy sibling
directory named `rion-studio`. When it contains persistent data and no completed
migration marker exists, Rion Studio makes a verified staging copy, retains any
unpublished Tauri test directory as a timestamped backup, and atomically installs
the staged copy. The legacy source is never deleted automatically. Do not move,
rename, or clean either data directory while this migration is in progress.

Each role owns an isolated browser directory at:

```text
roles/{roleId}/browser
```

The app stores browser session data only. It does not store login passwords.

### Browser Session Architecture

Roles always launch their configured game URL directly in an isolated System
WebView store: WebView2 on Windows and WKWebView on macOS. The runtime never uses
an installed third-party browser profile directly. The user-consented one-time
Chrome transfer reads only the approved Cookies and exact launch-origin Local
Storage inputs, snapshots them in memory, filters them before persistence, and
never mutates the source profile.

### Packaging Notes

Game roles use the operating system WebView runtime. Compatibility checks use a
short-lived isolated System WebView surface.

Linux CI validates only the portable Rust crates because Linux is not a supported
Tauri shell target. Run the same portable gates locally with:

```bash
pnpm run lint:rust:portable
pnpm run test:rust:portable
```

The complete Tauri workspace must be linted and tested on both supported shell
platforms. Windows platform operations are part of the `rion-platform` Rust crate.
Install the pinned Rust toolchain and the Visual Studio 2022 MSVC/Windows SDK
components required by the `x86_64-pc-windows-msvc` target. To run the complete
Rust checks directly on macOS or Windows:

```bash
pnpm run lint:rust
pnpm run test:rust
cargo check -p rion-tauri
pnpm run verify:system-only
```

`pnpm run build` links the Rust core directly into the application. CI must validate
both `macos-latest` and `windows-latest` with platform-aware Rust lint, tests, and
`cargo check -p rion-tauri --all-targets`. After that quality gate succeeds, the
release candidate workflow is the only production Tauri bundle build and verifies
the resulting installers on both platforms. macOS releases target 14+, use the
explicit ad-hoc signing identity (`-`), and must not import a Developer ID certificate
or submit for notarization. Windows releases remain unsigned, matching the legacy
release, and require a WebView2 runtime presence check. The updater archives on both
platforms still require Tauri's independent cryptographic signature.

Releases use Tauri's updater-signed `latest.json`; the two-version/90-day upgrade
window additionally publishes `latest.yml` and `latest-mac.yml` for legacy
installations. Keep `Rion.Studio-mac.dmg`, `Rion.Studio-mac.app.tar.gz`, and
`Rion.Studio-win.exe` stable because updater manifests and README links depend on
them. Manifests are uploaded only after the immutable assets and updater signatures verify.

The Tauri parity ledger at `docs/tauri-parity-ledger.json` classifies every test
removed with the legacy shell. `pnpm run verify:system-only` validates both the
negative architecture boundary and this ledger; a deleted behavior test may not
remain unclassified or point to missing replacement evidence.

The cross-baseline behavior ledger is
`tests/parity/refactor-behavior-ledger-v2.json`; its human-readable audit status is
summarized in `docs/refactor-regression-audit.md`. Do not replace executable
evidence with source strings or documentation-only claims.

### Windows Multi-Display Release Check

Before releasing workspace display changes, smoke-test the x64 NSIS build on both
Windows 10 and Windows 11. Use at least two displays with mixed 100% and
125%/150% scaling, then repeat with the secondary display positioned to the left
or above the primary display. Verify bottom and side taskbar layouts when the
hardware permits.

For each topology, launch a System WebView workspace. The workspace must remain
on the selected display, fit inside that display's work area without covering the
taskbar, and keep the same display reserved. Also verify simultaneous launches,
all-displays-occupied cancellation, and display disconnect/reconnect behavior.
These native checks supplement the platform-aware unit tests and the existing
`windows-latest` x64 NSIS build job.
