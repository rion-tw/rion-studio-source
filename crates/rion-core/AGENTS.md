# rion-core Scope

- Keep domain decisions, validation, SQLite transactions, runtime state, and
  semantic effect planning in this crate.
- Organize large areas as cohesive modules with a small facade; tests belong in
  feature-specific child modules rather than the production file.
- Do not depend on Tauri or native window/WebView objects.
- Preserve atomic persistence and deterministic concurrency tests.
- Public exports are intentional cross-crate contracts; prefer `pub(crate)` for
  implementation details.
