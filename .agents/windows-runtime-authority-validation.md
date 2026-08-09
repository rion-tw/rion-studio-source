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
