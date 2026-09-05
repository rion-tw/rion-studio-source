# Chromium Migration Execution Ledger

This ledger tracks the remaining work between the current transition tree and
the owner-approved Electron/Chromium v23 production cutover. The normative
requirements remain in [Chromium Runtime Migration](chromium-runtime-migration.md)
and [Updater Install Transaction](updater-transaction-contract.md); this file is
only an execution view and must never be used to waive a gate.

Last reconciled: 2026-09-06.

## Current count

- Five release-cutover work packages remain before the migration can be called
  done. A failed native gate may add remediation work, but cannot remove a gate.
- The known packages contain nine independently verifiable deliverables.
- Within the currently authorized candidate-branch scope, implementation and
  local validation are complete. Candidate closure requires the latest branch
  head to have a green exact-SHA macOS/Windows CI matrix; the hosted status is
  reported in the handoff because it can change after this ledger is committed.
- The one later repository-mutation package is the deliberately gated sole-entry
  cleanup, which cannot begin until the external native and release gates pass.
  The real-transaction producer and terminal-promotion finalizer are implemented
  as hard-disabled transition code but remain open execution gates. One package
  is owner-controlled GitHub configuration. One package is exact-candidate native
  and physical-platform evidence.
- A passing portable or macOS-only test run does not reduce the Windows evidence
  count. Historical evidence does not count for the current source SHA.

## Local pre-cutover validation snapshot

The 2026-09-02 macOS working tree has passed the following non-GUI checks:

- the full Rust workspace test suite and Rust lint;
- the desktop-E2E build followed by a restored production renderer and the
  production-isolation verifier;
- the production Electron main/preload/renderer build and pinned runtime probe;
- an unpacked arm64 Electron application build plus the packaged-ASAR, fuse,
  native-addon, bundle-metadata, and ad-hoc-signature verifier; and
- the stable-v22-plus-scoped-Electron source architecture gate.

The packaged macOS addon links AppKit and QuartzCore and does not link WebKit,
which is the intended retained-AppKit/replaced-WKWebView boundary. This snapshot
does not close a release deliverable: the working tree is not an immutable
candidate SHA, no real updater transaction ran, and no Windows evidence was
produced.

The complete local macOS distribution formats also passed the production
package-binding verifier. The updater tar was safely extracted, the DMG was
verified and mounted read-only, and both copies reproduced the unpacked
application's exact package-manifest summary before their file identities were
re-read. This remains local working-tree evidence rather than a signed candidate
or updater transaction.

The current working tree was rebuilt as a release-mode arm64 Electron `.app`
on 2026-09-03. Its pinned Electron/Chromium/Node/Node-API/Rust runtime, ASAR,
production fuses, native addon, AppKit linkage, renderer purity, desktop-E2E
isolation, and stable-v22/scoped-Electron boundary all passed their local
verifiers.

An uncontested foreground macOS AppKit session then closed the remaining local
desktop gates:

- `chromium-tabs-visible-seed` and `chromium-tabs-visible-restart` passed with
  exact native topology, final flush, restart, and SQLite journal evidence in
  `.desktop-e2e-artifacts/2026-09-03T00-32-10-867Z-darwin`;
- `chromium-macro-cutover-terminal-cleanup-seed` and its restart passed with
  AppKit-Chromium binding, native application-quit, trusted-input cleanup, final
  flush, and SQLite clean-exit evidence in
  `.desktop-e2e-artifacts/2026-09-03T00-42-12-067Z-darwin`; and
- the five covered macOS journeys are
  `CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019`,
  `CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020`,
  `CHROMIUM-MACOS-APPKIT-RUNTIME-LAUNCH-DESTINATIONS-008`,
  `CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-TOPOLOGY-009`, and
  `CHROMIUM-MACOS-APPKIT-MACRO-TERMINAL-CLEANUP-006`.

The same reconciled tree passed source hygiene with the owner-approved 3,200
line ceiling and the unchanged 65,536-byte ceiling, TypeScript, lint with zero
errors, 424 JavaScript/TypeScript test files containing 3,174 tests, Rust fmt and
clippy with warnings denied, the full Rust workspace tests, the renderer/Tauri
build, and desktop-E2E coverage (P0 70/70, P1 66/66, and both Chromium platform
parity manifests 40/40).

## 2026-09-03 completion audit

- Local implementation and evidence are green: TypeScript, renderer, Electron
  main/preload, Rust workspace, contract generation, source hygiene, E2E
  coverage, foreground AppKit topology and terminal cleanup, release-package
  structure, and migration-boundary checks passed on the current working tree.
- No known local macOS implementation or foreground desktop-E2E task remains.
  This does not substitute for an immutable candidate's packaged update
  transaction or its Windows counterpart.
- Windows native build/install/update/trusted-input evidence cannot be produced
  by this macOS host. Portable tests and source checks remain supporting evidence
  only.
- Real updater transactions, terminal promotion, and protected recovery-store
  configuration require owner-controlled external state that is intentionally
  absent. Repository code must not invent or enable it.
- The sole-production-entry cleanup remains deliberately gated. Removing Tauri,
  System WebView, or dual-shell transition paths before the preceding native and
  release gates pass would violate the migration contract; `rion-appkit` remains
  after that cleanup.

## Owner-controlled GitHub audit

A read-only audit on 2026-09-03 confirmed that the owner-controlled gate is
absent rather than merely unverified:

- source `main` has neither branch protection nor a repository ruleset;
- none of the five Electron production environments declared by the transition
  workflows exists;
- the repository-level release App, updater public key, and stable-Tauri signing
  secret names exist, but the recovery-store repository coordinates and its
  separate reader/writer GitHub App variables and secret names are not
  configured; and
- the remote `main` still points to `0b6e42f0939bb341a935e1d6e5bf6f3858c56073`,
  while local `HEAD` is `7bec758a458475dc4ffebcdbdea069d35b3ffd92`
  plus an uncommitted migration working tree, and none of its
  `electron-production-*` workflows exists on remote `main`.

The most recent successful remote CI run therefore validates only that older
remote SHA. It is not current migration evidence. No GitHub setting, credential,
environment, branch rule, workflow, or remote ref was changed by this audit.

## Remaining work packages

| Package | Required deliverables | Current state | Completion evidence |
| --- | ---: | --- | --- |
| Real updater transaction producer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow seals one challenge and exact upstream identities, drives visible updater UI in four native cells, records product-authored terminality and target-process identity, detached-attests only each terminal receipt, and verifies the aggregate | Four exact source-runtime transactions: Tauri v22 and prior Electron to target Electron on both macOS and Windows |
| Terminal promotion finalizer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow re-verifies readiness/provisional/capsule/lease identities, brackets the sole lease release with exact target observations, writes only a create-new `promoted` receipt, and leaves every non-success path to durable recovery | Fresh external-state observation plus one terminal promotion receipt, with rollback or indeterminate closure for every non-success path |
| Sole Electron production entry and cleanup | 2 | Pending until every prior gate passes; Tauri v22 remains stable production | macOS and Windows release/CI matrices green; make Electron the only production entry, then remove Tauri/System WebView and dual-shell code while retaining `rion-appkit` |
| Owner-controlled release configuration | 1 | Approval and external setup pending | Explicitly approved private recovery repository, protected append-only branch, narrow GitHub Apps, protected environments, and matching variables/secrets |
| Current-SHA native release evidence | 2 | Pending physical/native execution | Retained AppKit-host macOS package/update evidence and physical Windows install/update/trusted-input evidence for the exact candidate SHA |

Repository code may validate and consume owner-controlled configuration, but it
must not create it, guess the repository identity, or enable public mutation
without owner approval.

The durable provisional-publication recovery package is no longer counted as
remaining repository implementation. Its hard-disabled workflow now covers the
private append-only capsule and outcome store, proof-derived one-shot mutation
markers, creator-only public mutation, zero-write resume and reconciliation,
rollback or held-lease release, and fresh terminal readback. All recovery jobs
remain statically disabled. The owner-controlled store, GitHub Apps, protected
environments, variables and secrets, plus an independent recovery drill, remain
part of the configuration gate above rather than inferred repository state.

The real updater transaction producer is also no longer missing repository
implementation. Its hard-disabled fixed workflow is covered by focused source,
contract, bundle, promotion-readiness, and full repository tests. This does not
complete either of its deliverables: the owner-controlled provisional endpoint
and native environments must still run all four exact transactions, including
retained AppKit evidence on macOS and physical Windows evidence.

The terminal-promotion finalizer is likewise no longer missing repository
implementation. Its closed receipt, file-bound CLI, source contract, and
hard-disabled workflow are covered by focused tests. This does not complete
either finalizer deliverable: the owner must first authorize and successfully
run the upstream four-cell producer, then authorize this finalizer against the
live public state. Unknown or failed mutation acknowledgement remains a durable
recovery outcome and is never promoted by elapsed time or local inference.

## 2026-09-04 current-branch validation hold

The active candidate branch is `codex/electron-chromium-v23-cutover`. Remote
commit `282751a3335d5a31be6c456912534a077e24314f` is not yet a completed candidate:
CI run `33872639465` found package-profile failures after the narrower macOS and
Windows desktop-E2E jobs passed. The Windows package failure is covered by an
uncommitted exact-process-exit correction. The macOS package failure exposed a
Quick Access foreground-focus gap which is also corrected in the working tree.

A subsequent full local `chromium-macos-appkit-smoke` run deliberately continued
past those known failures and exposed later validation defects. The Quick Access
seed/restart and background-tab phases now pass locally. The restart half of
`chromium-macro-cutover-topology` then exposed a saved-window hydration defect:
a visible Show intent moved the persisted Game Window from `dormant` to
`restoring`, but no native launch began. The exact cause was a schema-v2 restore
path writing the complete GameWindow back into the schema-v1 compatibility
snapshot field. Two valid workspace tabs shared one role; Rust normalization
removed the later legacy snapshot tab, so exact receipt validation rejected the
mutation before native hydration. The working correction persists only the
schema-v2 in-progress identity and keeps GameWindow state authoritative. It also
clears the full schema-v2 recovery cohort when the user discards all recovery.
Focused tests cover both shared-role tabs and an empty legacy snapshot field.
Foreground confirmation remains pending and the defect must not be bypassed by
creating a duplicate workspace tab or extending a timeout.

Foreground macOS automation is temporarily paused at the owner's request while
another full-screen application is in use. Until the owner resumes foreground
testing, work is limited to source/event-chain diagnosis, unit and static tests,
repository hygiene, and Windows/CI remediation. Before the next candidate push,
the complete local macOS AppKit smoke profile must pass from a clean start. Only
then may a new current-SHA CI matrix be dispatched.

The non-foreground working-tree validation after the correction is green:
source hygiene, TypeScript, ESLint (zero errors), 424 Vitest files / 3,207 tests,
Rust formatting and clippy, and the complete Rust workspace test suite. These
checks do not replace the paused macOS foreground profile or Windows CI.

The same hold also exposed and corrected a release-only AppKit ABI verifier
drift: the native addon and production host require ABI 6, while
`verifyElectronRuntime.mjs` still expected ABI 5. A pinned verifier regression
test now requires 6 and cross-checks the Electron AppKit host constant. The
release addon runtime probe, macOS arm64 Electron
package build, final `.app` structure verifier, ad-hoc signature/linkage checks,
DMG checksum, and tar payload inventory all pass locally.

## 2026-09-05 local candidate closure

The owner resumed foreground testing. The complete current-source
`chromium-macos-appkit-smoke` profile passed from a fresh start, including
saved-window seed/restart hydration, Quick Access foreground activation,
shared-role tab restoration, browser-data cleanup, workspace-web surfaces,
trusted input, macro terminal cleanup, native AppKit tab identity, and clean
exit. Its artifact root is
`.desktop-e2e-artifacts/2026-09-05T10-53-54-780Z-darwin`.

The retained stable shell was then revalidated from the same tree. The macOS
`smoke` profile passed fullscreen toolbar, contained fullscreen, seed, and
restart journeys in
`.desktop-e2e-artifacts/2026-09-05T14-30-52-724Z-darwin`. The complete macOS
`full` profile also passed native macro input and cleanup, role-store isolation,
workspace recovery, cross-domain lifecycle, system-settings boundaries, and
Game Window seed, restart, force-terminate, crash-restart, and crash-discard
journeys in `.desktop-e2e-artifacts/2026-09-05T14-33-20-538Z-darwin`. This
preserves local evidence that the v22 AppKit/WKWebView fallback remains healthy
while the v23 Chromium candidate retains AppKit presentation.

The fresh 8.5.0 macOS Electron distribution then passed the pinned runtime,
ASAR/fuse/native-addon/AppKit-linkage/package-structure verifier and the packaged
black-box AppKit Role journey. The black-box accessibility probe now follows the
actual retained native hierarchy through `AXScrollArea`, validates the prefixed
AppKit window/tab identity before pressing content, and quits with the physical
Command-Q key code.

The packaged updater gate also passed locally with a CI-equivalent ephemeral
trust fixture. It built a real ad-hoc-signed 8.3.0 Tauri v22 application with the
`rion-tauri` executable and no Electron `app.asar`, then verified the 8.3.0 and
8.4.0 source transitions into the signed 8.5.0 Electron archive, rollback,
wrong-platform rejection, recovery journal removal, and audit-token-supervised
active-zero process cleanup. The macOS helper sandbox now permits only its
bundle executables, framework helpers, and the fixed `/usr/bin/codesign` needed
to validate the replacement; unrelated external execution remains denied. The
process admission bound is 10 seconds so a freshly copied app can complete the
OS policy check, while the authoritative updater acknowledgement remains a
separate fail-closed 120-second external boundary.

The reconciled tree passes source/document/dependency hygiene with the
owner-approved 3,200-line limit, TypeScript, ESLint with zero errors, all 426
Vitest files containing 3,223 tests, Rust formatting and clippy with warnings
denied, the full Rust workspace suite, production build, desktop-E2E build, and
production renderer isolation. Coverage remains P0 70/70, P1 66/66, and both
Chromium platform manifests 40/40.

The first exact-SHA hosted matrix for branch
`codex/electron-chromium-v23-cutover`, run `33972543890` at
`4dfa8e1fdd64e35aae5321adb233dfae9044aa49`, passed checks, both native
validation jobs, macOS desktop E2E, renderer assets, and the Linux sanitizer and
concurrency soak. Its three failures exposed native evidence gaps rather than a
new product-boundary decision: the Windows package workspace exceeded the
ordinary SQLite `MAX_PATH` open boundary; the macOS Chromium evidence validator
rejected a legitimate fully hidden ready observation between native close and
show; and the Windows stable native-menu input plan counted middle menu rows
whose native representation is host-dependent. The candidate corrections use a
verbatim Windows SQLite destination path when required, preserve strict visible
terminal-state validation while admitting the exact hidden-ready state, and
select Hide relative to the final actionable menu item. These corrections still
require a green exact-SHA hosted matrix and Windows evidence is never inferred
from this macOS host.

The second exact-SHA matrix, run `33973955767` at
`f8a380e211430d0d997e870498d82c7b5f7f2831`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, macOS desktop E2E, and both native
validation jobs. It confirmed that the Windows SQLite long-path correction and
the macOS hidden-ready evidence correction work. The remaining three failures
each exposed a later physical boundary. The macOS package reached empty Game
Window creation, where AppKit's authoritative layout callback legitimately
updated saved placement and `updatedAt`; the Electron coordinator compared the
entire saved record and compensated the valid host. The correction now retains
immutable saved-window identity, requires monotonic time and exact active-display
geometry, and permits only the expected native placement commit. The local
AppKit `chromium-game-window-ui-seed` and seed-plus-restart runs pass with that
correction.

The Windows package advanced through Chromium Game CRUD and entity persistence,
then showed that a physical workspace-divider release could cross from its thin
host control into an adjacent Chromium `WebContentsView`. The Windows host now
keeps its transparent divider layer pointer-active for the drag lifetime and
terminalizes from document release, cancellation, lost capture, or host blur.
The stable Windows desktop E2E also proved that the separator between Hide and
Stop consumes one native keyboard traversal; the exact input plan now anchors
at Stop and crosses the separator before selecting Hide. These Windows
corrections remain pending physical validation on the next exact-SHA matrix.

The third exact-SHA matrix, run `33975626227` at
`4c27f13430f48424705be8b6235a0249705e04e7`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, both native validation jobs, and the
Windows desktop E2E. It therefore closed the preceding Windows native-menu and
both-platform native-validation gaps. Its three later failures exposed exact
terminal-boundary defects. The Windows package proved that the physical divider
updated the authoritative Runtime Kernel topology to 55/45 while an equal-revision
SQLite follower remained at 50/50. Internal Runtime Kernel snapshots may now
replay an equal generation and revision to repair that stale follower, while the
public commit API retains strict latest-wins duplicate supersession. A focused
Core regression test covers both sides of that fence.

The stable macOS cross-domain journey proved that two successive visible Quick
Open launches could race after the native dialog closed but before React finished
its awaited launch and recency mutation. The palette now publishes an explicit
presentation state, and the E2E waits for the authoritative React-closed state
before beginning the next visible action. The macOS Chromium macro cleanup
journey also showed that traversing every accessibility descendant of an AppKit
window could enter Chromium's large accessibility tree and exhaust the external
automation boundary. Known game windows are now closed through their exact
retained AppKit `AXIdentifier` and native close button; the descendant fallback
remains only for controlled popups without a game-window identity. The three
corrected journeys pass locally on physical macOS: stable
`p1-cross-domain-seed`, Chromium/AppKit
`chromium-macro-cutover-terminal-cleanup-seed`, and Chromium/AppKit
`chromium-workspace-web-slot-seed`. Windows packaging and the new branch head
remain pending the next exact-SHA hosted matrix.

The current correction tree passes 426 Vitest files containing 3,224 tests,
TypeScript, ESLint with zero errors, source/document/dependency hygiene, Rust
formatting and clippy with warnings denied, the full Rust workspace suite,
production Tauri and Electron builds, Electron renderer purity, and production
desktop-E2E isolation. The local Core suite includes 955 tests, including the
equal-revision authoritative-follower repair regression.

## Non-completion rules

- Actions artifacts alone are not durable recovery storage.
- The public latest lease alone is not rollback evidence.
- Compatibility probes with `sourceUpdaterInvoked: false` are not real updater
  transactions.
- Candidate and readiness receipts are not terminal publication receipts.
- A hard-disabled recovery workflow is not an enabled publication path or an
  owner-approved recovery drill.
- Removing Tauri before exact-SHA macOS and Windows gates pass is not cutover.
- Replacing AppKit presentation with generic HTML or `BrowserWindow` chrome is
  outside the product target.
