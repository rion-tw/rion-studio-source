# System WebView Runtime Contract

Contract version 17 defines the shared semantics for WKWebView on macOS and
WebView2 on Windows. Rust orchestration owns the contract, while the
AppKit/WKWebView and Win32/WebView2 adapters implement it. The native APIs may
differ, but both platforms must expose the same observable contract.

`RuntimeKernel` is the logical authority. Tauri owns native handles and applies
revision-fenced desired projections. Native adapters, SQLite, and renderer
stores are followers; none may create a second logical writer.

Normal correctness is event-bound. Event-bound work never terminalizes because
time elapsed: it completes only from its exact authoritative event,
cancellation, supersede, actor stop, or event-stream failure. Deadline-bound
work is limited to declared external liveness boundaries, and an elapsed
deadline is never success.

## Contract parts

Read only the parts required by the task:

| Task | Normative contract |
| --- | --- |
| Operation identity, completion, subsystem semantics, revisions, diagnostics | [Operations and Receipts](contracts/system-runtime/operations-and-receipts.md) |
| Window/tab ownership, launch destinations, activation, topology mutation | [Ownership and Activation](contracts/system-runtime/ownership-and-activation.md) |
| Native tab chrome, destructive stop, persistence, display topology, dragging | [Native Projections and Placement](contracts/system-runtime/native-projections-and-placement.md) |
| Navigation, input fences, process-death recovery, power, shutdown | [Lifecycle and Recovery](contracts/system-runtime/lifecycle-and-recovery.md) |
| WebGL performance, popup security, and capability policy | [WebView Policy and Performance](contracts/system-runtime/webview-policy-and-performance.md) |

Changing a terminal status, completion scope, identity fence,
popup/security policy, or ordering guarantee requires a contract-version bump
and matching macOS and Windows behavior tests. Additive fields remain compatible
within version 17 only when the generated Rust/TypeScript contracts and all
consumers remain aligned.
