# Rion Studio 2.1

Rion Studio 2.1 completes the Rust-led main-process boundary while preserving
the existing Electron/React UI, Chromium engine, login/session locations,
portable format, updater format, IPC channels, and `window.rionStudio` API.

## Runtime and reliability

- Browser role and workspace operations are coordinated by the Rust operation
  actor with bounded effect queues, deadlines, cancellation, rollback, and
  stable error payloads.
- Embedded Electron calls are applied by thin TypeScript effect adapters.
  External Chrome process control, CDP, health, recovery, and fallback decisions
  remain entirely in Rust.
- Macro input ownership, held-key release, resource ordering, compatibility,
  CDN decisions, profile/portable file sagas, logging, diagnostics, and
  performance telemetry have one production implementation in Rust.
- SQLite schema 4 adds a versioned operation journal for recoverable operations
  spanning SQLite, filesystem work, and Electron effects.

## Compatibility

- Existing browser directories and Electron session partitions are unchanged;
  the upgrade does not proactively clear cookies or login data.
- SQLite remains the only production metadata write source. Existing migration
  backups remain read-only and are not deleted automatically.
- Portable JSON remains the supported cross-version data transfer format and
  deliberately excludes cookies, browser profiles, and login sessions.
- Supported release targets remain macOS arm64 and Windows x64.

## Internal release gates

The 2.1 candidate must pass the zero-debt TypeScript boundary checks, Rust and
TypeScript suites, macOS/Windows package smoke tests, a real-userData copy test
using only the “米娜醬” role for interactive launch checks, and the documented
1.37 performance A/B thresholds before release.
