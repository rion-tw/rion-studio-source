---
name: rion-task-router
description: Route substantive Rion Studio planning, implementation, diagnosis, review, and verification work to the minimum repository context and validation set. Use when a task touches renderer UI, shared contracts, Rust Core, macros, Tauri/System WebView runtime, desktop E2E, release/CI, or engineering documentation.
---

# Route a Rion Studio task

1. Run `pnpm run ai:context -- --list` only when the intent IDs are unknown.
2. Before substantial work, run `pnpm run ai:context -- --intent <id>` or pass existing targets with `--paths`. Add `--change-kind` when the task classification is known.
3. Read only the context and canonical documents emitted by the router. Treat `.agents/context.md` as the fallback when the command is unavailable.
4. After edits, run `pnpm run ai:context -- --changed --change-kind <kind>` and reconcile its required checks, platform obligations, and candidate journeys with the actual change.
5. Stop and inspect the routing map when the command reports an unknown intent, missing reference, or unclassified path. Do not guess around a failed route.

The router recommends checks; it never proves they ran. Report only observed command results, and keep unavailable native platforms pending their required CI or physical-host gates.
