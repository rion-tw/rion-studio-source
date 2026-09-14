# Rion Studio AI Context Index

Global rules and the owner-locked release decision live in `AGENTS.md`;
routing lives in `.agents/context-map.json`.
Use the router for unfamiliar areas, cross-boundary changes, or unclear context
and validation requirements. Known small edits, typo fixes, and commit-only
tasks need no fresh routing or document reads. Explicit skill requests still apply.

```bash
pnpm run ai:context -- --intent <area-id> --change-kind unknown
pnpm run ai:context -- --paths <task-paths> --change-kind <kind>
```

Use `--list` only when intent IDs are unknown. Read emitted context once; reuse
unchanged files already loaded. Canonical documents are lookup targets: search
headings/symbols, then read the relevant sections and dependent clauses before
changing behavior. Follow their links when needed to resolve the task.
`--verbose` shows all match reasons; `--json` always retains the complete report.

Re-route only when scope or risk changes; reuse applicable context and checks.
Use this task's paths for validation. `--changed` includes every worktree change,
including other tasks; reconcile that inventory with this task's actual diff.
If the router is unavailable, use the matching fallback below:

| Task | Context | Authority |
| --- | --- | --- |
| IPC, shared contracts | `.agents/context/architecture.md` | `docs/system-webview-runtime-contract.md` |
| SQLite, role stores | `.agents/context/data.md` | Schema and transaction tests |
| Tabs, input, macros, native | `.agents/context/system-runtime.md` | Relevant runtime contract part |
| React UI | `.agents/context/renderer.md` | `docs/design-system.md` |
| Tests, tooling | `.agents/context/testing.md` | Adjacent tests; E2E strategy for desktop journeys |
| Packaging, updater, release | `.agents/context/release.md` | `docs/updater-transaction-contract.md` |
| AI context, documentation | `.agents/context/testing.md` | `docs/ai-development.md` |
