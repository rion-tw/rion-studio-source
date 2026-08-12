# Testing and Source Hygiene

- Rust unit/property/integration tests cover domain, persistence, launch effects,
  recovery, macro ordering/cancellation, and platform branches.
- Vitest covers the typed bridge, renderer behavior, architecture boundaries,
  release tooling, and browser-safe shared runtimes.
- Desktop E2E coverage is journey-based and versioned in
  `docs/e2e-coverage.json`; `docs/e2e-strategy.md` defines the smoke, full, and
  extended profiles plus their PR, nightly, and release-candidate gates.
- Prefer executable behavior tests. Source scans are reserved for forbidden
  imports/tokens, generated-output integrity, and dependency direction.
- Hand-written source must satisfy `pnpm run check:source-hygiene`; generated
  contracts and machine-owned data are excluded explicitly.
- Source hygiene requires production JS/TS timers and generic timeout wrappers
  to carry an event-topology classification. Exceptional mechanisms must use an
  ID present at the same path in `docs/event-topology-exceptions.json`; stale or
  unused ledger entries also fail validation.
- Event-bound tests drive the authoritative callback/channel event directly and
  assert stale, duplicate, cancellation, and stream-failure behavior. Do not use
  elapsed time as evidence that an event-bound operation completed correctly.
- Tests must not inherit the host platform implicitly. Use `node:path` for path
  assertions and platform tables for shared macOS/Windows behavior.
