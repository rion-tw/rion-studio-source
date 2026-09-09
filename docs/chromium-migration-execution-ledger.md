# Chromium Migration Execution Ledger

## Owner scope — 2026-09-09

The owner now requests only the final v22 configuration delta and the sole
Electron entry with old-runtime cleanup. All other previously remaining ledger
workstreams are removed from this task and are not prerequisites. This explicitly
supersedes the earlier protected-runtime hold for the requested repository
cleanup. Publication, merge and credential changes remain outside this task.

| Work package | Deliverables | Current state |
| --- | ---: | --- |
| Final v22 configuration delta | 1 | Read-only comparison complete: existing repository, App, updater secrets, endpoint, identity and asset names can be reused; see the configuration delta report. No remote settings changed. |
| Sole Electron entry and old-runtime cleanup | 2 | Complete: default/release entry points target Electron; Tauri/System WebView and obsolete launch/E2E paths are removed; provisional release jobs are disabled. Complete native, profile and package verification is bound below. Rust authority, AppKit and consumed v22 data compatibility remain. |

There are two scoped work packages / three deliverables, not the earlier four
packages / seven deliverables. All three deliverables are complete, with no
remaining task-scoped gate. API closure counts from the retired backlog are no
longer used to gate this task.

The [configuration delta](v22-configuration-delta.md) records exact baseline SHA,
GitHub observation time and release/asset IDs. No physical dual-monitor, actual
OS sleep/sign-out, real production updater transaction or terminal-promotion
execution is queued. Existing simulations and fixture evidence retain their
actual classifications; removed work is not labeled PASS.

## Completion checkpoint — 2026-09-09

The final Windows validation source is
`40e21d19070a21d4f2cbe78f1e2ff7cc2aa17b75`.
[CI 34291837369](https://github.com/rion-tw/rion-studio-source/actions/runs/34291837369)
is terminal **SUCCESS in all five jobs**. Later commits change documentation
only. Program/verifier changes and documentation were committed separately;
the last verifier change is `9433f25b1cf0875aa9ada98cc1b531593937129a`.

| Deliverable / invariant | Completion evidence |
| --- | --- |
| Final v22 configuration delta | Read-only settings/asset comparison and actual Rust endpoint fetch in the configuration delta report; existing repository, release App, keys, endpoint, identity and asset names are reused. No remote configuration or credential change. |
| Sole Electron entry / retired runtime | Default dev/build/package/dist and existing release workflows target Electron. Tauri shell, WebView2/WKWebView engine code and obsolete launch/E2E paths are absent. Source/dependency/renderer-boundary and complete hygiene checks pass. Five ignored local generated schemas were preserved with matching bytes/hashes. |
| Native and shared regression | Windows: Rust 1106 PASS / 4 ignored, native integration 16 PASS, full JS 3695 PASS / 48 platform skips. Shared CI: JS 3718 PASS / 29 platform skips, lint/typecheck/hygiene and sanitizer/concurrency pass. The 256-round updater concurrency assertion remains intact. |
| Complete Chromium journeys | Windows 58 PASS + 4 expected force / 54 journeys PASS; macOS 56 PASS + 4 expected force / 52 journeys PASS. Both reports match their exact-source manifests, and every normal phase has final flush and process exit. |
| Package / updater / native black-box | Windows final-source NSIS installed payload, Rust updater fixtures, package identity and visible native black-box all pass. Retained macOS package, published-v22-source fixture and AppKit black-box all pass at the exact source below. |
| Rust / AppKit / legacy compatibility | Rust remains the data/topology/terminality/Macro authority; the typed bridge, retained AppKit host and consumed v22 data/updater compatibility remain. No second runnable shell, user Chrome profile runtime or renderer Node/Tauri fallback. |

The retained macOS runtime evidence is from
`c52decf9d4c55888f5a0d2e979884d2387020223`, CI 34286895282: native job
102264594395 has **1116 Rust PASS / 5 ignored** and **14 native integration PASS /
2 platform skips**, while package job 102264458817 is SUCCESS. Differences
after that runtime source are test-only Rust shutdown observations, equivalent
test regex formatting, verifier pipe-drain diagnostics/tests and documentation;
they do not change the distributed runtime or native ownership. The new verifier
observations have explicit darwin/win32 unit coverage; no later macOS native run
is claimed, and completed macOS acceptance was not redispatched.

Historical Windows SQLite teardown, Job diagnostic timeout, runtime-probe access
violation and local VM input/symlink failures retain their exact failure records.
The historical Darwin malformed process-group row also remains unreproduced.
Later success does not prove a causal fix for those historical observations.
No physical/production requirement was converted to PASS, no publication or merge
was performed, and no release infrastructure or credential was introduced.

### Final Windows package identity

Package job 102279853042 is terminal SUCCESS on Windows Server 2025 Datacenter
10.0.26100, image `windows-2025-vs2026` `20260824.214.3`. It verifies Electron
43.6.0, Chromium 150.0.7871.250, Node 24.20.0, Node-API 10 and Rust Core 8.5.0
on win32-x64, including the runtime probe that previously crashed.

Artifact 10082607888 was downloaded and SHA-256 verified:
`9dd2ab84f173e4fb217853084266bca0318f2f7b421d0cac0ccec9def91bbaaa`.
The fixture 8.5.0 NSIS installer is 101625818 bytes, Authenticode-unsigned,
SHA-256 `601f06ec9607b1e6354a09854442048b7dfac03c9299680e44bf2100ea8c43fa`.
The source and normalized installed manifests are identical, adding only the
root NSIS uninstaller and changing/removing no source files. The source,
normalized install and black-box all bind package manifest
`e73299c8de0c4839fc0479427bb82b98b6ea42996889120384a4c1e018f3bf29`
(79 entries, 407337638 regular-file bytes).

Both Rust updater fixture cases pass for 8.4.0 to 8.5.0, using that installer
digest and manifest digest
`8f9a87676e92f3ac144491df3256fb532458838683ca29b6bbabf2b72a91a486`.
Their observations remain non-authoritative and are not production terminal
receipts. Packaged black-box root
`2026-09-09T00-19-16-687Z-e689d63e-e8a9-4cd6-ba61-6b8ad612c017-win32-packaged-black-box`
is PASS: visible OS accessibility click, bundled Chromium host, temporary local
Windows profile, no remote debugging and exit code 0. Its executable, app.asar
and native-addon digests match the corresponding installed-source entries.
ZIP, selected reports, job observations and both reconciliation scripts/results
are retained under `.desktop-e2e-artifacts/ci34291837369/`.

The following checkpoints retain the state observed at their respective times;
their earlier pending states and failed candidates are historical, not queued
work. This completion checkpoint is the current scope/status authority.

## Published-source fixture and release-entry checkpoint — 2026-09-09

Latest verifier change: `9433f25b1cf0875aa9ada98cc1b531593937129a`.
The 373880b8 Windows package job 102270917982 is terminal **FAIL**, after
release artifact build, previous-version fixture preparation and extension
seed/restart all passed. At `2026-09-08T23:35:18.2339793Z`, the next runtime
probe exited with decimal `3221225477` (`0xC0000005`, Windows access violation),
without retained child stderr. Package structure, NSIS installed payload, updater
and black-box steps after it did not execute. Failure bundle 10081435766 has
SHA-256 `2c4862569a0210861f3df4a66ded8372d21d3eee7c3f97859d38652271e07816`;
it is not a successful package receipt. Selected original job-log lines are
`ci34288948657/windows-runtime-probe-failure.log` under the local artifact root.

One unchanged-source local x64 `pnpm run verify:electron-runtime` on clean
`a08cf27fec6e86be42e8e4308a0264d18f432491` passed with Electron 43.6.0 and
Rust Core 0.1.0; it did not reproduce the crash in the CI 8.5.0 fixture context.
Receipt prefix: `windows-takeover-4e5ec764/sole-entry-a08cf27f-runtime-access-violation-focused`.
The prior verifier collected streams at process `exit` rather than pipe `close`
and omitted stdout on a nonzero exit. Consequently the original failure cannot
show whether its version payload had already been written before the crash.

Commit 9433f25b corrects that observation boundary, retains the last 16384
characters of each stream on failure, and writes fixed synchronous probe stages
before Electron import, at readiness, around addon loading and after the contract
write. Nonzero exit remains failure even with a valid payload; no retry, timer,
deadline or product runtime change was added. Six new explicitly darwin/win32
tests cover data arriving after exit, a payload followed by a crash, and bounded
native noise. The two adjacent files pass **13 tests / 1 existing platform skip**;
typecheck, full lint (0 errors / 23 existing warnings), source hygiene and the
changed local x64 runtime probe pass. This is `internal-only` verifier work with
no changed product journey; the access violation remains unreproduced, not fixed.
Final package verification of the changed verifier subsequently completed in
the exact-source run below.

[Windows CI 34291837369](https://github.com/rion-tw/rion-studio-source/actions/runs/34291837369)
was dispatched once at `2026-09-08T23:42:26.460Z` for exact source
`40e21d19070a21d4f2cbe78f1e2ff7cc2aa17b75`, after finding zero existing runs
for it. That source consists of the verifier/test commit 9433f25b and its
documentation. All five jobs are terminal SUCCESS. Scope is Windows only; no completed
macOS acceptance was redispatched and no publication was requested.
The dispatch receipt is `sole-entry-runtime-probe-output-ci-dispatch.json`
under `.desktop-e2e-artifacts/`. Shared checks job 102279853600 is terminal
SUCCESS: **3718 JS PASS / 29 platform skips** (448 passing files / 9 skipped),
including the six new probe-output tests; portable Rust **997 PASS / 1 ignored**,
lint 0 errors / 23 existing warnings, and complete hygiene/typecheck pass.
Renderer build 102279853346 and sanitizer/concurrency 102279853289 are also
SUCCESS. Windows native 102279976389 is terminal SUCCESS: **1106 Rust PASS /
4 ignored**, **16 Electron native integration PASS**, and complete Windows JS
**3695 PASS / 48 platform skips** (447 passing files / 10 skipped). Native lint
and adapter build pass. The import-teardown case and unchanged 256-round updater
test pass, and every Windows Job diagnostic stage is observed through cleanup
at 7081 ms within its original 10000 ms budget. Package 102279853042 is also
terminal SUCCESS; its installer/updater/black-box identities are bound above.
Selected shared-check job observations are retained in
`ci34291837369/shared-checks-summary.log`; native observations are in
`ci34291837369/windows-native-summary.log` under the local artifact root.

The complete Windows profile on exact source 40e21d19 has also passed:
report root `2026-09-08T23-44-32-268Z-win32`, **58 PASS + 4
EXPECTED_FORCE_TERMINATION / 54 journeys PASS**. It ran from
`2026-09-08T23:44:32.414Z` to `2026-09-09T00:03:04.492Z`; its fixture version
application is the expected dirty worktree flag. Artifact 10082164316 matches
SHA-256 `909ab2bcef635d3463bbbee4c707f071345ad5464819d87835d1c0d7da79b55e`.
The downloaded report matches the exact source manifest's complete phase order,
derived journey verdicts and the four expected-force phases, with no normal
final-flush/process-exit failures. ZIP, report and reconciliation output remain
under `ci34291837369/` in the local artifact root. The package job subsequently
completed every stage as recorded in the completion checkpoint.

Final verification candidate: `c52decf9d4c55888f5a0d2e979884d2387020223`
(documentation on top of the program commits below). On the clean Windows
worktree, `pnpm run build` passed in 11.31 seconds and
`pnpm run check:desktop-e2e-isolation` passed. Both commands used Node 24.20.0
x64 and Rust 1.98.1 x64; full source/runtime/time/exit receipts are
`windows-takeover-4e5ec764/sole-entry-c52decf9-{build-x64,isolation}.result.json`
under `.desktop-e2e-artifacts/`.

[CI 34286895282](https://github.com/rion-tw/rion-studio-source/actions/runs/34286895282)
was dispatched once for this exact source at `2026-09-08T22:38:09.507Z`, after
checking that no existing run used it. Scope is `all`: the changed published
macOS fixture needs the previously failing native package stage, and complete
JS must cover the corrected runner assertion and retain Job-stage diagnostics.
This is not a rerun of an unchanged historical source. Current job handles:
shared checks 102264458635; macOS/Windows native 102264594395/102264594440;
macOS/Windows package 102264458817/102264458843. Renderer build is already
SUCCESS. Shared checks completed with **3712 JS PASS / 29 platform skips**;
the job then failed on two `no-regex-spaces` lint errors in the newly added
workflow-retirement test. Commit `1b30cd2e1710124c4baa48d8f90f760fbbc7e6da`
replaces literal indentation spaces with equivalent `{2}` / `{4}` counts.
It changes only that test, not runtime, packaging, fixtures, workflow execution
or assertions. The 12 adjacent tests, complete lint (0 errors / 23 existing
warnings), and hygiene pass locally; logs are
`sole-entry-retired-workflow-regex-{check,lint,hygiene}.log` under
`.desktop-e2e-artifacts/`. The full JS result remains attributed to c52decf9,
not to the later test-formatting commit. Sanitizer/concurrency is also SUCCESS.
macOS native job 102264594395 is terminal SUCCESS: Rust **1116 PASS / 5 ignored**,
Electron native integration **14 PASS / 2 platform skips**, native lint and
adapter build passed. Windows native job 102264594440 is terminal FAIL: AppKit
portable stubs 4 PASS, then Core 981 PASS / 1 FAIL / 1 ignored. Its exact failure
is `app::tests::a_fully_verified_import_journal_allows_launch_without_new_role_evidence`
at `behavior_21_session_migration_launch_gate.rs:1211`, with
`StateDatabase("state worker shutdown timed out after 3 seconds")` during checked
Chromium teardown. Later native/Windows JS steps did not run. The automatically
invoked loader diagnostic also exited 1, but this was an executed Rust test
failure, not a test-executable loader failure. Both package jobs later completed
as SUCCESS; their exact-source evidence is recorded below.
No publication was dispatched.

The exact import-teardown test passed once locally on clean source
`c7edd7b4a7036dd5824ab37b73cdaeaa56f11033`: 1 PASS in 2.52 seconds using Windows
x64 Rust 1.98.1. This does not reproduce or fix the CI timeout. Receipt/log:
`windows-takeover-4e5ec764/sole-entry-c7edd7b4-import-teardown-focused.*` under
`.desktop-e2e-artifacts/`. Source inspection confirms that checkpoint and SQLite
connection close precede the successful shutdown response.

Commit `c03203f4c24b1c8b23c416a27b6cdaebc9323b04` adds only `#[cfg(test)]`
fixed observations for shutdown request, checkpoint entry/exit, connection close
and response. They expose which existing native boundary is outstanding without
changing production code, authority, failure results or the 3-second budget.
Windows x64 Rust lint and source hygiene pass. The complete local x64 Rust
suite passed against that clean source: **1106 PASS / 4 ignored / 0 FAIL**,
including the unchanged 256-round concurrent updater test and the exact import
teardown test. It ran from `2026-09-08T22:59:02.624Z` to
`2026-09-08T23:02:37.083Z` using Node 24.20.0 x64 and Rust 1.98.1 x64.
`windows-takeover-4e5ec764/sole-entry-shutdown-stage-full-rust.*` retains the full
command, clean source, log and exit receipt. The CI timeout is not reproduced;
diagnostics are not a runtime fix.

[Windows CI 34288948657](https://github.com/rion-tw/rion-studio-source/actions/runs/34288948657)
was dispatched once at `2026-09-08T23:04:20.199Z` for exact source
`373880b86092b31d6b7670d0cdc430ea67fe789f`, after confirming zero existing runs
for it. This source includes both test-diagnostic changes, the equivalent regex
lint fix and documentation. Production runtime/package code remains identical
to c52decf9. Scope is Windows only, to obtain the native integration and complete
Windows JS results that the prior Rust failure prevented. macOS jobs completed
on c52decf9; no macOS acceptance was redispatched. The new Windows run
has completed shared checks as SUCCESS: **3712 JS PASS / 29 platform skips**,
lint 0 errors / 23 existing warnings, portable Rust 997 PASS / 1 ignored,
renderer build and sanitizer/concurrency SUCCESS. Windows native job
102271073604 is terminal SUCCESS: Rust **1106 PASS / 4 ignored**, Electron
native integration **16 PASS**, and complete Windows JS **3689 PASS / 48 platform
skips** (446 passing files / 10 skipped files). Rust lint and native adapter build
also pass. The exact import-teardown case and the unchanged 256-round concurrent
updater test pass in this full suite. Windows Job diagnostics reach every stage,
including cleanup at 5705 ms, within the original 10000 ms test budget.
Neither the earlier 3-second SQLite teardown failure nor the earlier 10-second
Job-test timeout is reproduced; later success does not establish a causal fix.
Selected immutable-job log observations are retained as
`ci34288948657/windows-native-summary.log` under `.desktop-e2e-artifacts/`.
The package job later failed at its runtime probe as recorded above; its later
package/install/updater/black-box steps did not execute.

The complete Windows profile on this same 373880b8 source is also verified:
report root `2026-09-08T23-05-45-983Z-win32`, **58 PASS + 4
EXPECTED_FORCE_TERMINATION / 54 journeys PASS**. Artifact 10081108347 matches
SHA-256 `a401fb70ba30149aaf5d46af8da9de631edc504f0e3a82cc98439f0f75b37696`.
The exact source manifest, phase order, derived journey verdicts, four expected
force phases, and all normal final-flush/process-exit results were reconciled.
The report ran from `2026-09-08T23:05:46.272Z` to `2026-09-08T23:23:22.174Z`;
fixture version application accounts for the dirty worktree flag. ZIP, report,
reconciliation script and summary are retained under `ci34288948657/` in the
local artifact root.

### Final runtime-source complete profiles

Both complete profile artifacts from CI 34286895282 have now been downloaded,
SHA-256 checked and reconciled against the manifest at the exact runtime source
`c52decf9d4c55888f5a0d2e979884d2387020223`. Phase order and every derived journey
verdict match; every normal phase has final flush and process exit. Fixture
version application explains `worktreeDirty: true` in these reports.

| Platform | Report root | Phase / journey verdicts | Artifact ID |
| --- | --- | --- | --- |
| Windows | `2026-09-08T22-39-52-638Z-win32` | 58 PASS + 4 EXPECTED_FORCE_TERMINATION; 54 journeys PASS | 10080334586 |
| macOS AppKit | `2026-09-08T22-39-20-498Z-darwin` | 56 PASS + 4 EXPECTED_FORCE_TERMINATION; 52 journeys PASS | 10080404245 |

Expected-force phases are exactly app, mixed, window and window-restore recovery
on each platform. Windows artifact SHA-256:
`ffb73b302f96c4588faf1bd975d2e1d7f870f1a3aa9427b3627b310f99834f71`;
macOS artifact SHA-256:
`67b64588637d5c5d16e4e963fdfc76a78eb296c9f2b2fad28687425b4ca62244`.
ZIPs, reports and manifest-reconciled summaries are retained under
`.desktop-e2e-artifacts/ci34286895282/`. Complete profiles do not replace package
verification results.

### Final runtime-source macOS package

Job 102264458817 is terminal **SUCCESS**. It verified Electron 43.6.0,
Chromium 150.0.7871.250, Node 24.20.0, Node-API 10 and Rust Core 8.5.0 on
darwin-arm64. Host: macOS 26.6.2 (25G83), runner image `macos-26-arm64`
`20260831.0337.3`; app structure, ad-hoc signing, DMG and updater distribution all
passed. The fixed published v8.3.0 source passed native fixture preparation,
including its pinned bytes/hash, plist versions and strict codesign verification.

The Rust packaged updater probe completed four applied cases: manifest
fail-closed, Electron-layout replacement from fixture versions 8.3.0 and 8.4.0,
and helper handoff/relaunch from the real published Tauri v22 8.3.0 source to
the CI fixture 8.5.0 target. Target archive SHA-256:
`90805a83bdf18b5cd4aaf7d8ab6af7df9297d2cd83decf8553e4b8f34e793bd5`;
manifest SHA-256:
`465e7583c63e3f83bc20570353cdd43116c43614fc4749ffc70359945ba2359a`.
The job-log observations are retained as
`ci34286895282/macos-packaged-updater-observations.json` under the local artifact
root, explicitly non-authoritative and not a production terminal receipt.

Packaged AppKit black-box report
`2026-09-08T23-09-50-354Z-cd7ec567-41ec-49c8-8057-4da9f545a664-darwin-packaged-black-box/packaged-smoke-report.json`
is PASS: visible OS accessibility click, `appkit-chromium` host, fixed isolated
macOS home, no remote debugging and exit code 0. It binds package manifest
`dc33d9fb90307f761eb198a575fbeb2941a2747ee91257ac2c0c05b6adac749e`
(601 entries: 319 directories, 268 regular files, 14 symlinks;
316183585 regular-file bytes). Artifact 10080738353 was downloaded and matched
SHA-256 `04c53180c197da2ec473b1885947f66745fa889638fe9a737a1497882a0d8d87`.
The ZIP and selected report are retained under `ci34286895282/`.
This completes the previously failing macOS package path at the exact c52decf9
runtime source; it does not establish production-key cutover or a real source
updater fetching a production release.

### Final runtime-source Windows package

Paired job 102264458843 is terminal **SUCCESS**, including complete profile,
direct View input ownership, release build, runtime/extension isolation, package
structure, distribution, exact NSIS installed payload, Rust updater and packaged
native black-box. Artifact 10080836624 was downloaded and verified against
SHA-256 `26aa0037d11054b22fa50680661f5c536fb3cb26d82e676ef2985a62a62fefd5`.
Host: Windows Server 2025 Datacenter 10.0.26100, runner image
`windows-2025-vs2026` `20260824.214.3`. Runtime verification confirms Electron
43.6.0, Chromium 150.0.7871.250, Node 24.20.0, Node-API 10 and Rust Core 8.5.0
on win32-x64. This hosted runner is distinct from the local Windows ARM64 VM.

The fixture 8.5.0 installer is 101626449 bytes, Authenticode-unsigned, SHA-256
`ae1363d64e4eebee34361e79563de6f611f9e68093e727e54624158abd4cc719`.
Its installed payload matches the source exactly, with only the root NSIS
uninstaller added and no changed/removed files. The source, normalized installed
payload and black-box bind the same package manifest:
`c474f3ac369c2e54428b1c8e9e41f86a047753a37ab72444d5862cb275974559`
(79 entries, 407337638 regular-file bytes).

The two Rust updater probe cases pass for fixture 8.4.0 to 8.5.0, using that
same installer digest and manifest digest
`9a2d84e6fee750b0be4eb54cadcda668d82aefa2e0f7e85af3b9fb93c1a9062c`.
They remain non-authoritative diagnostics, not production terminal receipts.
Black-box report root
`2026-09-08T23-13-13-882Z-4580f360-6ad4-4dc0-b9ca-670ce595a894-win32-packaged-black-box`
records PASS, visible native interaction, bundled Chromium, isolated temporary
Windows user profile, disabled remote debugging and exit code 0. ZIP, exact
reports and cross-reconciled summary are under
`.desktop-e2e-artifacts/ci34286895282/`. Both platforms' package evidence is now
complete at runtime source c52decf9; the later Windows diagnostic-source CI is
still pending and does not rewrite the earlier native test failure.

### Local retirement preservation

The tracked old runtime and launch roots are absent. A final filesystem audit
found five ignored JSON schemas in the retired Tauri generation directory.
Their exact bytes and SHA-256 were preserved, then the old local directory was
moved to `.desktop-e2e-artifacts/retired-local-tauri-generated-20260909/`.
`preservation.json` records the original paths and verified destination hashes.
No user file was discarded or overwritten; the source `src-tauri` directory is
now absent too. `pnpm run verify:system-only` passes. The four requested handoff
ancestors are still in HEAD history, and the tracked worktree is clean.
Local scope/provenance observations are retained in
`.desktop-e2e-artifacts/sole-entry-completion-audit.json`; it deliberately records
`complete: false` while final Windows CI remains pending.

Program commits:

- `dc1432e181e51fed5dc1e3c66c6eadda20ce835c`: consume the pinned published
  v22 macOS source instead of rebuilding the removed Tauri shell; accept only
  matching POSIX file-type bits in Rust-tar headers; correct the retired runner
  assertion and add bounded Windows Job test-stage diagnostics.
- `e223e2f24dcf2b12a2f10a49e8f279af17fabc67`: disable the remaining provisional
  candidate, compatibility-lineage, readiness and publication jobs. Every job in
  all eight provisional workflows is now disabled. Existing `desktop-release-*`
  workflows remain the release entry; no remote configuration changed.

### Exact prior CI evidence

[CI 34281548249](https://github.com/rion-tw/rion-studio-source/actions/runs/34281548249)
used source `9c19a4008188a448da83e58f7fba654337200032`. The package jobs apply
fixture version 8.5.0, so E2E reports correctly record a dirty version-adjusted
worktree. This is fixture evidence, not production updater evidence.

| Evidence | Actual result |
| --- | --- |
| Shared JS | 3706 PASS / 29 platform skips |
| Windows native | Rust 1106 PASS / 4 ignored; native integration 16 PASS; JS 3682 PASS / 1 FAIL / 48 skips. Missing signer await was fixed in `e91316e88a2f0414c942ea6744e6d23938f5de4a`. |
| macOS native | Rust 1116 PASS / 5 ignored; native integration 14 PASS / 2 platform skips |
| Complete Windows Chromium profile | 58 PASS + 4 EXPECTED_FORCE_TERMINATION; 54 journeys PASS. Every normal phase has final flush and process exit. Report root `2026-09-08T21-38-09-149Z-win32`. |
| Complete macOS Chromium profile | 56 PASS + 4 EXPECTED_FORCE_TERMINATION; 52 journeys PASS. Every normal phase has final flush and process exit. Report root `2026-09-08T21-37-54-373Z-darwin`. |
| Windows package job 102247242665 | SUCCESS: NSIS installed payload matches the exact source tree; only the installer-owned uninstaller is added. Version 8.5.0; Authenticode-unsigned; installer 101628046 bytes. |
| Windows Rust-owned packaged updater probe | PASS for manifest fail-closed and installed-layout replacement/relaunch cases, prior Electron 8.4.0 to fixture 8.5.0. The report explicitly states `authoritative: false` and `productionTerminalReceipt: false`. |
| Windows packaged native black-box | PASS: visible OS accessibility click, bundled Chromium host, isolated temporary local-user profile, remote debugging false, exit code 0. Exact report is `2026-09-08T22-12-46-722Z-340fbfac-6d43-4d59-b12d-9954aa0375ee-win32-packaged-black-box/packaged-smoke-report.json`. |
| macOS package job 102247242846 | FAIL at previous-version fixture construction: it attempted `pnpm exec tauri build` after Tauri retirement. Packaged updater/black-box steps did not run. Fixed source still requires native macOS CI. |

Windows installer SHA-256:
`19c34b0211b94ad87ac4d10548ca1c1aa9c8a6d1467308bdc36a90e878685911`.
The black-box and installed-payload proofs bind the same package manifest:
`b11ee5e66365ef3ee3861d25f392ccaa593791eef8a5e2080d8b236633f915fc`
(79 entries, 76 regular files, 3 directories, 407337638 regular-file bytes).
Artifact 10079004994 SHA-256:
`13c27b498e969c94a844d07d3d8ed67787e5c800e3c46bde2b4eb3c47c011675`.
Profile artifact IDs: Windows 10078389872, macOS 10078569440; macOS failure
artifact 10078923541. Downloaded ZIPs and selected reports are retained under
`.desktop-e2e-artifacts/ci34281548249/`. The black-box report was initially
missed by a filename filter for `report.json`; inspection of the actual ZIP
found `packaged-smoke-report.json`. No CI rerun was needed to recover it.

[Windows CI 34284338910](https://github.com/rion-tw/rion-studio-source/actions/runs/34284338910)
uses source `b6ea7ae8425eb1c0c43046660ca466e68233be04`. Shared JS completed
with 3700 PASS / 1 FAIL / 29 skips: a stale runner-source assertion. Windows
native job 102256438416 completed with Rust 1106 PASS / 4 ignored and native
integration 16 PASS; Windows JS has 3676 PASS / 2 FAIL / 48 skips. Its failures
are that same assertion and the original 10000 ms Job diagnostics deadline.
The assertion is corrected in dc1432e1. The deadline failure is not reproduced
locally: direct fixture 1791 ms; instrumented focused test PASS in 2.27 seconds.
Bounded stage observations now expose compilation, exact root assignment/exit,
Job empty notification, survivor rejection and cleanup without deciding success.
The deadline and every native assertion remain unchanged. Package job
102256294098 is now terminal **SUCCESS**, including native/package verification,
artifact retention and cache cleanup; do not redispatch that source.

The b6ea7ae8 Windows profile report was downloaded from artifact 10079464266
(SHA-256 `bff53b3991a1931c8f3cbe4d52429c41cb9d8e71be5d3893d63e90a84b011452`).
Its exact source manifest resolves all 62 observed phases in the same order:
58 PASS + 4 EXPECTED_FORCE_TERMINATION, with 54 journeys PASS and no normal
final-flush/process-exit failure. The four expected-force phases are app,
mixed, window and window-restore recovery. Report root:
`2026-09-08T22-10-15-177Z-win32`. Machine-readable report, summary and exact
manifest reconciliation are retained under `.desktop-e2e-artifacts/ci34284338910/`.

The same run's package artifact 10080025266 is retained there too (SHA-256
`610bae5d32574adcf9f7f79a2c4580a4ec4d7c517d3b8d261aea3bd38375b5b5`).
The installed-payload proof and packaged native black-box both pass for fixture
8.5.0 and bind package manifest
`cd234525e7c46e898003bab74810fa883a06190d1c09217abb6d7557fad9f4d9`.
The NSIS installer is Authenticode-unsigned, 101625647 bytes, SHA-256
`a722602fc88479bf379c79357a10dbb9b57373cf085c2dfe2c4e1c5e1d9ee6f0`.
Installed bytes match the source tree with only the root uninstaller added.
Black-box report root:
`2026-09-08T22-44-59-762Z-24d7e7b4-b75b-42fd-b7b1-12e4d78db025-win32-packaged-black-box`;
visible native interaction, temporary local-user isolation and exit code 0
are confirmed. Both Rust updater probe cases report applied for fixture
8.4.0 to 8.5.0, with `authoritative: false` and `productionTerminalReceipt: false`.
These source-specific fixture results do not replace final c52decf9 validation.

### Replacement fixture and local checks

The macOS source is the immutable published v8.3.0 archive from
`rion-tw/rion-studio`, release 377881658, asset 532406564, source
`cde23e1201a750f1456a0d35424085e9d9f155dc`. It is 14229514 bytes with SHA-256
`003ef23b36e592515e42e522156630cce642c1b0a6d42bfe6c1026d88ee9b9b0`.
Download uses HTTPS only, at most two redirects, the original 10-second connect
and 30-second total boundary, and no retry. A private create-new directory,
exact size/hash and bounded safe extraction precede version/shape/codesign
verification and publication of the fixture path. Signing inputs are excluded
from download and previous-version builder subprocesses. No old runtime is
rebuilt, relabeled, installed or launched by fixture preparation.

Windows read-only extraction verified 9 entries (5 directories, 4 regular files,
31026425 regular-file bytes, no symlinks), both plist versions 8.3.0, the real
`rion-tauri` executable and absent `app.asar`. Native codesign verification
remains macOS-only. The extracted source and receipt are under
`.desktop-e2e-artifacts/published-v22-8.3.0/`.

Local checks before the commits: fixture/release focused checks 14 PASS; Job
stage test 1 PASS; retired-workflow focused checks 38 PASS; typecheck, lint
(0 errors / 23 existing warnings) and complete hygiene PASS. Earlier complete
safe-tar/fixture files had 28 PASS / 1 symlink EPERM FAIL / 2 existing platform
skips; all eight new raw-mode cases passed. The promotion-readiness file likewise
retains its local symlink EPERM failure. Neither failure is skipped or replaced
by focused success. Logs have `sole-entry-fixture-`, `sole-entry-job-diagnostics-`,
`sole-entry-published-v22-` and `sole-entry-retired-workflow-` prefixes under
`.desktop-e2e-artifacts/`.

These are internal-only fixture/diagnostic changes and compile-only retirement
of obsolete workflow entry points; no product journey was removed or changed.
Final native package and complete JS verification must identify the new exact
source SHA. Historical local foreground/activation failures remain failures;
CI success does not rewrite them. No removed hardware, production transaction
or terminal-promotion gate is restored as a prerequisite.

## Evidence preservation

Previous Windows failures and successful native/profile/package runs remain
historical facts. They are not silently repaired by changing scope. Their full
commands, source SHAs and receipts are retained in Git at the prior ledger
revision [a366dc475b67380cfce7bb5640d00d490e243939](https://github.com/rion-tw/rion-studio-source/blob/a366dc475b67380cfce7bb5640d00d490e243939/docs/chromium-migration-execution-ledger.md)
and in the existing local artifacts. This compact ledger replaces the old task
queue rather than carrying removed gates into future handoffs.

This change is internal documentation. New code, build and validation receipts
must identify their actual source SHA separately from document-only commits.

## Cleanup implementation checkpoint — 2026-09-09

Source baseline: `e61895ba3848947132191eb55e3f73026f548bf7` plus the uncommitted
cleanup worktree. These intermediate results are not verification of a new
immutable runtime candidate. Record a full source SHA when the implementation
is ready for final native/profile/package validation.

Default development/build/package entry points now target Electron. The Tauri
shell crate, renderer bridge, runtime documents, native WebKit/WebView2 engines
and obsolete E2E driver are removed from the worktree. Shared Rust data contracts,
AppKit, and consumed legacy installation/data handling remain. The existing
Tauri CLI is retained only for updater signing. Release/CI references and tests
are being adapted; the worktree is not yet a completed cutover.

| Check | Observed result | Local artifact |
| --- | --- | --- |
| Initial cleanup Rust workspace check | PASS | `sole-electron-cargo-check.log` |
| Initial cleanup Rust lint | PASS | `sole-electron-rust-lint.log` |
| First cleanup Rust test run | Core 981 PASS / 1 FAIL / 1 ignored; obsolete v22 font assertion failed | `sole-electron-rust-tests.log` |
| Font inventory/cache/fallback and legacy-data-version focused checks | 1 PASS each after adapting the obsolete assertion | `sole-electron-font-tests.log`, `sole-electron-legacy-font-tests.log` |
| Window gesture / onboarding / native shortcut source checks | 21 PASS | `sole-electron-window-gesture-tests.log` |
| E2E coverage and profile alias checks | 25 PASS; immutable 41-journey source baseline retained for both platforms | `sole-electron-coverage-size-tests.log` (the separate size-constant assertion failed and was subsequently updated) |
| First complete cleanup JavaScript run | 3605 PASS / 90 FAIL / 61 skipped; includes retired source references and symlink EPERM | `sole-electron-full-js-first.log` |
| GitHub release redirect policy | 4 PASS; actual Rust transport fetched the 1,237-byte v8.4.2 manifest successfully without installing | `sole-electron-github-redirect-tests.log`, `sole-electron-endpoint-rust-live.log` |
| Updated Rust lint including redirect transport | PASS | `sole-electron-rust-lint-current.log` |
| Updated full Windows ARM64 Rust suite | 1106 PASS / 4 ignored / 0 FAIL | `sole-electron-rust-tests-current.log` |
| Cleanup contracts, first focused batch | 76 PASS / 13 FAIL; stale paths and 10-second timeouts retained | `sole-electron-cleanup-contracts-current.log` |
| Updated workflow contracts | 31 PASS / 6 FAIL; remaining source assertions and Bash/gate timeouts retained | `sole-electron-workflow-contracts-updated.log` |
| TypeScript after the first contract cleanup | PASS | `sole-electron-typecheck-cleanup-contracts.log` |
| Hygiene after the first contract cleanup | Source hygiene, docs and AI context PASS; Knip failed on the retired renderer entry and unused sortable dependencies, subsequently corrected | `sole-electron-hygiene-current.log` |

Artifacts above are under `.desktop-e2e-artifacts/`. The first full JS result
remains a failure. Focused results and removal of obsolete-runtime tests do not
replace a new complete run. The updated Windows native Rust suite includes the new
transport change. Full build, isolation, affected Chromium profiles and packaged
verification remain required for the resulting source.

The configuration comparison discovered the existing GitHub endpoint's two-hop
redirect chain. A bounded Rust transport adaptation is part of the cleanup;
see the updated configuration delta. No credentials or remote settings changed,
and no publication or real production updater transaction was performed.

The full Rust result includes the unchanged 256-round concurrent terminal-receipt
test in `crates/rion-updater/src/persistence.rs`. The local host is Windows ARM64;
this does not replace the Windows x64 Electron build/package or macOS evidence.

The completed diagnostic JavaScript command was `pnpm run test --maxWorkers=1`, with
the original 10-second deadline and every collected test retained. Its log is
`sole-electron-full-js-serial.log`: **3638 PASS / 32 FAIL / 48 skipped**, exit 1,
1219.30 seconds. The 32 failures comprise 11 symlink EPERM, 14 original
10,000 ms deadline failures and 7 other assertions. Exact failure names and
errors are in `sole-electron-full-js-serial-failures.json`. The command began
from HEAD `446974bd41bc6d6bd8f999f092f10f9ff5806ac8` and ended after the document
commit `fc530bcfe5079f2184bcc7a38d75085ea25f919e`; source fixes continued in the
dirty worktree, so this is intermediate
diagnosis, not an immutable candidate receipt. Observed failures include symlink
EPERM, signer/Bash startup overhead, stale contract references and renderer
timeouts. Standalone architecture validation took 2,491 ms; twelve independent
Bash syntax inputs took 5,604 ms. These measurements do not change a failed test
verdict or authorize a larger deadline.

The cleanup removes the unused sortable dependencies, corrects the Knip renderer
entry, and preserves every literal Bash program as syntax-only input with bounded
parallel parser processes. The pinned updater signer is invoked directly in its
integration test instead of through a pnpm shell. The release preflight now checks
strict semantic versions and rejects updater endpoint credentials, query and
fragment before packaging. These latest fixes still require their focused checks
and final complete source-specific validation.

## Sole-entry implementation candidate — 2026-09-09

Program and test commit: `76042b4a988dcf32bf989971b4a08cc1c7f3f7ea`.
Documentation/context changes are committed separately. This implementation
candidate retires the Tauri shell and routes existing build/package/release
commands to Electron. It is not yet a fully validated runtime candidate.

Latest local checks before the program commit:

| Check | Result | Artifact under `.desktop-e2e-artifacts/` |
| --- | --- | --- |
| TypeScript | PASS | `sole-electron-typecheck-final-cleanup.log` |
| ESLint | 0 errors / 23 warnings | `sole-electron-lint-final-cleanup.log` |
| Source/docs/context/unused/Cargo/E2E hygiene | PASS; retained unused-export/type warnings are not errors | `sole-electron-hygiene-entry-fixed.log` |
| E2E manifest | P0 48/48, P1 58/58, P2 4/4; retained compatibility 41/41 on each platform | Same hygiene log; manifest coverage is not execution evidence |
| Entry, package, release and contract checks | 86 PASS / 1 FAIL; the last obsolete Tauri version-list assertion was then corrected | `sole-electron-final-entry-contracts.log` |
| Complete adjacent candidate test file after that correction | 13 PASS | `sole-electron-candidate-version-fixed.log` |

The generated offline start page was regenerated with the repository generator
after the canonical design-token update. No generated source was hand-edited.
Package preparation now requires the distribution's matching Node/Rust target:
macOS arm64 or Windows x64. This Windows ARM64 workstation uses the existing
portable x64 Node 24.20.0 and x64 Rust 1.98.1 for Electron native/package checks;
the system installation remains Node 24.20.0 ARM64. This prevents a build for one
architecture from packaging a leftover addon for another architecture.

Next: validate this committed source with Windows x64 build and production
isolation, the complete affected Chromium profile and package checks; classify
remaining complete-JS failures and obtain any needed exact-source CI evidence.
The owner-retired physical/production/terminal-promotion backlog stays removed.

## Native candidate evidence and retired launcher cleanup — 2026-09-09

Exact clean Windows x64 source: `9c19a4008188a448da83e58f7fba654337200032`
(program ancestor `76042b4a988dcf32bf989971b4a08cc1c7f3f7ea`). Node 24.20.0 x64,
Rust 1.98.1 x64, Electron 43.6.0 / Chromium 150.0.7871.250. The system Node
installation is 24.20.0 ARM64; distribution/native Electron checks use the
existing portable x64 runtime without changing that installation.

| Command / evidence | Actual result |
| --- | --- |
| `pnpm run build` | PASS; production Electron renderer and native addon built |
| `pnpm run check:desktop-e2e-isolation` | PASS |
| `pnpm run test:electron:native-integration` | 16 PASS / 0 skipped, 8 files |
| `pnpm run test:e2e:desktop:full` | FAIL: 10 phases PASS then `chromium-workspace-web-fullscreen-seed` FAIL; 11 journeys PASS / 4 FAIL / 39 NOT_RUN |

Build, isolation and native-integration logs plus command/SHA receipts are under
`.desktop-e2e-artifacts/windows-takeover-4e5ec764/sole-entry-9c19-` with suffixes
`build-x64`, `isolation` and `native-integration`. The full profile log uses
`chromium-full`; its report is
`.desktop-e2e-artifacts/2026-09-08T21-38-16-609Z-win32/report.json`.
The manifest declares 62 phases; this failed run did not complete the profile.
The observed failure is `exact Windows file dialog is not foreground for input`
after matching the exact native dialog. The progress receipt stops at
`focusing-dialog`; the original helper omitted its HWND snapshot on this error.
This is an observed failure, not an expected forced termination. The report
retains final-flush and process-exit receipts for the failed phase too.

[CI 34281548249](https://github.com/rion-tw/rion-studio-source/actions/runs/34281548249)
was dispatched once for exact source `9c19a4008188a448da83e58f7fba654337200032`.
Observed completed jobs: shared checks (job 102247242966), renderer build,
Linux sanitizer/concurrency, and macOS native validation (job 102247422680).
The shared complete JS run is **3706 PASS / 29 platform skips**, 448 passing
files / 9 skipped files. macOS native Rust is **1116 PASS / 5 ignored**, and
Electron integration is **14 PASS / 2 platform skips**. Windows native and both
package jobs were still running at this checkpoint. Linux shared JS success
does not rewrite the earlier local Windows JS failure or prove Windows native
reachability. No unchanged CI rerun was dispatched.

Follow-up program commit: `eb92d4c0420fc312edbe166631135b683b63b840`. It removes
the unused Tauri development bundle and WKWebView experiment launcher, including
the misleading `performance:webkit:experiment` command which would now start
Electron. The sole-entry guard rejects their return. It also retains exact
native-dialog failure snapshots during focus/input/submission without changing
the original error, input assertions or deadline. This diagnostic addition is
not a claim that the foreground failure is fixed.

The adjacent entry/documentation/fullscreen-source tests passed **17/17**;
`verify:system-only`, full hygiene, TypeScript and ESLint passed (ESLint retains
23 warnings, 0 errors). Artifacts use `sole-electron-retired-launcher-` prefixes.
E2E omission for launcher removal is `compile-only`; dialog diagnostics are
`internal-only` and still require the affected Windows profile investigation.
The removed WebKit-only runbooks are archived byte-for-byte with full source SHA
and SHA-256 in the archive manifest. CONTRIBUTING now describes the sole Electron
commands, current native validation and existing release inputs.

## Final runner cleanup and exact Windows failures — 2026-09-09

Program commits after the previous checkpoint:

- `cdc56e004c2a1bd87eb806ebc6ed26b0c42b3df1` adds per-monitor-aware native-dialog pointer readback, exact control
  hit validation, acknowledged two-event SendInput submission and LastClick
  diagnostics. Full SHA is retained in Git and the following exact-source report.
- `e91316e88a2f0414c942ea6744e6d23938f5de4a` awaits the async pinned-signer helper
  before reading `.sig`, and observes only a NULL native foreground transition
  within the original shared 10-second chooser budget. A different foreground
  HWND fails immediately; no click is replayed and no deadline is extended.
- `18cfe8154809fdd1474175f5b7f6a3adf9920f13` removes unreachable Tauri E2E
  validators, 14 retired prerequisite mappings and 23 retired namespace mappings.
  Non-Electron build/shutdown drivers now fail closed. The obsolete
  `clean-shutdown.json` disconnect-success path is removed; current Electron
  final-flush/process-exit and four expected-force classifications remain.

The native-dialog diagnostic runs all failed and are not complete-profile PASS:

| Exact tested source | Artifact run | Result |
| --- | --- | --- |
| `329521d3692ee6157dee04e6dcadeeba355b4b9b` | `2026-09-08T21-54-02-720Z-win32` | Same foreground failure; HWND 42796306 / dialog PID 14584, owner HWND 7014482 / Rion PID 7904, foreground 0 |
| `d6f4a9461c5d9ce3df3b5ad5b3338f8c579981e4` (full SHA in command/report receipt) | `2026-09-08T21-57-48-567Z-win32` | Pointer readback matched (1683,1589), hit control 9307954 and foreground dialog 12453736 before submission; subsequent foreground 0 |
| `e91316e88a2f0414c942ea6744e6d23938f5de4a` | `2026-09-08T22-00-46-026Z-win32` | Foreground did not recover within the unchanged chooser budget; FAIL retained |

The command was `pnpm run test:e2e:desktop:full
--phase=chromium-workspace-web-fullscreen-seed`, including its entity-persistence
seed/restart prerequisites. Each full SHA and clean-worktree status is bound by
its runner report and wrapper result. The additional observations rule out a
mismatched pointer coordinate/control in the recorded attempt; they do not
establish the cause of the workstation foreground loss. No further unchanged
local retry is justified. Win32 permits a NULL foreground during activation
changes, but the failed budget is still a failure, not an accepted transition.

CI 34281548249 Windows native job 102247422605 finished with Rust
**1106 PASS / 4 ignored**, native integration **16 PASS**, and complete JS
**3682 PASS / 1 FAIL / 48 platform skips**. The exact sole JS failure was a
missing `artifact.bin.sig` in the pinned-signer test: the newly async helper's
sign call lacked `await`. The fix above preserves signature verification. The
complete adjacent signer/fullscreen-source files then passed **20/20** locally.
This focused result does not replace the failed complete Windows JS run.

Both native Chromium full E2E steps in CI 34281548249 completed successfully;
package construction was still running. Final phase/journey counts and package
receipts require their artifacts, so no package completion is claimed here.
The current helper changes are Windows-only E2E control changes; no macOS native
runtime or production renderer change was introduced after the 9c19 candidate.

The runner cleanup's 63 active phase prerequisite/namespace mappings were
compared before and after and are unchanged:
`.desktop-e2e-artifacts/sole-entry-runner-active-graph-equivalence.json`.
Six adjacent runner/driver/recovery test files passed **31/31**. Full hygiene and
ESLint passed (0 errors, 23 existing warnings). Logs use the
`sole-entry-final-runner-` prefix. The manifest and all its active journeys are
unchanged; retired phases remain in immutable compatibility history only.

## Current immutable verification source — 2026-09-09

Latest verified build source: `b6ea7ae8425eb1c0c43046660ca466e68233be04`
(program commit `18cfe8154809fdd1474175f5b7f6a3adf9920f13`). On the clean Windows
worktree, x64 Node 24.20.0 / Rust 1.98.1 ran `pnpm run build` successfully from
2026-09-08T22:09:01.1005165Z to 22:09:19.5677020Z, followed by successful
`pnpm run check:desktop-e2e-isolation` through 22:09:20.7264319Z. The output is
restored to the production build. Logs and exact command/SHA receipts:
`.desktop-e2e-artifacts/windows-takeover-4e5ec764/sole-entry-b6ea7ae8-build-x64`
and `sole-entry-b6ea7ae8-isolation` (`.log` / `.result.json`).

[Windows-scoped CI 34284338910](https://github.com/rion-tw/rion-studio-source/actions/runs/34284338910)
validates that exact source, including the awaited signer, native-dialog
observations and runner cleanup. The pre-dispatch exact-SHA lookup found no
existing run; one dispatch returned HTTP 204 at 2026-09-08T22:08:26.295Z. It does
not dispatch macOS validation. Current handles: checks 102256294174, Windows
native 102256438416, Windows package 102256294098; renderer build already passed.
Retain these live jobs instead of restarting when observation takes time.

The earlier 9c19 CI remains live for package receipts: Windows job 102247242665
has completed exact NSIS installed-payload verification and is executing packaged
Rust-owned updater transactions; macOS job 102247242846 is building release
artifacts after its complete Chromium profile passed. No production publication,
real production transaction, credential change or removed hardware gate occurred.
The sole-entry task remains open until the relevant complete and packaged
results are inspected; the local foreground failure remains unresolved evidence.
