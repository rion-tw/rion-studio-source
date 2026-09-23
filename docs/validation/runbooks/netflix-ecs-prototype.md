# Netflix ECS prototype

## Scope

The original isolated experiment started at
`193bc8701b813d8bef72e413f6a8ede063521a16`. Main keeps official Electron
44.4.3 for ordinary development and distribution. ECS 44.1.0 is available only
through the explicit prototype commands below. It predates the official runtime's
Extension fixes; production adoption requires a maintained equivalent and Windows
validation.

The official 44.4.3 baseline was rerun on this Mac on 2026-09-22: every Widevine
request rejected with `NotSupportedError`; ClearKey created MediaKeys. The exact
global-Web session and both Roles were healthy, with no observed permission
denial. This localizes the first proven failure to the runtime/key-system layer.
It does not establish the cause of the earlier working version or exclude a
separate Netflix service change. The owner reports Chrome still plays full titles.

## Runtime and ownership

The repository pins official Electron 44.4.3 in `package.json` and the lockfile.
The separate installer pins CastLabs `v44.1.0+wvcus`, commit
`bbb3862120430db6fa3ffa1ce22c3b66fe99e0b8`. ECS runtime versions are Electron
44.1.0, Chromium 152.0.7977.65, Node 24.19.0, modules 149, N-API 10. AppKit ABI
remains 11. `scripts/ecsPrototypeRuntime.mjs` records release SHA-256 values for
macOS arm64 and Windows x64. The installer checks the downloaded archive, including
cached archives. ECS is extracted under `.electron-cache/ecs-prototype/dist`;
the prototype packaging config consumes it explicitly. The normal release
configuration cannot select that directory.

EVS accepts only the certified ECS Framework binary. The normal release's
Electron fuse changes alter that binary's VMP digest, so the isolated ECS
prototype packaging leaves the vendor fuse wire unchanged. The ordinary
official Electron release retains all production fuse checks. The prototype
package verifier compares its wire with the pinned ECS distribution; this
variant must remain an isolated experiment and must not enter the normal
updater or release channel.

After `app.whenReady()`, Electron main requests the Widevine component through
ECS `components.whenReady([WIDEVINE_CDM_ID])`. The vendor Promise is the
authoritative EventBound completion; Electron main owns the one-shot snapshot.
Revision fencing prevents late completion after `will-quit`. ECS exposes no
download abort; shutdown owns that process. Role startup does not await the CDM.
There are no added polling loops, retry transports or readiness deadlines.
The existing HTTPS global-Web permission policy and Rust session ownership stay
intact. The diagnostic consumer is an E2E-only reserved fixture endpoint, with
no renderer product API, CDM extraction, profile import or database migration.

## Reproduction

```bash
pnpm install --frozen-lockfile
pnpm run setup:drm-prototype
pnpm run verify:electron-runtime
pnpm run verify:electron-runtime:drm-prototype
pnpm run test:drm-prototype
```

Build the native addon first with `pnpm run build:electron:rust` on a fresh
checkout. The network-dependent `chromium-macos-appkit-drm` and
`chromium-windows-drm` profiles run the entity prerequisites and Workspace Web
fullscreen seed/restart phases. They are separate from ordinary smoke profiles.
Affected journeys are paired `WORKSPACE-WEB-DRM-PLAYBACK-095`,
`WORKSPACE-WEB-FULLSCREEN-017` and `WORKSPACE-WEB-SECURITY-POLICY-027`.

The visible public test uses pinned Shaka 5.2.11 and its Angel One Widevine asset.
Success requires a license response, Widevine MediaKeys, an active audio track,
presented video frames and ten seconds of advancing frame media time, with two
running Roles and no additional shell errors. No license body, key, header or
credential is recorded. Audio-track presence does not prove audible output.
The public license response is inspected only for its platform-verification
status (SignedMessage type 2, License field 10, matching the vendor VMP Lab).
Only an allowlisted status leaves this parser. No license bytes are persisted.
The vendor Lab UI was also attempted, but did not produce a status; that external
page result is not used as a pass or as proof of a runtime failure.

## Production VMP and Netflix gate

For public DRM samples use `pnpm run dev:drm-prototype`. For a Netflix capability
check on this registered Mac, use `pnpm run dev:drm-prototype:signed`. The latter
verifies the production streaming VMP signature of the signed ECS copy at
`.electron-cache/evs-control/Electron.app`, makes a private Game Mode bundle,
re-applies macOS ad-hoc signing, verifies VMP again, and launches the built app.
Set `RION_STUDIO_SIGNED_ECS_APP` to another signed `Electron.app` if needed. Both
launchers use `.electron-cache/drm-manual-user-data` without touching the normal
Rion profile. Close any running Rion Studio window first. Ordinary `pnpm dev`
still uses official Electron and cannot validate Widevine or Netflix.

The bundled development certificate is insufficient for production services.
EVS 1.3.2 `verify-pkg` reports `Certificate is valid for development only` on the
downloaded bundle. No EVS configuration or credentials were present on this host.
The account owner must log in locally; never put a password in a chat or a log.

```bash
python3 -m venv .electron-cache/evs
.electron-cache/evs/bin/python -m pip install castlabs-evs==1.3.2
.electron-cache/evs/bin/python -m castlabs_evs.account reauth
# For a new account, use: python -m castlabs_evs.account signup
```

For an unpacked application built with the genuine release updater endpoint and
public key embedded in its Rust addon:

```bash
pnpm run package:drm-prototype:dir
RION_EVS_PYTHON="$PWD/.electron-cache/evs/bin/python" \
  pnpm run sign:drm-prototype -- --package=release/ecs-prototype/mac-arm64
node scripts/preparePackagedWorkspaceDrm.mjs \
  --app "$PWD/release/ecs-prototype/mac-arm64/Rion Studio.app"
```

`package:drm-prototype:dir` alone does not provide that updater configuration.
The manual packaged launcher fails at `packaged-updater-preflight` with
`UPDATE_ENDPOINT_MISSING` when it is absent. Do not substitute test updater
keys. A signed ECS development runtime with isolated user data can be used for
a separate Netflix capability check, but it is not packaged acceptance.

On Windows use `release/ecs-prototype/win-unpacked` and the virtual environment's
`Scripts/python.exe`. The signing script uses streaming VMP, then re-applies and
verifies macOS ad-hoc signing. Windows stays Authenticode-unsigned. It verifies
VMP again after final signing. Pre-existing archives are stale after this step:
do not publish them. Existing updater signing, `.sig` and SHA-256 requirements
still apply; no replacement trust keys or platform credentials are introduced.

In the isolated packaged workspace, verify production VMP and play a Netflix
full title for at least two minutes. Record title, resolution, audible sound,
pause/resume, seeking, fullscreen, restart and simultaneous Role behavior.
Credentials are entered by the owner through the visible site only. Neither
public UAT playback nor a successful test harness counts as Netflix acceptance.
Do not promote this older ECS runtime based only on these tests.

## Recorded native result, 2026-09-22

[Sanitized machine-readable evidence](../netflix-ecs-prototype-result.json)
records macOS 27.0 (26A428), arm64. All four phases of
`chromium-macos-appkit-drm` passed. Both seed and restart created Widevine
MediaKeys with AVC/AAC and VP9/Opus, received HTTP 200 license responses, presented
251 frames over ten seconds, and reported
`PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED` through UAT. Seed ended at 320x240;
restart ended at 768x576. These are adaptive public-sample resolutions, not
Netflix resolution limits. Both Roles stayed running with unchanged shell errors.
The existing copied Game Mode bundle and native AppKit host were used.

Extension regression did **not** pass. `chromium-extensions-seed` lost its
WebDriver session during `verifyBusterStoreNavigation`; macOS recorded an
Electron `EXC_BAD_ACCESS` / `SIGSEGV` at 17:12:40. Restart was not run after that
failure. The symbolicated native cause is unproven; this cannot be treated as
the already known back-navigation assertion failure. This concrete regression,
the older runtime patch level, missing production EVS signature, and pending
Windows checks block replacing the official 44.4.3 runtime.

The isolated experiment passed 132 focused tests, TypeScript, focused ESLint, source hygiene,
documentation/context/coverage checks, Rust lint and 1,249 Rust tests (five
ignored), and the normal Electron build. Unused-code warnings exactly match the
unchanged baseline. Windows native E2E/build, signed production VMP, audible
audio, and Netflix full-title controls/restart remain unverified. No production
package or update was published. Later integration into main preserves the official
Electron pin; rerun both runtime verifiers after installation.

## Main integration check, 2026-09-23

The official 44.4.3 and isolated ECS 44.1.0 native runtime verifiers both passed
after the merge. The macOS DRM profile passed its four entity and Workspace Web
seed/restart phases with the isolated ECS executable. Public encrypted playback
played in both phases: CDM 4.10.3050.0, HTTP 200 license responses, 251 presented
frames over ten seconds, UAT `PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED`, two
running Roles, and unchanged shell errors. This is still not a Netflix or
production-VMP pass.

The normal official-runtime Extension seed profile remained a separate failure:
after opening a Role it timed out waiting for the terminal extension
compatibility status. It did not show the ECS SIGSEGV in this run. Unit tests,
Rust tests, lint, hygiene, typecheck, and the Electron build passed; the first
parallel Rust run had one timing-sensitive failure and passed when rerun alone.
The explicit unpacked package build used the isolated ECS distribution under
`release/ecs-prototype/mac-arm64`, and macOS ad-hoc code-sign verification
passed. EVS production VMP signing was not yet available in that run, so it
did not establish a Netflix-ready package.
Windows native tests and desktop E2E remain pending on a Windows host.

## EVS signing check, 2026-09-23

After account registration, EVS successfully issued a production streaming
signature for an unchanged copy of the pinned ECS distribution. The first
unpacked app signing request was denied with `Binary signature denied`; its
packager had flipped Electron Framework fuses, changing the certified VMP
digest. After leaving the vendor fuse wire intact only in the isolated
prototype config, the unpacked `Rion Studio.app` had the same VMP digest as
the pinned ECS Framework. EVS accepted its streaming signature, `verify-pkg`
passed, and macOS ad-hoc code-sign verification passed. No account details,
tokens, license bodies, or keys were recorded. Netflix full-title playback
and Windows execution remain untested. Manual launch of the signed unpacked
package was blocked at updater preflight because the development build did
not embed the genuine updater endpoint or public key.

## Sources

- [Pinned ECS release](https://github.com/castlabs/electron-releases/releases/tag/v44.1.0%2Bwvcus)
- [CastLabs VMP requirements and status meanings](https://github.com/castlabs/electron-releases/wiki/VMP)
- [EVS account and signing workflow](https://github.com/castlabs/electron-releases/wiki/EVS)
- [VMP Lab](https://castlabs.github.io/wv-vmp-lab/)
- [Official Electron baseline investigation](netflix-official-electron.md)
