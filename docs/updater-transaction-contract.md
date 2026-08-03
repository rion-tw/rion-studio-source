# Updater Install Transaction

Rion Studio treats installation as a recoverable transaction. The signed Tauri
updater payload and SHA-256 release verification remain mandatory. Production
macOS artifacts continue to use Tauri's ad-hoc identity (`-`) without
notarization, and Windows installers remain Authenticode-unsigned.

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

## Durable journal

`app-update-install-journal.json` is replaced atomically for every phase. It
stores the attempt ID, target version, timestamps, phase, and stable failure
code. At startup:

- If the target equals the running version, the attempt is concluded as
  `applied`, the journal is removed, and the pending-version retry fence clears.
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

On Windows, `Update::install` extracts the installer before invoking its
`on_before_exit` hook. Extraction failure leaves WebView2 and Core accepting
work. The hook writes `draining`, closes runtime/core, records installer handoff,
calls Tauri's `cleanup_before_exit()`, and then lets the plugin launch the
installer and terminate the process. If handoff returns an observable error
after draining began, the journal records `failedAfterDrain` and Rion Studio
restarts automatically.

Placement or restore-session persistence runs before either platform begins
installation. Failure there is `install_failed`, retains the verified pending
payload, leaves runtime/core open, and permits retry. Only failures observed
after the runtime/core drain begins force an automatic restart.
