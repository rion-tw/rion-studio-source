# Architecture

```text
React / AppKit / Windows host / native lifecycle event
  -> RuntimeIntent / NativeRuntimeEvent
  -> AppCore actor mailbox
  -> RuntimeKernel aggregate transaction
  -> RuntimeCommit + monotonic revision
  -> native executor / SQLite projection / renderer external store
```

`RuntimeKernel` owns window generations, tab membership/order/selection/settings,
role leases and slots, logical surfaces, terminality, tombstones, and the global
revision. `LiveWindowTabStore` is a compatibility facade over Kernel snapshots
and intents. Held gestures and transient overlays are local UI state; committed
results come from Kernel projections.

`NativeResourceRegistry` holds exact non-serializable native identities.
Adapters, SQLite, and React's `useSyncExternalStore` follow forward-only commits.
Effects never synchronously re-enter Core from the effect call stack;
completion returns through an identity/generation-fenced event or effect result.
The Node-API boundary does not move authority out of Rust.

For IPC changes, update Rust domain/result types, generated TypeScript,
`src/shared/api.ts`, Electron adapters, bridge wiring, renderer use, and adjacent
Rust/Vitest coverage together. See `docs/system-webview-runtime-contract.md`
and its relevant contract parts for ordering and receipt semantics.

See `docs/event-topology.md` for async classification and exceptions; root rules
apply to all effects. Focus confirmation and surface close/isolation are
reference event-bound transactions.

Rust is statically linked. Split by responsibility/platform adapter, not dynamic
libraries introduced merely to reduce source-file size.
