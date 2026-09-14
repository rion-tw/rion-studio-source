---
name: rion-task-router
description: Select Rion Studio task context and validation when the affected areas or required checks are unclear.
---

# Rion task context and validation

Use for unfamiliar areas, cross-boundary changes, unclear obligations, or an
explicit skill request. Known small edits, typo fixes, and commit-only tasks
need no fresh routing. Re-route only when scope or risk changes.

`pnpm run ai:context -- --intent <id>` selects by task; `--paths <task-paths>`
selects by actual scope. Set `--change-kind` when known. Use `--list` for unknown
IDs, `--verbose` for all match reasons, and `--json` for the complete report.
`--changed` inventories the whole worktree, including unrelated work.

Reuse applicable, unchanged context already loaded. Canonical documents are
lookup targets: read relevant sections and dependent clauses before changing
behavior. Use `.agents/context.md` if the router is unavailable. Inspect the map
on unknown intent, missing reference, or unclassified path; do not bypass errors.

The report selects checks, not evidence. Matching fast/required commands run
once for unchanged relevant inputs. Preserve platform and journey obligations;
report observed results and unavailable native gates pending CI or physical hosts.
