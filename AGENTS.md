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

- This is a Tauri 2 + React + TypeScript desktop app in transition from a legacy
  Electron shell. Do not add new product dependencies on Electron.
- The Rust core and Tauri shell own file system access, managed role stores,
  system WebView launch behavior, and browser lifecycle. The product runtime is
  WebView2 on Windows and WKWebView on macOS 14+.
- The renderer is a React app. It must call `window.rionStudio` through the preload
  bridge and must not import Node, Electron, or browser automation clients directly.
- Shared contracts live under `src/shared` and should be treated as the source of
  truth between Rust, Tauri, the temporary Electron bridge, renderer, and tests.

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

## IPC Contract Changes

When adding or changing an app capability exposed to the renderer, update the full
contract together:

1. Domain/input/output types in `src/shared/types.ts`
2. API surface in `src/shared/api.ts`
3. Channel constants in `src/shared/ipc.ts`
4. Preload bridge in `src/preload/index.ts`
5. Main process handler in `src/main/ipc/registerHandlers.ts`
6. Renderer hook or feature usage under `src/renderer/src`
7. Adjacent Vitest coverage under `tests`

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
  CDN rewriting, external browser launch, and browser-profile import are retired
  and must not return as compatibility paths.

## Renderer And UI Rules

- Follow the existing compact desktop-app layout and Tailwind v4 token system.
- Reuse local UI primitives from `src/renderer/src/components/ui` and patterns from
  `src/renderer/src/components/ui/patterns.tsx`.
- Use `lucide-react` icons when adding icon buttons or navigation actions.
- Add user-facing text through `src/renderer/src/i18n.ts` for both `en` and `zh-TW`.
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

`pnpm run build` currently validates the transitional Electron shell. Use
`pnpm run build:tauri` for the target desktop shell.
