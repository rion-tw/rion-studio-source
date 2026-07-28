# Refactor regression audit status

This document is the human-readable completion record for the refactor regression
audit. It is a status snapshot, not the source of truth for individual behavior
classifications. Run `pnpm run verify:system-only` to validate the authoritative
machine-readable ledgers and their executable evidence.

## Baselines and policy

| Purpose | Revision |
| --- | --- |
| Completed refactor target | `58c917168a3864d2bb6a54887d631736e7c37c74` |
| Modern pre-refactor comparison | `551b4d9` |
| Signed v1.37 comparison | `a3c7504da111c43d25c098c3b178fa2add8b668e` |
| Deleted-test inventory | `b11b526` |
| Implementation HEAD recorded by this snapshot | `de4365f4b83bd47643846e5d60f3b35ec6346593` |

Behavior is preserved by default. A difference is accepted only when the v2
ledger contains a concrete retirement clause and executable negative evidence for
the retired capability. Electron, External Chrome, CDN rewriting, custom proxy
injection, profile-as-runtime behavior, and generic debugger/session automation
remain retired.

## Coverage result

- The signed v1.37 inventory contains 226 Browser/Workspace behaviors.
- The deleted-test inventory contains 245 declarations: 244 executable tests and
  one support helper.
- Four refactor-target contracts are included in the cross-baseline inventory.
- Parity v2 maps 475 source cases to 102 canonical behaviors.
- The verifier currently reports zero unresolved cases, zero source-only evidence,
  and zero weak fanout.
- The 45 legacy overlay/injector behaviors have individually identifiable current
  tests. Runtime-critical macro, session import, restore, file, trusted-input, and
  surface lifecycle behavior is covered by focused Rust or Vitest evidence.

The detailed records are:

- `tests/parity/refactor-behavior-ledger-v2.json` for canonical behaviors and
  cross-baseline mappings;
- `tests/parity/v1.37.0-browser-workspace.json` and the generated
  `docs/v1.37-browser-workspace-parity.md` for the signed v1.37 audit; and
- `tests/parity/b11b526-legacy-test-inventory.json` plus
  `docs/tauri-parity-ledger.json` for removed legacy tests and shell files.

## Historical live evidence

Earlier refactor snapshots used machine-specific native app-launch checks before
and after packaging. Those checks were useful while replacing the retired shell,
but they coupled release acceptance to the developer or runner's local WebView,
focus, process, and user-data state. Native attestation is now retired: `build`,
`package`, CI, and release-candidate workflows do not launch Rion Studio.

The production behavior formerly exercised by those checks remains covered at
deterministic boundaries: FIFO native-effect ordering and surface lifecycle in
Rust, macro ordering and balanced release in Rust/Vitest, transactional session
import and file operations in Rust, runtime restore/display fallback in Rust, and
localStorage sequencing and teardown snapshots in Rust/Vitest. macOS and Windows
jobs compile, lint, test, bundle, and inspect signatures on their native target.

The signed-in local game check resolved exactly the `test` and `test2` roles and
the `test雙開` workspace. It retained these disabled test macros without creating
duplicates:

- `[測試][單開] 左右方向往返`
- `[測試][單開] 迴圈與取消`
- `[測試][按住] 放開與失焦復原`
- `[測試][雙開同步] 左右方向往返`
- `[測試][雙開同步] 啟停與取消`

The check covered single-role execution, loop cancellation, held-key release,
two-role ordering and cancellation, background behavior, and workspace stop.
It ended with zero running macros, the workspace stopped, and no held keys. No
chat, payment, trade, item consumption, deletion, credential, Cookie, or token
operation was performed. The data remains in the local application store; no
durable redacted screenshot or dispatch-log attachment has yet been added to the
repository.

## Remaining acceptance evidence

- Keep deterministic coverage for multi-role ordering, deadlines, partial
  failure, cancellation, and handle cleanup at the Rust effect/runtime boundary.
- Require Linux checks/sanitizer plus macOS and Windows platform build jobs for
  each release source commit. Automatic releases pin the candidate tag to that
  successful CI SHA instead of repeating the same tests; manually dispatched
  candidates rerun CI. A local macOS build is not Windows evidence.
- Complete manual Windows 10/11 multi-display and legacy in-place-upgrade checks
  when preparing a release; these product checks are intentionally separate from
  normal build and package commands.
