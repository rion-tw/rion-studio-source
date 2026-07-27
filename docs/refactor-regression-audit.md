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
- Parity v2 maps 475 source cases to 106 canonical behaviors: 93 preserved and 13
  retired.
- The verifier currently reports zero unresolved cases, zero source-only evidence,
  and zero weak fanout.
- The 45 legacy overlay/injector behaviors have individually identifiable current
  tests. Runtime-critical macro, session import, restore, file, and trusted-input
  behavior is attached to package-level native gates.

The detailed records are:

- `tests/parity/refactor-behavior-ledger-v2.json` for canonical behaviors and
  cross-baseline mappings;
- `tests/parity/v1.37.0-browser-workspace.json` and the generated
  `docs/v1.37-browser-workspace-parity.md` for the signed v1.37 audit; and
- `tests/parity/b11b526-legacy-test-inventory.json` plus
  `docs/tauri-parity-ledger.json` for removed legacy tests and shell files.

## Native and live evidence

The `0151d25` refactor implementation snapshot passed type checking, lint, 426
Vitest tests, 497 Rust tests, Clippy, build, the system-only/parity gate, and all
five macOS native gates before and after packaging. The trusted-input gate now
retains only a bounded native key/mouse sample; its 1,000-cycle stress workload is
silent and runs through the production Rust input-state machine.

After `de4365f` changed role navigation to schedule every role before waiting for
completion, the full 426-test Vitest suite, system-only/parity verifier, and the
unpackaged three-process runtime-restore gate passed again on macOS on 2026-07-27.
The complete packaged matrix has not yet been repeated for this newer HEAD.

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

- Add an execution-level delayed-page fixture for 3/6/9-role `EmbeddedLoadRoles`
  concurrency, deadline, partial failure, cancellation, and handle cleanup. The
  current regression assertion proves source ordering but the runtime-restore
  fixture loads one role.
- Repeat the complete macOS unbundled and packaged five-gate matrix at the current
  audited HEAD.
- Run the same unbundled and packaged matrix on Windows CI, then retain the job
  URLs and commit SHA. A local macOS pass is not Windows evidence.
- Complete the Windows 10/11 multi-display and legacy in-place-upgrade smoke
  checks required by the release policy.
- Preserve a sanitized live-game evidence attachment if durable screenshots and
  dispatch records are required for release sign-off.

Until these items are complete, implementation parity is classified and locally
supported, but cross-platform release acceptance remains open.
