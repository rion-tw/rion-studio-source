# Rion Studio Runtime 單一權威：Windows 實機驗收與稽核提示

本文件永久保留，供另一台 Windows 電腦上的 Codex／工程師執行。它是
`.agents/runtime-authority-migration-ledger.md` 的 Windows 證據入口，不得在 Windows
驗收時刪除主帳本。

## 可直接貼給 Windows Codex 的提示

```text
請在這台 Windows 實機完整驗收 Rion Studio Runtime 單一權威改造。

先完整閱讀 repo 根目錄 AGENTS.md、.agents/context.md、最接近修改檔案的 AGENTS.md，
以及 .agents/windows-runtime-authority-validation.md。不得 reset、覆蓋或遺失既有變更；
不得把 Linux portable、macOS、mock 或只編譯 shared crate 當成 Windows 通過證據。

你要依該文件逐項執行所有自動 gate、Windows WebView2/Win32 實機 transcript、
diagnostics idle audit 與反向 source audit。每次 UI 動作都重新讀取目前 UI／
accessibility 狀態，不沿用舊元素索引。可匯入並永久保留
tests/fixtures/runtime-authority/portable.json 測資。

完成後建立或更新 .agents/windows-runtime-authority-validation-report.md，填入：
exact git SHA、Windows 版本、架構、WebView2 Runtime 版本、每個命令的 exit code／
test counts、每個 WUI transcript 的觀察證據、diagnostics 數值、失敗／修正與重跑結果。
沒有證據的項目維持 pending/failed。不要刪除
.agents/runtime-authority-migration-ledger.md；不要宣稱整個 initiative 完成。

如果既有 report 已是 `Status: pass`，但目前 HEAD 晚於 report 的
`Validated-code SHA`，不得把祖先 SHA 的 pass 直接沿用到新 HEAD。先逐筆 audit commit
range，再依第 7 節完成 final-audit delta 複驗並把 report 更新到新 exact SHA。

若發現程式缺陷，先找根因並加入 regression，再做最小且架構一致的修正，重跑所有
受影響 gate。禁止以 allow(dead_code)、skip Windows test、放寬 invariant、polling、
watchdog、dirty readback 或 timeout-derived success 隱藏失敗。
```

## 0. 驗收身份與工作樹

- [ ] WR0.1 記錄 `git rev-parse HEAD`；必須是由 macOS 主工作回報的 exact SHA 或其明確後繼。
- [ ] WR0.2 記錄 `git branch --show-current`、`git status --short` 與起始未提交變更。
- [ ] WR0.3 記錄 Windows edition/build、CPU architecture、Node、pnpm、Rust toolchain及 WebView2 Runtime 版本。
- [ ] WR0.4 確認執行於 Windows 原生 NTFS 工作樹，不是 WSL/Linux container。
- [ ] WR0.5 確認沒有 production signing credential；測試不改變 unsigned Windows distribution 決策。

建議先保存以下輸出到報告，不要把敏感環境變數、Cookie、token、真實 URL 或頁面內容寫入 repo：

```powershell
git rev-parse HEAD
git branch --show-current
git status --short
node --version
pnpm --version
rustc --version --verbose
rustup show active-toolchain
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
```

## 1. Windows required 自動 gate

依序執行；任何非零 exit code 都是失敗，不得跳過：

```powershell
pnpm install --frozen-lockfile
pnpm run verify:system-only
pnpm run check:hygiene
pnpm exec vitest run tests/rust-architecture-boundaries.test.ts tests/thin-typescript-boundary.test.ts
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run lint:rust
pnpm run test:rust
cargo check -p rion-tauri --all-targets
cargo build -p rion-tauri
pnpm run build
git diff --check
```

報告必須特別列出：

- [ ] WR1.1 Core RuntimeKernel tests 與 10,000-step model trace 通過。
- [ ] WR1.2 fake macOS/fake Windows port conformance transcript 通過。
- [ ] WR1.3 Windows renderer full Vitest 通過，不只 targeted tests。
- [ ] WR1.4 `rion-tauri` Windows tests實際執行，沒有 DLL loader failure。
- [ ] WR1.5 `cargo check --all-targets` 與 `cargo build` 觸及 WebView2/Win32 adapter。
- [ ] WR1.6 沒有 `allow(dead_code)`、cfg 隱藏或跳過 Windows-only reachability。
- [ ] WR1.7 generated bindings保持乾淨；若 generator造成 diff，必須說明且不可手改 generated source。

## 2. 本機 localhost fixture

在兩個 PowerShell 視窗分別啟動；fixture只允許 `127.0.0.1`：

```powershell
pnpm run runtime-authority:fixture
pnpm run dev
```

- [ ] WR2.1 `http://127.0.0.1:41739/health` 回覆健康。
- [ ] WR2.2 由正式 Rion Studio UI 匯入 `tests/fixtures/runtime-authority/portable.json`。
- [ ] WR2.3 確認 1 game、4 個 `[Runtime QA]` roles、2 workspaces、3 game windows、3 macros。
- [ ] WR2.4 再匯入一次時資料不增殖；fixture資料驗收後保留。
- [ ] WR2.5 所有角色實際載入 System WebView2，沒有 external Chrome、remote debugging或 runtime fallback。

## 3. Windows HTML tab strip／WebView2 實機 transcript

每個動作後重新讀取 UI/accessibility state並記錄 screenshot或精確可觀測值；不得只寫「看起來正常」。

### WUI-1：重複 admission 與永久 TabId

- [ ] 快速雙擊 `[Runtime QA] Alpha`，只有一個 logical tab與一個 WebView2 surface。
- [ ] Alpha執行中立即啟動 `[Runtime QA] Two Columns`，existing/joined只能聚焦同一 source，不能建立第二個 Alpha surface。
- [ ] 同時啟動相同 role、workspace、saved window；重複 intent必須 idempotent。

### WUI-2：Windows HTML tabs

- [ ] 以滑鼠選取 Alpha/Beta tabs，active tab、WebView visibility與focus一致。
- [ ] 拖曳排序至少三次並來回還原；authoritative order與HTML strip一致。
- [ ] 將 tab跨兩個遊戲視窗拖動再移回；source/target membership、active successor與focus一致。
- [ ] 拖動期間交錯 launch與close；stale drag callback不得覆蓋較新 revision。
- [ ] 使用鍵盤 tab shortcut切換；不得誤攔截系統 Alt+Tab。

### WUI-3：視窗與設定 transaction

- [ ] rename視窗，主 UI、native Win32 title與restore後名稱一致。
- [ ] move/resize/maximize/restore；placement在重啟後恢復。
- [ ] 選取 target display；多螢幕時驗證跨DPI display，單螢幕時記錄限制。
- [ ] window zoom、role zoom、mute/unmute；HTML chrome與WebView實際狀態一致。
- [ ] hide/show保留同一WebView2 page計數；stop後owner/handle消失，relaunch建立新generation。

### WUI-4：close／relaunch fences

- [ ] loading期間close tab/window後立即relaunch。
- [ ] ready期間close後立即relaunch。
- [ ] loop macro running期間close並確認停止，再立即relaunch。
- [ ] close-before-attach、duplicate close與晚到ready/closed都不能復活tombstone tab。
- [ ] 每次relaunch沿用新的operation/attempt fence；一個logical launch只對應一個surface。

### WUI-5：restore

- [ ] 建立至少三個native windows與六個tabs，改變order、active、position、size、zoom、mute。
- [ ] 以正式 Quit結束，確認沒有非terminal operation後重新啟動。
- [ ] restore後逐一核對window count、tab membership/order、active tab、placement、zoom、mute與name。
- [ ] restore進行中啟動相同source，只能existing/joined，不得duplicate surface。

### WUI-6：macro與renderer reload

- [ ] Once macro使fixture click與keydown得到精確預期增量並terminal為0 running。
- [ ] Loop macro累積計數；stop後至少再觀察一次，計數不再增加且held keys歸零。
- [ ] Nested macro顯示parent/child lifecycle，terminal後兩者都歸零。
- [ ] 保持WebView2開啟及fixture計數非零時reload主renderer；AppSnapshot恢復且WebView2不重建、計數不歸零。

### WUI-7：重複壓力

- [ ] 至少20輪 launch → select → reorder/move → macro → close/relaunch。
- [ ] 至少5輪正式 Quit/relaunch restore。
- [ ] 測試後沒有重複window、orphan HTML tab、無內容placeholder、不可操作cloaked window或殘留WebView2 process owner。

## 4. Diagnostics idle gate

停止所有QA macros並關閉所有QA tabs/windows後，透過正式 Diagnostics UI／typed bridge取得 snapshot。
不得以查詢結果反向修復狀態；只做稽核。

- [ ] `healthy = true`
- [ ] `snapshotComplete = true`
- [ ] `collectionErrorCodes = []`
- [ ] `runtimeNativeResourceInvariantsOk = true`
- [ ] `runtimeNativeResourceInvariantFailureCount = 0`
- [ ] `runtimeKernelPendingOperationCount = 0`
- [ ] `runtimeKernelLogicalSurfaceCount = 0`
- [ ] `managedSurfaceCount = 0`
- [ ] `closingSurfaceCount = 0`
- [ ] `quarantinedSurfaceCount = 0`
- [ ] `pendingCloseTabCount = 0`
- [ ] `activeNativeCreationCount = 0`
- [ ] `activeLifecycleOperationCount = 0`
- [ ] `activeNavigationOperationCount = 0`
- [ ] `activeInputFenceCount = 0`
- [ ] `recoveringRoleCount = 0`
- [ ] recent operation皆為唯一terminal outcome，沒有同identity重複surface或revision倒退。

若 Windows 正常保留空的 saved native host，報告必須分開列出 logical owner與不可序列化handle，並證明它符合既有產品契約；不得直接把非零數字忽略。

## 5. Windows source 反向稽核

```powershell
rg -n "role_tabs|native_tab_hosts|optimistic_closed_tabs|launch_plans|owner.?prob|dirty.?scan|watchdog|reconcile_navigation_input_fence|finish_navigation_reconciliation" crates/rion-core/src src-tauri/src src-tauri/native src/renderer/src
rg -n "#\[cfg\(" crates/rion-core/src/runtime_kernel.rs crates/rion-core/src/runtime_kernel
rg -n "allow\(dead_code\)" crates src-tauri/src
git diff --check
git status --short
```

- [ ] WR5.1 第一個搜尋沒有舊權威／dirty reconciliation production hit；測試名稱或明確非權威術語需逐筆說明。
- [ ] WR5.2 pure RuntimeKernel只有test cfg，沒有平台行為分支。
- [ ] WR5.3 新增／修改的Windows可達程式碼沒有dead-code suppression。
- [ ] WR5.4 renderer仍只經typed `window.rionStudio` bridge。
- [ ] WR5.5 NativeResourceRegistry只持有native handle，不判定logical membership、role owner或relaunch eligibility。

## 6. 回傳報告格式

Windows端完成後建立 `.agents/windows-runtime-authority-validation-report.md`：

```markdown
# Windows Runtime Authority Validation Report

- Status: pass | failed | blocked
- Exact SHA:
- Branch:
- Windows build / architecture:
- WebView2 Runtime:
- Started / finished at:

## Starting worktree

## Automated gates

| Gate | Exit | Counts / evidence |
| --- | ---: | --- |

## Native transcripts

| ID | Status | Exact observation / screenshot path / counter |
| --- | --- | --- |

## Final diagnostics

| Field | Value |
| --- | ---: |

## Reverse audit

## Failures, root causes, fixes and reruns

## Remaining blockers
```

只有 WR0–WR5 全部有證據且報告 `Status: pass`，macOS 主工作才可將 W1–W4 標為 done。

## 7. Final-audit delta 複驗

若 macOS 主工作在第一份 Windows pass report 後又推送 final-audit 修正，依下列規則
驗證；這不是以 targeted tests 取代完整 gate，而是允許沿用未受影響的既有 WUI
transcript：

- [ ] WR7.1 `git pull --ff-only` 後記錄新 exact HEAD、remote SHA、clean worktree，並證明
  原 `Validated-code SHA` 是新 HEAD 的 ancestor。
- [ ] WR7.2 audit 該 commit range 的每一個 production/test 變更；列出為何既有
  WUI-1、WUI-3–WUI-7 證據仍適用，不能只寫「變更很小」。
- [ ] WR7.3 在新 exact HEAD 重跑第 1 節全部 required 自動 gate；Rust/Vitest counts、
  `cargo check --all-targets`、Tauri build、generated clean 與 exit codes全部寫入 report。
- [ ] WR7.4 對 Windows WebView2 role surface 實際連續執行至少 20 輪
  `Ctrl+Tab`／`Ctrl+Shift+Tab`，每輪重新確認 active HTML tab、WebView visibility與focus；
  不得 hang、duplicate commit、失去modifier release或誤攔截 `Alt+Tab`。
- [ ] WR7.5 在快捷鍵壓力後關閉所有 QA runtime，重跑第 4 節 required idle diagnostics；
  所有 required count仍須為0，invariant須為true。
- [ ] WR7.6 反向檢查 WebView2 `AcceleratorKeyPressed` callback只呼叫 defer helper；
  callback本體不得讀 `CoreState`、執行 tab selection或 application shortcut。defer helper
  必須先以 `run_on_main_thread`離開callback stack，之後才可讀Core／提交intent。
- [ ] WR7.7 確認 Windows tab-chrome bootstrap cleanup 仍由 `#[cfg(windows)]` 限定；
  不得用 `allow(dead_code)` 或 non-Windows no-op掩蓋可達性。
- [ ] WR7.8 在既有 report 加入 `Final-audit delta validation` 章節，更新
  `Validated-code SHA`與`最終 branch exact SHA`為新 HEAD，commit、push並核對遠端一致。

只有 WR7.1–WR7.8 全部通過，既有 Windows pass 才能延伸到 final exact SHA。

## 8. Final-ledger audit successor

如果主工作在WR7 pass後發現 tombstone cleanup 對
`Indeterminate/Cancelled` terminal outcome過度清理，最終後繼SHA還必須完成：

- [ ] WR8.1 記錄新exact HEAD／remote／clean worktree，證明WR7的
  `Validated-code SHA`為ancestor，逐檔audit該range。
- [ ] WR8.2 確認`RemoveWindow`只能清除沒有logical surface、且close operation為
  authoritative `Completed | Failed`的tombstone；`Indeterminate`與event-stream failure
  必須保留tombstone及`Closing` logical surface，晚到ready不得復活。
- [ ] WR8.3 執行exact focused regression，必須同時涵蓋正常`Closed -> RemoveWindow`、
  `RemoveWindow -> Closed`、duplicate closed、直接`Indeterminate/Cancelled/Failed`
  terminalization與`FailEventStream`。
- [ ] WR8.4 在新exact SHA重跑第1節全部required Windows automated gates，包括完整
  Vitest、完整Rust、all-targets check、native build、production build與generated clean。
- [ ] WR8.5 以新binary完成至少一次實際role launch與正式runtime window close，再由正式
  Diagnostics UI證明正常authoritative closed path仍使全部required idle counts（含
  tombstone）為0、invariant=true；不得故意把unknown teardown當成功來製造0。
- [ ] WR8.6 既有WR7的20輪shortcut與其他WUI可在逐檔差異稽核後沿用，因本delta只能修改
  pure RuntimeKernel tombstone predicate/tests/docs；若range出現其他production檔則不得沿用。
- [ ] WR8.7 在Windows report新增`Final-ledger audit successor`章節，更新validated-code SHA，
  commit、push並以remote/tracking/local三方一致值回傳；仍不得刪除migration ledger。

只有WR8.1–WR8.7全部通過，主工作才可完成Z4/Z6並把ledger作為最後檔案變更刪除。

## 9. Dormant admission permanent-ID 與 tab-chrome close delta

WR8 pass 後，macOS 以使用者既有資料重播發現一條較早期、獨立的 dormant-window
hydration 路徑仍產生 `provisional-<uuid>`，會在 desired topology/native chrome 已投影後，
才以該非 UUID 值呼叫新 Core admission，因而得到 `RUNTIME_TAB_ID_INVALID`。修正保留
Core 的嚴格 permanent-TabId 契約，並讓 live/dormant preview 共用同一 UUID allocator。
實機關閉測試另發現 logical close 與 native surface teardown 完成後，平台 tab chrome
未收到 committed removal effect；修正只在 Kernel close commit 後投影既有
`try_remove_native_tab_reservation`，不建立第二個 authority 或 correctness timer。

- [ ] WR9.1 `git pull --ff-only` 後記錄新 exact HEAD、remote SHA、clean worktree，證明
  WR8 validated-code `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7` 與 report commit
  `9af44f3e` 都是新 HEAD 的 ancestor；逐檔 audit `9af44f3e..HEAD`。
- [ ] WR9.2 確認 production delta 只做下列契約收斂：live/dormant preview 共用
  `allocate_launch_preview_handle`、`provisional_tab_id`相容欄位值為普通 UUID、close
  在 `commit_live_tab_close` 之後投影 native tab removal。不得放寬 Core UUID validation、
  加 alias/owner probing/dual-write/timer，且 `format!("provisional-` production 命中為零。
- [ ] WR9.3 在正式 UI 重複匯入更新後的
  `tests/fixtures/runtime-authority/portable.json`；確認新增 `[Runtime QA] Epsilon`、
  `[Runtime QA] Zeta`、`[Runtime QA] Dormant Admission`，重跑不增殖，且該 workspace
  不存在於任何 fixture saved game window，確保會覆蓋 append-source dormant path。
- [ ] WR9.4 所有 runtime window 都為 dormant／未顯示時，從 main dashboard 開啟
  `[Runtime QA] Dormant Admission`。必須記錄 `first-eligible-dormant-window`、普通 UUID
  permanent TabId、兩個 WebView2 fixture surface ready、唯一 logical/native tab，且沒有
  `RUNTIME_TAB_ID_INVALID`、runtime crash、duplicate surface 或 error payload。
- [ ] WR9.5 立即再次開啟同一 workspace，必須 terminalize 為
  `existing-live-source | joined`，不新增 tab/surface；再以 Windows HTML tab strip 的正式
  「停止並關閉」關閉，確認 chrome item、logical membership、SQLite tab與兩個 surface
  全部移除。隨後立即 relaunch，必須取得新 permanent TabId且舊 callback不復活。
- [ ] WR9.6 在新 exact SHA 重跑第1節全部 required Windows automated gates：完整
  Vitest、完整 Rust、`cargo check -p rion-tauri --all-targets`、native build、production
  build、source/system-only/dependency hygiene、generated clean與`git diff --check`。
- [ ] WR9.7 關閉全部 QA runtime，經正式 Diagnostics UI 匯出並解析；所有 required
  idle counts（特別是 tombstone/pending/logical/native/tab/role/display host）須為0，
  `runtimeNativeResourceInvariantsOk=true`、failure count=0、`collectionErrorCodes=[]`。
- [ ] WR9.8 在既有 Windows report 新增 `Dormant admission and tab-chrome close delta`
  章節，記錄每一步、失敗／重跑、validated-code SHA；commit、push並核對
  local HEAD/tracking/remote 三方一致。migration ledger仍保留，由macOS主工作完成最後
  range audit後才可刪除。

只有WR9.1–WR9.8全部通過，才能把Windows pass延伸到本次修正的final exact SHA。
