# Contributing

## Stack and commands

Rion Studio uses a React/TypeScript renderer, Electron with bundled Chromium,
and a Rust Core exposed through a narrow Node-API boundary. Rust owns SQLite,
managed role stores, macros, runtime topology and operation terminality. macOS
retains the AppKit native window, tab and trusted-input boundary. The renderer
uses only the typed `window.rionStudio` bridge.

Use the Node and pnpm versions declared by `package.json` and the pinned Rust
toolchain. For distribution builds, use macOS arm64 or Windows x64 Node and Rust;
package preparation rejects a mismatched host architecture.

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run lint:rust
pnpm run test:rust
pnpm run build
pnpm run package
```

The unqualified `dev`, `build`, `package` and `dist` commands target Electron.
`dist` additionally requires the existing updater signing inputs. Build/package
verification does not launch the application; native integration and desktop E2E
are separate explicit commands.

## Runtime data and browser sessions

The Rust Core stores metadata in `rion-studio.sqlite3` below the canonical
`Rion Studio` application-data directory (`~/Library/Application Support/Rion Studio`
on macOS and `%APPDATA%\Rion Studio` on Windows).

The retired sibling directory named `rion-studio` is ignored. Rion Studio does not
move, delete or replace that data; it opens the canonical `Rion Studio` directory
when present and creates a fresh canonical data root otherwise.

Each role owns an isolated Chromium profile under `roles/{roleId}/browser/chromium`.
Consumed v22 data and installation compatibility remain supported without a
second desktop runtime. Chrome Profile import is a visible, consented, one-time
transfer of the launch origin's cookies and LocalStorage. The source stays
unchanged and is never used as a live runtime. Session secrets never pass through
the renderer. Rion Studio stores browser session data, not login passwords.

## Native validation

Linux validates portable Rust and shared JavaScript. It cannot establish native
Windows or macOS reachability. Changes to native code, platform imports or shared
runtime contracts require both supported native targets. Windows uses the
Visual Studio MSVC/Windows SDK components for `x86_64-pc-windows-msvc`.

```bash
pnpm run lint:rust:portable
pnpm run test:rust:portable
pnpm run test:electron:native-integration
pnpm run test:e2e:desktop:full
pnpm run check:desktop-e2e-isolation
pnpm run verify:system-only
```

The full E2E command runs the complete host-platform Chromium profile from
[the coverage manifest](../docs/e2e-coverage.json). Follow the
[E2E strategy](../docs/e2e-strategy.md) for exact journeys and evidence. Optional
hardware profiles are separate; physical dual-monitor and actual OS sleep or
sign-out are not cleanup prerequisites. An omitted hardware check is not PASS.

CI retains shared checks, Linux sanitizer/concurrency checks, macOS and Windows
native validation, and native Electron package validation. Package checks cover
ASAR entries, fuses, production E2E isolation, native ABI/linkage, installed NSIS
payload, Rust-owned updater transactions and packaged native black-box E2E.
Fixture results do not establish a real production update transaction.

## Packaging and releases

The existing desktop-release workflows build the exact source SHA and reuse the
existing release App, updater keys, endpoint, app identity and asset names. See
[the v22 configuration delta](../docs/v22-configuration-delta.md). Do not create
additional release environments or credentials for the cutover.

macOS targets 14+ and uses the explicit ad-hoc identity (`-`), without Developer
ID signing or notarization. Windows installers remain Authenticode-unsigned;
bundled Chromium does not require a WebView2 installation. Updater signatures
and SHA-256 verification remain mandatory on both platforms. The pinned Tauri
CLI remains only as the updater signing tool, not as a runtime or build shell.

Keep `Rion.Studio-mac.dmg`, `Rion.Studio-mac.app.tar.gz`,
`Rion.Studio-win.exe`, their updater signatures, `checksums.txt` and `latest.json`
consistent with the existing release inventory. Publish the manifest only after
the immutable assets and signatures verify. Release finalization and Resume
Release preserve immutable tags and reject non-identical asset replacement.
Publication and credential changes require explicit authorization.

`pnpm run verify:system-only` enforces the negative architecture boundary. Keep
current behavior covered by focused Rust/Vitest tests and complete affected
profiles; retired parity ledgers are historical evidence, not extra release gates.
