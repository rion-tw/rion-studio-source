# Rion Studio AI Context Index

Rion Studio is a Tauri desktop launcher and automation host for isolated System
WebView roles. For substantial work, use the deterministic router before loading
topic documents:

```bash
pnpm run ai:context -- --list
pnpm run ai:context -- --intent <area-id> --change-kind unknown
pnpm run ai:context -- --changed --change-kind <kind>
```

`.agents/context-map.json` is the routing authority. Read only the files emitted
by the router. If the command is unavailable, use this fallback table:

| Task area | Context | Canonical source |
| --- | --- | --- |
| Architecture, IPC, shared contracts | `.agents/context/architecture.md` | `docs/system-webview-runtime-contract.md` |
| SQLite, role stores, portable data | `.agents/context/data.md` | Source schema and transaction tests |
| WebView, tabs, input, macros, native code | `.agents/context/system-runtime.md` | Relevant part linked by the runtime contract index |
| React UI, styling, translations | `.agents/context/renderer.md` | `docs/design-system.md` |
| Tests, E2E, source hygiene | `.agents/context/testing.md` | `docs/e2e-strategy.md` and queried manifest entries |
| CI, packaging, updater, release | `.agents/context/release.md` | `docs/updater-transaction-contract.md` |
| AI context or documentation maintenance | `.agents/context/testing.md` | `docs/ai-development.md` |

Repository ownership remains: Core owns domain and persisted state; Tauri owns
native handles and effects; shared contracts own cross-boundary types; the
renderer is browser-safe. Global invariants and the owner-locked release decision live in `AGENTS.md`.
