# Rion Studio 2.1 Rust Boundary Completion

The 2.1 migration makes the Rust core authoritative for domain data, durable
I/O, browser lifecycle decisions, scheduling, queues, rollback, processes,
networking, CDP, and performance data. TypeScript remains responsible for
Electron object handles and Electron-only effects, IPC/preload transport,
desktop UI integration, AppKit, and presentation state.

The temporary executable debt manifest was removed after every listed transfer
completed. `tests/thin-typescript-boundary.test.ts` now enforces the final
boundary directly:

- a new non-Electron Node I/O import, core interval, Promise tail,
  authoritative runtime `Map`, browser orchestration method, or specialized
  Node-API method fails the test;
- Electron handle registries are narrowly allowlisted and remain TypeScript;
- authoritative game, role, workspace, and macro contracts must stay generated
  from Rust;
- legacy manager, fallback, and specialized addon symbols are prohibited.

The release gate has no debt exceptions. The only allowlists describe intended
Electron-owned handles and the AppKit addon locator.
