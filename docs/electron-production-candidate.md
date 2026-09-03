# Electron Production Candidate

The `Electron Production Candidate` workflow builds the Chromium v23 release
asset set without publishing it. It is deliberately separate from the stable
Tauri v22 release workflows and from fixture-key Electron package validation.
Candidate construction is a manual, owner-locked operation protected by the
`electron-production-release` GitHub environment.

## Required immutable inputs

The owner supplies one exact lowercase 40-character source SHA, one strict
semantic version without a leading `v` or build metadata, one calendar-valid
RFC 3339 publication timestamp, and the HTTPS directory that will eventually
contain `latest.json` and the immutable assets.
The acknowledgement must be exactly `BUILD ELECTRON PRODUCTION CANDIDATE`.
Before any build, the workflow checks out the exact SHA, reruns the reusable CI
workflow for that SHA, derives `<base-url>/latest.json`, and requires that URL to
answer with HTTP 200 without a redirect. The external endpoint probe has a
10-second connect deadline and a 30-second total deadline; any non-200 or
unknown response fails the candidate.

The protected environment must provide the existing production updater trust:

- `RION_STUDIO_UPDATER_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Missing trust fails closed. The public key is admitted before the build. The
private key and password enter only a detached signing job on a fresh runner
with a clean, credential-free checkout, after dependencies are installed and
the exact unsigned package plus black-box evidence have been downloaded. They
are never job-wide or inherited by the packaged runtime black-box. The workflow
never generates a key and never uses the ordinary Electron CI fixture key. The
updater endpoint and public key are also embedded into the Rust Node-API addon
at build time.

The detached signer invokes the pinned local Tauri CLI directly rather than a
package-manager command. Its child receives an isolated home and temporary
directory plus a minimal system/locale allowlist and exactly one updater key
source with its password. GitHub/Actions tokens and command files, package
manager credentials, proxy or cloud credentials, Node injection options, and
Rion release inputs are absent. The password is never a command argument and a
signer failure returns only a fixed redacted error.

## Platform construction

macOS and Windows build from the same SHA, version, endpoint, publication time,
and production public-key digest. The release version is applied to every Rion
workspace package before the locked build.

The macOS arm64 job packages the embedded Chromium surface inside the retained
AppKit host. It requires the configured ad-hoc identity (`-`), verifies the app
bundle and external Rust addon, verifies the DMG, and does not notarize. The
Windows x64 job requires both the packaged executable and NSIS installer to be
Authenticode-unsigned. Neither job receives platform-signing credentials.

Before signing or staging either platform payload, the job launches that exact
production-keyed package without WebDriver or a remote-debugging port. Native
Command-K/Ctrl-K opens the visible Role, macOS accessibility must observe the
Chromium content inside the retained AppKit tab host (Windows uses UI
Automation), a real content click must reach the local fixture, the Role is
closed through native UI, and Command-Q/Ctrl-Q must terminate the exact process.
The per-platform report uses a fixed schema and a `passed` verdict. Before the
private key is used, the candidate tool requires exactly one report and checks
its platform, runtime target, native-host kind, application version, application
path, platform-specific profile isolation kind, zero exit code, and disabled
remote debugging. Windows evidence must come from a loaded temporary local-user
profile; macOS evidence must come from its fixed isolated home. It rebuilds one
bounded, stable-handle manifest of every directory, regular file, and symlink
in the application package. The executable, `app.asar`, and `rion-core.node`
digests are taken from that same stable snapshot rather than independent path
reads. The manifest binds root and entry permission modes, rejects multiply
linked regular files, and permits only relative symlinks whose resolved targets
remain inside the package. On macOS that manifest must match
the factory-issued private AppKit launch copy before execution, both package
trees must remain unchanged after execution, and the extracted updater archive
must match the same manifest. A
missing, ambiguous, stale, malformed, or mismatched report prevents signing.
The fixed-name native-window PNG is structurally validated and re-hashed as
release evidence. Bounded logs remain diagnostic artifacts whose artifact name
is bound to the source SHA, version, and exact workflow run attempt.

The build checkout never retains GitHub credentials. Windows gives its
temporary black-box SID read/execute-only repository access, no tool-home
access, and a writable evidence root under `RUNNER_TEMP`; the Job must reach
active-zero before those restrictions are removed. macOS also writes evidence
outside the checkout. The unsigned `release/electron` tree is moved to one
create-new `RUNNER_TEMP` root before it is executed, then sealed with macOS
AppleDouble emission disabled and handed to the detached signer. The fresh
signer restores the exact `release/electron` archive root into another
create-new external path before the private key enters scope. Its streaming
extractor accepts only ordered regular files, directories, and relative
symlinks that remain inside that root. It rejects hardlinks, special entries,
path traversal, symlink ancestors, duplicate or case/Unicode-colliding paths,
unbounded expansion, and any pre-existing destination; it never extracts into
the checkout. No script from the prior, package-executing job is reused when
the production key enters scope.

On macOS, the updater tar passes the same type-aware, bounded safe extractor at
a private create-new path and the DMG is attached read-only at a private
create-new mount point. Native verification subprocesses receive an environment
with updater-private values removed. The `.app` from each surface must pass the
packaged Electron/AppKit verifier, report the exact candidate version, and
reproduce the black-box package manifest. This check runs before updater
signing and again after signing. The second pass fences the tar and DMG path
identity and bytes across native verification, preventing a verified package
from being replaced before staging. A closed `macosPackageBinding` record binds
the signed tar identity, DMG identity, native verification kind, application
bundle name, and common package manifest. Staging, cross-platform assembly, and
the independent final verifier all require and revalidate that record against
the black-box evidence and current assets. This retains the AppKit host and the
owner-locked ad-hoc/no-notarization policy; it does not introduce a second macOS
window implementation or platform signing credential.

Before the Windows updater-signing secret enters scope, the exact unsigned NSIS
artifact is also installed under a fresh temporary local Windows user with
`/S`, `/currentuser`, and a create-new, no-space `/D` target. `/D` is the final
argument and the gate never passes `--force-run`. The install wrapper runs in a
kill-on-close Job Object and accepts only an observed three-process topology:
the isolated wrapper, requested proof process, and NSIS process. After the root
process exits, the runner requires authoritative active-zero, removes the
temporary profile and account, restores every granted ACL, and only then writes
a create-new, flush-to-disk closed-schema result containing the measured exit,
active, total, expected-total, and cleanup values. The NSIS artifact and proof
harness first move into a protected, parent-owned input root outside the
repository. The temporary SID receives read-only access there, writable access
only to its fresh gate, no repository grant, and an explicit recursive deny on
the source package. A canonical forbidden inventory contains the source root and
every directory and file. Before NSIS starts, the isolated harness uses
non-mutating native opens and requires `ACCESS_DENIED` for read, write, and
delete access to every listed path. Its work directory and launcher also remain
outside the repository, and the child does not inherit
`GITHUB_WORKSPACE`.

The result additionally binds a fresh 128-bit attempt nonce, a canonical digest
of the exact command path, ordered arguments, and work directory, plus measured
identities for the command executable, harness, and staged installer. Those
inputs and the canonical forbidden inventory are measured before and after the
Job, and the proof producer independently reconstructs the inventory from the
current source manifest and checks every binding. It accepts only canonical
JSON from a bounded, exclusively linked regular file; it does not synthesize the
Job values or accept a reusable success receipt.

The source `win-unpacked` tree and isolated installed tree are captured again as
full portable manifests. Both reject multiply linked files and any Windows
reparse point. The Windows harness also rejects every non-default NTFS alternate
data stream in the source, installer, and installed payload. The installed tree
must become byte-for-byte identical to the
black-box package after removing exactly one root entry,
`Uninstall Rion Studio.exe`; no removed or changed path and no other added path
is allowed. The installer, installed main executable, and generated uninstaller
must all remain Authenticode `NotSigned`. Each status is observed while the
exact file bytes are read-locked and hashed, and that identity must match the
surrounding stable captures. The main executable,
`resources/app.asar`, and `resources/native/rion-core.node` remain bound to the
black-box component and whole-package digests. Windows Node does not provide a
reliable POSIX `O_NOFOLLOW`; this gate therefore relies on explicit reparse
rejection, stable path/handle identity, single-link checks, and capture only
after the installer Job reaches active-zero rather than claiming a POSIX
no-follow primitive.

The resulting canonical `windows-installer-payload-proof.json` binds the source
SHA, version, current installer identity, both full manifests, the normalized
installed manifest, the exact allowed delta, and the measured isolation result.
Signing re-reads the current installer, source package, black-box report, and
proof before invoking the updater signer. Staging re-verifies the copied proof
against the copied installer and records the proof byte length and SHA-256 in
the Windows platform receipt. Assembly and the independent candidate verifier
require the same fixed proof inventory and cross-bind it again. Assembly also
rebinds every copied single-link asset to its closed platform receipt, so a
verify-then-swap source cannot become a verified candidate. The proof step
receives no `TAURI_SIGNING_*` or updater-private environment value.

The macOS smoke launch runs only from a factory-issued private app copy. Its
root and Chromium helpers are tracked by unique process identity and signalled
with audit tokens, including helpers that change process group or are reparented.
All managed helpers in this gate must execute from the private `.app` until
observed; daemonizing through an unobserved intermediate process and then
executing an external binary is outside the admitted Electron topology and is
forbidden for the production package.

Each detached platform signer signs only its complete updater payload with the
production updater private key. The candidate tool then independently verifies the prehashed
Minisign payload signature and trusted-comment signature with the production
public key. The verified report body is copied into the immutable platform
candidate as `packaged-black-box-report.json`; the validated PNG is copied as
`packaged-role-native-host.png`. Their byte lengths and SHA-256 values, the full
package-manifest digest and counts, component hashes, AppKit/Chromium host
verdict, and runtime identity are recorded beside the payload, signature,
distribution, source, version, endpoint, platform policy, and normalized
public-key SHA-256 in the platform receipt.
The report and platform receipt each use one canonical JSON byte encoding;
duplicate keys, reordered keys, alternate whitespace, trailing bytes, and a
same-size path replacement are rejected before their receipt digests are
accepted.

## Cross-platform assembly

The assembly job accepts only the exact platform inventories. It re-verifies
both Minisign signatures, both fixed-schema black-box reports, and every
platform receipt. A report body, screenshot, package manifest, or digest that
no longer matches its platform receipt is rejected. The cross-platform receipt
summarizes both reports' runtime, native-host, verdict, package manifest,
screenshot, and component digests, in addition to rejecting
any source, version, timestamp, endpoint, key digest, filename, byte length, or
SHA-256 divergence. It then creates and verifies this closed asset set:

- `Rion.Studio-mac.dmg`
- `Rion.Studio-mac.app.tar.gz`
- `Rion.Studio-mac.app.tar.gz.sig`
- `Rion.Studio-win.exe`
- `Rion.Studio-win.exe.sig`
- `latest.json`
- `SHA256SUMS.txt`

`latest.json` contains exactly `darwin-aarch64` and `windows-x86_64`, with the
same version and owner-selected direct HTTPS base URL. Its inline signatures
and SHA-256 values must match the immutable files and `SHA256SUMS.txt`.

The separate `electron-production-candidate-receipt.json` binds the exact
source, version, endpoint, normalized production-key digest, platform policy,
and every final asset digest. Its status is `verified-not-published`; the
workflow has read-only repository permission and only uploads a retained GitHub
Actions candidate artifact. It does not create, edit, or upload to a GitHub
Release and does not modify the updater endpoint.

Every black-box, platform-candidate, and assembled-candidate GitHub artifact
name ends in `-attempt-${{ github.run_attempt }}`. Promotion readiness first
verifies each source run's current attempt through the GitHub API and then
downloads only names containing that exact attempt. A rerun therefore cannot
silently reuse an artifact from an earlier attempt with the same source and
version.

Promotion readiness is a distinct owner-approved, read-only operation behind
the same protected environment. It downloads and canonically rebuilds both the
exact target candidate and the owner-pinned prior-v23 candidate, including both
platform artifacts and API-verified workflow attempts. It separately downloads
the attempt-bound macOS and Windows public-v22 lineage receipts, verifies their
fixed-workflow GitHub attestations, and binds the captured public release and
asset IDs, peeled source tag, updater trust, and derived source executable
hashes to the terminal evidence. It then requires separately attested
Tauri-v22-to-Electron and Electron-to-Electron terminal evidence on both
platforms. All four transactions share a fresh challenge and bind source
runtime invocation, the actual source fetch endpoint, served target bytes,
runtime-typed source journal identity, target first boot, the raw source journal,
the product-authored durable terminal receipt, preserved user data, and the
target native host. Current layout probes with `sourceUpdaterInvoked: false` or
`cutoverEligible: false` are rejected as terminal transactions. The lineage
receipts establish source identity only and deliberately remain
`cutoverEligible: false`.

The resulting `electron-production-promotion-readiness-receipt.json` says
`verified-terminal-evidence`,
`externally-served-terminal-evidence-observed`, and
`terminalPromotionReceipt: false`. This is deliberately not a `not-published`
claim: the immutable published v22 binary can observe v23 only when its fixed
public-latest endpoint is actually serving that target. The workflow itself has
only read permissions, verifies GitHub artifact attestations from one fixed
external evidence workflow, does not receive updater or public-release private
keys, and cannot create, upload, edit, or publish a release. The provisional
publisher remains a hard-disabled transition draft. A separate hard-disabled
durable recovery workflow now provides private append-only capsule and outcome
storage, predecessor-fenced one-shot public-mutation markers, rollback or
held-lease release, zero-write resume/reconciliation, and exact terminal
readback. It remains non-authorizing until the owner supplies and approves the
protected private-store configuration and an independent recovery drill passes.
The external evidence producer and terminal finalizer remain separate missing
gates; candidate construction, recovery code, or evidence aggregation alone is
never terminal cutover evidence. The observation status is historical; the
finalizer must independently re-observe current external state.

## Compatibility boundary

The existing `Tauri Release Candidate`, private release, resume, and public
release workflows remain active and authoritative for the stable v22 path. Their
new fail-closed runtime-identity checks restrict the generic publisher to the
exact regular-file `rion-tauri` macOS executable; they do not create an Electron promotion
path. This workflow does not retire the stable path and does not label an
Electron layout probe as a real v22 updater transition. Windows evidence remains
independent from macOS AppKit evidence; neither platform can supply the other
platform receipt.
