# Rion Studio Agent Rules

Use `.agents/context.md` and `pnpm run ai:context` for unfamiliar areas,
cross-boundary changes, or unclear context/validation requirements. Follow scoped
`AGENTS.md`; reuse loaded, unchanged context. Known small edits, typo fixes, and
commit-only tasks need no fresh routing or document reads. Preserve unrelated
work; use `pnpm`, existing patterns, and focused runtime tests. Keep source
cohesive within hygiene limits; never hand-edit `src/shared/generated`.

## Product boundaries

- Electron + bundled Chromium is the sole runtime on macOS and Windows. The
  owner authorized Tauri/System WebView retirement on 2026-09-09; preserve
  consumed legacy data and updater compatibility, not another runnable shell.
- Rust owns filesystem access, SQLite, managed role stores, logical runtime
  topology, operation terminality, and macro scheduling. Electron owns Chromium
  sessions and non-serializable WebContents handles, applying revision-fenced
  Rust projections. `src/shared` owns cross-boundary contracts.
- The renderer uses only typed `window.rionStudio`; no Node, Electron, Tauri,
  or browser automation client imports.
- macOS 14+ retains AppKit-native game-window/tab chrome, gestures, host identity,
  physical modifier observation, and focus-neutrality proof. Adapt Chromium to
  this host; never replace it with HTML chrome or a BrowserWindow-only host.
- In-process CDP Input owns only final Chromium key/mouse submission. Only
  Electron main may attach `webContents.debugger`, to the exact managed Role
  WebContents, allowing only `Input.dispatchKeyEvent`/`Input.dispatchMouseEvent`.
  Detach terminalizes input; no arbitrary methods, reconnect, or fallback.
- External Chrome, remote-debugging port/pipe, external CDP clients,
  renderer/preload debugger access, CDN rewriting, and live user Chrome profiles
  are forbidden. User-consented Chrome Profile import is a bounded one-time
  transfer of launch-origin cookies and LocalStorage, never a runtime fallback.

## Event topology

- Before implementing behavior, identify its authoritative event source, single
  state owner, ordered/revision-fenced propagation, consumer, cancellation, and
  terminal outcome. Normal correctness is event-bound: no polling, watchdogs,
  dirty scans, or timeout reconciliation without a documented external liveness
  requirement.
- System Runtime/Core effects explicitly select `EventBound` or `DeadlineBound`.
  Event-bound work has no deadline: only the exact authoritative event,
  cancellation, supersede, actor stop, or stream failure completes it. Unknown
  external acknowledgement at a deadline means failure or indeterminate outcome;
  elapsed time never means success.
- Presentation timers/coalescing may delay non-authoritative UI work, never
  discover truth, retry toward convergence, or decide domain errors. Classify
  production JS/TS timers per `docs/event-topology.md`. Exceptional timers,
  polling, watchdogs, dirty checks, or generic timeout wrappers require a local
  `event-topology-exception` ID paired with `docs/event-topology-exceptions.json`.

## Platforms

- Audit runtime/native/filesystem changes on Windows Electron and macOS
  Chromium/AppKit, including paths, locking, and matching `#[cfg]` reachability.
  Cover legacy decoders without rebuilding Tauri. Shared tests pass `platform`
  explicitly; use platform-aware tests/mocks when a native target is unavailable.
- Keep `macos-latest` and `windows-latest` CI. After native imports, shared runtime
  contracts, or Windows/macOS `#[cfg]` changes, run `pnpm run lint:rust` and
  `pnpm run test:rust` on a supported native host. Report Windows checks and
  pending Windows CI explicitly. Linux never proves desktop/Windows reachability.
  Do not mask reachability with `allow(dead_code)`.

## Release Distribution (Owner-Locked)

- Production macOS uses ad-hoc identity (`-`), no Developer ID or notarization.
  Windows installers remain Authenticode-unsigned.
- Mandatory for transition and Chromium artifacts: updater signing, `.sig`
  files, and SHA-256 verification. Add no platform signing credentials or
  fail-closed signing gates unless the owner explicitly changes this decision
  and confirms both credential sets.

## Validation and handoff

- Complete the authorized implementation, required validation, and fixes for
  failures caused by this change; do not stop for review merely after a first
  implementation. Finish when done, when the user asks to pause, or when an
  actual blocker requires external information or authorization. Report unrelated
  failures separately without expanding the task.
- Run routed checks from narrowest to broadest: hygiene, typecheck, lint,
  tests, Rust lint/tests, and build. Use this task's
  `--paths` for validation; `--changed` inventories all worktree changes, including
  unrelated work. Report observed results.
- `docs/e2e-coverage.json` owns journey coverage. Every user-visible change names
  affected journey IDs and updates the manifest and adjacent desktop E2E. New
  features require an automated P0/P1 journey. Omit E2E only for `internal-only`,
  `compile-only`, or `lower-layer-covered`; report the exact reason and focused
  test evidence.
- Desktop E2E primary actions use visible UI; debug controls only set deterministic
  preconditions, inject classified failures, or read authoritative evidence.
  Report macOS/Windows profiles run and platforms pending CI; Linux is never
  desktop E2E evidence. Preserve coverage targets unless owner-approved.
  Run `pnpm run check:e2e-coverage` when journeys, profiles, or feature routes change.
