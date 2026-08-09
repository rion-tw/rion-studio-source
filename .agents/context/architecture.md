# Architecture

The authoritative runtime flow is:

```text
React, AppKit, Windows HTML, or native lifecycle event
  -> RuntimeIntent / NativeRuntimeEvent
  -> AppCore runtime actor mailbox
  -> RuntimeKernel aggregate transaction
  -> RuntimeCommit + monotonic revision
  -> native executor / SQLite projection / renderer external store
```

`RuntimeKernel` is the only logical runtime authority. Its actor-serialized
aggregate owns window generations; tab membership, order, selection, and
settings; role leases and slot ownership; logical surface lifecycle;
operation terminality; tombstones; and the global runtime revision.
`LiveWindowTabStore` is a compatibility facade over Kernel snapshots and
intents, never a second writer. Platform UI may own a held gesture and a
transient visual overlay, but every committed result comes from a revisioned
Kernel projection.

The Tauri `NativeResourceRegistry` owns only non-serializable window/WebView
handles and their exact native identity. It cannot decide logical membership,
role ownership, or relaunch eligibility. Native adapters, SQLite, and the React
`useSyncExternalStore` store are forward-only followers. A native effect never
synchronously re-enters Core from the effect call stack; completion returns as
an identity/generation-fenced event or effect result.

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
