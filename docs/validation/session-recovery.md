# Preserve-session role recovery

## First upgrade and continued use

The first ordinary role or workspace launch now performs a Rust-owned, one-time
legacy upgrade before Chromium admission. The existing role ID, macro links,
workspace slots, name, URL and settings remain unchanged. No replacement role is
created. `pnpm dev` uses this same launch path.

Session usability is independent of migration completeness. A completed attempt
admits a session even if Cookies or all supported website data could not be
transferred. `SessionMigrationRequired` is no longer a recurring consequence of
a failed or missing legacy journal. Physical store corruption, active maintenance
and invalid ownership remain real errors; they are not rewritten as successful
migration. The original migration journal remains an accurate historical record.

Results distinguish Cookies and LocalStorage as transferred, partially
transferred, failed or unavailable. A committed and authenticated RSP2 vault is
the first-upgrade source when present. Otherwise macOS selects only the v8.4.2
development identity `com.rionstudio.launcher` and the role's deterministic
`WebsiteDataStore` UUID. `.launcher.dev`, `rion-tauri`, timestamps and candidate
counts are not automatic source authority. Windows selects only that role's
legacy WebView2 directory and detects its deterministic profile layout.

The stopped-source snapshot contains only the Cookie database, LocalStorage
database/LevelDB files, origin metadata and SQLite WAL/SHM/journal companions.
Every source file is held, identity checked and included in a stable digest
before its protected clone is parsed; the legacy store is never written. All
recognizable LocalStorage origins and UTF-16 code units must pass exact readback
in a second fresh Chromium process before the category becomes `transferred`.
An unreadable origin is partial or failed, never an empty inventory.

Raw WebKit and WebView2 cookies are independently best-effort. Representable
domain/path/host-only, Secure, HttpOnly, expiry/session and SameSite fields are
offered to Chromium one record at a time. Expired, duplicate, corrupt,
partitioned, app-bound, undecryptable or unknown-semantics records are skipped
with reason codes. Chromium's accepted and normalized subset is digest-bound
and read back by the second helper process. Raw cookies therefore remain
`partiallyTransferred` even when every offered record is accepted. A Cookie
helper failure triggers one LocalStorage-only import into another owned helper
tree; an unknown first helper target is retained and never reused. Only an exact
fresh-process receipt permits installation.

Rust publishes a new session under the **same role** at
`roles/<role>/browser/sessions/<attempt>/chromium`. Existing Chromium, WebKit and
WebView2 stores are preserved. A private marker and atomic session choice bind
the role, attempt, platform, original journal and per-category result. Durable
`role_session_fresh_v1` operation evidence authorizes usability separately from
`Verified` or `ExplicitReset`; first launch admission is recorded there. Later
launches and application restarts select the same session without replaying old
data, including after a user signs in again. An interrupted attempt does not
establish transferred data; an empty continuation may retain that classification.
An exact marker/choice publication can finish a pending SQLite publication;
restart or elapsed time alone never verifies an import.

The launch progress notice and existing role-menu recovery dialog expose the
result. Data counts refer only to the verified installed subset. IndexedDB and
Service Workers are not transferred, and data transfer never proves remote login.
No real account is opened by the automated tests or diagnostic tool.

## Strict preserve-login recovery

The explicit preserve-login operation remains available before continuation.
It requires complete source evidence and an unused target, and never treats a
partial upgrade as complete migration. Its original support list follows.

## Source admission

| Source and native host | Formal admission | Evidence still required |
| --- | --- | --- |
| Committed, authenticated v22 RSP2 transfer vault | Highest priority; exact Cookie and LocalStorage import | Authentication, canonical inventory and two-process equality; remote login is separate |
| macOS v8.4.2 `com.rionstudio.launcher` role WebKit store | Automatic first-upgrade fallback on macOS | LocalStorage exact; raw Cookies always partial with per-record reason codes |
| `.launcher.dev`, `rion-tauri` or another WebKit store | Diagnostic/manual inspection only | Never competes with the automatic v8.4.2 source |
| Windows role WebView2 profile | Automatic first-upgrade fallback on Windows | LevelDB exact; Cookie SQLite/WAL rows are decrypted and imported best-effort; Windows native CI required |

`session_source` contains the shared Rust source readers. The bounded raw-store
snapshot and decoders are used only by the one-time first-upgrade fallback;
broader inventory, comparison, repair and public WebKit probes remain behind the
`session-migration-diagnostics` feature. The strict preserve-login command still
accepts only a committed canonical envelope with complete source-authority
evidence. Raw fallback does not filter LocalStorage to the launch website,
normalize unknown attributes, or infer an empty account from missing files.

SameSite None, unspecified and native nil cannot be conflated for an exact
transfer. The historical
[WebKit change](https://results.webkit.org/commit?id=283230%40main&repository_id=webkit)
describes a change in CFNetwork's nil handling; its subsequent
[reversion](https://bugs.webkit.org/show_bug.cgi?id=280080) further rules out using
one upstream patch as proof of installed-system behavior. Known-answer native
fixtures must establish the actual format and semantics before extending this
list. Binary-cookie inspection currently reports these gaps explicitly.

All accepted canonical Cookie and LocalStorage records are compared, including
UTF-16 code units and Cookie attributes. Exact-vault expiration or Chromium
normalization mismatches fail equality. Raw Cookie normalization instead binds
the exact accepted subset and keeps the public category partial. Chromium may
clamp far-future expiration dates. IndexedDB, Service Worker and cache data are
not transferred; `OTHER_WEBSITE_DATA_NOT_MIGRATED` records that exclusion without
exposing origins, keys or values.

## Authority and lifecycle

The typed `sessionMigrationRecovery` bridge accepts only `inspect`, `recover`, `upgrade`
and `cancel` commands. Inputs are role ID, attempt UUID, expected journal
revision and opaque candidate token. Source paths, Cookie values and success
flags are not renderer inputs. Candidate tokens bind role, application and
source bytes. Ambiguous candidates require explicit selection, never newest-file
selection. File identity, roster and digest changes invalidate the selection.

Rust acquires the role maintenance lease and rejects live roles, stale revisions,
previously verified targets and any pre-existing Chromium target contents.
An attempt owns `.session-recovery/<attempt>` and an independent SQLite journal,
encrypted transfer vault and Chromium profile. Its durable operation history
retains the original formal journal and source digest. The private Node method
provides only the active exact-attempt payload to the Electron executor.

Electron runs the existing offline apply helper to clean exit, then a separate
fresh verifier process. External networking is blocked. Exact receipts return
to Rust; only Rust can mark the isolated journal verified. Cancellation, process
failure or unknown acknowledgement cannot become success through elapsed time.
Unknown process ownership leaves that attempt's target retained for diagnosis.

After verification Rust rechecks source identity and the empty formal target,
publishes a new authenticated transfer identity, and atomically admits only
that role's `exported` record. The existing `importing → verifying → v23Ready`
path performs another clean apply and independent readback. It does not call
the v22 batch preparation authority. Failure before admission leaves the formal
migration journal unchanged; failure during formal import retains source and
attempt history and leaves the role blocked/indeterminate. Retry cannot erase
an unknown existing formal target.

Progress is a Rust-owned revisioned event. The dialog rejects stale or other-role
events and can reattach to an active attempt. The interactive `inspect` command
may list historical identities, but automatic `upgrade` never turns their
coexistence into `RECOVERY_SOURCE_SELECTION_REQUIRED`. Cancel is a request to the owning
operation; the UI waits for the terminal event/result. Restart preserves durable
attempt history and never infers success for interrupted work.

## Validation

Run the [isolated diagnostic tool](session-migration-diagnostics.md) for raw
source evidence. Its Markdown/JSON reports separate source integrity, target
equality, persistence, role isolation and login. Real source material remains
in ignored private artifacts, never Git or CI. An unavailable source gate means
the authorized single-role login experiment remains not run.

Focused checks:

```sh
cargo test -p rion-core session_recovery
pnpm exec vitest run tests/renderer-session-recovery.test.tsx
pnpm exec vitest run --config vitest.native-integration.config.mjs tests/electron-session-maintenance.native-integration.ts
pnpm run build:e2e:desktop
pnpm run test:e2e:desktop -- --profile=chromium-macos-appkit-smoke --phase=chromium-role-session-recovery
```

Use the Windows profile on Windows. The paired P1
`CHROMIUM-{MACOS-APPKIT,WINDOWS}-ROLE-SESSION-RECOVERY-033` journeys seed a
test-owned canonical v22 package, use visible source selection/recovery UI, and
check the authoritative journal. Both targets prove a new transfer and Verified
receipt without automatic launch. Windows raw profile decryption and native
file-sharing behavior remain a required Windows CI gate. Rerun both platform versions of
`ROLE-SESSION-ISOLATION-003` and `ROLE-EXPLICIT-RESET-007` with this feature.

The diagnostic tool alone has an `internal-only` E2E omission. The product
recovery path has the new P1 journey and no such omission. Complete hygiene,
typecheck, lint, Vitest, native Rust lint/tests and build remain required. Report
targeted desktop phases separately from complete smoke/full profiles, and keep
unobserved Windows and historical macOS native checks pending.

Production builds exclude the diagnostic binary, scripts, probes and synthetic
seed methods. The addon build checks the fixture surface for both development
E2E and production builds. These checks do not publish or create a release.
Strict preserve-login recovery rejects unsupported formats with actionable classifications.
Ordinary first-launch upgrade records these gaps and admits the retained-role
continuation described above. Retained snapshots do not guarantee safe downgrade
to v8. The owner authorized partial or empty continuation on 2026-09-10.


The paired P1 `CHROMIUM-{MACOS-APPKIT,WINDOWS}-ROLE-SESSION-UPGRADE-034`
journeys use visible Open and a native retained fixture. LocalStorage is verified
independently across installation and a fresh application process; cookie
failures retain the clean LocalStorage-only fallback. Core and helper tests add
the fixed v8.4 identity, competing historical identities, multi-origin/UTF-16
LocalStorage, expired/duplicate/unknown cookies, accepted-subset persistence,
source immutability and no-repeat upgrade checks. Run the upgrade restart phase
to include both lifecycle phases.
