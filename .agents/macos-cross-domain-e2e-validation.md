# macOS 角色 × 工作區 × 巨集 × 遊戲視窗實機 E2E 驗收帳本

本帳本交接 Windows 已完成的 cross-domain lifecycle 實作與驗證，並提供可直接貼給 macOS Codex 的完整執行 prompt。macOS 驗收必須在實體 macOS 14+ 主機、AppKit 與 WKWebView 上執行；Linux、虛擬顯示器或 portable checks 都不能替代原生證據。

## Windows 交接 checkpoint

- Windows 已驗證 code SHA：`b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32`
- Branch：`main`
- 驗證時 worktree：clean
- Windows 顯示器：單一 2560×1440、200% scale
- Windows extended：`BLOCKED: requires two physical mixed-scale displays`
- Windows smoke artifact：`.desktop-e2e-artifacts/2026-08-14T23-43-23-971Z-win32`
- Windows focused cross-domain artifact：`.desktop-e2e-artifacts/2026-08-14T23-44-33-561Z-win32`
- Windows full artifact：`.desktop-e2e-artifacts/2026-08-14T23-48-29-774Z-win32`
- Game Window focused regression artifact：`.desktop-e2e-artifacts/2026-08-14T23-41-36-859Z-win32`

Windows full 的 `report.json` 綁定上述 exact SHA、`worktreeDirty=false`，共 25 phases、12 journeys，所有 journey 均 PASS。`p1-cross-domain-topology-force`、`force-terminate`、`crash-restart` 依設計記為 `EXPECTED_FORCE_TERMINATION`，其餘 phases PASS；SQLite validators 分別確認 crash 時 `cleanExit=false`，以及 recovery/final restart 的 `cleanExit=true`、`cleanupComplete=true`。

Windows 最終 gates：

| Gate | 結果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm run check:e2e-coverage` | PASS；P0 13/13、P1 16/16 |
| `pnpm run check:source-hygiene` | PASS；1180 tracked files |
| `pnpm run typecheck` | PASS |
| `pnpm run lint` | PASS；0 errors、23 既有 Fast Refresh warnings |
| `pnpm run test` | PASS；164 files、929 tests |
| `pnpm run lint:rust` | PASS |
| `pnpm run test:rust` | PASS；workspace all targets、0 failures |
| Tauri all-target check/build | PASS |
| `desktop-e2e` feature check/Clippy | PASS；`-D warnings` |
| Focused Rust regressions | PASS；1 placement-fence + 2 host-retirement tests |
| `pnpm run build` | PASS |
| `pnpm run check:desktop-e2e-isolation` | PASS |
| `git diff --check` | PASS |
| Windows smoke / focused cross-domain / full | PASS / PASS / PASS |

## 已修正的缺陷與新增防線

- 建立四域 full-profile lifecycle、四個 P1 journeys、四個 state-combination IDs、focused phase dependency、SQLite validator 與 expected-force verdict，coverage 提升為 P0/P1 100%。
- 新增 Windows `SendInput` 與 macOS AppKit 原生 pointer/tab 操作；drag、hide、同窗/跨窗 move、move-to-new-window 都使用可見 tab 控制，並以 window generation、tab identity、topology revision fencing。
- 修正 shared role ownership transfer、navigation failure placeholder、multi-role macro terminality 與 input fence，避免 blocked/非目標角色收到 late input。
- 修正 close window 與 close tab 前沒有 checkpoint live role Cookie/LocalStorage，並排除 dormant window 的 stale session checkpoint。
- 修正 restored tab 尚未 ready/hydrated 就被測試關閉造成的不確定 session evidence；E2E 改等 authoritative readiness，而非 sleep。
- 修正 E2E 錯選 runtime webview 當主視窗，現在以 exact main-window identity fencing。
- 修正 Windows tab chrome acknowledgment 沒有綁定 host generation：exact host retirement 現在 terminalize 為 superseded，wrong/late generation 不得完成新 operation。
- 修正相同初始 Normal placement 雖接受 observation 卻未清除 initial placement fence，導致之後正確的 Maximized receipt 被拒；現在接受 observation 會推進 fence，但不產生多餘 topology commit。
- debug transcript 補上 native presentation/show-command readback；debug API、ACL、fixture 與 evidence 仍由 production isolation gate 保證不進正式 bundle。

## Cross-domain phases 與 journeys

| Phase | Journey | macOS 必驗證行為 |
| --- | --- | --- |
| `p1-cross-domain-seed` | `RUNTIME-LAUNCH-DESTINATIONS-008` | 四個隔離角色、兩個重疊工作區、單/多角色巨集、兩個永久視窗；Roles/Workspaces 可見選單能開到 temporary、live、dormant destination；重複開啟只聚焦既有 tab。 |
| `p1-cross-domain-topology-force` | `RUNTIME-TAB-TOPOLOGY-009` | AppKit 原生 tab 點擊、menu、reorder、同窗/跨窗 drag、最後 tab detach、hide/show；保存 active/hidden/order/owner generation 後 exact PID termination。 |
| `p1-cross-domain-topology-force` | `MACRO-OWNERSHIP-TRANSFER-010` | shared role 成功接管時依 role identity 延續 macro；blocked/非目標 role 無輸入；phase 為 `EXPECTED_FORCE_TERMINATION`，journey 必須 PASS。 |
| `p1-cross-domain-recovery` | `RUNTIME-MIXED-RECOVERY-011` | Dashboard Restore 還原 role+workspace topology、order、hidden/active、Cookie/LocalStorage；macro 不自行復活；接管 navigation failure 會隔離原 owner、建立可重試 placeholders、終止 multi-role macro 且無 late input；可見 placeholder retry 成功。 |
| `p1-cross-domain-final-restart` | cleanup lifecycle | 測資、runtime windows、macro statuses、owners、input fences、close tombstones、recovery session 全清空；SQLite clean exit。 |

## 可直接貼給 macOS Codex 的 prompt

```text
請在這台 macOS 實機完成 Rion Studio「角色 × 工作區 × 巨集 × 遊戲視窗」跨域 E2E 驗收。你已獲授權在本 repo 實作必要的 regression 與最小產品修正、commit，並在全部通過後直接 push origin/main。不要建立 PR，不要改 owner-locked signing 決策。

先完整閱讀 AGENTS.md、.agents/context.md、與所編輯路徑最近的 AGENTS.md，再閱讀 .agents/macos-cross-domain-e2e-validation.md、docs/e2e-strategy.md、docs/e2e-coverage.json。必須在實體 macOS 14+、AppKit/WKWebView 上執行；Linux/portable checks 不能當作 desktop E2E 證據。

同步與 checkpoint：

git fetch origin
git switch main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
git merge-base --is-ancestor b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32 HEAD
git diff --name-only b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32..HEAD

要求：status 必須乾淨，ancestor command exit 0。Windows 實際驗證的 code SHA 是 b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32；其後允許只有本 macOS 帳本/交接文件 commit。若其後包含產品、測試或 runtime source 變更，先稽核差異，將目前 HEAD 視為新的 exact SHA，完整重跑所有 gates 與 E2E，不得沿用 Windows exact-SHA 結論。

記錄環境：

sw_vers
uname -m
system_profiler SPDisplaysDataType
node --version
pnpm --version
rustc --version --verbose
rustup show active-toolchain

先跑 required static/Rust/build gates，每個命令保存 exit code 與精確 counts：

corepack enable
pnpm install --frozen-lockfile
pnpm run check:e2e-coverage
pnpm run check:source-hygiene
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run lint:rust
pnpm run test:rust
cargo check -p rion-tauri --all-targets
cargo build -p rion-tauri --all-targets
cargo check --workspace --all-targets --features desktop-e2e
cargo clippy --workspace --all-targets --features desktop-e2e --no-deps -- -D warnings
cargo test -p rion-tauri --features desktop-e2e identical_placement_observations_advance_the_fence_without_a_topology_commit -- --nocapture
cargo test -p rion-tauri --features desktop-e2e retiring_the_exact_host_generation -- --nocapture
pnpm run build
pnpm run check:desktop-e2e-isolation
git diff --check

再依序跑 focused chain、smoke、full、extended，全部都要保存 artifact root 與 report.json：

node scripts/runDesktopE2e.mjs --profile=full --phase=p1-cross-domain-final-restart
pnpm run test:e2e:desktop:smoke
pnpm run test:e2e:desktop:full
pnpm run test:e2e:desktop:extended

focused chain 必須包含：
- p1-cross-domain-seed PASS
- p1-cross-domain-topology-force EXPECTED_FORCE_TERMINATION，且兩個 journey PASS
- p1-cross-domain-recovery PASS
- p1-cross-domain-final-restart PASS

full 必須讓 report.json 的所有 journeys PASS。對 expected-force phase，必須稽核 forced-termination.json 的 exact PID/session、PID 確實死亡、SQLite cleanExit=false，且後續 recovery/final restart cleanExit=true、cleanupComplete=true；不得把 WebDriver disconnect、sleep、elapsed time 或 timeout 當成功。

macOS 原生人工/自動 evidence 必須逐項確認：
- AppKit tab click、可見 tab menu、同窗 reorder、跨窗 drag、移動最後一個 tab、detach 到新視窗、hide/show。
- 每個 native action receipt 都綁定 exact window generation、tab identity、target revision；stale/遮蔽/不存在的 control 要 failed 或 superseded，不能成功。
- WKWebView 每個 role 的 Cookie 與 LocalStorage 隔離；shared role ownership transfer 只有一個 live owner，失敗 takeover 不得污染 unique roles。
- NSWindow.contentLayoutRect 與保存的 client geometry 一致；maximize/windowed/fullscreen round trip 保留 normal bounds。
- 原生 fullscreen Space、toolbar safe area、tab chrome 自動顯示/隱藏均有 native snapshot/event 證據。
- extended 必須使用至少兩台實體、scale factor 不同的顯示器，完成跨螢幕 round trip、負/不同座標、Dock work-area inset、maximize/fullscreen/restore。硬體不足時只能寫 BLOCKED，不能 PASS；精確 blocker 寫成：BLOCKED: requires two physical mixed-scale displays。

每次 E2E 後稽核：report.json、journey-verdict.json、forced-termination.json、phases/*/runner.log、phases/*/wdio、screenshots、events.ndjson、sqlite-query.json、rion-studio.sqlite3*。測試判定只使用 terminal event、projection、native snapshot、fixture input 與 SQLite。

失敗處理：product failure 不得原樣自動重跑。先保存第一個完整 artifact，建立 red reproduction，定位 authoritative owner，再加 focused Rust/Vitest regression 和最小修正，重跑 affected phase chain、static/Rust gates、smoke/full；若改到 macOS/AppKit 也要保留 platform-aware Windows lower-layer regression。只有保存 artifact 且證明是 infrastructure failure 時，才可原樣重試一次，報告中同時列出兩次結果。未知 native 結果必須 failed/indeterminate，不能視為成功；不得放寬 assertion、增加 polling/watchdog、以 timeout-derived success 或 rollback 新可見狀態掩蓋缺陷。

全部 E2E 結束後，因 debug E2E build 會留下 debug renderer，必須再次執行：

pnpm run build
pnpm run check:desktop-e2e-isolation
git diff --check

把完整結果寫入 .agents/macos-cross-domain-e2e-validation-report.md，使用本帳本的 report 模板。若有產品修正，一起提交 regression、修正與報告；若無修正，只提交報告。提交前再次 git fetch origin；若 origin/main 前進，使用 ff-only 或安全 merge 整合並按影響重驗。確認工作樹、exact SHA、所有 required PASS/BLOCKED 判定後 commit 並直接 push origin/main。保留所有 artifacts，不要清除。
```

## macOS report 模板

macOS agent 將結果寫入 `.agents/macos-cross-domain-e2e-validation-report.md`：

```markdown
# macOS Cross-domain Desktop E2E Validation Report

- Status: PASS | FAILED | BLOCKED
- Exact tested SHA:
- Final pushed SHA:
- Branch / origin/main:
- Starting and final worktree:
- macOS version / architecture:
- WKWebView / Safari version:
- Node / pnpm / Rust:
- Physical displays / resolutions / scale factors / coordinates:
- Started / finished at:

## Required gates

| Gate | Exit | Counts / exact evidence |
| --- | ---: | --- |

## Focused cross-domain chain

- Artifact root:

| Phase | Status | Journey verdict | Native / event / SQLite evidence |
| --- | --- | --- | --- |

## Smoke profile

- Artifact root:
- `report.json` exact SHA / worktreeDirty:
- Phase verdicts:

## Full profile

- Artifact root:
- `report.json` exact SHA / worktreeDirty:

| Phase | Status | Journey verdict | Evidence summary |
| --- | --- | --- | --- |

## Extended mixed-scale profile

- Status: PASS | BLOCKED | FAILED
- Artifact root:
- Exact hardware blocker, if any:
- Cross-display / contentLayoutRect / fullscreen Space / toolbar safe-area evidence:

## Native acceptance checklist

| Check | Status | Evidence path / event / snapshot |
| --- | --- | --- |

## Failures, classification, regressions, fixes, and reruns

## Production isolation after E2E

## Remaining blockers

## Final verdict and pushed commit
```

## 驗收判定

- macOS static/Rust/build/isolation、focused cross-domain、smoke 與 full 必須全部 PASS。
- extended 只有在兩台實體 mixed-scale 顯示器完成所有 native round trips 時可 PASS；硬體不足必須明確 BLOCKED。
- 任一 product failure 未修復、任一 required artifact 缺失、report exact SHA/dirty state 不可信，總結不得寫 PASS。
- Windows 結論維持：smoke PASS、focused cross-domain PASS、full PASS、extended `BLOCKED: requires two physical mixed-scale displays`。
