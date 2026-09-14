---
name: rion-task-router
description: Select Rion Studio task context and validation by intent or changed paths for planning, implementation, diagnosis, and review of repository code or engineering documentation.
---

# Route a Rion Studio task

1. Run `pnpm run ai:context -- --intent <id>` or pass concrete targets with
   `--paths`. Use `--list` only for unknown IDs. Set `--change-kind` when known.
2. Read emitted context once, reusing unchanged content already loaded.
   Canonical documents are lookup targets: search headings/symbols, then read
   relevant sections and dependent clauses before changing behavior. Follow
   contract links as needed. Use `.agents/context.md` if the router is unavailable.
3. After edits, route this task's actual paths for checks and platform/journey
   obligations. Use `--changed` for whole-worktree inventory; reconcile unrelated
   changes instead of treating them as this task. Use `--verbose` for all match
   reasons or `--json` for the complete machine-readable report.
4. Inspect the map on unknown intent, missing reference, or unclassified path;
   do not guess around failed routing.

Report observed checks, never recommendations as evidence. Keep unavailable
native platforms pending CI or their required physical-host gates.
