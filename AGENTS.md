# Agent Instructions

This file applies to the entire repository. For substantial work, read `.agents/context.md`
before changing code.

## Working Rules

- Keep changes scoped to the user request and the surrounding implementation.
- Preserve existing user work. Do not revert or rewrite unrelated modified files.
- Use `pnpm` for package scripts and dependency management.
- Prefer existing project patterns over new abstractions.
- Add or update focused tests when changing runtime behavior.
- For documentation-only changes, `git diff --check` is usually sufficient.

## Project Boundaries

- This is a Tauri 2 + React + TypeScript desktop app. Tauri is the only supported
  product shell; retired desktop-shell dependencies and source paths must not return.
- The Rust core and Tauri shell own file system access, managed role stores,
  system WebView launch behavior, and browser lifecycle. The product runtime is
  WebView2 on Windows and WKWebView on macOS 14+.
- The renderer is a React app. It must call `window.rionStudio` through the typed
  Tauri bridge and must not import Node, Tauri internals, or browser automation clients directly.
- Shared contracts live under `src/shared` and should be treated as the source of
  truth between Rust, Tauri, the renderer, and tests.

## Cross-Platform Development

- macOS and Windows are both required target platforms. Every new or changed
  feature must be designed, implemented, and verified for both operating systems.
- A feature is not complete if it works on only one target platform. When behavior
  differs by platform, keep the shared behavior consistent and provide explicit
  macOS and Windows implementations instead of omitting or deferring one platform.
- Isolate operating-system-specific APIs behind Tauri/native modules or adapters;
  do not leak platform assumptions into the renderer or shared contracts.
- Add focused coverage for shared behavior and each platform branch. Where local
  end-to-end verification is unavailable, use platform-aware unit tests or mocks
  and document any remaining native verification required before release.
- Never let a test inherit the developer machine's operating system implicitly.
  Pass `platform` explicitly to test harnesses, cover shared macOS and Windows
  behavior with a platform table, and use `node:path` for filesystem assertions
  instead of hard-coding `/` or `\\` separators.
- Keep both `macos-latest` and `windows-latest` validation jobs in the release
  workflow. A local pass on one platform is not evidence that the other platform
  passes; use CI for the unavailable native platform before considering work done.

## Owner-Locked Release Distribution Decision

- This is an explicit owner decision, not a temporary fallback: production macOS
  release artifacts use Tauri's ad-hoc identity (`-`) and are neither Developer ID
  signed nor notarized. Production Windows installers remain Authenticode-unsigned.
- Platform installer signing and Tauri updater signing are separate. Updater signing,
  updater `.sig` files, and SHA-256 checksum verification remain mandatory.
- Agents must not add Apple Developer ID, Apple notarization, Windows Authenticode,
  platform certificate secrets, or related fail-closed release gates as hardening,
  best-practice, security, or release-optimization work.
- This policy may change only when the user explicitly changes this decision and
  confirms that both Apple and Windows production signing credentials are available.
  A generic request to fix CI, release, or security does not authorize that change.

## IPC Contract Changes

When adding or changing an app capability exposed to the renderer, update the full
contract together:

1. Domain/input/output types in `src/shared/types.ts`
2. API surface in `src/shared/api.ts`
3. Rust command/result/effect model and generated contracts in `crates/rion-core`
4. Tauri commands and shell effects under `src-tauri/src`
5. Typed bridge in `src/renderer/src/tauri/installTauriBridge.ts`
6. Renderer hook or feature usage under `src/renderer/src`
7. Adjacent Rust and Vitest coverage

Avoid adding renderer-only shortcuts around this bridge.

## Data And Runtime Rules

- Metadata is stored in `rion-studio.sqlite3` below the shared app data directory.
- Each role owns an isolated browser directory at `roles/{roleId}/browser`.
- Do not store account passwords.
- Rust repositories validate and normalize persisted metadata and commit related
  mutations in one SQLite transaction.
- Keep launch behavior centralized in the Rust core and system runtime adapters.
- Preserve the existing post-launch auth verification before considering a browser
  session running.
- System WebView launches must not expose a general remote-debugging endpoint.
  CDN rewriting, external browser launch, Chrome-profile-as-runtime, and full
  profile copying are retired and must not return as compatibility paths.
- A user-consented Chrome Profile import may perform a bounded, one-time transfer
  of launch-URL cookies and the exact launch origin's LocalStorage through the
  dedicated encrypted staging and native System WebView effects. It must never
  become a role session source, startup fallback, generic cookie/session effect,
  or external Chrome runtime.

## Renderer And UI Rules

- Follow the existing compact desktop-app layout and Tailwind v4 token system.
- Reuse local UI primitives from `src/renderer/src/components/ui` and patterns from
  `src/renderer/src/components/ui/patterns.tsx`.
- Use `lucide-react` icons when adding icon buttons or navigation actions.
- Add user-facing text through `src/renderer/src/i18n.ts` for `en`, `zh-TW`,
  `zh-CN`, and `ja`.
- Keep layout stable across the app minimum window size of 960x640.

## Useful Commands

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run package
```

`pnpm run dev` starts Tauri directly. Build, package, and CI commands must not
launch the application as a validation step; platform jobs compile, test, and
bundle the macOS and Windows targets without exercising a machine-specific WebView.
