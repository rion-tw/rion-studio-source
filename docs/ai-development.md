# AI Development Workflow

Rion Studio gives Codex a small durable instruction chain and loads detailed
context only when the current task requires it. The current working default is
GPT-6 Astra with high reasoning effort. Keep that quality budget; reduce repeated
reading, irrelevant context, and redundant checks. This repository does not
override personal model settings or set speculative token/compaction limits.

## Where information belongs

| Information | Owner |
| --- | --- |
| Repository-wide invariant or completion rule | Root `AGENTS.md` |
| Directory-specific constraint | Nearest nested `AGENTS.md` |
| Machine-readable task routing and validation selection | `.agents/context-map.json` |
| Concise domain orientation | `.agents/context/*.md` |
| Normative product behavior | Active contract or policy under `docs` |
| Repeated Codex procedure | Repo-local skill under `.agents/skills` |
| Mechanical restriction | Script plus CI test |
| One-time task prompt or exact-SHA evidence | `docs/validation/archive` |

Do not copy a normative rule into multiple layers. A higher-level instruction may
state the invariant and link its authority, but detailed states, ordering, and
failure behavior belong in one contract.

## Route when context or validation needs clarification

Use the router for unfamiliar areas, cross-boundary changes, or unclear context
and validation requirements. Known small edits, typo fixes, and commit-only
tasks need no fresh routing or document reads; explicit skill requests still
apply. Existing applicable requirements remain in force. Use an intent while
planning and paths when concrete files are known:

```bash
pnpm run ai:context -- --list
pnpm run ai:context -- --intent renderer --change-kind user-visible
pnpm run ai:context -- --intent ai-context --change-kind internal-only
pnpm run ai:context -- --paths src/renderer/src/features/settings --change-kind unknown
pnpm run ai:context -- --changed --change-kind internal-only
pnpm run ai:context -- --changed --base origin/main --json
pnpm run ai:context -- --changed --verbose
```

The router unions overlapping areas. Text reports group commands into
`Fast checks (required)` (both lists), `Fast checks (suggested)` (fast only), and
`Additional required checks` (required only), omitting empty groups. Each exact
command appears once, preserving source order within its group; different
commands and wrapper scripts are not assumed equivalent. A successful check
satisfies both lists while relevant inputs remain unchanged. Relevant changes,
failures, or new evidence may require rerunning it; no result cache is maintained.

Text reports show the first reason per area and the remaining count;
`--verbose` shows every reason. `--json` always retains all fields and reasons,
even with `--verbose`. Checks, platforms, and journey IDs are never truncated.
An unknown intent, missing path, invalid Git base, or unclassified routed path
is an error. The router never executes checks or proves they passed.

## Read and validate proportionally

- Read emitted context once; reuse unchanged instructions already loaded.
  Canonical documents are lookup targets, not a whole-file reading checklist.
  Search headings and symbols, then read relevant sections and dependent clauses
  before changing behavior. Follow referenced contracts when the task needs them.
- Prefer targeted searches and batch independent reads. Retain failure diagnostics;
  summarize successful checks instead of repeatedly loading full logs. Re-run
  checks after relevant changes, failures, or new evidence, not unchanged success.
- Plain documentation changes require documentation, AI-context, and diff checks.
  AI routing/instruction changes additionally require the router and documentation
  tests plus release-workflow guards for owner-locked instruction text.
  Script/test changes also select the full tooling validation profile.
  Executable policy registries retain their validation (the event-topology
  ledger selects tooling; journey coverage selects desktop E2E). Mixed tasks
  union all requirements; product, native, and CI gates remain in force.
- General tooling starts with testing context. Release and desktop E2E tasks
  select their respective routes, including by intent when a generic CI/script
  path alone cannot express the task's release or journey impact.
- Retain instructions that improve decisions. Existing hygiene limits remain
  ceilings, not reduction targets. Context/reference/report bytes can describe
  input size; they do not measure token savings or quality.

## Maintain the routing map

- Add a path to the narrowest existing area; create an area only when its
  context, risk, or validation obligations are materially different.
- Keep validation commands in shared profiles so overlapping areas deduplicate
  them automatically.
- Use feature paths only to produce candidate E2E journeys. The coverage
  manifest remains authoritative for journey membership and targets.
- Keep archives outside routine routing. Historical comparison starts at the
  archive index and records why old evidence applies.
- When Codex repeats a domain mistake, first decide whether the fix is a scoped
  instruction, canonical contract clarification, router entry, or mechanical
  check. Do not add the same rule to all four.

## Task completion

The completion boundary is defined in root `AGENTS.md`. Re-route this task's
actual `--paths` only when scope or risk changes; reuse still-applicable context
and checks. Use `--changed` for whole-worktree inventory, reconciling unrelated
tasks with this task's diff. Report observed results, affected journey IDs,
the exact E2E omission reason when applicable, and native platforms pending CI. A green
portable check is not native Windows or macOS evidence.
