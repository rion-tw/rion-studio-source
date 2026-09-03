# Rion Studio Agent Rules

These rules apply to the whole repository. For substantial work, read
`.agents/context.md`, run `pnpm run ai:context` for the task or changed paths,
then follow the scoped `AGENTS.md` nearest the files you edit.

## Working Rules

- Keep changes scoped and preserve unrelated user work.
- Use `pnpm` for JavaScript/TypeScript scripts and dependencies.
- Prefer existing patterns and add focused tests for runtime behavior changes.
- Keep hand-written source cohesive and below the repository hygiene limits.
- Treat generated files under `src/shared/generated` as outputs, never hand-edit them.

## Product Boundaries

- Rion Studio is migrating from its stable Tauri 2/System WebView shell to an
  Electron + Chromium shell. Migration code may coexist only in the scoped
  transition roots routed by `.agents/context-map.json`; it must not create a
  permanent user-selectable dual-engine product.
- Rust remains the logical authority for filesystem access, SQLite state,
  managed role stores, runtime topology, operation terminality, and macro
  scheduling. Electron owns Chromium sessions and non-serializable WebContents
  handles and applies revision-fenced Rust projections. On macOS, the existing
  AppKit-native game-window/tab presentation, gestures, and trusted-input adapter
  remain product requirements; the migration replaces WKWebView, not AppKit.
- The renderer calls only the typed `window.rionStudio` bridge. It must not import
  Node APIs, Electron internals, Tauri internals, or browser automation clients.
- Shared contracts under `src/shared` are the source of truth across Rust, the
  transition shells, the renderer, and tests.
- The stable v22 runtime remains WebView2 on Windows and WKWebView on macOS 14+
  until the Chromium v23 parity and migration gates pass. The target runtime is
  the Electron-bundled Chromium on both platforms. External Chrome, a remote
  debugging port, CDN rewriting, and a user's Chrome profile as a live runtime
  remain forbidden.
- Target macOS runtime code must adapt Chromium surfaces to the retained AppKit
  host boundary. It must not replace native AppKit game-window/tab chrome with
  HTML chrome or a generic cross-platform BrowserWindow-only implementation.
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

- macOS and Windows are both required. During migration,
  runtime/native/filesystem changes must audit both the stable
  Win32/WebView2/AppKit/WKWebView path and the target Electron/Chromium path,
  including paths, file locking, and matching `#[cfg]` reachability.
- Shared tests must pass `platform` explicitly. Use platform-aware unit tests or
  mocks when the other native target is unavailable locally.
- Keep both `macos-latest` and `windows-latest` CI validation. Handoffs must state
  which Windows checks ran and which still require CI.
- A green Linux portable check is not evidence that desktop-shell code is
  reachable on Windows. After changing any `#[cfg(windows)]`,
  `#[cfg(target_os = "macos")]`, shared runtime contract, or native import, run
  `pnpm run lint:rust` and
  `pnpm run test:rust` on a supported native host before handoff; if Windows is
  unavailable, leave the Windows CI gate pending and report it explicitly.
- Do not hide target reachability problems with `allow(dead_code)`.

## Release Distribution (Owner-Locked)

- Production macOS artifacts use the ad-hoc identity (`-`) and are not
  Developer ID signed or notarized.
- Production Windows installers remain Authenticode-unsigned.
- updater signing, `.sig` files, and SHA-256 verification remain mandatory for
  both transition and Chromium artifacts.
- Do not add platform signing credentials or fail-closed platform-signing gates
  unless the owner explicitly changes this decision and confirms both credential sets.

## E2E and AI Development

- Treat `docs/e2e-coverage.json` as the source of truth for user-journey coverage.
- Every user-visible behavior change must name the affected journey IDs in the
  handoff and update the manifest and adjacent desktop E2E when behavior changes.
- A new user-visible feature requires an automated P0/P1 journey. An E2E omission
  is allowed only for `internal-only`, `compile-only`, or `lower-layer-covered`
  work, and the handoff must state that exact reason with the focused test evidence.
- Primary user actions in desktop E2E must use visible UI. Debug-only controls may
  establish deterministic preconditions, inject classified failures, or read
  authoritative evidence, but must not replace the user action under test.
- Handoffs must list the macOS and Windows E2E profiles that ran and identify any
  platform still pending CI. Linux is never desktop E2E evidence.
- Meet the coverage targets declared by `docs/e2e-coverage.json`; do not lower
  them without owner approval. Run `pnpm run check:e2e-coverage` whenever
  journeys, profiles, or feature routes change.

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
