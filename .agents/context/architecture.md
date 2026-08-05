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

Rust source is statically linked. Split by responsibility and platform adapter;
do not introduce dynamic libraries merely to reduce source-file size.
