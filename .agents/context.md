# Rion Studio AI Context Index

Rion Studio is a Tauri desktop launcher and automation host for isolated System
WebView roles. Use this file as a routing index; read only the topic documents
needed for the current task.

| Task area | Required context |
| --- | --- |
| Architecture or IPC | `.agents/context/architecture.md` |
| SQLite, role stores, portable data | `.agents/context/data.md` |
| WebView launch, tabs, input, native code | `.agents/context/system-runtime.md` |
| React UI, styling, translations | `.agents/context/renderer.md` |
| Tests, source hygiene, generated contracts | `.agents/context/testing.md` |
| CI, packaging, updater, release policy | `.agents/context/release.md` |

Repository ownership map:

- `crates/rion-core`: domain, SQLite, scheduling, portable data, runtime state.
- `crates/rion-platform`: operating-system adapters without Tauri UI ownership.
- `src-tauri`: Tauri commands, native windows, System WebView effects.
- `src/shared`: generated and hand-written cross-boundary contracts.
- `src/renderer`: browser-safe React UI and local presentation utilities.
- `tests`: TypeScript behavior, architecture, and release validation.

Global invariants and the owner-locked release decision live in `AGENTS.md` and
must not be duplicated or weakened in scoped context.
