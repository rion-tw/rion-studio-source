# Architecture

The authoritative flow is:

```text
renderer action
  -> window.rionStudio
  -> Tauri command
  -> rion-core
  -> semantic core effect
  -> Tauri/native System WebView adapter
  -> core event/state refresh
```

Keep business decisions in `rion-core`; Tauri/native code applies semantic
effects and owns native handles. Renderer features never bypass the typed bridge.

IPC changes update the complete contract together: Rust domain/result types,
generated TypeScript, `src/shared/api.ts`, Tauri commands/effects, bridge wiring,
renderer usage, and adjacent Rust/Vitest coverage.

Rust source is statically linked. Split by responsibility and platform adapter;
do not introduce dynamic libraries merely to reduce source-file size.
