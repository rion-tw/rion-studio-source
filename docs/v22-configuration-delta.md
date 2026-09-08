# v22 to Electron configuration delta

Owner direction on 2026-09-09: complete the final configuration comparison and
make Electron the sole repository runtime. Remove the other ledger workstreams
as prerequisites. This is authorization for repository cleanup, not publication
or modification of credentials or remote settings.

## Observed baseline

Read-only GitHub API observation: 2026-09-08T19:05:36.1935125Z, source
`a366dc475b67380cfce7bb5640d00d490e243939`. All five metadata requests returned
HTTP 200. Only secret names were read; no secret values were retrieved.

| Setting | Existing v22 configuration | Electron disposition |
| --- | --- | --- |
| Source repository | `rion-tw/rion-studio-source`, public, default branch `main` | Reuse |
| Public release repository | `rion-tw/rion-studio` | Reuse |
| Current published baseline | `v8.4.2`, release ID `378891834`, not a draft | Historical baseline; no publication in this task |
| Updater trust | Secrets `RION_STUDIO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` exist | Reuse names and Minisign format; no key rotation |
| Release App | Secret `RION_RELEASE_APP_PRIVATE_KEY`, variable `RION_RELEASE_APP_CLIENT_ID` exist | Reuse existing release authority |
| GitHub environments | None configured | Do not introduce the provisional Electron environments |
| Application identity | `com.rionstudio.launcher`, product `Rion Studio` | Already matches Electron builder |
| Update endpoint | `https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json` | Reuse |
| Public assets | `latest.json`, `Rion.Studio-mac.app.tar.gz`, its `.sig`, `Rion.Studio-mac.dmg`, `Rion.Studio-win.exe`, its `.sig`, `SHA256SUMS.txt` | Preserve names and manifest/hash/signature validation |
| Platform signing | macOS ad-hoc, Windows Authenticode-unsigned | Preserve Electron builder policy |
| Native targets | macOS ARM64, Windows x64 | Preserve both; retain AppKit on macOS |
| Versioning | semantic-release on `main`, immutable `v${version}` tags, draft staging | Reuse; remove writes to retired Tauri configuration |

Observed asset IDs, in table order: `534832912`, `534832791`, `534832814`,
`534832750`, `534832832`, `534832866`, `534832884`. Private local metadata
receipt: `.desktop-e2e-artifacts/v22-configuration-delta-metadata.json`.

## Necessary repository changes

1. Point the default development, build, package and desktop E2E commands at
   Electron; remove the Tauri renderer entry, shell crate and native engines.
2. Route the existing release build to Electron artifacts while retaining the
   existing public asset contract, updater signing and immutable-source checks.
3. Remove transition-only source/build/profile references and provisional
   release infrastructure assumptions. Preserve persisted v22 data decoding and
   migration compatibility where the current Electron runtime consumes them.
4. Verify the resulting entry points, dependency graph, native build, production
   E2E isolation and applicable Chromium journeys. No old test result is evidence
   for the changed source.

The comparison finds no need for a new repository, App, environment, variable,
secret or remote configuration change. Implementation and verification of the
repository changes are tracked in the migration execution ledger.
