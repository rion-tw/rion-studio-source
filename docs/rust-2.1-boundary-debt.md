# Rion Studio 2.1 Rust Boundary Debt

The 2.1 migration makes the Rust core authoritative for domain data, durable
I/O, browser lifecycle decisions, scheduling, queues, rollback, processes,
networking, CDP, and performance data. TypeScript remains responsible for
Electron object handles and Electron-only effects, IPC/preload transport,
desktop UI integration, AppKit, and presentation state.

`tests/architecture/rustOwnedMainDebt.ts` is the executable debt manifest. Its
entries identify the exact source symbol, the numbered migration commit that
must remove it, and the ownership problem. The compiler-AST test compares
current production sources with that manifest in both directions:

- a new Node I/O import, core interval, Promise tail, authoritative `Map`,
  browser orchestration method, or specialized Node-API method fails the test;
- a transferred responsibility leaves a stale manifest entry and also fails;
- Electron handle registries are narrowly allowlisted and remain TypeScript;
- authoritative game, role, workspace, and macro contracts must stay generated
  from Rust.

The manifest is intentionally temporary. Commit 12 must remove every entry and
turn the checks into zero-exception release gates.
