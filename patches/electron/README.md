# Native DNR allocation candidate

Status: historical Electron 43.7.0 source patch only; **not compiled or installed in the bundled runtime**.
The current official Electron 44.4.3 upgrade does not apply this candidate or
reuse its source hashes. Rebase and validate the candidate against the selected
engine before considering a custom runtime.
Do not describe the native DNR restart regression as repaired until a patched
binary passes `scripts/verifyElectronExtensionRulesetAllocation.mjs`.

Electron 43.7.0 loads extensions at Chromium's `kCommandLine` location.
Chromium 150.0.7871.250 excludes these extensions when initializing its global
static-rule allocation count, but later subtracts their persisted allocation.
A 31,001-rule extension retains 1,001 allocated rules in preferences while the
new process starts its total at zero. Reducing it to 31,000 computes an unsigned
underflow and incorrectly rejects the update as exceeding the global limit.

The candidate tracks per-extension allocations that were actually charged to
the current global total. It initializes persistent installed allocations using
the existing policy; explicitly reloaded command-line extensions acquire their
allocation when their native rules are loaded. Decreases and release subtract
only counted reservations. It preserves static/dynamic rules, enabled ruleset
preferences, quotas, package bytes, and role storage. No API shim manipulates
Chromium preference files or retries failed ruleset updates.

## Reproduce and apply

Obtain an Electron v43.7.0 source checkout with its pinned Chromium dependencies
using the official Electron build process. This requires an appropriately sized
native macOS or Windows build host. The development machine initially had about
40 GiB free. Owner-authorized cleanup of Cargo outputs, package caches and old
browser resource/code caches increased this to about 93 GiB, preserving Role
profiles and test evidence. Electron v43.7.0 and depot_tools were checked out
under `$HOME/.cache/rion-electron-build`. Chromium dependency sync completed with
`--no-history --shallow --nohooks`, and the candidate's input hashes and patch
applicability also passed against that real checkout. Official Electron hooks
and native compilation have not run; apply this candidate after official hooks.
Xcode 26.6 is installed, but using its developer directory fails with the native
"You have not agreed to the Xcode license agreements" error. The owner must
complete Xcode's license/initial setup before an engine build can proceed.

```sh
node scripts/applyElectronDnrAllocationPatch.mjs --chromium-source=/build/electron/src
node scripts/applyElectronDnrAllocationPatch.mjs --chromium-source=/build/electron/src --apply
```

The script verifies SHA-256 of both upstream inputs and checks the patch before
applying. The adjacent JSON records exact source versions and hashes. A changed
source tree is rejected rather than patched approximately.

Build Electron on macOS and Windows following its source build instructions.
Run the native allocation, extension compatibility and filtering probes with
that binary before integrating any engine artifact into packaging:

```sh
RION_EXTENSION_PROBE_EXECUTABLE=/build/patched/Electron node scripts/verifyElectronExtensionRulesetAllocation.mjs
RION_EXTENSION_PROBE_EXECUTABLE=/build/patched/Electron pnpm run verify:electron-extensions
```
Required additional native cases: two extensions competing for the shared quota;
decrease/release after fresh-process restart; repeated release; retained excess
allocation; genuine quota rejection; unchanged enabled-rule selections.

Custom engine artifact integration remains blocked pending Xcode setup and validated
macOS/Windows binaries. This gate applies to the patched candidate, not official Electron upgrades. Distribution
must retain the project's updater signing/SHA-256 requirements, macOS ad-hoc
identity, and unsigned Windows installer policy.

Sources: [Electron loader](https://github.com/electron/electron/blob/v43.7.0/shell/browser/extensions/electron_extension_loader.cc),
[Chromium tracker](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/browser/api/declarative_net_request/global_rules_tracker.cc).
