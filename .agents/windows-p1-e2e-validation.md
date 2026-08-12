# Windows P1 Desktop E2E 實機驗證

本文件用於在 Windows 實機驗證 P0/P1 desktop journey、自動化 fixture、WebView2／
Win32 生命週期，以及 `main` 上最新的 restore focus、maximized reveal 與 placement 修正。
macOS 結果不能替代本文件要求的 Windows 證據。

## 可直接貼給 Windows Codex 的提示

```text
請在這台 Windows 實機完整執行 Rion Studio P1 desktop E2E 驗證。

先閱讀 repo 根目錄 AGENTS.md、.agents/context.md、最接近修改檔案的 AGENTS.md、
docs/e2e-strategy.md，以及 .agents/windows-p1-e2e-validation.md。使用原生 Windows
PowerShell 與 NTFS 工作樹，不可使用 WSL、Linux portable 或 macOS 結果替代。

先執行 git fetch origin、git switch main、git pull --ff-only origin main，確認工作樹乾淨，
並記錄 git rev-parse HEAD、Windows build/architecture、WebView2 Runtime、Node、pnpm 與
Rust toolchain。接著依文件順序執行 required static/Rust gates、
pnpm run test:e2e:desktop:full；若有兩台 mixed-DPI 實體螢幕，再執行
pnpm run test:e2e:desktop:extended。

不得將 product failure 自動重跑成綠燈。只有能證明為基礎設施問題且已保存完整 artifact
時，才允許重試一次，並同時記錄原始失敗與重試。force-terminate phase 的 WDIO failure
只有在 report.json 標示 EXPECTED_FORCE_TERMINATION、PID 已死亡且後續 crash-restart PASS
時才算預期行為。BLOCKED 不得當成 PASS。

完成後建立或更新 .agents/windows-p1-e2e-validation-report.md，依文件模板填入 exact SHA、
環境、自動 gate exit code、full/extended 每個 phase、8 條 P1 journey verdict、artifact 路徑、
SQLite/event/log 證據與剩餘 blocker。沒有證據的項目保持 pending/failed。若發現產品缺陷，
先保存 artifact、定位根因、加入 focused regression，再做最小修正並重跑受影響 gate；
不可放寬 invariant、skip Windows test、以 sleep/polling 或 timeout-derived success 掩蓋問題。

驗證完成後回報：PASS / FAILED / BLOCKED、exact SHA、full artifact root、extended artifact root
或硬體 blocker，以及 Windows 上實際執行與尚未執行的項目。除非使用者明確要求，不要
自行 push 測試產生的產品修正；驗證報告可以獨立 commit。
```

## 1. 身份與環境

必須在 Windows 原生 PowerShell 執行：

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
git log -5 --oneline
node --version
pnpm --version
rustc --version --verbose
rustup show active-toolchain
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
```

- [ ] `git status --short` 沒有非預期輸出。
- [ ] 工作樹位於原生 NTFS，不是 WSL／container。
- [ ] 記錄 Evergreen WebView2 Runtime 版本。
- [ ] 記錄每台螢幕的解析度、work area 與 scale；只有一台時明確記錄 extended 硬體限制。
- [ ] 不新增 signing credential；Windows installer 維持 owner-locked unsigned 決策。

## 2. Required gates

依序執行，非零 exit code 一律記為失敗：

```powershell
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
cargo build -p rion-tauri
pnpm run build
pnpm run check:desktop-e2e-isolation
git diff --check
```

`check:desktop-e2e-isolation` 必須在 production `pnpm run build` 之後執行，避免拿
debug-feature E2E renderer bundle 當成 production isolation 證據。Lint 可以保留 repository
既有 warning，但不得有 error。`test:rust`、`cargo check --all-targets` 與 Tauri build 必須
真正觸及 Win32／WebView2 target。

## 3. Required full profile

```powershell
pnpm run test:e2e:desktop:full
```

保存命令輸出的 `.desktop-e2e-artifacts/<timestamp>-win32`。`report.json` 必須沒有
`failure`，且逐 phase 符合：

| Phase | Required status | 核心證據 |
| --- | --- | --- |
| `smoke-seed` | `PASS` | UI 建立與 launch admission、Settings persistence |
| `smoke-restart` | `PASS` | clean restart 與 persisted smoke entities |
| `p1-mutations` | `PASS` | Role／Workspace／Macro edit、pointer reorder 與 SQLite ordinal |
| `p1-workspace-recovery` | `PASS` | 雙角色 partial failure、degraded、recovery、取消後零殘留 |
| `p1-guard-cleanup` | `PASS` | bulk delete cancel／partial result、quit guard 決策、final flush |
| `p1-final-restart` | `PASS` | 所有 E2E entity 清除、unsaved Game 不存在、clean exit |
| `system-settings` | `PASS` | Windows system Settings boundary 與取消路徑 |
| `seed` | `PASS` | permanent windows、tabs、placement 與 mode seed |
| `restart` | `PASS` | clean restore cohort、maximize/minimize/fullscreen transition |
| `force-terminate` | `EXPECTED_FORCE_TERMINATION` | 精確 PID 終止且 SQLite `cleanExit=false` |
| `crash-restart` | `PASS` | crash 不誤判 clean exit、手動恢復後正常 final flush |

以下 8 條 P1 journey 必須全部有 Windows 證據：

- [ ] `APP-FULL-CRUD-001`
- [ ] `GAME-WINDOWS-TABS-001`
- [ ] `APP-RECOVERY-001`
- [ ] `SETTINGS-SYSTEM-001`
- [ ] `NATIVE-DISPLAY-001`（由 extended 驗證；缺硬體時維持 `BLOCKED`）
- [ ] `APP-CRUD-REORDER-002`
- [ ] `WORKSPACES-RECOVERY-002`
- [ ] `APP-QUIT-GUARD-002`

### Windows 特別核對

- [ ] Control 多選真的出現 selection toolbar；cancel 後 entity 不變，confirm 後 snapshot 與 SQLite 一致。
- [ ] Role／Workspace 以 pointer UI 拖曳，畫面順序、bridge evidence 與 SQLite ordinal 一致。
- [ ] Workspace 一個 role 健康、一個 navigation failure 時，健康 role 保持可用，tab 進入 degraded。
- [ ] 解除 failure 後收到 recovery completed/applied；不得以 elapsed time 當成功。
- [ ] gated relaunch 經 Game Windows 的 Stop and close window 取消後，兩個 role、runtime tab、
  provisional launch 都消失。
- [ ] Games bulk delete 同時含 in-use 與 unused entity，精確顯示 partial delete／skipped 數量。
- [ ] quit guard 的 Keep editing 保留 dirty editor；Discard changes 後 final flush 完成，restart 不建立 unsaved Game。
- [ ] dormant permanent Game Window 先經 UI Show 建立 live generation，再經 UI Delete；不得留下 window record。
- [ ] restart 時只恢復 clean `liveWindowIds` cohort；關閉後原生 focus arbitration 可使 A 或 B 成為
  `lastFocusedWindowId`，但不得把 dormant B 加入 live restore cohort。
- [ ] maximized window reveal 保留 `maximized`，restore／minimize／fullscreen 過程不污染最後有效 `normalBounds`。

## 4. Extended mixed-DPI 實機 profile

只有具備至少兩台實體螢幕、且 scale 不同時才能宣稱 PASS：

```powershell
pnpm run test:e2e:desktop:extended
```

- [ ] `extended-native` 為 `PASS`，不是 `BLOCKED`。
- [ ] HWND／PID、client rect、monitor work area、per-monitor DPI 與 target display 一致。
- [ ] 至少一台螢幕使用不同 scale，並涵蓋負座標 placement（硬體排列允許時）。
- [ ] 視窗跨螢幕後 close／restart 回到正確螢幕，logical client size 沒有 DPI 倍增或縮小。
- [ ] maximized／fullscreen reveal 與 restore 保留原來的 windowed `normalBounds`。
- [ ] artifact 保存 30 天所需的 report、logs、event transcript、screenshots 與 SQLite evidence。

若硬體不符合，將 `NATIVE-DISPLAY-001` 與 extended verdict 記為
`BLOCKED: requires two physical mixed-DPI displays`；full 仍需完成，且不得把 BLOCKED 當成
release／跨平台通過。

## 5. Artifact 稽核

至少保存並在報告中引用：

- `report.json`
- `fixture.log`
- `user-data/desktop-e2e/events.ndjson`
- `phases/*/runner.log`
- `phases/*/wdio/*`
- `phases/*/screenshots/*`（若沒有失敗截圖，記錄 N/A）
- `phases/*/sqlite-query.json`
- `phases/*/rion-studio.sqlite3*`

產品失敗不可自動重跑。基礎設施重試需同時保留第一次 artifact，並在報告列出分類依據、
原始 exit code、重試次數與結果。

## 6. 報告模板

建立 `.agents/windows-p1-e2e-validation-report.md`：

```markdown
# Windows P1 Desktop E2E Validation Report

- Status: pass | failed | blocked
- Exact SHA:
- Branch / tracking SHA / remote SHA:
- Windows build / architecture:
- WebView2 Runtime:
- Node / pnpm / Rust:
- Monitor topology / scale:
- Started / finished at:

## Starting worktree

## Required gates

| Gate | Exit | Counts / exact evidence |
| --- | ---: | --- |

## Full profile

- Artifact root:
- report.json failure:

| Phase | Status | SQLite / event / log evidence |
| --- | --- | --- |

## P1 journeys

| Journey ID | Status | Windows evidence |
| --- | --- | --- |

## Extended mixed-DPI profile

- Status: pass | failed | blocked | not run
- Artifact root or exact hardware blocker:

## Failures, infra classification, fixes and reruns

## Remaining blockers

## Final verdict
```

只有 required gates、full profile 與所有非硬體 extended 項目有完整證據時，才能說
Windows full 通過；只有 mixed-DPI extended 也 PASS，才能說本次 P0/P1 跨平台驗收完成。
