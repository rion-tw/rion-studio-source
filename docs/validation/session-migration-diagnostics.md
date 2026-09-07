# Isolated v8 → v9 session migration diagnostics

This is an internal feasibility tool, not a production upgrade or a login
recovery command. Product versions v8/v9 are distinct from runtime contracts:
the legacy export authority is contract 22, and the target uses the current
`CHROMIUM_RUNTIME_CONTRACT_VERSION` (24 when introduced).

The separate [product recovery flow](session-recovery.md) now reuses the Rust
source boundary and admits only its explicit supported-format list. Statements
below about no renderer API or product journey apply to this diagnostic entry.

## Run

On a native macOS or Windows development host with dependencies installed:

```sh
pnpm run diagnose:session-migration --output /absolute/new/test-directory
```

The output's parent must exist and be canonical. The output itself must not
exist. It cannot be inside Application Support, WebKit, APPDATA, LOCALAPPDATA,
or the selected source. For a stopped local installation, add
`--source-data /absolute/existing/Rion-data-directory`. The driver discovers
the known production/development WebKit roots on macOS and the selected
installation's role root on Windows. It never selects a source by modification
time. More than one matching store is `SOURCE_AMBIGUOUS`.

The explicit Cargo feature `session-migration-diagnostics` enables the
`rion-session-migration-diagnostics` executable. It accepts bounded JSON on
stdin; `mode` is camelCase and request fields are snake_case. Modes are
`inventory`, `decodeWebkit`, and `synthetic`. Inventory supports `role_ids`,
`source_roots` (`appId` and absolute `path`), `capture`, `user_data_dir`, and
`output_dir`. The native host chooses the platform; a supplied platform field
is rejected. `decodeWebkit` is a secret-bearing internal pipe interface, not
a report endpoint. Never redirect real decoded data into logs.

The Electron entry also requires `RION_MIGRATION_DIAGNOSTICS=1`, a canonical
run root, an unpackaged app and a supported native platform. These variables
are set only for child processes. It reuses the existing Chromium maintenance
helper. No renderer API, runtime launch condition or product action changes.

## Ownership, isolation and terminal outcomes

Rust owns source role/store mapping, the existing Core instance lock, private
SQLite copies, RSP2 authenticated snapshots, canonical transfer envelopes and
isolated migration journals. Production AppCore is never instantiated. SQLite
opens the copy with its WAL; the original DB and WAL hashes must remain equal.
The instance lock is opened without creating, truncating or rewriting it.
An unavailable lock blocks the run. macOS additionally checks native open-file
evidence for each candidate store; Windows source files are opened with no
sharing. Missing release evidence prevents capture. There is no wait-until-idle
loop or elapsed-time success.

Source reads reject symlinks/reparse points, path escape, noncanonical role IDs,
file replacement, changing rosters, excessive size and special files. Snapshots
exclude cache directories and are not full browser backups. Matching one
directory establishes a candidate, not historical application-use provenance.
The report explicitly retains this distinction; no candidate gets login
permission from its pathname alone.

Only new run-owned paths are mutable. Source snapshots use existing RSP2
protection and retain role/transfer-bound authentication context. Plaintext
materialization uses private temporary directories. Rust removes them on normal
completion/failure; the driver removes the named plaintext temporaries after
cancellation of its Rust child. Encrypted snapshots and nonsecret reports remain.
Abrupt termination of the driver/OS cannot run cleanup; before retaining such a
run, remove only its `plaintext-*`, `synthetic-*` and helper paths. Do not share
the run directory: it contains protected account data and private role metadata.
Real data never belongs in Git or CI.

Electron owns only isolated Chromium sessions and helper processes. It permits
only protocol-intercepted `.invalid` migration documents; external navigation
is denied and DNS resolution is disabled. No real role is loaded in Chromium.
Do not instantiate `defaultSession` over the role's `sessionData`: it creates
another writer to that same directory and invalidates persistence evidence.

Each apply must exit cleanly and close its pipe. A second independent process
receives the exact exit digest and compares all supported records through the
production verifier. The synthetic run checks two distinct roles at the same
site, two origins on macOS 26, Unicode/NUL values, secure HttpOnly cookies,
restart persistence, rollback A, and unchanged B after rollback A. It leaves
the isolated journal at importing; it does not fabricate a ready/launch receipt.
Unknown acknowledgement, malformed frames, nonzero exit and cancellation fail.
An external native-process deadline only terminates a failed run.

## Supported evidence and deliberate gaps

| Source | Implemented evidence | Limitation / admission |
| --- | --- | --- |
| macOS 26 public WebKit export | A nonpersistent, known-answer API probe; strict version-1 LocalStorage serialization decoding; Cookie API smoke | Real-store export and complete Cookie attributes are unproven; no real transfer admission |
| Stopped WebKit SQLite | Origin-pair decoding, UTF-16 values, SQLite integrity/schema check, committed WAL inclusion on a private copy | Partitioned origins, unknown schemas/versions and corrupt files fail; macOS 14/15 native fixtures still required |
| WebKit binary cookies | Bounded structural page/record/string validation and counts | SameSite, partition/session completeness and unknown footer attributes are not proved; never treated as a complete cookie export |
| Existing bridge-exported RSP2 vault | Existing Rust authentication, role/platform/revision binding and committed journal digest/count verification | Native Windows source evidence pending; authenticated package assessment does not itself import a real role |
| Unbridged WebView2 | Existing complete LocalStorage reader; all Cookie rows inspected, applicable native decryptor used without website filtering | Layout, missing LocalStorage, decryption/app-bound formats and native partition-capability proof can block; raw rows cannot manufacture the contract's source evidence |

Missing data is not an empty account. IndexedDB and Service Worker presence is
inventoried and is never reported as transferred. Cookie expiry is reported
separately for authenticated packages. Any expiry crossing an eventual real
verification must be classified separately from unconditional success.

The installed source application's exact version is not inferable from SQLite
schema or current updater metadata. Reports record it as unavailable when no
trusted historical version exists. Multiple application sources require usage
or installation evidence before a future adapter can select one.

There is intentionally no online command in this implementation: the real local
sources cannot meet source identity and complete Cookie admission. The authorized
Liyou check therefore remains **not run**, rather than silently falling back to
a partial import. A subsequent admitted source requires an isolated Electron
application with retained macOS AppKit presentation and visible launch of the
original URL; macros and automation remain off. Stop on login/MFA/identity
mismatch, enter no credentials and perform no game action. Report login retained,
login/verification required, or indeterminate independently of data equality.
An online check can rotate server credentials; deleting its clone cannot undo
that server-side effect.

## Validation and reports

Each run produces local `report.md` / `report.json`, optional `inventory.json`,
and encrypted snapshots. Reports carry OS, Electron version, Git commit and dirty
state, separate source/target/persistence/isolation/login fields, native-platform
gaps and cleanup outcome. Synthetic results are not a real-role login success
rate. A run may complete successfully while every real source remains unsupported.

Focused checks:

```sh
pnpm run test:session-migration-diagnostics
cargo clippy --locked -p rion-core --features session-migration-diagnostics --all-targets --no-deps -- -D warnings
pnpm exec vitest run tests/session-migration-diagnostics.test.ts
pnpm exec vitest run --config vitest.native-integration.config.mjs tests/electron-session-maintenance.native-integration.ts
```

The Rust cases cover native serialization known answers, Unicode, partition
refusal, empty/unproven sources, corrupt and unknown formats, committed WAL,
role/platform spoofing, locks, replaced paths, and source SQLite preservation.
Existing session-transfer and maintenance-helper tests supply canonical cookie
validation, authenticated vault identity/decryption failures, stale revisions,
rollback and readback mismatch coverage. Run the whole Rust/Vitest suite as well
as source hygiene, typecheck, lint and build before handoff. Normal Cargo builds
exclude the feature-gated bin; Electron package inputs include only production
`out` trees and the native addon, not diagnostic scripts, fixtures or reports.
The existing macOS/Windows platform CI matrix explicitly checks the diagnostic
feature and synthetic Rust fixtures. Its future results are pending; this wiring
does not substitute for observed Windows or historical macOS native evidence.

E2E omission is `internal-only`: no product journey or shared importer/helper is
modified. No desktop profile is claimed from this diagnostic run. If a later
change touches the common importer, rerun both native platform versions of
`ROLE-SESSION-ISOLATION-003` and `ROLE-EXPLICIT-RESET-007`. Windows, macOS 14/15,
and real-login checks remain pending until their actual native evidence exists.

The product recovery flow implements Rust-owned attempts, explicit candidate
selection and user-visible outcomes for admitted canonical exports. Raw-store
admission still requires source provenance and complete format evidence. Unsupported sources
must preserve old data and offer a separate session requiring login; never
automatically reset failed roles. Retained snapshots are not a safe-v8-downgrade
guarantee. This diagnostic entry neither publishes a release nor invokes the
production recovery UI.

## Retained dev LocalStorage retry (macOS 26, internal only)

The one-time usable-session continuation can report
`RECOVERY_SOURCE_SELECTION_REQUIRED` when production and development WebKit
stores both exist. This means **no source was imported**, not that Chromium lost
an imported inventory. A user's explicit application choice is necessary before
repairing that role. A completed continuation is not full migration evidence.

Use `node scripts/migrationDiagnostics/retained.mjs --role <role UUID>
--application com.rionstudio.launcher.dev --output <new absolute directory>` to
capture the chosen stopped WebKit source and verify its real LocalStorage in two
separate offline Chromium processes. The driver receives canonical bytes only
through private pipes. Its reports contain counts, hashes and classified results.
It retains protected source snapshots and deletes isolated Chromium targets.

With `--current-data <Rion data directory>`, it also requires the Core instance
lock and native source-release evidence, snapshots the role's **currently selected**
LocalStorage and compares a disposable Chromium copy. The offline LevelDB decoder
can reject formats the native Chromium reader supports; decoder failure is not an
empty-source finding. Native comparison is authoritative for the selected origins.

`--restore-missing yes` is an explicitly invoked internal repair: Rust seals a
role/path/state/digest-bound plan; Electron inserts only absent keys into the copy,
retaining every existing value on conflicts. After clean process exit, another
process compares every resulting entry of the selected origins. The driver also
verifies the retained source independently before asking Rust to publish. Rust
rechecks the native locks, selected profile, full application database digest and
both LocalStorage directory fingerprints. On macOS it atomically exchanges only
the `Local Storage` directories with `renameatx_np(RENAME_SWAP)`, flushes the
publication and verifies both resulting trees. Other role directories, Cookies,
IndexedDB, role names/covers, macros and migration journals are not modified.
The previous LocalStorage remains in its authenticated snapshot. If the directory
or database changed, the attempt refuses publication. It never selects a different
role or resets the role. No automatic repeat/reconciliation is installed.

Conflicting keys remain current and are reported; this repair cannot restore an
old value over a new value. Restoring missing LocalStorage is **not** evidence of
preserved login. Old Cookie host-only/SameSite/partition/session semantics remain
unproved and are not guessed. Existing Chromium Cookies are left untouched.
The current website may subsequently change its own LocalStorage when opened.

Focused native validation:

```sh
cargo build --locked -p rion-core --features session-migration-diagnostics --bin rion-session-migration-diagnostics
node scripts/migrationDiagnostics/testMissingRepair.mjs
pnpm exec vitest run tests/session-migration-diagnostics.test.ts
pnpm run test:session-migration-diagnostics
```

E2E omission for this additional CLI is `internal-only`. No renderer control,
production importer, or automatic v9 source-selection policy is added. The
native fixture covers preservation of conflicting new values, missing Unicode
keys, fresh-process persistence and another role's unchanged data. Rust tests
cover atomic exchange, source locks, authenticated-plan tampering, changed
profile contents, clone mismatch and replay. macOS 14/15 and Windows publication
remain unsupported/pending native validation. This tool must never enter the
production package, and does not authorize a fleet-wide legacy-data deletion.
