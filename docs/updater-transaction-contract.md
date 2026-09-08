# Updater Install Transaction

Rion Studio treats installation as a recoverable transaction. The sole Electron
shell retains persisted preferences, install-attempt phases, updater signatures,
and the SHA-256 release contract, including consumed legacy v22 records.
Production macOS artifacts continue to use the ad-hoc identity (`-`) without
notarization, and Windows installers remain Authenticode-unsigned. Platform
signing policy does not weaken the mandatory Minisign `.sig` and SHA-256 checks.

For v23, `rion-updater` is the trust root. Electron main may request a check,
present a status, order the shell/Core drain, and exit after a handoff receipt;
it does not select releases, trust a URL, calculate success from elapsed time,
or use Electron `autoUpdater`. The compile-time verification key and HTTPS
manifest endpoint enter only the Rust Node-API addon. The manifest parser
selects one exact platform artifact, requires a strictly newer semantic version
and RFC 3339 publication time, and rejects credentials, queries,
fragments, unknown fields, and over-limit input.

## Public state

`installDownloadedUpdate()` returns an accepted
`AppUpdateInstallAttemptRecord` immediately. The `rion://update-status` event is
the authoritative source after acceptance and uses `AppUpdateStatusRecord`.
Transaction states are `preparing`, `installing`, `draining`,
`restart_pending`, and `install_failed`.

One install gate owns the active attempt. Repeated clicks return the same attempt
and cannot launch another installer. A failed attempt becomes retryable only
when the runtime remains usable or a fresh process has recovered from the
journal.

The Chromium addon additionally wraps every native status in a monotonic
revision. Its blocking Node event bridge preserves every authoritative status;
Electron accepts only a contiguous forward stream before publishing the existing
renderer-facing `onUpdateStatusChanged` payload. Manual check and install calls
are single-flight in both Electron main and Rust. A duplicate waits for or
replays the exact leader outcome and never repeats download, replacement, drain,
or installer launch.

## Verified staging

The v23 downloader rejects redirects except for the bounded, fixed public GitHub
release route documented in the configuration delta. It applies explicit external-network
deadlines. A connection receives ten seconds, a complete manifest request
receives thirty seconds, and a complete artifact stream receives sixty minutes,
which prevents the former thirty-second whole-download cutoff. Manifest input
is bounded to 1 MiB and an artifact to 1 GiB. The
artifact streams into a private, create-new file; advertised length, observed
length, SHA-256, and Minisign must all match before Rust atomically publishes a
pending receipt. The receipt is the commit marker and binds the target version,
platform, fixed staged filename, byte length, manifest digest, artifact digest,
and signature digest. A fresh process re-reads the manifest and re-verifies the
exact regular artifact before restoring `downloaded` state. Missing, malformed,
symlinked, mismatched, or tampered evidence is never installable.

Packaged v23 builds have no implicit GitHub release endpoint. They must embed an
owner-selected HTTPS origin. Direct responses or the fixed GitHub release
redirect chain are accepted; a missing endpoint makes updater construction fail closed.
Unpackaged development uses only the non-routable `updates.invalid` placeholder.

## Release entry and evidence

Electron is the sole repository release target, using the existing release
workflows, App, updater credentials, endpoint, application identity, and normalized
asset names. The owner retired the provisional publication/terminal-promotion
backlog on 2026-09-09; no additional GitHub environment or recovery infrastructure
is required. This does not authorize publication during repository cleanup.

Current publication and restore targets must pass the Electron package shape,
Minisign, SHA-256, exact inventory, and immutable-source checks. Published legacy
v22 packages remain valid source inputs only. The existing protected-main control
boundary, durable public-latest lease, exact source/target snapshot identity,
acknowledgement and fresh readback rules remain enforced. Ordinary publication
requires a strictly newer target; latest restoration may select an older verified
Electron release. Neither path may produce a new Tauri target.

The former four production updater transactions and terminal-promotion receipts
are no longer execution gates. Existing receipts retain their original semantics:
fixtures and installer replacement tests do not prove a source updater actually
fetched or installed a production release. Historical gate specifications remain
in [the pre-cleanup contract](https://github.com/rion-tw/rion-studio-source/blob/e61895ba3848947132191eb55e3f73026f548bf7/docs/updater-transaction-contract.md).

## Durable journal

`app-update-install-journal.json` is replaced atomically for every phase. It
stores the attempt ID, target version, timestamps, phase, and stable failure
code. At startup:

- If the target equals the running version, reconciliation first produces an
  in-memory `applied` attempt but deliberately retains the source journal.
  Platform finalization, pending-payload cleanup, and preference persistence
  must all succeed. Rust then writes an immutable attempt-bound record under
  `app-update-terminal-receipts/` containing the exact source-journal byte
  length and SHA-256, raw prelaunch phase, running version, applied attempt, and
  reconciliation timestamp. Only after that durable commit does it remove the
  source journal. A crash after receipt creation reuses the matching receipt and
  retries journal removal; a mismatch fails closed. The receipt uses an atomic
  no-replace commit, and its directory entry is durable before unlink begins.
  Once committed, an already-absent, retained, replaced, or durability-uncertain
  journal cleanup cannot revoke the Applied outcome; replay preserves the first
  receipt's reconciliation identity. A different journal at the canonical path
  is never deleted or overwritten: it places the manager in a fail-closed
  `SourceChanged` quarantine that skips pending restore and rejects later check
  or install mutations until explicit reconciliation.
- On Windows, pending cleanup first moves the canonical `pending` directory by
  no-replace `MoveFileExW` with write-through into a UUID tombstone. Only the
  non-canonical tombstone is reclaimed best-effort. Terminal receipt publication
  uses the same write-through, no-replace boundary from a UUID temporary file.
  Exact-handle journal deletion may remain durability-uncertain, which is safe
  because the durable receipt makes replay idempotent; it is not reported as a
  failed Applied update. Unix retains its no-replace quarantine plus directory
  fsync ordering. Both paths re-check the canonical journal after detach so a
  concurrent writer cannot be mistaken for successful cleanup.
- If the version did not advance, status becomes `install_failed` with
  `UPDATE_INSTALL_VERSION_UNCHANGED` and the release remains eligible for a
  fresh verified download.
- An interrupted pre-drain transaction becomes `UPDATE_INSTALL_INTERRUPTED`.
- An unreadable, unsupported, or corrupt journal produces a stable recovery code;
  corrupt content is removed so it cannot trap every later launch.

## Platform ordering

The updater dependency is pinned to `tauri-plugin-updater =2.10.1`. Any upgrade
must revalidate both platform sequences.

On macOS, `Update::install` stages and replaces the application bundle first.
Only a successful return starts runtime/core draining, after which the attempt is
marked `restartPending` and the application restarts. Staging failure therefore
leaves WKWebView and Core accepting work.

The v23 path keeps the same ordering without transferring runtime ownership away
from AppKit. Rust securely expands the verified archive beside the installed
application, rejects escaping archive paths and invalid bundle identity, checks
the exact target version and ad-hoc code-signature integrity, and uses the native
same-volume rename-swap primitive so the installed path always names a complete
bundle. The displaced bundle moves to an attempt-bound backup. Any observed
pre-drain failure swaps the backup back atomically. After an exact shell/Core
drain receipt, Rust records `restartPending` and writes a private handoff record
binding the attempt, target, parent PID, and helper executable inode before it
launches the new bundle in helper mode. That helper validates both durable
records, waits for the exact parent-process exit through the native process
event, and only then starts the normal application with the exact same user-data
directory. The normal application accepts that internal recovery locator only
after Rust revalidates the canonical directory, exact `restartPending` journal,
handoff receipt, target version, ad-hoc bundle, and helper executable inode. The
first target manager finalizes the handoff, backup, staging, pending payload,
and preferences, commits the durable terminal receipt described above, and only
then removes the source journal. AppKit game-window/tab ownership is unchanged;
the updater replaces the application bundle, not the retained AppKit runtime
model. Both relaunch stages resolve the exact regular `CFBundleExecutable` from
the already verified `Info.plist` and spawn it directly. Handoff evidence
therefore names the live helper or target process rather than a short-lived
LaunchServices command. A verified target may use a different executable name
from the displaced Tauri bundle; executable identity is derived independently
from each bundle's signed `Info.plist`.

For v23 Windows, the already verified, fixed-path NSIS executable is prepared
while Chromium and Core remain available. Rust records `draining` before the
shell/Core drain. Only after that drain reaches a successful terminal receipt
does Rust record `installerHandoff` and spawn the exact staged installer with a
hidden process. Electron never substitutes another path or calls an updater
browser API. The installer remains intentionally Authenticode-unsigned; its
mandatory Minisign and SHA-256 evidence is the release authenticity boundary.
Failure to spawn after drain is `failedAfterDrain` and requires a controlled
restart. Windows replacement, relaunch, and data-preservation evidence remains a
required Windows CI/release-candidate gate; macOS validation cannot substitute
for it.

The ordinary Electron package matrix generates a fresh password-protected Minisign key
inside the CI runner's temporary directory. That key is fixture-only and never
enters production release configuration or repository history. CI signs the
real packaged updater payload, creates the normal `latest.json`, and drives the
Rust manager with it. The probe must reject a wrong-platform payload, wrong
SHA-256, bad Minisign signature, and same-version replay. On macOS it exercises
the real ad-hoc `.app` archive through replacement, rollback, interrupted-first-
boot recovery, helper handoff, relaunch, and user-data preservation. On Windows
it installs a previous Electron v23 unsigned NSIS control fixture into an
isolated per-user location, hands the exact verified target NSIS off only after
the synthetic drain receipt, waits for the installer process, relaunches the
installed target, and requires journal recovery plus preserved user data. This
fixture is not Tauri v22 evidence and must never be labelled as such.

Published Tauri v22 input compatibility is a separate, manually supplied,
fail-closed workflow gate. It requires an exact Electron target commit and
version, the owner-selected direct-200 production manifest endpoint, the
published Tauri release tag and tagged source commit, the historical semantic
version, and externally recorded SHA-256 for both platform artifacts. The gate
first captures the tagged release and unique selected asset IDs, then downloads
each artifact by that exact ID rather than by a mutable tag/name lookup. It binds
the artifact, signature, `latest.json`, `SHA256SUMS.txt`, target SHA, and
production public-key digest in an immutable input receipt. It independently verifies the published signature,
proves the macOS source is an ad-hoc arm64 non-Electron bundle, and proves the
Windows source installer remains Authenticode-unsigned.

The same workflow captures a closed public-release snapshot and the source
repository tag object, then emits one attempt-bound
`tauri-v22-public-lineage-receipt.json` per platform. macOS accepts only the
canonical `rion-tauri` archive member. Windows performs a bounded isolated NSIS
installation and accepts only one canonical non-reparse `rion-tauri.exe`, with
the historical product version and unsigned policy. The native compatibility
job has only read permission and uploads each closed receipt. A separate
keyless, non-protected job downloads exactly one attempt-bound platform receipt
and holds the OIDC and provenance-attestation permissions. Production updater
signing material and attestation authority therefore never coexist in one job.
Neither job has contents-write or release-write permission and neither can publish
the Electron target.

The same jobs build the exact v23 target with production updater trust. A
narrow preparation-only process signs the target and foreign-platform
companion, writes an architecture-bound canonical receipt for their bytes and
the generated manifest, and then exits. The signer executes the pinned local
Tauri CLI directly with an isolated home and temporary directory; its child
environment is an allowlist containing exactly one key source and its password,
never GitHub command files, OIDC/Actions tokens, package-manager auth, proxy or
cloud credentials, Node injection options, or Rion release inputs. The password
is not placed in process arguments and signer failures are redacted.
On macOS the preparation request also names the exact unpacked
`Rion Studio.app`. After signing, the parent safely extracts the staged updater
tar through a no-follow, single-root reader, requires the extractor's streamed
archive digest to equal the staged signed-input identity, and runs the full
production package verifier against both the unpacked reference and extracted
application. Full package manifests bracket each verifier call and must remain
identical; their summaries must also match each other. The prepared receipt
therefore records a fail-closed `macosPackageVerification` object bound to the
archive bytes, version, AppKit/native package verifier, and complete package
manifest digest. The Windows form records this field as exactly `null`.

The later platform replacement/relaunch process consumes the prepared receipt
with every updater-private environment variable absent; it rejects any private
signing material at its runtime boundary. Windows gives the repository and
prepared-input root read/execute-only access with explicit mutation denies,
while only a separate runtime root and external Cargo target are writable. The
Windows parent removes inherited access from one protected sibling boundary,
grants the temporary profile traversal-only access there, and grants mutation
only to its direct `child-runtime` descendant. The parent-owned isolation-result
root is explicitly denied and the terminal-receipt sibling does not exist until
active-zero. The isolated entry script reconstructs its complete environment
from a positive allowlist; the sole fixture-signing exception is an explicit CI
call whose key path must be the canonical direct-child fixture key. Production
candidate, E2E, and public-v22 compatibility callers cannot enable it.
Only after the declared platform isolation boundary reaches its terminal state
does the trusted outer parent re-read every prepared identity and canonical
receipt. On Windows that boundary is Job Object active-zero plus verified
temporary-profile cleanup; on macOS it is exact helper admission followed by
active-zero for the supervisor's admitted and observed bundle process lineage.
The isolated probe can publish only a create-new provisional receipt inside its
child runtime. The trusted platform boundary produces the closed isolation
result: the macOS runner does so after its supervisor reaches active-zero, while
the Windows parent does so only after Job active-zero and profile cleanup. The
parent pre-binds the exact command invocation and immutable input receipt
digests, re-reads the command/harness and isolation evidence after active-zero,
and only then creates the previously absent sealed terminal-receipt sibling.
Any change fails; the terminal receipt uses only those sealed identities and
binds the prepared receipt digest instead of hashing mutable runtime paths.
macOS must retain the
AppKit package gate. Its terminal target projects the same prepared
`macosPackageVerification`, so the exact signed updater tar—not a nearby
unpacked bundle—is the artifact proven to retain AppKit, QuartzCore, the native
addon, Chromium linkage, production fuses, and the owner-locked ad-hoc signing
policy. Windows must replace the
historical Tauri executable layout, retain user data, and keep both source and
target installers Authenticode-unsigned. The terminal receipt binds both sets
of hashes but deliberately records
`evidenceKind: tauri-v22-input-plus-v23-layout-replacement-probe`,
`sourceUpdaterInvoked: false`, and `cutoverEligible: false`. This is strong
layout and trust compatibility evidence, not proof that the published v22
executable fetched, accepted, and initiated installation of the v23 candidate.

The macOS compatibility process runs with a closed child environment and an
inherited Seatbelt write fence. Its relaunch child receives a second, narrower
profile that denies writes to the installed bundle and denies process execution
outside that bundle's exact `Contents/MacOS` and `Contents/Frameworks` roots.
The fixed result and admission-acknowledgement files live under one private
`probe-control` directory that the narrower profile cannot mutate. The trusted
outer command hashes the exact Seatbelt profile string and a NUL-delimited
invocation template containing its closed environment, working directory,
Node command, and complete argument vector; the self-digest field uses one
fixed placeholder. The same nonce, invocation digest, and profile digest must
survive the child isolation result and the parent finalizer.
The parent separately pre-hashes the canonical Node executable and exact probe
harness, re-reads both only after active-zero, and records their path, bytes,
and digest in the terminal receipt. The provisional macOS receipt carries the
source and target version observed for every applied transition: exactly one
published-v22 helper case plus the v22-layout and owner-selected prior-v23
Electron bundle cases. The finalizer cross-checks those observations against
the published v22 receipt, prior-v23 workflow input, and prepared target; it
never synthesizes a source version and rejects a same-version transition.
The helper result remains unpublished until the parent admits the exact live
helper PID, executable path, start fence, and audit token; a create-new
acknowledgement then releases the Rust test parent. Audit-token and process
unique-ID containment terminates the observed helper, normal application, and
bundle descendants and requires bundle-process active-zero before parent-only
terminal-receipt finalization. Native AppKit/helper reachability and Seatbelt
inheritance remain required macOS CI evidence; a portable source test cannot
establish them.

Placement or restore-session persistence runs before either platform begins
installation. Failure there is `install_failed`, retains the verified pending
payload, leaves runtime/core open, and permits retry. Only failures observed
after the runtime/core drain begins force an automatic restart.

## Runtime clean-exit handoff

Updater preparation writes the runtime restore session with `cleanExit: false`.
Starting a drain is not evidence of a clean exit. The flag becomes `true` only
after the shared `close_all()` shutdown receipt reaches terminal `applied` or
`degraded`; `failed` and `indeterminate` retain the unclean marker. This rule is
identical for ordinary exit, macOS post-install restart, and the Windows
`on_before_exit` handoff.

If the process stops between drain start and a verified terminal receipt, the
next launch exposes the interrupted window IDs and prior session generation in
the runtime recovery projection. The updater journal and runtime restore session
remain separate authorities: the journal decides installation outcome and
download retry eligibility, while the restore session decides whether native
windows and tabs require recovery.
