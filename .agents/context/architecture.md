# Architecture

The authoritative window/tab flow is:

```text
AppKit or Windows HTML gesture
  -> Rust LiveWindowTabStore
  -> background native surface follower
  -> background role ownership runtime
  -> background latest-wins SQLite snapshot
```

The platform UI owns the held gesture and immediate visuals;
`LiveWindowTabStore` is the only committed window membership, order, active,
hidden, and placement authority. Core owns role leases and generation-fenced
role ownership only. Native projection and persistence are forward-only sinks:
they never restore, reorder, delete, or resurrect live tabs. Other renderer
features still use the typed bridge and keep business decisions in `rion-core`.

IPC changes update the complete contract together: Rust domain/result types,
generated TypeScript, `src/shared/api.ts`, Tauri commands/effects, bridge wiring,
renderer usage, and adjacent Rust/Vitest coverage.

Async behavior follows an event topology:

```text
accepted intent
  -> authoritative owner mutation or native submission
  -> identity/revision-fenced event
  -> downstream projection or terminal receipt
```

Use `OperationCompletionPolicy::EventBound` for normal correctness. It carries
no deadline and waits for the exact authoritative event, explicit cancellation,
supersede, actor stop, or event-stream failure. `DeadlineBound` is reserved for
an external native, network, process, or storage acknowledgement that may never
arrive; its elapsed boundary is a failed or indeterminate terminal result, never
a success signal or reconciliation trigger. Focus confirmation and surface
close/isolation are reference event-bound transactions.

Polling, watchdogs, dirty-state scans, timeout-based state discovery, and
readback loops are not fallback architecture. Pure presentation delays and
coalescing of already-committed events are non-authoritative and must remain
separate from domain state and errors. See `docs/event-topology.md` for the
classification and exception contract.

Rust source is statically linked. Split by responsibility and platform adapter;
do not introduce dynamic libraries merely to reduce source-file size.
