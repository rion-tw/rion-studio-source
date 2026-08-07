# Rion Studio Agent Rules

These rules apply to the whole repository. Read `.agents/context.md` first for
substantial work, then follow the scoped `AGENTS.md` nearest the files you edit.

## Working Rules

- Keep changes scoped and preserve unrelated user work.
- Use `pnpm` for JavaScript/TypeScript scripts and dependencies.
- Prefer existing patterns and add focused tests for runtime behavior changes.
- Keep hand-written source cohesive and below the repository hygiene limits.
- Treat generated files under `src/shared/generated` as outputs, never hand-edit them.

## Product Boundaries

- Rion Studio is a Tauri 2 + React + TypeScript desktop app. Tauri is the only
  supported product shell.
- Rust owns filesystem access, SQLite state, managed role stores, System WebView
  launch behavior, native windows, and browser lifecycle.
- The renderer calls only the typed `window.rionStudio` bridge. It must not import
  Node APIs, Tauri internals, or browser automation clients.
- Shared contracts under `src/shared` are the source of truth across Rust, Tauri,
  the renderer, and tests.
- Current browser runtimes are WebView2 on Windows and WKWebView on macOS 14+.
  External Chrome, CDN rewriting, remote debugging, and Chrome profiles as a
  runtime must not return.
- The user-consented Chrome Profile import is a bounded one-time transfer of the
  launch origin's cookies and LocalStorage. It is not a runtime fallback.

## Event Topology

- Event topology is the default design for product behavior, cross-boundary
  communication, completion, and errors: identify the authoritative event
  source, single state owner, ordered/revision-fenced propagation, consumer,
  cancellation, and terminal outcome before implementation.
- Normal correctness is event-bound. Do not add polling, watchdogs, dirty-state
  scans, or timeout-driven reconciliation unless the requirement deliberately
  calls for a documented external liveness boundary.
- System Runtime and Core effects must select `EventBound` or `DeadlineBound`
  explicitly. Event-bound work has no deadline and completes only from an exact
  authoritative event, cancellation, supersede, actor stop, or stream failure.
  Deadline-bound work must terminalize as failed or indeterminate when its
  external acknowledgement is unknown; elapsed time never becomes success.
- Presentation timers and event coalescing may delay non-authoritative UI work,
  but cannot discover state, establish truth, retry toward convergence, or
  decide a domain error. Mark production JS/TS timers with the event-topology
  classification required by `docs/event-topology.md`.
- Any exceptional timer, polling loop, watchdog, dirty check, or generic timeout
  wrapper requires a source-local `event-topology-exception` ID and a matching
  entry in `docs/event-topology-exceptions.json`; source hygiene enforces the
  pairing.

## Cross-Platform Requirement

- macOS and Windows are both required. Runtime/native/filesystem changes must
  audit Win32/WebView2 behavior, AppKit/WKWebView behavior, paths, file locking,
  and matching `#[cfg]` reachability.
- Shared tests must pass `platform` explicitly. Use platform-aware unit tests or
  mocks when the other native target is unavailable locally.
- Keep both `macos-latest` and `windows-latest` CI validation. Handoffs must state
  which Windows checks ran and which still require CI.
- A green Linux portable check is not evidence that Tauri code is reachable on
  Windows. After changing any `#[cfg(windows)]`, `#[cfg(target_os = "macos")]`,
  shared runtime contract, or native import, run `pnpm run lint:rust` and
  `pnpm run test:rust` on a supported native host before handoff; if Windows is
  unavailable, leave the Windows CI gate pending and report it explicitly.
- Do not hide target reachability problems with `allow(dead_code)`.

## Release Distribution (Owner-Locked)

- Production macOS artifacts use Tauri's ad-hoc identity (`-`) and are not
  Developer ID signed or notarized.
- Production Windows installers remain Authenticode-unsigned.
- Tauri updater signing, `.sig` files, and SHA-256 verification remain mandatory.
- Do not add platform signing credentials or fail-closed platform-signing gates
  unless the owner explicitly changes this decision and confirms both credential sets.

## Validation

Run the narrowest relevant checks first, then expand as risk requires:

```bash
pnpm run check:source-hygiene
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run lint:rust
pnpm run test:rust
pnpm run build
```
