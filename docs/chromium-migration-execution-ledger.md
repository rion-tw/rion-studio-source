# Chromium Migration Execution Ledger

This ledger tracks the remaining work between the current transition tree and
the owner-approved Electron/Chromium v23 production cutover. The normative
requirements remain in [Chromium Runtime Migration](chromium-runtime-migration.md)
and [Updater Install Transaction](updater-transaction-contract.md); this file is
only an execution view and must never be used to waive a gate.

Last reconciled: 2026-09-08.

The separate [Chromium Cross-Platform API Ledger](chromium-cross-platform-api-ledger.md)
tracks shared API adoption and justified native boundaries. Its maintenance
tasks do not waive or replace the release-cutover gates in this ledger.

## Current count

- Five release-cutover work packages remain before the migration can be called
  done. A failed native gate may add remediation work, but cannot remove a gate.
- The known packages contain nine independently verifiable deliverables.
- Within the currently authorized candidate-branch scope, Windows validation
  and remediation are in progress. Candidate closure requires the latest branch
  head to have a green exact-SHA macOS/Windows CI matrix; the hosted status is
  reported in the handoff because it can change after this ledger is committed.
- The one later repository-mutation package is the deliberately gated sole-entry
  cleanup, which cannot begin until the external native and release gates pass.
  The real-transaction producer and terminal-promotion finalizer are implemented
  as hard-disabled transition code but remain open execution gates. The
  owner-controlled release-configuration package is a provisional final delta
  audit, not a presumption that v23 needs a second release infrastructure. One
  package is exact-candidate native and physical-platform evidence.
- A passing portable or macOS-only test run does not reduce the Windows evidence
  count. Historical evidence does not count for the current source SHA.

## 2026-09-08 workstation acceptance checkpoint

CI 34224123627 at exact 68a0e92c2b3f00edc62a7fd2a30c3a2fc9581789
passes shared JS 3898/27 platform skips and both complete Windows profiles:
stable 31 normal/three expected force, 40 journeys/all 34 phases; Chromium 58
normal/four expected force, 54 journeys/all 62 phases. Artifact 10055652342
and 10055704709 hashes, exact report membership and all normal Chromium
flush/process exits verify. Native job 102054376905 also succeeds: Rust 1673
PASS/four ignored, native integration 16 PASS, complete Windows JS 3873 PASS/48
platform skips and Tauri build PASS. Package results continue independently.

Latest correction 68a0e92c2b3f00edc62a7fd2a30c3a2fc9581789 distinguishes
retained process enumeration from native liveness, rereads final Job accounting
after identity checks, and removes one unnecessary native fixture runtime startup.
No deadline, process-count, active-zero or live-survivor assertion is relaxed.
The native retained-enumeration replay fails before the fix; adjacent validation
passes 51 tests/10 files and hygiene/typecheck/lint pass. Complete local JS has
3862 PASS/11 symlink EPERM/48 platform skips, without timeout failures, and
remains FAIL. Windows-only CI 34224123627 was dispatched once for this exact
source at 12:05:14.430Z; App runtime remains 3eff9b28. The withdrawn
generic exited-member experiment is not presented as a verified repair.
Both local production shell builds and production E2E isolation pass at exact
68a0e92c, with only ledger edits dirty. The rebuilt x64 addon loads and exposes
none of the retired child-HWND exports; its exact hash is in the API ledger.

CI 34218883892 is terminal FAIL: native Rust 1673/4 ignored and integration 16
pass, but full Windows JS is 3870 PASS/one original 10000ms fixture timeout/48
platform skips. NSIS payload passes exact manifest, unsigned identity, Job total
three, active zero and cleanup checks. Updater cleanup still fails because PID
8852 remains enumerated after taskkill/Wait-Process; black-box is skipped.
Artifact 10054303974, hashes and original error remain in the API ledger.
The complete local Chromium report 2026-09-08T11-08-31-880Z-win32 at documentation
SHA 1ae51c6eca8793074b46cc083b0e5ff505816219 (built code 3c08e479) passes
58 normal/four expected force, all 54 journeys and exact 62-phase membership,
including final flush/exit, visible chooser 1152 and fresh import restart,
foreground/hidden trusted input, standby listener and native session-end ingress.
This is not actual OS sleep/sign-out or physical dual-display evidence.

CI 34218883892 at exact 3c08e479117e47c2caa7ec0256efc1224202fe70 now
passes both complete Windows profiles: stable 31+3 expected force/40 journeys,
Chromium 58+4/54. All 34/62 phases match the manifest, all phase exits are
zero and all normal Chromium flush/exit receipts verify. Artifacts 10053491058
and 10053568859 are hash-verified; report identities and hashes are in the API
ledger. Shared JS passes 3898/25 platform skips. Native/package failures are above;
no package or production terminal is inferred from these full-profile passes.

Windows-only CI 34218883892 is dispatched once at 11:05:51Z for exact
3c08e479117e47c2caa7ec0256efc1224202fe70. Its local complete JS run is
3860 PASS/11 FAIL/48 platform skips; all failures are symlink EPERM, with no
timeout or document-reference failures. The local run remains FAIL and the
same-source Windows CI failure is retained; no assertion, deadline or OS policy changes
are used to obtain a PASS. Full source/command/report evidence is in the API
ledger. Existing macOS CI is not repeated.
Both local production shell builds and production E2E isolation pass at exact
3c08e479, with only ledger edits dirty; package/install/update acceptance is
still failed/pending as distinguished above.

Tooling/test correction 3c08e479117e47c2caa7ec0256efc1224202fe70 awaits
exact native process exit after taskkill acceptance and preserves primary plus
cleanup failures. It also fences transient Job accounting after an exact root
or sole conhost exit: a native empty notification wakes a fresh native active
count check, within the original remaining command deadline. Unknown/live
members, exact process counts and active-zero/cleanup assertions stay strict.
The local native regressions fail before these corrections; final adjacent
validation passes 70 tests/11 files, hygiene/typecheck/lint pass. App runtime
remains 3eff9b28. The owner-directed local simulation audit also passes 78/12
files, without claiming actual OS sleep/sign-out or physical dual displays.

CI 34214207165 at 737d5a1f is terminal FAIL solely in package validation:
NSIS Job total three retains the already-signaled root PID 6164 in accounting,
so no installed-payload proof is published and updater/black-box are SKIPPED.
Native Rust/JS and both complete profiles pass. Native local adjacent testing
independently reproduces accounting lag after exact conhost termination.
Artifact 10052381939 and exact error/process identities remain in the API ledger.

After the UAC obstruction disappears, local stable full at exact documentation
SHA d1e539059ea45b543e867fd1a04ad556825f5983 (built code 737d5a1f) passes
31 normal/three expected force, all 40 journeys and exact 34-phase membership
in report 2026-09-08T10-37-02-204Z-win32. All phase exit codes are zero.

Diagnostic CI 34212812982 is terminal FAIL: actual NSIS payload passes, but
updater cleanup immediately observes PID 5192 still present after taskkill
acceptance and fails at 10:38:22.518Z. Job total 88 eventually has active 0;
this does not turn the failed cleanup into success. Packaged black-box is
SKIPPED. Artifact 10051994123 and exact proof/error identities are retained in
the API ledger. The old finally could hide an earlier probe error; none can be
reconstructed. Correction-source 737d5a1f native validation meanwhile passes
Rust 1673/4 ignored, native integration 16 and full Windows JS 3864/48 skips;
its package job continues independently.

The owner subsequently directs best-effort simulation/native-event coverage of
unavailable dual-display hardware and actual OS sleep/sign-out, without hardware
purchases, display-mode changes or manual OS operations. Evidence continues to
distinguish simulated data, native event ingress and actual OS operations; no
physical PASS or real production transaction is inferred from fixture results.

Correction-source CI 34214207165 at exact
737d5a1f2a2ebc8cf7f7896c24a39faa3336514e completes stable full 31+3 expected
force/40 journeys and Chromium full 58+4/54. Exact 34/62-phase membership/order,
all phase exit codes and all normal Chromium flush/exit verify. Shared JS passes
3893/23 platform skips. Artifacts 10051715847 and 10051789691 are hash-verified;
full hashes/report identities are in the API ledger. Native/package jobs continue.
Earlier diagnostic-source 5cbcecfb native validation now passes Rust 1673/4
ignored, native integration 16 and full Windows JS 3857/48 platform skips.

Diagnostic-source CI 34212812982 at 5cbcecfb04a01a39dc6bf4c50a38b5178ead4801
completes stable full 31+3 expected force/40 journeys and Chromium full 58+4/54.
Exact 34/62-phase membership/order and all normal Chromium flush/exit verify.
Shared JS passes 3893/16 platform skips. Native/package jobs continue. This
later PASS does not repair the earlier helper timeout or ERR_NO_BUFFER_SPACE,
and it does not establish acceptance for the later 737d5a1f harness correction.
Native chooser 1152/1, unchanged import source/restart scope, standby input
neutrality and exact-HWND WM_QUERYENDSESSION are retained in the API ledger;
actual OS sleep/sign-out and physical secondary display remain unverified.

Native-harness correction 737d5a1f2a2ebc8cf7f7896c24a39faa3336514e is pending
CI 34214207165, dispatched once at 10:12:30Z. Local native tests reproduce
PowerShell stdin continuing after throw and reporting success (two red cases),
and the stale Windows Dashboard selector dereferencing .Count on no result
(four red cases, PropertyNotFoundStrict). A single script block preserves
original exception terminality; a shared exact-PID Home-button selector uses
explicit collection counts and retains uniqueness requirements. Final adjacent
validation passes 75/2 existing platform skips, hygiene/typecheck/lint pass.
These are harness corrections, not product runtime changes or full-profile
acceptance. Diagnostic-source CI 34212812982 continues separately; no source
or result is relabeled and no macOS run is repeated.
Both local production builds and production E2E isolation also pass at exact
737d5a1f, with only ledger edits present during the later checks.

CI 34209380675 is terminal FAIL at exact
0c070d9126b7bedbf3c2a66f15cc8031c4d3a4c8. Native Rust 1673/4 ignored,
native integration 16, Windows full JS 3852/48 platform skips, shared JS
3888/16 platform skips and stable full 31+3 expected force/40 journeys pass.
Chromium still fails the native shortcut helper, leaving 59 phases unexecuted.

Actual 8.5.0 NSIS payload and the Rust-owned Electron-v23 8.4.0 to 8.5.0 CI
fixture updater transaction now PASS. Persisted observations bind installer
a2d86165ddd59d62ab66cd868d7b76ae30dc16d1bb202b0681777f189a43c89d and updater
manifest 1c60c3a1888b5b68887819fad947fc001cb1d68f0a107e1d33e7d8b2861b2943,
with installed-version replacement, fresh-process journal removal and preserved
data marker; updater Job total 88/active 0. This is not a Tauri-v22 transaction
or production terminal receipt. Packaged native black-box executes but FAILS:
root PID 5984, Job total 25/active 0, command exit 1, empty App stdout/stderr,
no passed report and unavailable original harness error. Final artifact
10050138648 SHA-256 is
503c6bed86ff80887deebf503d184bfeedcca47cffb2d1f7df4a3390dd44f9a0.

Diagnostic-only 5cbcecfb04a01a39dc6bf4c50a38b5178ead4801 adds a bounded,
create-new packaged failure file with stage, child PID, package hashes, primary
and cleanup errors, preserving the original rejection and all native checks.
Adjacent validation passes 64/2 existing platform skips; hygiene/typecheck/lint
pass. CI 34212812982 is pending on that exact new source to recover the missing
black-box error. No macOS or unchanged-source rerun is dispatched, and no API
or production gate is closed on diagnostic or fixture success.
Local production Tauri/Electron builds and production E2E isolation pass at
5cbcecfb with only ledger edits dirty; App runtime remains 3eff9b28.

Earlier checkpoint progression (retained, superseded by the terminal result):

New CI 34209380675 at 0c070d9126b7bedbf3c2a66f15cc8031c4d3a4c8 is in
progress, but its Chromium report already FAILS after two PASS phases. The
first native newGameWindow shortcut in shell-smoke reaches the unchanged
30-second helper deadline with no stage output or trusted-input receipt;
59 phases remain unexecuted. App PID 4548 final-flushes/exits. This does not
reach or resolve the previous mixed-seed ERR_NO_BUFFER_SPACE failure. Shared
JS passes 3888/16 platform skips; independent package, stable and native jobs
continue. Exact report/artifact/source identities are retained in the API ledger.
Stable job 102006478859 subsequently completes at that same source: clean
report 2026-09-08T09-21-05-931Z-win32, 31 PASS/three expected force, all 40
journeys PASS, exact 34-phase membership/order and all phase exit codes 0.

Latest CI 34204932987 at 57b5daf00c7c41ba78348d42aecd099a0cc85b0e is FAIL
in package validation. Windows native Rust 1673/4 ignored, native integration
16, Windows JS 3843/48 platform skips, shared JS 3883/12 platform skips and
stable full 31+3 expected force/40 journeys/all 34 phases pass. Chromium report
2026-09-08T08-32-38-959Z-win32 fails mixed-recovery-seed after 49 PASS/one
expected force: Workspace Role main-frame ERR_NO_BUFFER_SPACE (-176), then
Core ELECTRON_ROLE_SURFACE_LOAD_FAILED. Eleven phases remain unexecuted;
completed normal stages and the failed stage flush/exit. Prior complete
07950a33 Chromium evidence does not establish latest-source PASS. The resource
failure is not attributed to the previous WebElement-origin issue or fixed by
updater changes. Exact topology, original error and artifact hashes are in the
API ledger; this seed has no completed trusted-pointer assertions.

Actual 8.5.0 NSIS installed payload passes with exact Job 3/active 0/exit 0 and
verified cleanup, proof SHA-256
c6d654cf1c1e3ea6bd4970f356b6b947f900b88b11d6a9e02e653f1ab7e325c2.
The new persisted updater diagnostic identifies the failing PowerShell wait
for installer PID 6780: exit 1, empty stdout/stderr. Job total 79/active 0;
packaged black-box skips. This remains fixture evidence, not a completed
transaction or production-key cutover.

Tool-only 0c070d9126b7bedbf3c2a66f15cc8031c4d3a4c8 corrects the locally
reproduced absent-PID PowerShell status error in both wait and cleanup. Only
the exact native NoProcessFoundForGivenId result becomes absence; unknown
errors still fail, the 120-second wait and target-survival assertion remain.
Three native regression cases fail before the correction; final adjacent
suite passes 33 tests/5 files, hygiene/typecheck/lint pass. Complete Windows
CI 34209380675 is pending for this exact new source. No macOS run is repeated.
No API or production gate is closed on this focused evidence.
Both local production builds and production E2E isolation also pass at exact
0c070d91 with Node 24.20.0 x64/Rust 1.98.1 x64. The full-JS Windows gate is CI
evidence while the workstation's UAC prompt continues to obstruct local UI.

Earlier source reconciliation (retained, superseded by the latest result above):

CI 34202245777 is terminal FAIL in native and package jobs. The package job
101983499285 passes actual 8.5.0 NSIS payload with exact Job 3/active 0/exit 0
and verified cleanup. Proof SHA-256
88b3c995a23a224f464bf5113bafe8b36394bea1777edaf6bf3a78a4f52a0fd6 is retained in
artifact 10047717814 (ZIP SHA-256
c3a9ea73dc74b116f44ebea6d6b0216098a2b328239fcf1da673e70427f7eded).
The updater now executes native pnpm, Node, Rust probes, previous 8.4.0 installer
and target installer/old-uninstaller; it then exits 1 with Job total 79/active 0.
Original child stderr and final observations are unavailable; black-box skips.
This proves the native-entry correction executes the command, not successful
updater replacement/relaunch. Pending 57b5daf0 CI retains the diagnostic capture
needed for this later failure. Exact process/package identities are in the API ledger.

At exact 07950a33a04bbd313e926e4a3b9077a0f18f21b8, CI 34202245777 passes
shared JS 3877/11 platform skips, stable full 31+3 expected force/40 journeys
and complete Chromium 58+4/54, with all phase membership/order, exits and normal
Chromium flush/exit verified. Native job 101983647773 FAILS: Core 981 PASS/
1 FAIL/1 ignored, after four binding tests pass. The restart test first records
a state-worker shutdown timeout at its unchanged three-second boundary, then
APP_INSTANCE_LOCKED when it opens the same directory for v22. Original logical
platform/substage is unavailable. Subsequent native integration/Windows JS/
Tauri build are skipped; the independent package job's terminal result is above.

Test-only 57b5daf00c7c41ba78348d42aecd099a0cc85b0e checks all three shutdown
terminals in that test and reports the platform plus original error immediately.
Focused native test and Rust lint PASS; full local Rust passes 1673/4 ignored
at exact 57b5daf0, with only ledger edits present. Both production builds and E2E
isolation pass; the earlier local runtime-verifier crash is not rerun away. The CI
timeout remains undiagnosed, with its deadline and lock retention unchanged.
Tooling-only bffcb262486dceac7ea19b55a77b0bfee15ab54b persists bounded updater
observations in the existing artifact root, with create-new/source binding and
original-error preservation. The record explicitly cannot substitute for Core
or production terminal receipts. Adjacent JS 51 PASS/2 existing platform skips,
typecheck/hygiene/lint PASS. The API ledger retains full failure and artifact
identities; no old CI is reclassified by these later changes.
Windows-only CI 34204932987 is dispatched once at 08:31:10 UTC for exact source
and workflow head 57b5daf00c7c41ba78348d42aecd099a0cc85b0e. The prior package
job continues independently; no macOS run is dispatched.

CI 34198254073 is terminal FAIL at updater launch, after real Windows NSIS
installed-payload PASS for exact source 0935ac593e0630ecfc785cacce1a7f66bcf1e32c.
Version 8.5.0 installs the exact source tree plus its single expected unsigned
uninstaller. Job total 3, raw root/final active 0, command exit 0 and profile/ACL
cleanup verify; no application launch is requested. Proof SHA-256
e7a51e4d21ca0e4d4cffcef439bfd6e5d415878c584e9d1ad62f649eaee75dd0 is retained in
artifact 10045973731 (ZIP SHA-256
938607f06a219e20dcf7ee288840504674eec221178f95018ef4a3f43cc70f74).
The API ledger retains exact installer/executable/manifest identities and native
PIDs. This is NSIS payload evidence, not updater-signature or transaction proof.

The following isolated updater exits 1 with only pwsh/conhost/cmd observed;
original child stderr is unavailable. The workflow bypasses its verified native
pnpm entrypoint by explicitly selecting pnpm.cmd. Tooling correction
07950a33a04bbd313e926e4a3b9077a0f18f21b8 uses pnpm.exe for both isolated CI
callers and preserves existing ACL/identity/cleanup/deadline gates. The workflow
regression fails before and passes after; adjacent tests 33 PASS/2 existing
platform skips, hygiene/lint PASS. Native pnpm 12.3.4 locally executes a Node
24.20.0 marker child; the separate shim quoting failure is not the exact CI
failure reproduction. Windows-only CI 34202245777 is dispatched once for this
exact source and workflow head at 08:01:02 UTC.
Packaged updater/black-box and production transactions remain open; no completed
macOS CI is rerun. App runtime remains 3eff9b28.

Windows-only CI 34198254073 tests exact tooling source
0935ac593e0630ecfc785cacce1a7f66bcf1e32c from documentation-only workflow head
efef879adf7e2fb8e40f05cd292ddf646cf1ae2b. Shared JS passes 3876/11 platform skips.
Stable full passes 31 normal + three expected force/40 journeys (artifact
10045318438, report 2026-09-08T07-14-45-533Z-win32). Complete
chromium-windows-smoke passes 58 normal + four expected force/54 journeys
(artifact 10045417927, report 2026-09-08T07-14-42-429Z-win32). Downloaded hashes,
exact source, all 34/62 phase memberships/order and journey aggregation verify;
all phase exit codes are 0 and all normal Chromium phases flush and exit.
Windows native job 101970942425 is SUCCESS: Rust lint and 1673 PASS/4 ignored,
native integration 16 PASS, complete Windows JS 3835 PASS/48 platform skips and
Tauri build. The new PowerShell fixture passes in the complete suite at 6623 ms
under its unchanged 10000 ms deadline. Downstream installed-payload/updater/
black-box have the terminal outcome above. The API ledger retains artifact
hashes and native identities.

Latest tooling correction 0935ac593e0630ecfc785cacce1a7f66bcf1e32c executes the
exact attested NSIS PowerShell file in the already isolated host and removes the
duplicate host. A native probe measures total 4 before/3 after, with real marker
execution and original exit 7. The first expanded test exposes an active-1
root-exit race; the parent now retains that raw observation and may join only
the exactly revalidated same-Job system conhost within the original remaining
deadline. Final Job active-zero, exact total 3, exit code, identity binding and
profile/ACL cleanup remain mandatory. Unknown survivors are rejected. Native
and adjacent checks pass 34/2 existing platform skips; hygiene/typecheck/lint
PASS. This is lower-layer-covered tooling work; complete regression at its exact
SHA and real installed-payload now pass in CI 34198254073. The
unsupported child-side console drain was withdrawn with its failure evidence.

Current candidate 3eff9b2865f90b85908b1c71f605d64805051ddd passes local Windows
x64 Rust lint and the full native suite: 1673 PASS/4 ignored, with the updater's
256 concurrent rounds unchanged. Documentation-only head
f85b689e47f50e91acbe596547a16c4891e8ae4e passes both production builds and E2E
isolation. The new local runtime verifier fails with 0xC0000005. A separate
instrumented diagnostic reaches app-ready, loads the unchanged x64 addon and
reads the expected runtime versions, but does not establish the crash cause or
repair the failed verifier. Exact hashes and raw diagnostic receipts are in the
API ledger. Local trusted UI remains obstructed by UAC PID 648/HWND 12648580.
CI 34193287664 tests exact 3eff9b28 source once; shared JS completes with
3876 PASS/10 platform skips. New-source stable full passes 31 normal + three
expected force / 40 journeys (artifact 10043390328, report
2026-09-08T06-08-26-340Z-win32). Chromium full passes 58 normal + four expected
force / 54 journeys (artifact 10043474025, report
2026-09-08T06-09-04-559Z-win32). All 34/62 phases match manifest membership
and order, every normal Chromium phase flushes and exits, and all phase exit
codes are 0. In the corrected Web-only phase, stop starts at sequence 469,
quit starts at 475, stop completes at 483, Core effects dispose at 490/491 and
checked Core shutdown completes at 511. This validates the actual overlapping
close/quit ordering in a complete profile. Visible import/restart, standby
events and native session-end repeat successfully; actual OS sleep/sign-out
remain unverified. Windows native job 101955717971 is SUCCESS: Rust 1673/4
ignored, native integration 16 PASS, complete Windows JS 3834/48 platform skips
and Tauri build. The package job is terminal FAIL: target 8.5.0/previous 8.4.0
builds and runtime/package/distribution/native NSIS preconditions pass, but the
installed proof still reports total 4/expected 3. Exact members are pwsh
1244/7332, conhost 6896 and staged installer 6808; the active snapshot is empty.
Updater and packaged black-box are skipped. No valid installed proof exists.
Artifact 10043875557 contains earlier diagnostics, not black-box success. The
API ledger retains exact hashes and terminal receipts.

Earlier completed Windows CI 34190968118 tests exact source
c153c0c737fde081d6b5050e4bfe8d1fa6a507c5 (workflow head
8bd62ff679690f59ea187807f68974646a4c9e1f). Windows Rust 1673 PASS/4 ignored,
native integration 16, full Windows JS 3827/48 skips and shared JS 3869/10 skips
PASS. Stable full passes 31 normal + 3 expected force / 40 journeys, all exits 0
(report 2026-09-08T05-33-25-227Z-win32, artifact 10042591212). This validates the
129702a3 page-handle correction with full regression, not just focused tests.

Chromium full FAILS after 12 normal phases: 15 journey PASS/39 NOT_RUN. The
next Web-only Workspace phase passes its UI spec but cannot flush at quit:
embeddedTabStop starts at Core-flow sequence 479, clean exit starts at 480,
Core effects dispose at 488/489, then checked shutdown rejects the still-owned
browser-operation lease. Report 2026-09-08T05-33-11-886Z-win32, artifact
10042368444; original code CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED is
retained. GitHub's continue-on-error-normalized step conclusion is not the
report verdict; the final workflow guard still fails the job.

Runtime correction 3eff9b2865f90b85908b1c71f605d64805051ddd waits for the exact
cohort of accepted native window/tab/divider/reload Promises while Core effects
remain live, then performs existing ordered teardown. Original Core errors,
admission fences, final-flush assertions and all deadlines remain intact. A
bootstrap ordering regression fails before wiring and passes after; six explicit
darwin/win32 tests cover delayed terminality, failures and reentrant closure.
Focused suite 52 PASS; hygiene, lint and corrected ES2022 typecheck PASS. The
Windows WORKSPACE-WEB-ONLY-024 journey retains its final visible close beside
teardown and the complete-profile normal-exit requirement. New-source local
native/build/full-profile checks pass as above; local runtime verification
remains open. macOS native acceptance of new
runtime changes is not inferred from prior CI and is not rerun in this takeover.

The c153c0c7 NSIS attempt still fails exact total 4/expected 3. The new snapshot
has no active members, error 0 and no truncation; the prior retained-1 failure
is not retroactively fixed. Observed processes are pwsh 8660/6684, conhost 476,
installer 10036. No valid installed proof exists; updater and packaged black-box
remain skipped. Production-key transactions and hardware gates remain open.

Earlier terminal CI: 34187765250 at
caea487d93c0b6200b181c866b1a6a46ef994e8e FAILS overall. Windows Rust passes
1673/4 ignored and native integration 16. Complete Windows JS is 3819 PASS /
2 FAIL / 48 skips; shared JS is 3861/2/10. Both failures are the stale adjacent
navigation mock. Stable full fails an obsolete .app-page handle. E2E-only
129702a33e37ce8b1d80ff31e0e32b3ce72125c5 fixes current-page queries and the
mock, retaining negative assertions and the original 10 s deadline; 18 focused
tests PASS; c153c0c7 full revalidation above subsequently passes. Chromium full at caea487d is 58 PASS +
4 expected force / 54 journey PASS, all 58 normal flush/process exits/exit 0
(report 2026-09-08T04-41-10-400Z-win32, artifact 10041391334).

Package job 101939449858 passes target 8.5.0/previous 8.4.0 builds, package and
distribution checks and native NSIS running/absent fixtures. Installed payload
fails the unchanged Job gate: total 4/expected 3, active 1 at root exit. Exact
creation observations are pwsh PID 2360/7956, conhost 6192 and installer 6576;
the still-active identity was not retained and cannot be guessed. No valid
installed proof is written; updater and packaged native black-box are skipped.
Tooling-only c153c0c737fde081d6b5050e4bfe8d1fa6a507c5 adds one bounded active
member snapshot before cleanup. Native/adjacent tests 28 PASS/2 existing platform
skips, typecheck/hygiene/lint PASS; omission reason lower-layer-covered. Failed
hidden/detached console-launch experiments were withdrawn and preserved in the
ignored takeover artifacts. No process-count, exit or cleanup gate is relaxed.

Previous production restoration passed: clean Tauri build at
2ee06d88c1007fa0fb1335dba2ec67bbc7125bc4; Electron build, isolation and runtime
checks at 129702a33e37ce8b1d80ff31e0e32b3ce72125c5. Actual addon inventory again
contains no retired child-HWND exports. App runtime remains d4993ed8cf890e6c5468447aceca3acd6c373099,
installer source 9e56d430ee464f0c0ce4c511ea8badfd8661612d. Local trusted UI is
still obstructed by UAC PID 648/HWND 12648580, not a product topology failure.
The detailed ordered table, hashes, receipts and rejected experiments are in the
API ledger. None of this closes production transactions or physical gates.

Latest Windows reconciliation: local runner
c17f9763f28409c0582a8a7730809017b004ac63 starts clean and completes stable full
31 PASS + 3 expected force terminations / 40 journey PASS (report
2026-09-08T02-07-16-602Z-win32), and chromium-windows-smoke 58 PASS + 4 expected
force terminations / 54 journey PASS (2026-09-08T02-25-16-277Z-win32). All 62
Chromium phases execute; all 58 normal phases have final flush/process exit/exit 0.
The full run includes exact survivor topology, mixed recovery, native trusted
foreground/hidden input, actual Electron powerMonitor listener ingress, native
WM_QUERYENDSESSION close-drain, visible consent/cancel/native chooser 1152/1,
launch-origin scope/source immutability and fresh-process Chrome import restart.
Actual OS sleep/sign-out is unverified; no manual assistance is required and no
synthetic event is called physical PASS. Only one display is present, so stable
extended and chromium-windows-hardware-extended remain hardware-blocked.

Runtime source remains d4993ed8cf890e6c5468447aceca3acd6c373099; later commits
are E2E/tooling or documentation. CI 34178511175 checks out
d67d87596695b912ff8912481dbf7356ae1e9778 (workflow head c17f9763), passing
Windows Rust 1673/4 ignored, native integration 16, JS 3813/48 skips, stable
31+3/40 and Chromium 58+4/54. Artifacts 10038386129 and 10038472885 retain the
complete reports. Its 8.5.0 target and previous installers build, but package
verification cannot load Microsoft.PowerShell.Security. Installed payload,
updater transactions and packaged black-box therefore do not execute.
Tooling/CI source ca4375cfa86a17c62cdb6140d28ba56ac2aa872e explicitly imports
the executing Windows PowerShell Security module, preserves unsigned checks and
retains public package/updater observations. Focused 44 tests, typecheck, lint,
hygiene and complete local JS 3814 PASS/48 skips pass. Exactly one new Windows-only
CI, 34182057095, is pending on this source. No completed macOS gate is rerun.
The new run subsequently fails stable fullscreen-toolbar before any passing
phase (artifact 10039400895): the visible Role launch reaches
WINDOWS_TAB_CHROME_BOOTSTRAP_TIMEOUT after the original 2000 ms native wait,
with revision-1 WINDOWS_TAB_CHROME_ACK_TIMEOUT. Later native acknowledgements
do not repair the original launch. The delayed-bootstrap cause remains open;
no same-source rerun or deadline increase is used. Its independent Chromium
package and native jobs remain in progress.
Chromium full in that same run subsequently passes 58+4/54 with all normal
flush/exit, artifact 10039609270/report 2026-09-08T03-02-46-256Z-win32,
exact source ca4375cfa86a17c62cdb6140d28ba56ac2aa872e with the explicit 8.5.0
fixture version applied. Package validation continues; overall CI remains
non-green because of the independent stable bootstrap failure.
Windows native job 101923060225 on ca4375cf subsequently finishes SUCCESS:
Rust 1673 PASS/4 ignored, unchanged updater 256-round concurrency test,
native integration 16 PASS, full JS 3814 PASS/48 skips and Tauri build PASS.
The run finishes FAIL: package/AuthentiCode/distribution checks now pass, but
the isolated NSIS installed-payload gate observes 12 Job processes versus the
unchanged expected 3. No installer proof is written; updater/packaged black-box
are skipped. Artifact 10039932747 retains prior package-stage evidence.
Diagnostic-only source f7e3ef9508b9a5ef344055aafbca7d99d360182c adds bounded
Job completion-port PID/image observations before the existing count assertion,
preserving all count, active-zero, command-exit and cleanup gates. Native local
compilation/focused 18 PASS plus two existing platform skips, typecheck, hygiene
and lint pass; full JS and exact-source hosted installer diagnostics are pending.
The observer is not a completion authority and records no arguments/environment.
Windows-only diagnostic run 34185634130 checks out f7e3ef95 (full SHA above),
with workflow head f92fee12b0dace84bbb867593b1cb0a5387cd7f6. Local full JS
launch is waiting for Windows UAC and is not a started/passing test. A separate
non-installing native NSIS macro fixture observes PowerShell/cmd/conhost helpers
but does not reproduce the exact hosted count; the original proof count 3 stays.
That run's Chromium profile stops after 10 PASS phases at the native upload
chooser (11 journey PASS/4 FAIL/39 NOT_RUN, artifact 10040537849); stable
smoke-seed separately expects "No roles yet" but receives null (10040568493).
The hosted installer diagnostic is therefore not reached. Installer-only
9e56d430ee464f0c0ce4c511ea8badfd8661612d uses the existing native nsProcess
plugin and admits replacement only when both runtimes are absent. It preserves
the three-process proof gate, requires normal Rust drain, and fails silent
installation while either runtime is active or the lookup is unknown. Native
absent/running fixtures and complete local NSIS compile pass (application
0.0.0-development, Electron 43.6.0, Core 0.1.0); installed-payload acceptance
remains pending. SETTINGS-TRANSFER-002 stays planned; its native precondition
uses lower-layer-covered evidence, not an interactive journey PASS.
E2E-only 56bee2adf66eead1f9d4903d22b844b8b653ca08 adds bounded file-dialog
failure controls without changing matching/deadlines. CI-only
bb9c29d4a971714f31b9bd1b14eb6b1ff6dde637 collects independent Windows package
evidence, then still fails the job unless the original complete Chromium E2E
outcome is success. Focused/native compile/typecheck/lint/hygiene pass; exact
new-source full JS and CI remain pending. No production acceptance is inferred.
The f7e3ef95 Windows native job subsequently passes Rust 1673/4 ignored, native
integration 16 and full JS 3815/48 skips. Run 34187072547 at
8ed20726b69ae853fb6258f3efebe0096d89a1e0 fails the new probe's explicit
Electron transition naming boundary; its independent stable full passes
31+3/40 (artifact 10041217543). caea487d93c0b6200b181c866b1a6a46ef994e8e
corrects the path/command within existing rules and passes the same local gate,
hygiene/lint/typecheck; exact-source CI 34187765250 is pending.
The stale primary-heading fix is E2E-only 27f8ee06c07c27c1349e05cbc9eb6cdd8f7f17f4,
with node-project include 6a6c235cb1daeb19e9fd3114a66bff5022b306e7. Replacement
fixtures fail before/pass after on explicit darwin/win32; the 10 s boundary and
wrong-text failure remain. Local caea487d full passes that point but fails after
five phases because the earlier unanswered test UAC prompt occludes native
mind-map hover. One cd4232ec3d859f6e41f82f8cf42717d8df8efefb diagnostic replay
identifies hit/root HWND 12648580, PID 648, Credential Dialog Xaml Host versus
Rion PID 19980/foreground HWND 11339334. Standard cancellation is denied by
Windows (error 5); local trusted UI waits for dismissal. The elevated JS launch
was cancelled before tests started. Neither this focused diagnostic nor a
Default-desktop probe substitutes for a complete local profile. Final production
restoration is required after the later Tauri E2E build.
Both production shell builds, production E2E isolation and actual x64 runtime
verification subsequently pass at ca4375cf (Electron 43.6.0/Chromium
150.0.7871.250/Node 24.20.0/Core 0.1.0). Final addon inventory has no retired
child-HWND exports. Electron build/probes have only ledger edits pending;
later E2E must rebuild its own shell because the shared outputs are production.

The API ledger separately closes CP-08 and CP-10 on these unchanged input/import
boundaries: 11/18 API items are verified. The five cutover work packages and nine
deliverables below are unchanged and overlap the API count. This does not close
the latest-source macOS native requirement for the changed launch coordinator,
physical dual-display, four real production-key updater transactions, terminal
promotion, the final v22 configuration delta, or protected runtime retirement.
Earlier native filesystem and timeout failures remain historical FAIL evidence;
the isolated complete-profile PASS does not establish their cause or repair.

Earlier takeover checkpoints (historical sequence; latest results above prevail):

Windows takeover is now active. The clean local branch safely fast-forwarded to
4e5ec764315af1594b41fb693e65bc2abc4b2b1e with the specified ancestors verified.
Windows ARM64 VM Rust lint passes, Rust has 1673 PASS/4 ignored, and complete JS
has 3809 PASS/48 platform skips at test-only source
45b846e451adcad89c6ab5b5749d18394cd0b44c. An elevated process supplies verified
real symlink capability without changing persistent privilege policy. System
Node is now 24.20.0 under the owner's explicit authorization. CI 34170886520
at f63755f005c21b7c46c875c371bfdde5cc55c9fb passes x64 Rust/native integration
and all Chromium phases (57 PASS + 4 expected force, 53 journeys), but fails
stable smoke-seed, two original JS deadlines, and the previous installer fixture
command. Packaging source 6476b49d1a86d3463a26f6f15b082cf9ba0ea57b corrects
the Windows command and binds installer Electron to the verified 43.6.0 runtime;
prior packages used 43.4.1. It has a new Windows-only CI dispatch, not a package
PASS. No completed macOS gate is rerun. Only one VM display is available. Detailed command
receipts, full-profile results and remaining limitations belong to the latest
Windows checkpoint in the API ledger. No gate is closed by this progress entry.

Subsequent Windows results supersede the pending statuses in that initial entry:
stable full at 9f6e022d0afa3d0949c9b9d30fccb1cf66445d67 passes 31 normal phases
plus three expected force terminations / 40 journeys (report
2026-09-08T00-35-11-471Z-win32, WebView2 152.0.0.0). Complete JS at E2E-only
7bcb2d65d9d7e0ba749fc07d5756beb6fc022535 passes 3810 / 48 platform skips.
Its new exact-HWND WM_QUERYENDSESSION focused journey proves native delivery,
single-listener handling, final flush and process exit, not an actual OS sign-out.
The Windows Chromium full manifest now has 62 phases / 54 journeys.
CI 34173824730 at 9f6e022d fails stable website-entrance-seed, two Rust shutdown
tests, and Chromium tabs-visible-seed; package/update steps did not run.
Runtime correction d4993ed8cf890e6c5468447aceca3acd6c373099 exactly reproduces
and fixes the last failure's reconciled-host cache loss after delayed tab admission
and close. All 53 coordinator tests pass with paired platform fixtures; complete
Windows verification is in progress. The two Rust shutdown stages and hosted
stable click failure remain unresolved. Detailed identities, logs and source
classification are retained in the API ledger. No production or physical gate
is closed, and the new shared runtime source still needs native macOS evidence;
the owner-requested Windows work does not rerun completed macOS acceptance.

The newer Windows checkpoint retains additional failures instead of closing
gates from focused success. CI 34176121361 checks out runtime
d4993ed8cf890e6c5468447aceca3acd6c373099 (workflow head b0639dbaf29c4143b6d01d400f8dfe05b4f12476):
native Rust 1673 PASS/4 ignored, native integration 16 PASS and Windows JS
3813 PASS/48 skips. Chromium records 54 normal PASS plus four expected force
terminations before an extra diagnostic stage breaks its strict collector;
package/update do not run. E2E-only 82bb6975051f1ac949af669359f7b0b2f30f5f0c
corrects that artifact channel and the complete tabs focused passes. Local
consented Chrome Profile import and fresh-process restart also pass at 82bb6975,
including native controls 1152/1, exact owner, source digest, scope and flush/exit
receipts. Its local full Chromium attempt fails Role publication rename with
Windows OS 5; the subsequent bounded 100-Role native diagnostic does not reproduce
it. Local x64 Rust retains one separate 2 s Macro event failure (aggregate
1672 PASS/1 FAIL/4 ignored). E2E-only d67d87596695b912ff8912481dbf7356ae1e9778
waits for native tab readiness after a stable ownership claim; its rebuilt
focused execution advances past the earlier viewport failure but fails later
cookie checkpoint replacement (0x80070497), correctly retaining stopping/failed
close. These exact failures and unavailable native Mac validation remain open;
the API ledger contains identities and report/artifact paths. API count remains
9/18, independently of the overlapping five packages/nine deliverables.

This checkpoint supersedes the earlier dated foreground holds and candidate
status snapshots below; those sections remain historical evidence. The current
last fully macOS-verified runtime/test candidate is **85f662f4860c9af1623580510f35997256108b66** on
codex/electron-chromium-v23-cutover. Later ledger-only commits do not relabel
older binaries or require another CI run. The detailed commands, identities,
reports and ordered Windows checklist live in the
[Cross-Platform API Ledger](chromium-cross-platform-api-ledger.md).

| Scope | Exact current evidence or remaining gate |
| --- | --- |
| macOS physical Chromium | Clean 85f662f4 hardware-extended report 2026-09-07T21-46-01-681Z-darwin: 57 PASS + four expected force terminations / 54 journey PASS, with every ordinary final flush and process exit verified. This includes visible consent/import/restart and two physical same-scale displays. |
| macOS native and stable CI | Run 34164313951 at 85f662f4: native Rust 1681 PASS / five ignored, Electron native integration 14 PASS / two platform skips, and stable full 31 PASS + three expected force terminations / 40 journey PASS. |
| Chromium package/updater CI | Run 34164313951 is entirely SUCCESS at 85f662f4: hosted Chromium 56 PASS + four expected force terminations / 52 journeys (artifact 10034074878), packaged updater 8.5.0 and packaged AppKit black-box PASS (artifact 10034566802, visible native click and normal exit). This uses ephemeral fixture trust, not a production-key transaction. |
| Windows execution | The owner directs all remaining Windows acceptance to the other Windows workstation. Do not dispatch Windows CI from this Mac; keep paired CI definitions intact. Final-source full JS, native, profiles, visible import, physical input/display/session-end and install/update evidence remain open. |
| Power and display limits | Physical mixed-DPI acceptance is removed by owner decision, not passed. Ordinary dual-display controls remain required and pass on the Mac. The owner does not require manual sleep/wake assistance: production power-monitor ingress, event ordering/failure/disposal, Core input fences and native held-input recovery are automated. Actual OS sleep/wake is unobserved because unattended wake scheduling requires unavailable authority; it is not inferred from synthetic events. |
| Production retirement | Four real production updater transactions, terminal promotion, final v22 configuration delta and paired exact-candidate native release evidence still gate sole-entry cleanup. No publication, merge, credential change or protected Tauri/System WebView removal is authorized by the successful Mac tests. |

The API ledger remains **9/18 closed**. Its nine open API items are not the same
count as this ledger's **five migration work packages / nine deliverables**;
the scopes overlap and must not be added together as independent tasks. Neither
count shrinks because the Mac passes while Windows or production release evidence
is absent. The fixed updater-evidence and terminal-promotion workflows remain
hard-disabled, and the provisional publication/recovery paths remain disabled.
No new infrastructure is assumed: the existing v22 release setup remains the
baseline for the final read-only configuration comparison.

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

The owner clarified on 2026-09-06 that this absence audit does not establish a
v23 requirement to create separate release infrastructure. Configuration review
is deliberately last: begin from the complete pre-migration v22 release
environment, reuse its secrets, permissions, endpoints, and owner settings, and
adjust only the Electron-specific workflow inputs that a final delta audit proves
necessary. The private recovery repository, separate GitHub Apps, and additional
environment assumptions recorded above remain provisional transition-workflow
assumptions; they are not owner-approved requirements and must be removed or
simplified if the existing release setup already supplies the required authority.

## Remaining work packages

| Package | Required deliverables | Current state | Completion evidence |
| --- | ---: | --- | --- |
| Real updater transaction producer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow seals one challenge and exact upstream identities, drives visible updater UI in four native cells, records product-authored terminality and target-process identity, detached-attests only each terminal receipt, and verifies the aggregate | Four exact source-runtime transactions: Tauri v22 and prior Electron to target Electron on both macOS and Windows |
| Terminal promotion finalizer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow re-verifies readiness/provisional/capsule/lease identities, brackets the sole lease release with exact target observations, writes only a create-new `promoted` receipt, and leaves every non-success path to durable recovery | Fresh external-state observation plus one terminal promotion receipt, with rollback or indeterminate closure for every non-success path |
| Sole Electron production entry and cleanup | 2 | Pending until every prior gate passes; Tauri v22 remains stable production | macOS and Windows release/CI matrices green; make Electron the only production entry, then remove Tauri/System WebView and dual-shell code while retaining `rion-appkit` |
| Owner-controlled release configuration | 1 | Deferred to the final delta audit; existing v22 release configuration is the baseline and no new repository, App, environment, variable, or secret is presumed necessary | Read-only v22-to-v23 configuration/workflow comparison, followed only by owner-approved Electron-specific adjustments that the comparison proves unavoidable |
| Current-SHA native release evidence | 2 | 85f662f4 macOS physical/native and fixture package/update PASS; Windows and production execution remain pending | Retained AppKit-host macOS package/update evidence and physical Windows install/update/trusted-input evidence for the exact candidate SHA |

Repository code may validate and consume owner-controlled configuration, but it
must not create it, guess repository identity, or enable public mutation without
owner approval. This package stays last and may close as a no-new-configuration
result if the existing v22 environment already covers the Electron workflows.

The durable provisional-publication recovery package is no longer counted as
remaining repository implementation. Its hard-disabled workflow now covers the
private append-only capsule and outcome store, proof-derived one-shot mutation
markers, creator-only public mutation, zero-write resume and reconciliation,
rollback or held-lease release, and fresh terminal readback. All recovery jobs
remain statically disabled. Its currently modeled separate store, GitHub Apps,
protected environments, variables, and secrets remain provisional until the
final v22-to-v23 delta audit; they are not inferred owner requirements.

The real updater transaction producer is also no longer missing repository
implementation. Its hard-disabled fixed workflow is covered by focused source,
contract, bundle, promotion-readiness, and full repository tests. This does not
complete either of its deliverables: the owner-controlled provisional endpoint
or reused v22 endpoint and native environments must still run all four exact
transactions, including retained AppKit evidence on macOS and physical Windows
evidence.

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
updated the authoritative Runtime Kernel topology to 55/45 while a stale shell
persistence fence left the SQLite follower at 50/50. Internal Runtime Kernel
snapshots bypass that non-authoritative fence to repair the follower, while the
public shell snapshot API retains strict latest-wins duplicate supersession. A
focused Core regression test covers both sides of that boundary.

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

The fourth exact-SHA matrix, run `33977476889` at
`ea37c551d2b4955c34809f76f3412e1aefb80ca0`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, both native validation jobs, and the
macOS desktop E2E. Its three package/later-journey failures exposed independent
incarnation and viewport boundaries. The Windows package confirmed that a
higher stale shell persistence fence could still block the authoritative Rust
Runtime Kernel snapshot; internal authoritative snapshots now bypass that
non-authoritative fence, while public shell commits remain strict latest-wins.
The stable Windows transcript appends multiple app incarnations whose sequence
numbers each begin at one; geometry validation now captures an exact byte offset
so an older incarnation's numerically larger failed receipt cannot leak into the
current action. The macOS package accumulated enough Workspaces to push the
visible reorder target outside the viewport; its physical pointer drag now uses
the product's edge auto-scroll before releasing on the target instead of relying
on an off-screen element origin.

The current correction tree passes 427 Vitest files containing 3,225 tests,
TypeScript, ESLint with zero errors, source/document/dependency hygiene, Rust
formatting and clippy with warnings denied, the full Rust workspace suite,
production Tauri and Electron builds, Electron renderer purity, and production
desktop-E2E isolation. The local Core suite includes 955 tests, including the
authoritative-follower repair across a stale shell revision fence. A physical
macOS Chromium/AppKit run passed the corrected `chromium-app-crud-mutations`
journey and all of its focused lifecycle dependencies in
`.desktop-e2e-artifacts/2026-09-05T16-49-16-871Z-darwin`. The corrected Windows
paths and the next immutable branch head remain pending the next exact-SHA
hosted matrix.

The fifth exact-SHA matrix, run `33979452487` at
`0021dc78cea254be8ba82f5f7c83a8c8d3c81f84`, passed renderer assets, checks,
both native-validation jobs, both macOS and Windows desktop-E2E jobs, and the
Linux sanitizer and concurrency soak. Its two package failures reached still
later native boundaries. The Windows Chromium workspace-divider gesture
committed the exact 55/45 geometry into Runtime Kernel while SQLite remained at
50/50. Divider completion now persists the already-fenced Runtime Kernel window
directly through the authoritative state mutation, rejects any topology change
between motion and release, and remains independent of a stale shell snapshot
revision. A Core regression test installs an impossible higher shell fence
before release and proves that the exact saved divider geometry still commits.

The macOS package failure showed that AppKit can create and reveal the retained
native host, then enqueue its authoritative frame/window-state correction. The
launch coordinator could compare Core against an intermediate revision and
compensate by retiring an otherwise valid window. Coherent launch readback now
first drains AppKit callbacks admitted before the event fence, then drains the
Rust projection queue before comparing state. A coordinator regression test
proves that no Core snapshot is read before that native fence. The focused
physical macOS Chromium/AppKit `chromium-game-window-ui-restart` seed and restart
journey passes with the correction in
`.desktop-e2e-artifacts/2026-09-05T17-27-30-195Z-darwin`.

The corrected tree passes source/document/dependency hygiene, TypeScript,
ESLint with zero errors, all 427 Vitest files containing 3,226 tests, Rust
formatting and clippy with warnings denied, the complete Rust workspace suite,
the stable Tauri production build, the Electron production build, renderer
purity, system-only boundary verification, and production desktop-E2E
isolation. The sixth immutable branch head and its hosted package evidence
remain pending.

The sixth exact-SHA matrix, run `33981080989` at
`d8a54049383e07d9297495d200585dcf9f10195f`, passed renderer assets, checks,
the Linux sanitizer and concurrency soak, both native-validation jobs, and the
macOS desktop E2E. Its three remaining failures were distinct native input and
message-delivery boundaries. The Windows Chromium package delivered an exact
55/45 divider move before its adjacent child `WebContentsView` took pointer
capture; Chromium emitted capture loss instead of the physical release, so the
renderer submitted cancellation and correctly left the moved Core state
non-durable. Capture loss after an accepted move now submits `end`, while loss
before any move and explicit host blur remain cancellation. A renderer
regression test covers both terminal paths.

The stable Windows package submitted `WM_CLOSE` with `PostMessageW` while the
WebView was actively navigating. The asynchronous message was accepted but did
not reach Tauri's real `CloseRequested` policy within the external E2E
boundary. The E2E-only native control now uses synchronous `SendMessageW`; the
real Tauri handler still prevents the native default and defers admission to the
Rust close transaction, whose exact native-destroyed event remains terminal.
This Windows-only correction requires hosted compilation and physical evidence;
the local macOS host cannot substitute for it.

The macOS Chromium package reached exact post-restart Core, native AppKit,
generation, and topology state, then timed out while System Events traversed the
complete Accessibility contents of the target window to rediscover a known
tab. The visible action now binds the exact Core/AppKit window and tab IDs,
validates ordered native membership, derives the physical point from AppKit's
first-tab screen bounds and per-tab window-relative anchors, raises only that
AX-identified window, and sends a real CoreGraphics right click. Chromium's
Accessibility subtree is no longer traversed. The focused AppKit seed and
restart phases pass locally in
`.desktop-e2e-artifacts/2026-09-05T18-07-03-450Z-darwin`, covering reorder,
move, detach, hide/reveal, restart persistence, and consolidation. The seventh
correction tree also passes source/document/dependency hygiene, TypeScript,
ESLint with zero errors, all 427 Vitest files containing 3,227 tests, Rust
formatting and clippy with warnings denied, the complete Rust workspace suite,
the stable Tauri and Electron production builds, desktop-E2E debug build,
production isolation, and the system-only boundary verifier. The seventh
immutable branch head and full hosted matrix remain pending.

Post-commit foreground validation at the seventh local head
`cd284959e6434abb26f0a88db8c244b68730548f` twice exposed a deterministic E2E
ordering race before the corrected native menu path. The first Role URL was
deliberately held at the external loading gate while the test asked the renderer
for a globally coherent application projection. If admission crossed the Core
and AppKit projection fence during that read, the coherent snapshot correctly
waited for the next native event while the test withheld the event by retaining
the URL gate. Loading admission now comes directly from the exact E2E-only
Core/AppKit Game Window observation: it requires one new tab ID and identical
ordered Core and native tab membership before inspecting AppKit's loading
presentation. The gate is then released before the renderer coherence read.
This changes no production timer, authority, or runtime behavior. The corrected
foreground seed and restart phases pass in
`.desktop-e2e-artifacts/2026-09-05T18-28-02-215Z-darwin`. The eighth immutable
branch head and its exact-SHA hosted matrix remain pending.

The eighth exact-SHA matrix, run `33984444918` at
`4a4bdd499d90a89692051fe314235cc1943d7a35`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both macOS and Windows native validation,
and both hosted desktop-E2E profiles. Its two Chromium package jobs failed in
separate late shell-E2E paths before any packaged release step. The Windows job
failed while restoring the saved mixed Workspace: Core
created the dormant Game Window at generation zero, then asked the shell to load
its global Web surfaces before the later ownership follower projected the
committed positive generation. The shell correctly rejected that stale identity
instead of attaching Chromium to an unfenced native host.

Every v23 Chromium launch now projects the exact committed Core window,
active-tab, generation, and topology ownership immediately after native tab
creation and before Role or Web-surface loading. A foreground launch continues
to carry reveal and focus intent; restore hydration carries empty reveal/focus
sets and therefore preserves the current key window. The cross-platform Core
regression test proves both the positive fences and `create < ownership < load`
ordering. The focused macOS AppKit Workspace Web seed and restart phases pass
locally in `.desktop-e2e-artifacts/2026-09-05T18-55-40-254Z-darwin`. This local
run cannot replace the failed Windows package evidence; the ninth immutable
branch head and full hosted matrix remain pending.

The macOS package completed the preceding Chromium/AppKit journeys and reached
the final visible-tabs seed before rejecting a menu-click geometry fence. After
a committed reorder or cross-window move, the titlebar observer read the current
CALayer presentation frame while each tab anchor still came from its destination
model frame. A still-visible AppKit animation could therefore make two otherwise
valid native observations disagree. The desktop-E2E-only anchor now samples the
same presentation layer as the titlebar observer, so the real CoreGraphics input
targets the pixels currently on screen without traversing Chromium's
Accessibility subtree. Native AppKit compilation and the focused tabs seed plus
restart pass locally in
`.desktop-e2e-artifacts/2026-09-05T19-03-54-908Z-darwin`. This correction is not
part of the ninth immutable head; it requires the following exact-SHA matrix.

The ninth exact-SHA matrix, run `33985708422` at
`bdfd61fe594f313d351e1d189752903f1aea8437`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both native-validation jobs, and both
macOS and Windows desktop-E2E jobs. Its macOS package job reached the same final
visible-tabs geometry fence described above; the correction is committed at
`55ae85e88c276e8c4bc7f5cea831e0173e99a643` and its clean exact-SHA local tabs
seed/restart evidence is
`.desktop-e2e-artifacts/2026-09-05T19-07-18-744Z-darwin`.

The Windows package advanced beyond saved mixed-Workspace generation and load
admission, then reopened the correct global-Web URL with both prior cookie and
LocalStorage absent. Its paired Role profile, under the same user-data root,
retained process-restart state. The exact difference is that Rust
`fs::canonicalize` serialized only the global-Web profile with a Windows
verbatim device-path prefix; Chromium accepted and echoed that storage path but
did not recover its persistent data. The pending correction preserves Rust
canonical and symlink-boundary validation while serializing the equivalent
ordinary absolute drive or UNC path for Chromium, and makes Electron reject a
verbatim device path instead of silently running a non-durable session. The next
immutable matrix must prove both this Windows persistence correction and the
already-corrected AppKit presentation geometry at one exact SHA.

The tenth exact-SHA matrix, run `33987222000` at
`299258f8a2bfa6ceb06760df644f391ea08a470f`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, and both macOS and Windows desktop-E2E
profiles. Its Windows package run physically proved that the ordinary absolute
global-Web profile path restores both the cookie and LocalStorage across an app
restart. Windows native validation then stopped only at a Windows-only Clippy
`needless_return` finding; `2704c532de8562daf026c905e9f0bc7edc1d9b1f`
removes that target-specific lint without changing path behavior.

Both tenth-matrix package jobs advanced to later E2E tooling edges. The macOS
journey passed through Workspace Web fullscreen and Web-only visible actions,
then the evidence reader rejected one valid hidden `activating` projection
sampled between the degraded surface and its visible reopen. The reader now
accepts at most one such projection only inside that generation-fenced interval;
the original CI artifact and a focused behavior test both pass, while a visible
or misplaced activating projection remains rejected. The Windows journey passed
global-Web seed and restart, then its exact-PID native file-dialog script failed
PowerShell parsing before UI Automation ran because the nested dialog condition
was missing one closing parenthesis. The script and its Windows-only portable
source fence are corrected.

The complete working-tree `chromium-macos-appkit-smoke` profile passes locally
after both corrections, including retained AppKit Workspace Web file upload,
fullscreen, tabs, trusted input, recovery, and all restart phases. Its artifact
root is `.desktop-e2e-artifacts/2026-09-05T19-45-05-164Z-darwin`. This local
evidence closes the macOS diagnosis but is not immutable candidate evidence; the
next exact-SHA hosted matrix must still prove the Windows dialog correction,
Windows lint, both native jobs, both package jobs, and the same AppKit profile
together.

The eleventh exact-SHA matrix, run `33989123321` at
`c850847d391759342155d4cc61c7c75375efd182`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both hosted desktop-E2E profiles, and
macOS native validation. Windows native validation passed target Clippy and 954
of 956 Rust Core tests. Its two failures were stale test expectations from the
ordinary Windows Chromium-path correction: they compared the serialized engine
path with `fs::canonicalize`'s verbatim device path instead of the same
`chromium_engine_path` contract used by production. Both assertions now use the
authoritative conversion and pass locally; the Windows host remains the required
proof.

The eleventh Windows package run reached the real visible file-upload action.
Fixture evidence proves that the trusted pointer down/up and default click
arrived, while the WebDriver log proves it switched back to the main renderer
three milliseconds before the input's default action requested its OS chooser.
The upload-only pointer path now retains the exact Role target until the
exact-PID native chooser selects and closes, then restores the main target in a
`finally` boundary. Other pointer actions retain their existing immediate
restore behavior. The same nested Windows UI Automation condition in the later
diagnostics save-panel helper also receives its missing parser parenthesis and a
portable source fence. The focused macOS AppKit dependency, file-upload,
fullscreen seed, and fullscreen restart chain passes with the retained target
in `.desktop-e2e-artifacts/2026-09-05T20-20-44-010Z-darwin`; Windows physical
proof and the complete next immutable matrix remain pending.

The eleventh macOS package run continued through every mixed-recovery phase and
then exposed a later seed-ordering gap in the multi-window recovery journey.
Three visible launches had completed their remote Session evidence, but the test
read the persisted Game Window list before the third tab projection committed
and dereferenced the absent tab. The seed now waits for the Rust-owned saved
topology to contain every exact Role in its requested Game Window, with a
non-successful external-liveness boundary if that projection never arrives,
before freezing lifecycle evidence. The focused retained-AppKit seed passes in
`.desktop-e2e-artifacts/2026-09-05T20-31-35-364Z-darwin`. This is E2E ordering
only; it does not add product polling or change recovery behavior. The next
immutable matrix must include this correction.

The twelfth exact-SHA Windows package run at
`183fd7a88e55b86b93c0d8bd432b5f4df8762cdc` proved that retaining the remote
WebContents target was necessary but not sufficient. The actual trusted
pointer down/up, captured click, and file-upload request all reached the page,
while UI Automation found no `#32770` whose own PID equaled the Electron main
PID. Chromium's Windows implementation creates the in-process
`IFileOpenDialog` with an explicit native owner HWND, so the helper now accepts
only a unique `#32770` whose UIA PID is the exact app PID or whose direct Win32
`GW_OWNER` HWND resolves to that PID. This preserves exact application
ownership across Windows UIA provider differences. If neither relation is
present, the phase remains failed and writes a bounded HWND/PID/class/owner
snapshot into its uploaded artifact instead of widening selection to another
application. The next immutable Windows run must prove which exact ownership
path is present and complete the native selection.

The thirteenth exact-SHA matrix, run `33991852617` at
`e6508373ddf154e851d283aab748116b65451090`, reached the revised Windows
owner-chain observer. Its failure occurred before native selection because
PowerShell enumerated the single matching dialog returned by the helper into an
`AutomationElement`; under `Set-StrictMode`, that scalar has no `Count`
property. Every exact-dialog read is now explicitly array-wrapped, preserving
the zero/one/many ownership fence while allowing the unique owned chooser to
advance. The same run passed checks, renderer assets, Linux soak, both hosted
desktop-E2E profiles, and macOS native validation; its remaining jobs were
still running when this correction was prepared.

The twelfth run's macOS package artifact also made the remaining AppKit geometry
mismatch precise. The titlebar observer reported the target window's first tab
at absolute screen `y=42`, while Core's Chromium content bounds began at
`y=68`; using the latter as a titlebar origin incorrectly rejected a real
native tab. Visible drag and menu input now translate every window-relative tab
anchor through AppKit's first-tab absolute screen frame, and take vertical
input from that same frame. No Core/AppKit ownership fence is relaxed and no
Chromium Accessibility node substitutes for the native action. The focused
retained-AppKit seed plus restart chain passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-16-47-637Z-darwin`.

The fourteenth exact-SHA Windows package run, `33992859467` at
`dcea42c9f515f0024b6856d5cdc0e581d3306666`, passed the array-cardinality
correction and again captured the trusted page input, but its ten-second UIA
snapshot contained only the two Electron `Chrome_WidgetWin_1` windows and no
top-level `#32770`; the foreground HWND belonged to a different process.
Chromium's authoritative Windows contract presents the common-item dialog with
`Show(owner)`, and Chromium's own native test identifies related windows by
their direct `GW_OWNER`, not a stable class name. The helper now snapshots the
exact top-level HWNDs belonging to the Electron app before the click, then
accepts an out-of-process candidate only when its direct owner equals one of
those handles and it uniquely contains both the file-name edit control `1148`
and Open button `1`. The legacy same-process `#32770` path remains, but also
requires those exact controls. Failure evidence now includes the foreground
window's class, name, owner HWND, and owner PID. The next immutable Windows run
must physically prove this stricter native-window ownership path.

The same fourteenth run's macOS package stopped earlier in the Quick Access
seed, independently of the AppKit tab correction. The exact localized Role
action button existed and was visible in the failure screenshot, but its
post-hover opacity transition had not completed when the test synchronously
called `isDisplayed()`. Quick Access now follows the already-proven CRUD E2E
pattern: select the unique existing localized action control, then wait for
that real control to become clickable before clicking it. The focused entity
seed/restart plus Quick Access seed/restart chain passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-38-06-887Z-darwin`; no renderer or product
timing behavior changed.

The fifteenth exact-SHA Windows package run, `33993690606` at
`b673b26852a3a3254598d27f46775af1ed0d3860`, proved the stricter native owner
relation without ambiguity. The foreground window was the native `Open`
`#32770` in process `5124`, and its direct owner HWND `524362` was the exact
Electron Game Window in process `4316`. Windows UI Automation nevertheless
omitted that dialog from `RootElement`'s direct children for the full bounded
observation. The helper now resolves the actual foreground HWND with
`AutomationElement.FromHandle`, then admits it only when it remains a
`#32770`, its direct owner is one of the snapshotted Electron HWNDs, and it
uniquely contains the exact file-name edit `1148` and Open button `1`. The
same-process and enumerated-owner paths remain unchanged, and multiple matches
still fail closed. A new immutable Windows package run must complete the
physical selection and subsequent packaged gates.

The same fifteenth run's macOS package crossed the earlier Quick Access race
and reached the background-tab Macro journey. Its retained AppKit host emitted
the trusted `Digit2` keydown and Core recorded the exact applied hold receipt,
but the E2E read the fixture's consumer state about 32 milliseconds before the
page's independent `consumer-keydown` report arrived. The later hidden-start
half of this journey already waits on that consumer event. The first start now
uses the same authoritative boundary and persists that exact trusted consumer
event in the validated runtime evidence before asserting held state. This is
E2E observation ordering only; it does not delay or otherwise change Macro,
trusted-input, Chromium, or AppKit runtime behavior. The corrected focused
AppKit/Chromium phase passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-52-20-301Z-darwin`.

The sixteenth exact-SHA Windows package run, `33994424367` at
`41b9cd746130e7dd1d744996741fd7486dc61d45`, reproduced the same positive
native relation: foreground `Open` HWND `262236` in process `3564` was directly
owned by exact Electron Game Window HWND `589924` in process `6580`. The
foreground-`FromHandle` candidate did not pass the exact file-name/Open control
fence, but the prior diagnostic could not distinguish zero controls, duplicate
controls, or a descendant-provider exception because that inspection was
fail-closed and intentionally swallowed. Failure evidence now records the
foreground UIA exception, exact control counts, total descendant count, and at
most 160 bounded descendant identities. No selection path or acceptance fence
changes in this diagnostic step; the next Windows run must identify the exact
provider/selector mismatch before remediation.

The same sixteenth run's macOS package crossed the corrected Macro phase and
reached `chromium-fullscreen-toolbar-restart`. Rust had already projected the
restored Role as `running`, so the E2E skipped a duplicate visible Open action,
but it immediately read the still-materializing Electron/AppKit session and
found `currentRuntime: null` only 2.7 seconds into the phase. The existing
bounded launch observer now completes only when both the Rust Role status is
running and the corresponding native Chromium runtime is non-null. It neither
relaunches an in-progress restored Role nor changes the product restore path;
the native projection itself remains the successful event condition. The full
focused dependency chain through entity seed/restart and fullscreen-toolbar
seed/restart passes locally in
`.desktop-e2e-artifacts/2026-09-05T22-07-00-603Z-darwin`.

The seventeenth exact-SHA Windows diagnostic run, `33995062145` at
`dd33630029746bfefece72ac5ee04b3a1055951b`, reached the bounded foreground
control collection but PowerShell 5.1 rejected array-subexpression conversion
of the generic `List<object>` while constructing the JSON snapshot with
`Argument types do not match`. The snapshot now calls the list's explicit
`ToArray()` conversion. This corrects diagnostic serialization only; it does
not change the native chooser's acceptance or input behavior.

The eighteenth exact-SHA Windows diagnostic run, `33995526248` at
`d15be30487b12ae643c1dc0e577ef21c0ef9e8f2`, produced the complete bounded UIA
snapshot. The exact foreground/owner relation was intact and descendant
traversal completed without error over 54 controls, but this Windows provider
classified every HWND-backed common-dialog control as `ControlType.Pane`.
Within that tree, the unique file-name leaf was still the stable native pair
`AutomationId=1148, ClassName=Edit`, and the unique Open leaf was
`AutomationId=1, ClassName=Button`; both had positive native HWNDs, were enabled,
and were on screen. The selector now uses those exact native identity pairs
instead of the provider-dependent UIA ControlType. After the same unique
dialog/owner/control fence passes, the helper focuses those visible controls,
types the literal isolated fixture path, and presses Enter on the exact Open
control. This preserves the real page click that opens the chooser and the
visible native selection while avoiding unsupported Value/Invoke patterns on
the generic `Pane` provider.

The nineteenth exact-SHA Windows package run, `33995971341` at
`33fff22550b8f1959c54c8231717c13dfc4d1b16`, reached the fullscreen upload
phase but Node failed before launching PowerShell with `ENAMETOOLONG`. The
expanded diagnostic script, encoded as UTF-16LE Base64 in `-EncodedCommand`,
had crossed the Windows process command-line bound; therefore this run did not
exercise or invalidate the exact native selectors above. The shared bounded
PowerShell runner now passes its trusted source through redirected standard
input using the fixed `-Command -` arguments, while keeping caller-controlled
JSON payloads Base64-encoded in the process environment. Direct updater
observers that need their own process/signal supervision retain the existing
encoded-command invocation. This removes command-length dependence without
placing fixture paths in command text or relaxing any native ownership,
cardinality, visibility, or control fence. A new immutable Windows package run
must physically prove the selection and continue through its remaining
package gates.

The twentieth exact-SHA Windows package run, `33996548461` at
`1130331d0a1f266bfa4838b47ec7a641d7ca1928`, physically completed the native
upload selection. Its durable artifact binds the exact application-owned
Windows common-item dialog and visible action to the fixture's 57 bytes,
filename, and SHA-256 as independently read by the remote page. The run then
passed website-controlled fullscreen exit and re-entry, but a process-wide
Win32 `SendInput` Escape did not leave HTML fullscreen: the exact Game Window
projection remained focused, the foreground HWND belonged to the exact app
PID, and the injection API accepted the scan-code pair, while Chromium retained
its entered state. The Windows journey now follows the same
focused-WebContents keyboard path used by Chromium's own fullscreen tests and
Rion's existing visible Windows Role F11/Quick Access E2E: after fencing the
exact URL and `document.hasFocus()`, a W3C keyboard source submits Escape to
that WebContents. macOS continues to validate the retained AppKit runtime
window/tab and posts its Escape through the existing CoreGraphics native-input
path. No product fullscreen, Chromium presentation, or AppKit code changes.
The next immutable Windows run must prove main and popup exit and advance into
packaging.

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
