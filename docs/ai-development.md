# AI Development Workflow

Rion Studio gives Codex a small durable instruction chain and loads detailed
context only when the current task requires it. The objective is deterministic
routing, not a larger prompt.

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

## Route before loading context

Use an intent when planning and paths when concrete files are known:

```bash
pnpm run ai:context -- --list
pnpm run ai:context -- --intent renderer --change-kind user-visible
pnpm run ai:context -- --paths src/renderer/src/features/settings --change-kind unknown
pnpm run ai:context -- --changed --change-kind internal-only
pnpm run ai:context -- --changed --base origin/main --json
```

The router unions overlapping areas, explains every match, and reports fast
checks separately from handoff gates. It never executes a command or turns a
recommendation into evidence. An unknown intent, missing path, invalid Git base,
or unclassified routed path is an error.

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

Run the router again with `--changed`, then reconcile its output with the actual
diff. Report observed results, affected journey IDs, the exact E2E omission
reason when applicable, and any native platform still pending CI. A green
portable check is not native Windows or macOS evidence.
