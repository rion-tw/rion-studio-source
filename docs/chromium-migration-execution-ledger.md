# Chromium Migration Execution Ledger

This ledger tracks the remaining work between the current transition tree and
the owner-approved Electron/Chromium v23 production cutover. The normative
requirements remain in [Chromium Runtime Migration](chromium-runtime-migration.md)
and [Updater Install Transaction](updater-transaction-contract.md); this file is
only an execution view and must never be used to waive a gate.

Last reconciled: 2026-09-03.

## Current count

- At least five necessary work packages remain before the migration can be called
  done. A failed native gate may add remediation work, but cannot remove a gate.
- The known packages contain nine independently verifiable deliverables.
- All currently executable local repository work is implemented. The one
  remaining repository-mutation package is the deliberately gated sole-entry
  cleanup, which cannot begin until the external native and release gates pass.
  The real-transaction producer and terminal-promotion finalizer are implemented
  as hard-disabled transition code but remain open execution gates. One package
  is owner-controlled GitHub configuration. One package is current-SHA native
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
