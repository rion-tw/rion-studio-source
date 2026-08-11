# Windows 遊戲視窗 placement 驗收清單

這份文件用於驗收 `agent/windows-window-placement-acceptance` 分支的遊戲視窗最後狀態修正。實作提交為 `e7455ea1`；Windows 驗收尚未完成，不得以 macOS 或 portable 測試結果取代。

## 驗收範圍

- 原生視窗的位置、內容尺寸、所在顯示器、工作區、scale factor 與 `normal / maximized / fullscreen` 模式，必須經由同一條有 generation 與 sequence fence 的 placement event 更新。
- 只有視窗化事件可以更新 `normalBounds`。最大化、全螢幕與最小化期間必須保留最後有效的視窗化位置與內容尺寸。
- 最小化不是可還原模式；重新開啟時應還原最後一個非最小化模式。
- Windows placement 的唯一持久化 writer 是 Win32 terminal receipt 路徑。Tauri `Moved` 只能處理 presentation/native surface 定位，不得再寫入 placement。
- 遊戲視窗列表必須有獨立且可排序的「視窗模式」欄，執行中顯示 live projection，未開啟時顯示 SQLite 保存值。

## Windows GPT 接手規則

1. 先閱讀 repository 根目錄的 `AGENTS.md`、`.agents/context.md`、`.agents/context/system-runtime.md`、`.agents/context/data.md`、`.agents/context/renderer.md`、`.agents/context/testing.md` 與本文件。
2. 使用 shell 執行自動化檢查，使用 Computer Use 操作 dev app 與原生遊戲視窗。
3. 使用隔離的 debug 資料目錄，不得用正式使用者資料做驗收。
4. 每個案例都記錄 `通過 / 失敗 / 阻塞` 與證據。不要只憑畫面判定 persistence；需要同時檢查重新啟動結果或 SQLite snapshot。
5. 若失敗，先保存重現步驟、畫面、log 與 SQLite 值並定位原因；未經使用者要求，不擴大成其他重構。

## 前置環境

- Windows 10 或 Windows 11，已安裝支援 Tauri 2 的 Visual Studio C++ Build Tools、Rust stable、WebView2 Runtime、Node.js `>=24.10.0` 與 pnpm `11.13.0`。
- 至少使用一台顯示器並記錄其 scale。若有兩台顯示器，優先使用不同 scale（例如 100% + 150%）完成跨螢幕案例。
- 從遠端 checkout 本分支，確認沒有夾帶與本修正無關的 macro 提交：

```powershell
git fetch origin
git switch --track origin/agent/windows-window-placement-acceptance
git pull --ff-only
git status --short
git log --oneline origin/main..HEAD
```

`git status --short` 預期無輸出。`origin/main..HEAD` 應只包含視窗 placement 實作與本驗收文件。

安裝依賴：

```powershell
corepack enable
pnpm install --frozen-lockfile
```

## 自動化 gate

依序執行下列命令。全部必須成功；`lint` 若只有 repository 既有的 Fast Refresh warnings 可記錄為 warning，但不得有 error。

```powershell
pnpm run check:source-hygiene
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run lint:rust
pnpm run test:rust
pnpm run build
git diff --check
```

Windows 驗收報告必須列出每個命令的 exit code 與測試摘要。`pnpm run test:rust` 和 `pnpm run build` 必須在 Windows 原生主機完成，不能用 Linux portable 結果代替。

## 建立隔離 dev 環境

在同一個 PowerShell session 建立唯一目錄，再啟動 dev app：

```powershell
$qaRoot = Join-Path $env:TEMP ("rion-window-placement-qa-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $qaRoot | Out-Null
$env:RION_STUDIO_USER_DATA_DIR = [System.IO.Path]::GetFullPath($qaRoot)
Write-Host $env:RION_STUDIO_USER_DATA_DIR
pnpm run dev
```

記錄 `$qaRoot` 的實際值。只有 debug build 接受 `RION_STUDIO_USER_DATA_DIR`；若 app 拒絕此變數，先確認啟動的不是 release build。

建立至少三個永久遊戲視窗，名稱建議使用：

- `QA Windowed`
- `QA Maximized`
- `QA Fullscreen`

每個視窗至少放一個可正常載入的角色／頁籤，避免空視窗生命週期干擾 placement 驗收。

## UI 與 persistence 案例

### W1 — 視窗模式欄與 saved fallback

- [ ] 「視窗模式」欄位位於「目標顯示器」之後，模式使用一般文字，不使用執行狀態 Badge。
- [ ] 未開啟的新視窗顯示「視窗化」。
- [ ] 表格在 960×640 主視窗內可水平捲動，右側操作仍可使用。
- [ ] 欄位 header 可聚焦／點擊排序，ARIA sort state 會更新。
- [ ] 三種模式的升冪固定為「視窗化 → 最大化 → 全螢幕」，降冪相反；排序不受翻譯字典序影響。
- [ ] 至少核對正體中文；若設定頁可直接切換語言，再抽查英文 `Windowed / Maximized / Full screen`、日文與簡體中文沒有漏 key 或顯示 raw key。

### W2 — 視窗化位置與內容尺寸

1. 開啟 `QA Windowed`，將視窗拖到明顯但完全位於工作區內的位置。
2. 互動式調整成容易辨識的尺寸，放開滑鼠後等待 UI 完成原生事件處理。
3. 記錄外框左上角與 content client area 的近似位置／尺寸。
4. 關閉原生遊戲視窗；確認列表仍顯示「視窗化」。
5. 再開啟一次，確認位置與 content 尺寸還原，不能逐次漂移一個 non-client frame 或 DPI 倍率。
6. 完全退出 Rion Studio，再用相同 `$env:RION_STUDIO_USER_DATA_DIR` 執行 `pnpm run dev`；再次開啟並確認位置／尺寸仍一致。

- [ ] 拖曳位置已保存。
- [ ] 互動式 resize 在 `WM_EXITSIZEMOVE` 後保存。
- [ ] app restart 後仍可還原。
- [ ] 重複關閉／開啟三次沒有累積座標或尺寸漂移。

### W3 — 最大化保留 normalBounds

1. 先依 W2 設定並記錄 `QA Maximized` 的視窗化位置與尺寸。
2. 使用 Windows 標題列按鈕最大化。
3. 保持視窗開啟時回主視窗，確認列表 live mode 為「最大化」。
4. 關閉原生遊戲視窗，確認 saved fallback 仍為「最大化」。
5. 再開啟，確認原生視窗直接以最大化呈現。
6. 按還原，確認回到步驟 1 的視窗化位置與尺寸，而不是最大化外框座標。
7. 完全重啟 app 後重做步驟 5–6。

- [ ] live projection 顯示最大化。
- [ ] 關閉後保存最大化。
- [ ] 重開與 app restart 後還原最大化。
- [ ] 最大化事件沒有覆寫最後有效 `normalBounds`。

### W4 — 全螢幕保留 normalBounds

1. 先將 `QA Fullscreen` 設成不同於 W2/W3 的視窗化位置與尺寸並記錄。
2. 使用產品支援的全螢幕操作進入全螢幕。
3. 確認列表 live mode 為「全螢幕」。
4. 關閉原生遊戲視窗，確認 saved fallback 為「全螢幕」。
5. 再開啟，確認直接進入全螢幕。
6. 離開全螢幕，確認回到步驟 1 的視窗化位置與尺寸。
7. 完全重啟 app 後重做步驟 5–6。

- [ ] live projection 與 saved fallback 都顯示全螢幕。
- [ ] 重開與 app restart 後還原全螢幕。
- [ ] 全螢幕事件／過渡 frame 沒有覆寫最後有效 `normalBounds`。

若目前 Windows 產品沒有可達的全螢幕操作，將本案例標為「阻塞」，附上 UI 與操作路徑證據；不得改標為通過。

### W5 — 最小化不是還原模式

對 `QA Windowed` 與 `QA Maximized` 各執行一次：

1. 先確認當前非最小化模式。
2. 最小化原生遊戲視窗。
3. 關閉視窗或退出 app，再重新開啟。

- [ ] 原本視窗化者以視窗化還原。
- [ ] 原本最大化者以最大化還原。
- [ ] 列表沒有出現「最小化」模式，SQLite 也沒有保存 `minimized`。

### W6 — 快速事件、關閉與 generation fence

1. 快速連續拖曳、resize、最大化、還原，再停在一個明確的最終視窗化位置／尺寸。
2. 立即關閉並重新開啟同一個遊戲視窗。
3. 重複一次，但最後停在最大化。
4. 在舊視窗剛關閉時立即重新開啟，觀察新 generation 是否被舊事件回寫。

- [ ] 最終還原值永遠對應最後被接受的 terminal placement。
- [ ] 沒有回跳到較早的 position、size 或 presentation。
- [ ] 舊 generation 的晚到事件不改變新視窗的 live/saved placement。
- [ ] 關閉與 app exit 的 final flush 不會漏掉最後狀態。

## 多螢幕與 DPI 案例

### W7 — 同 scale 跨螢幕

1. 將視窗化視窗移到第二台顯示器並調整尺寸。
2. 關閉、重開，再完全重啟 app。

- [ ] target display 與工作區已更新。
- [ ] 視窗在正確顯示器還原，且位於可見工作區內。
- [ ] 最大化／全螢幕後再還原，仍回到第二台顯示器的最後視窗化 bounds。

### W8 — 不同 scale 與 `WM_DPICHANGED`

僅在兩台顯示器 scale 不同時執行。將視窗由 100% 螢幕移到 125%／150%／200% 螢幕，完成移動後再 resize、最大化與還原。

- [ ] content size 按 per-monitor DPI 正確轉換，沒有把 physical pixels 當 logical size。
- [ ] `WM_DPICHANGED` 後關閉／重開沒有尺寸倍增、縮小或 non-client frame 漂移。
- [ ] 所保存的 display bounds、work area 與 scale factor 對應目標螢幕。
- [ ] 最大化／全螢幕期間切換螢幕不會污染 `normalBounds`。

若只有一台顯示器，W7/W8 標為「阻塞：缺少硬體」，並記錄目前解析度與 scale。Windows CI 通過不等於這兩項人工驗收通過。

## SQLite 證據

先關閉原生遊戲視窗，讓 final flush 完成。若系統已安裝 `sqlite3.exe`，可在 PowerShell 執行：

```powershell
$db = Join-Path $env:RION_STUDIO_USER_DATA_DIR "rion-studio.sqlite3"
$sql = @'
SELECT
  name,
  json_extract(payload_json, '$.placement.presentation') AS mode,
  json_extract(payload_json, '$.placement.normalBounds.x') AS x,
  json_extract(payload_json, '$.placement.normalBounds.y') AS y,
  json_extract(payload_json, '$.placement.normalBounds.width') AS width,
  json_extract(payload_json, '$.placement.normalBounds.height') AS height,
  json_extract(payload_json, '$.placement.scaleFactor') AS scale_factor
FROM game_windows
ORDER BY ordinal;
'@
sqlite3.exe -header -column $db $sql
```

每次執行 W3/W4 的最大化或全螢幕動作前後都保存查詢輸出：

- [ ] `presentation` 按預期改成 `maximized` 或 `fullscreen`。
- [ ] `normalBounds.x/y/width/height` 在模式切換期間保持完全相同。
- [ ] 回復視窗化並完成一次 terminal move/resize 後，`normalBounds` 才更新。

若沒有 `sqlite3.exe`，可用唯讀 SQLite 工具檢查相同欄位；不要因此跳過 persistence 證據。

## Win32 行為核對

以下項目以人工案例、現有 Rust/source tests 與必要的 debug log 共同判定：

- [ ] 互動式 move/resize 在 `WM_EXITSIZEMOVE` 產生完整 placement。
- [ ] 非互動式終端 `WM_SIZE`／`WM_WINDOWPOSCHANGED` 會收斂成完整 placement。
- [ ] `WM_DPICHANGED` 會更新 monitor/work area/scale 資訊。
- [ ] `GetWindowPlacement`、monitor work area 與 non-client frame 轉換符合「外框左上角 + content logical size」契約。
- [ ] Tauri `Moved` 不直接持久化 Windows placement，避免雙 writer 競爭。
- [ ] sequence 重複、逆序事件與過期 generation 被忽略。

相關 log event 名稱為 `native.window-placement-observed`。若案例失敗，保存該視窗從開啟到關閉的完整 dev console/log 片段，不要只截最後一行。

### Windows 原生待驗風險

目前 Win32 receipt 會在 terminal message 後進入共享 observer，再由 Tauri window getters 讀取 outer position、inner size、presentation 與 current monitor；原始修復計畫則要求直接用 `GetWindowPlacement` 搭配 non-client frame 與 per-monitor DPI 轉換。Windows GPT 必須把兩者的語意等價性當成待驗項目，不能因 source tests 通過就略過：

- [ ] 最大化與全螢幕時取得的 presentation 正確，而且不讀取該模式外框成為 `normalBounds`。
- [ ] 還原後的 outer position + content logical size 與 `GetWindowPlacement` 推導結果一致。
- [ ] 負座標顯示器、不同 DPI、工作列位置與 auto-hide 工作列都不造成 frame offset。

任何不等價結果都屬於本修正的 Windows implementation gap，最終 verdict 必須是 `FAIL`，並附上實測偏差值。

## 驗收報告模板

```text
Commit / branch:
Windows edition / build:
CPU architecture:
WebView2 version:
Monitor 1 resolution / scale / work area:
Monitor 2 resolution / scale / work area (or N/A):
Isolated data directory:

Automated gates:
- check:source-hygiene:
- typecheck:
- lint:
- test:
- lint:rust:
- test:rust:
- build:
- git diff --check:

Manual acceptance:
- W1:
- W2:
- W3:
- W4:
- W5:
- W6:
- W7:
- W8:

SQLite before/after evidence:
Screenshots / recordings:
Relevant logs:
Failures or blockers:
Final verdict: PASS / FAIL / BLOCKED
```

只有自動化 gate 全綠、W1–W6 全部通過，且可用硬體上的 W7/W8 通過時，才可回報 Windows 驗收 `PASS`。沒有第二台／混合 DPI 顯示器時，最終結果應清楚標記該硬體覆蓋缺口。

## 已知的非 Windows 證據

macOS 本機已完成模式欄、最大化／全螢幕 live 與 saved fallback、關閉與 app restart 還原、以及 `normalBounds` 不被兩種模式覆寫的 Computer Use 驗收；所有規劃中的 JS/Rust/build 檢查亦已通過。這些結果只作為對照，不算 Windows 原生驗收。
