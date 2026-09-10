# Engineering Documentation

This catalog separates normative sources from task guidance and historical
evidence. Load only the documents required by `.agents/context-map.json` or the
`ai:context` command.

## Contracts

| Document | Status | Load when |
| --- | --- | --- |
| [System WebView Runtime Contract](system-webview-runtime-contract.md) | Active, version owner | Core/Electron/native runtime contracts and consumed v22 compatibility |
| [Chromium Runtime Migration](chromium-runtime-migration.md) | Active, runtime contract | Electron/Chromium architecture, session transfer, cutover, or Tauri retirement |
| [Chromium Migration Execution Ledger](chromium-migration-execution-ledger.md) | Active, non-normative ledger | Remaining work count, gate status, or migration handoff |
| [v22 Configuration Delta](v22-configuration-delta.md) | Active, observed configuration comparison | Reusing existing release settings for the sole Electron entry |
| [Chromium Cross-Platform API Ledger](chromium-cross-platform-api-ledger.md) | Active, non-normative ledger | Shared Chromium API adoption, retained native boundaries, maintenance tasks and equivalence evidence |
| [Chromium Capability Ownership Audit](chromium-capability-ownership-audit.md) | Active, non-normative audit | Browser API owners, authoritative receipts, behavior evidence and native coverage gaps |
| [Chromium Platform Data Boundaries](chromium-platform-data-audit.md) | Active, non-normative audit | Retained filesystem, lock, encryption and Chrome-import adapters with native validation limits |
| [Operations and Receipts](contracts/system-runtime/operations-and-receipts.md) | Active, normative | Operation identity, completion, revisions, diagnostics |
| [Ownership and Activation](contracts/system-runtime/ownership-and-activation.md) | Active, normative | Window/tab ownership, launch, activation, topology |
| [Native Projections and Placement](contracts/system-runtime/native-projections-and-placement.md) | Active, normative | Native chrome, destructive stop, persistence, placement |
| [Lifecycle and Recovery](contracts/system-runtime/lifecycle-and-recovery.md) | Active, normative | Navigation, input fences, process recovery, power, shutdown |
| [Managed Macro Shortcuts](contracts/system-runtime/managed-macro-shortcuts.md) | Active, normative | Physical shortcut ownership, trusted replay, toggle and while-held ordering |
| [WebView Policy and Performance](contracts/system-runtime/webview-policy-and-performance.md) | Active, normative | WebGL, popup security, capabilities |
| [Updater Install Transaction](updater-transaction-contract.md) | Active, normative | Updater, drain, restart, or release recovery work |

## Policies and guides

| Document | Status | Load when |
| --- | --- | --- |
| [AI Development](ai-development.md) | Active | Maintaining agent routing, skills, or documentation governance |
| [Design System](design-system.md) | Active | Renderer styling, components, theme, or runtime chrome presentation |
| [Event Topology](event-topology.md) | Active | Any asynchronous production behavior or timer review |
| [Desktop E2E Strategy](e2e-strategy.md) | Active | User-visible behavior, journey coverage, or desktop validation |
| [Chromium Macro Cutover Parity](validation/runbooks/chromium-macro-cutover.md) | Active runbook | Paired managed Macro/input cutover phases, evidence, or platform limits |
| [Electron Production Candidate](electron-production-candidate.md) | Current entry index; retired design below | Existing Electron release entry and historical provisional workflow evidence |
| [Validation](validation/README.md) | Active index | Native/hardware runbooks or historical evidence lookup |
| [Electron Development Output](validation/electron-dev-output.md) | Active runbook | Classifying local Electron dev warnings and errors without suppressing stderr |
| [Session Migration Diagnostics](validation/session-migration-diagnostics.md) | Internal runbook | Isolated v8 → v9 source assessment, synthetic persistence proof and native evidence gaps |
| [Preserve-session Recovery](validation/session-recovery.md) | Active runbook | Single-role recovery authority, source support list, UI and native acceptance |
| [Web App DRM](validation/runbooks/web-app-drm.md) | Active runbook | HTTPS permission evidence and iq.com playback acceptance |
| [Windows Game Window Placement](validation/runbooks/windows-game-window-placement.md) | Active runbook | Physical Windows placement, DPI, and generation acceptance |

| [Chromium Extensions](extensions.md) | Active, additive capability | Extension packages, role leases, store presentation, and native validation |

## Machine-owned registries

| Registry | Authority |
| --- | --- |
| [Desktop E2E coverage](e2e-coverage.json) | Journey IDs, targets, profiles, phases, and feature coverage |
| [Event-topology exceptions](event-topology-exceptions.json) | Approved production liveness exceptions and their exact paths |
| [Validation archive manifest](validation/archive/manifest.json) | Immutable evidence paths and content hashes |

Query large registries by feature, journey ID, or exception ID. Do not load the
complete registry when a narrow query answers the task.

## Public and historical documents

Localized README and legal files are release-managed public documents, not
engineering context. [Rion Studio 2.0](release-notes-2.0.md) is a historical
product note.
Validation artifacts under `validation/archive` are exact-SHA evidence and are
never proof for current `HEAD` unless an active audit explicitly establishes
ancestry and applicability.

The retired WKWebView Game Mode and Brave/System WebKit comparison runbooks are
retained in the [validation archive manifest](validation/archive/manifest.json). Their launchers and performance gates do not apply to
the sole Electron runtime.
