# Rust core and native-shell boundary

Rion Studio keeps product state and runtime orchestration in Rust. The React
renderer uses the shared `window.rionStudio` contract and cannot import Node,
Tauri, Electron, WebKit, WebView2, or automation clients directly.

## Ownership

- `rion-core` owns SQLite state, migrations, games, roles, workspaces, macros,
  compatibility checks, runtime ordering, recovery decisions, diagnostics, and
  portable data.
- `rion-platform` probes operating-system capabilities without leaking platform
  APIs into the core domain.
- `rion-tauri` links `rion-core` directly and executes shell effects. Game
  surfaces use WebView2 on Windows and WKWebView on macOS.
- `rion-node` and the Electron main/preload code are transitional hosts only.
  They receive no new product behavior and are removed after the Tauri release
  gates pass.

The system WebView is the only game browser engine. A missing capability is a
typed launch or macro error; the runtime never switches to another browser
engine.

## Data and contracts

SQLite under the app data directory is the source of truth. Readers accept and
normalize supported legacy values, while current writes and portable exports use
only the system-native model. Browser website data remains in the isolated
per-role WebView store and is not copied into SQLite or portable exports.

Rust models generate the TypeScript files under `src/shared/generated`. Any
renderer-facing capability must be implemented through the complete shared API,
preload/Tauri bridge, shell command, core command/effect, and focused tests.

## Runtime effects

Long-running or platform-specific work is emitted as typed desktop-shell
effects. Every effect has an identity, deadline, bounded queue, and explicit
result. Late, duplicate, cancelled, or malformed results are rejected so the
core cannot publish a false running state. Macro key ownership and cleanup stay
authoritative in Rust across navigation, stop, role close, and process failure.

Remote game pages receive no general application API. A role WebView can invoke
only the narrow overlay command installed at document creation; the Tauri host
derives the role from the invoking WebView label and validates the request size.

## Verification

Run the normal gates with:

```bash
pnpm run lint:rust
pnpm run test:rust
pnpm run generate:rust-types
git diff --exit-code -- src/shared/generated
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build:tauri:renderer
cargo check -p rion-tauri
```

Native behavior must also pass on both target platforms. macOS validates the
WKWebView/AppKit adapter and Windows validates the WebView2 adapter. Tests must
select their platform explicitly; a local macOS pass is not evidence of Windows
compatibility.

Performance gates cover launcher idle, 1/4/9 visible roles, hidden workspaces,
macro on/off, layout latency, effect acknowledgement p95, CPU/RSS, and repeated
surface creation/destruction. Release requires actual macOS 14+ and Windows
10/11 smoke tests in addition to CI.
