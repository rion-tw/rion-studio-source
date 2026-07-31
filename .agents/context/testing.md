# Testing and Source Hygiene

- Rust unit/property/integration tests cover domain, persistence, launch effects,
  recovery, macro ordering/cancellation, and platform branches.
- Vitest covers the typed bridge, renderer behavior, architecture boundaries,
  release tooling, and browser-safe shared runtimes.
- Prefer executable behavior tests. Source scans are reserved for forbidden
  imports/tokens, generated-output integrity, and dependency direction.
- Hand-written source must satisfy `pnpm run check:source-hygiene`; generated
  contracts and machine-owned data are excluded explicitly.
- Tests must not inherit the host platform implicitly. Use `node:path` for path
  assertions and platform tables for shared macOS/Windows behavior.
