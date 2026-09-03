# Updater Install Transaction

Rion Studio treats installation as a recoverable transaction. The stable v22
Tauri shell and target v23 Electron shell share the same persisted preferences,
install-attempt phases, updater signature, and SHA-256 release contract.
Production macOS artifacts continue to use the ad-hoc identity (`-`) without
notarization, and Windows installers remain Authenticode-unsigned. Platform
signing policy does not weaken the mandatory Minisign `.sig` and SHA-256 checks.

For v23, `rion-updater` is the trust root. Electron main may request a check,
present a status, order the shell/Core drain, and exit after a handoff receipt;
it does not select releases, trust a URL, calculate success from elapsed time,
or use Electron `autoUpdater`. The compile-time verification key and HTTPS
manifest endpoint enter only the Rust Node-API addon. The manifest parser
selects one exact platform artifact, requires a strictly newer semantic version
and RFC 3339 publication time, and rejects credentials, redirects, queries,
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

The v23 downloader disables redirects and applies explicit external-network
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
owner-selected HTTPS origin whose manifest and artifact URLs answer directly
without redirects; a missing endpoint makes updater construction fail closed.
Unpackaged development uses only the non-routable `updates.invalid` placeholder.

## Production Electron candidate gate

The production Chromium asset set is built only by the manual, protected
`Electron Production Candidate` workflow described in
[`electron-production-candidate.md`](electron-production-candidate.md). The
owner must provide one exact source SHA, strict semantic version, calendar-valid
RFC 3339 publication timestamp, direct-200 HTTPS asset base, and explicit
acknowledgement. Both platform jobs use the existing production updater
public/private key secrets; a fixture or ephemeral key is forbidden. The macOS
job retains the AppKit host and ad-hoc identity (`-`) without notarization, while
the Windows executable and installer remain Authenticode-unsigned.

The v22/v23 names below identify runtime contracts only. They do not constrain
the major number of the application SemVer carried by a release. The target
application version must be strict SemVer and strictly newer than the exact
published Tauri source and prior Electron source versions.

Before any production updater private key enters scope, the Windows job must
silently install the exact NSIS artifact under a temporary local-user profile
and prove that its installed payload equals the already black-boxed
`win-unpacked` manifest after removing exactly the generated root uninstaller.
The isolated runner must report root exit code zero, Job Object active-zero,
exactly three observed processes, and verified profile/account/ACL cleanup in a
create-new measured result. Its repository-detached, parent-owned input root is
read-only to the temporary SID; the source package has an explicit recursive
deny. A canonical inventory lists the source root plus every directory and file;
before NSIS starts, non-mutating native probes must receive `ACCESS_DENIED` for
read, write, and delete access to every path. A canonical closed-schema payload
proof binds a fresh attempt nonce, exact command-invocation digest,
command/harness/installer/inventory identities, that result, both full
manifests, the sole allowed added path, the unsigned
policy, source SHA, version, and black-box component and package digests. It
also rejects non-default NTFS streams and binds Authenticode status to the same
locked bytes that were hashed. The proof is part of the exact Windows platform-candidate inventory;
its identity is recorded in the platform and cross-platform receipts and is
re-verified against the staged installer during assembly. Missing, forged,
noncanonical, stale, or payload-divergent proof prevents signing or assembly.

The assembly gate re-verifies both Minisign signatures, inline manifest hashes,
`SHA256SUMS.txt`, exact filenames, platform receipts, source SHA, version,
endpoint, and normalized public-key digest. It then rebinds every copied
single-link asset to the corresponding closed platform receipt. macOS and Windows must therefore be
parts of one immutable candidate rather than independent release selections.
The macOS receipt additionally binds the signed tar and DMG to one package
manifest already proven by the retained AppKit/Chromium black-box. Before the
private key enters scope, the detached signer restores the unsigned handoff only
under a create-new temp root. One bounded type-aware extractor rejects
out-of-root paths, hardlinks, special entries, symlink escapes or ancestor
writes, and colliding paths. Producer must safely extract the tar and attach
the DMG read-only before and after signing; native verifiers receive no
updater-private environment values. It fences artifact identity and bytes and
requires the binding during staging, assembly, and final verification.
The terminal candidate receipt is explicitly `verified-not-published`. The
workflow has read-only repository permission and cannot create or mutate a
release or updater endpoint. A later promotion needs a separate owner-approved
environment gate, the exact candidate receipt, and the required v22-to-v23 and
v23-to-v23 compatibility evidence. The stable Tauri release path remains active
until those cutover gates pass.

The manual `Electron Production Promotion Readiness` workflow is the read-only
aggregation boundary for those future receipts. It accepts exact target,
prior-v23, and evidence workflow-run IDs plus owner-recorded receipt hashes,
verifies each run's workflow path, successful conclusion, attempt, source SHA,
and event, and then downloads both complete candidates, all four platform
candidate artifacts, two attested public-v22 lineage receipts, and four terminal
transaction bundles. Candidate, platform, and external-evidence artifact names
include `-attempt-<run_attempt>`; each lineage name embeds the exact
API-verified run ID and attempt. The downloader derives every name only from the
verified run metadata, so a rerun cannot fall back to an earlier same-source
artifact. The candidate verifier rejects unknown receipt fields, rebuilds both
cross-platform candidates from their platform receipts and packaged black-box
reports, re-verifies production Minisign, and requires byte-identical assets and
byte-identical canonical candidate receipts. A terminal receipt cannot invent
its prior-v23 lineage.

Each public-v22 lineage receipt is create-new and closed-schema. The macOS job
derives the exact regular `Rion Studio.app/Contents/MacOS/rion-tauri` member;
the Windows job obtains the unique regular, non-reparse `rion-tauri.exe` only by
installing the verified NSIS artifact into a fresh isolated per-user root. The
receipt binds the public release and selected asset IDs, bytes and hashes, the
peeled source tag, target source SHA, production updater-key digest, and the
derived executable hash. Its producer name includes the API-verified workflow
run and attempt, and GitHub provenance attests that single receipt file. It
remains `cutoverEligible: false`: it proves source lineage, not source updater
invocation. Readiness cross-binds its artifact, manifest, trust, and executable
hashes to each platform's real v22 terminal transaction.

Each terminal transaction bundle has a closed inventory and one externally
attested receipt for one platform and one transition. The receipt binds a fresh,
bounded-lifetime challenge; published or canonically rebuilt source lineage;
the source binary's actual fetch endpoint; the target candidate's distinct
embedded future endpoint; exact manifest, artifact, signature, and updater key;
source invocation and handoff; data preservation; and native-host identity.
`evidenceAttemptId` is a unique RFC 9562 UUID, while
`sourceInstallAttemptId` preserves the product journal exactly: v22 uses an
`update-install-<u64>` sequence and v23 uses
`update-install-<uuid>`. The bundle contains the raw source journal and the
durable product-authored first-boot receipt that cryptographically binds that
journal's bytes and digest. A producer-authored `applied` boolean is not a
terminal authority. The aggregator requires all four combinations: Tauri v22
to Electron v23 and Electron v23 to Electron v23 on both macOS AppKit and
Windows. GitHub artifact attestation must identify the fixed external evidence
workflow and exact target source digest; an unattested receipt is not evidence.
The v23 source endpoint remains direct HTTP 200 with no redirect. The immutable
v22 GitHub public-latest endpoint instead records its real bounded HTTPS redirect
chain: one to three ordered hops, an exact first hop to the target version tag,
then only GitHub release-asset hosts, and a final HTTP 200. Short-lived signed
asset URLs are bound by SHA-256 plus scheme and host rather than persisted with
their query credentials.

The readiness result is create-new and explicitly
`verified-terminal-evidence`/
`externally-served-terminal-evidence-observed`. It has no release,
updater-endpoint, GitHub App, or updater-private-key write authority and is not a
terminal promotion receipt. It does not claim `not-published`: an immutable
published v22 binary can fetch v23 only after its compile-time public-latest URL
serves that target. The status records the completed evidence window and does
not assert that the endpoint is still serving v23 when readiness later runs; a
terminal finalizer must re-observe that external state. The fixed external
terminal-evidence workflow named by this gate now has a hard-disabled producer
implementation. Every job remains literal `if: ${{ false }}` and no native
transaction has been owner-authorized or executed, so the gate cannot pass from
current repository evidence. This is intentional fail-closed state, not
permission to infer the missing runtime observations.

## Public promotion boundary

The generic workflows that finalize a private release, publish a public release,
or restore the public latest release are stable Tauri v22 paths only. The public
publisher is reusable but is not manually dispatchable. Its caller must select
the `tauri-v22` release contract, and every private or public asset download is
checked again against the exact checksum set and the packaged macOS application
shape. The archive must contain exactly one regular top-level macOS executable at
`Rion Studio.app/Contents/MacOS/rion-tauri`. A second top-level executable, an
archive containing Electron's `app.asar` or `Electron Framework.framework`, an
Electron candidate receipt, or any unrecognized release asset fails closed.
These checks preserve the existing v22 publication and recovery behavior; they
are not an Electron promotion mechanism.

There is still no approved or enabled provisional publisher and no enabled or
owner-approved execution of either the hard-disabled externally attested
terminal-transaction producer or the hard-disabled terminal-promotion
finalizer. A closed terminal-promotion schema and producer now exist as
non-authorizing transition code, but every finalizer job is literal
`if: ${{ false }}`. Therefore no enabled workflow may translate a
`verified-not-published` candidate or a `verified-terminal-evidence` receipt
into a terminal published outcome. The compatibility receipt described below is
also ineligible because it records `sourceUpdaterInvoked: false` and
`cutoverEligible: false`. Because the existing v22 endpoint is immutable, a
future Electron writer must first preserve and re-hash the exact v22 latest
snapshot, compare-and-swap the exact target into externally served state, and
write only a non-terminal provisional receipt. A read-only producer may then
obtain the four real transactions. A separate finalizer must re-observe the
external state before writing the sole terminal promotion receipt; failure,
cancellation, or an unknown acknowledgement requires a dedicated rollback or
an indeterminate outcome. Until those gates are owner-enabled and successfully
executed, every generic Electron publication or latest-promotion attempt is
rejected.

The hard-disabled terminal finalizer serializes with every public-latest writer.
It re-verifies the exact readiness, provisional receipt, recovery-capsule source
and target snapshots, and held durable lease before any public write credential
enters scope. A read-only job must first observe the exact target. One separate
narrow writer may then release only the bound held lease with authoritative
readback. A second read-only job must still observe the exact target after that
release. Only those two target observations plus a confirmed or later
reconciled exact lease-release acknowledgement can create the canonical
`rion-electron-production-terminal-promotion` receipt with outcome `promoted`.
The final receipt binds the readiness and provisional hashes, both snapshot
identities, both observation receipts, held and released lease event hashes,
candidate identity, protected control-plane SHA, retained AppKit requirement,
and independent Windows evidence. Detached attestation receives that receipt
alone. A rejected, foreign, source, transport-unknown, or
acknowledgement-unknown input creates no terminal promotion receipt; the durable
recovery workflow remains the sole authority for rollback and non-terminal
indeterminate outcomes.

A provisional-publisher draft and a durable public-repository blob-SHA lease
transport now exist only as non-authorizing transition code. Its stage,
lease-acquisition, and latest-mutation jobs are statically disabled. The draft
already implements authoritative lease-file 404/genesis or blob-SHA
compare-and-swap, protected-default-branch writer jobs that never execute
candidate code beside release credentials, and exact last-moment public-state
readback.

The durable recovery path also exists as a separate hard-disabled workflow. It
fresh-reads a private append-only capsule and store seal, routes the current
public state, and probes one proof-derived marker slot for each outcome
predecessor before deciding whether any new public mutation is allowed. Only the
run that creates an absent marker may receive the public writer token and submit
one rollback or held-lease release. A resumed marker receives no public writer
token and performs observation-only reconciliation; already-released and
possibly-released lease routes likewise emit a canonical zero-PUT operation.
Rejected, unknown-acknowledgement, no-op, and successful operations all bind into
an append-only recovery outcome. Non-terminal outcomes use one create-new CAS;
terminal outcomes write the attempt and fixed terminal path as one atomic pair.
A distinct private reader then fresh-reads the applied commit and complete chain,
and the detached gate succeeds only for an exact terminal outcome.

Every job in that recovery workflow remains literal `if: ${{ false }}`. Enabling
either transition workflow still requires owner-approved private-store
coordinates, narrow reader and writer GitHub Apps, protected environments,
matching variables and secrets, and an independent recovery drill. None of this
authority may be inferred from a local artifact, lease receipt, or repository
default.

The hard-disabled abandoned-lease cleanup draft is deliberately narrower than
durable recovery. It may release only the current held provisional-publication
lease while GitHub still retains authoritative live metadata proving the exact
holder run attempt is terminally failed or cancelled and both possible public
mutation jobs are terminal `skipped` with no executed steps: the fixed
`publish-provisional` job and the fixed
`cleanup-held-lease-after-store-failure` job. The
workflow reads the bounded, fully paginated exact-attempt job set, fences the
two unique numeric job identities, and repeats that bounded exact-attempt
job-list read before mutation. It also rebuilds the exact Tauri source from an
initial latest/tag/assets observation, then requires an unchanged closing
latest/tag and a final unchanged latest reread immediately before the lease
CAS. If run or job metadata is missing, expired, non-unique, mutable, or
otherwise ambiguous, this shortcut cannot act and the lease requires the full
durable capsule/rollback recovery path. Its live Actions metadata is not
durable evidence and it cannot close a submitted or possibly submitted latest
mutation. The shortcut must remain statically disabled until its own durable
one-shot public-mutation marker is enforced and an owner-approved recovery
drill has passed.

The durable lease occupies the fixed
`releases/electron-production-public-latest-lease.json` path on `main` in the
public `rion-tw/rion-studio` repository. A missing-file observation is genesis
authority only when the same operation independently verifies that repository
is public, its default branch is `main`, and the exact `heads/main` reference is
readable. Publication leases require a Tauri v22 source; a Tauri latest-restore
lease records the actually observed source and may therefore start from either
Tauri v22 or an Electron v23 provisional latest, while its target remains Tauri
v22. Every non-genesis write supplies the currently observed Git blob SHA
to the GitHub Contents API. A create or update is acknowledged only after a
fresh read returns the exact canonical expected lease and blob identity;
conflict, malformed, foreign, transport-ambiguous, or server-ambiguous outcomes
remain non-success. The transport has no retry, timeout-to-success, expiry, or
stale-holder takeover path.

Production candidate signing, cross-platform candidate assembly, provisional
publication, readiness, recovery, and finalization execute their control code
only from a protected `main` control-plane SHA in
`rion-tw/rion-studio-source`. A candidate source SHA is immutable product input
carried by closed receipts, hashes, and attestations; it is not the workflow
implementation SHA. Candidate-controlled repository code must never execute on
a runner after an updater private key, release GitHub App private key, release
token, terminal-receipt attestation authority, or equivalent publication
credential enters scope. Downstream provenance therefore verifies the fixed
repository, protected branch, workflow path, run attempt, and control-plane SHA
separately from the candidate source identity.

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

On Windows, `Update::install` extracts the installer before invoking its
`on_before_exit` hook. Extraction failure leaves WebView2 and Core accepting
work. The hook writes `draining`, closes runtime/core, records installer handoff,
calls Tauri's `cleanup_before_exit()`, and then lets the plugin launch the
installer and terminate the process. If handoff returns an observable error
after draining began, the journal records `failedAfterDrain` and Rion Studio
restarts automatically.

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

The workflow has read-only repository permission and cannot publish or promote
the target needed for that final source-runtime transaction. Real cutover
evidence therefore remains pending until the exact published v22 executable
initiates the production-signed candidate update and reaches its authoritative
terminal outcome on both macOS and Windows. The existing Tauri compatibility
and release entry remains active until then; macOS or portable results cannot
substitute for Windows evidence.

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
