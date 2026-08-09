# Rion Studio Runtime 單一權威全面改造帳本

> 建立日期：2026-08-09
> 狀態：in-progress
> 執行原則：這是唯一完成清單。所有非帳本任務、macOS 實機驗收、Windows CI 與最終反向盤點完成前不得刪除本檔；真正阻塞時保留本檔並記錄 blocker。

## 基線

- Branch：`main`
- HEAD：`98145ee77d3c36b155ab8a643714ebbca3245be1`
- 起始工作樹：clean
- 既有 launch-admission 變更：已在目前 HEAD，視為不可回退的整合基線。
- 功能凍結：本帳本存在期間，不新增 Runtime／視窗／分頁／角色生命週期功能。
- 完成狀態規則：每項任務使用 `pending / in-progress / done / blocked`，`done` 必須附程式或測試證據。

## 摘要與根因

- React 應是 revision-fenced 的 UI 投影，不應成為原生視窗、WebView、角色租約的權威。
- Rust 是正確的執行位置；真正問題是 Rust 內存在多個可寫狀態表、跨模組直接存取、非原子快照及 Core/Tauri 循環協調。
- macOS AppKit 分頁與 Windows HTML 分頁只是放大器；共同語意沒有被抽成可驗證核心，才會在平台分支間漂移。
- 現況是單一權威遷移做到一半：LiveWindowTabStore、Core launch plan、Tauri runtime maps、surface registry、native projection 都仍能局部判定真相。
- 已確認的結構性缺陷包括跨視窗 snapshot 可能讀到 torn revision、部分名稱／縮放／音訊／generation 更新繞過 transaction，以及 provisional tab ID 在啟動完成後被替換所引發的 owner probing。

目標資料流：React/AppKit/Windows HTML 發出 RuntimeIntent；AppCore actor 獨佔 RuntimeKernel；Kernel 產生 revisioned RuntimeCommit；Tauri executor 只套用原生 effect，NativeResourceRegistry 只持有 handle；SQLite 與 renderer 是 forward-only projection；原生 callback 以 identity/generation/revision fence 回到 Kernel。

## 核心 invariants

- [x] I1 每個 live tab 只有一個 window owner、role lease、logical surface owner。Kernel candidate audit、duplicate-owner rejection與 10,000-step model trace通過。
- [x] I2 一個 role/source 的同一啟動意圖不可建立兩個 surface。darwin/win32 overlapping role/workspace admission各只產生一個 `EmbeddedCreateTab`，兩個 receipt 指向同一 TabId。
- [x] I3 關閉 tombstone 建立後，舊 attach/ready/focus event永遠不能復活該 tab。close-before-attach、late ready、duplicate closed、relaunch tests通過。
- [x] I4 revision 嚴格遞增，consumer不得把 torn snapshot標記成已套用。atomic multi-window snapshot、renderer monotonic store與 native desired projection global revision gate通過。
- [x] I5 每個 operation 必須是明確 pending或唯一 terminal outcome。Kernel audit、duplicate terminal、close/relaunch supersede tests通過。
- [x] I6 Native registry 不得存在沒有 live logical owner的 handle。System Runtime diagnostics cross-audit logical surface、exact native instance/window generation/role label並附 trace；281 tests通過。
- [x] I7 Native effect executor 不得在 effect call stack 內同步回查 Core。證據：native presentation callback 僅讀獨立 revision-monotonic desired projection cache 與 native surface identity；source hygiene 禁止 `request.live`／`LiveWindowHandle` re-entry，Tauri 281 tests 通過。

## A. 基線穩定與可觀測性

- [x] A1 `done` 建立帳本並保存 clean baseline；以全 repo `rg`、architecture source tests 與 source-hygiene guard 盤點 Runtime writer、registry、snapshot、effect、native callback、renderer refresh。所有找到的舊 writer/authority 已登錄 R1–R10 並移除或收斂。
- [x] A2 `done` completed/pending admission、cancelled attempt/relaunch、close-before-native lifecycle皆有 regression；新增 darwin/win32 overlapping role/workspace完整 Core effect replay，兩個 admission共用一個 TabId且只有一個 native create。
- [x] A3 `done` RuntimeKernel 使用 512 筆 bounded privacy-safe trace，僅含 operation/revision/window/tab/attempt/generation/phase/event source；`SystemRuntimeDiagnosticsRecord` 已輸出 Kernel revision/count/trace，不含 URL、Cookie、頁面內容或憑證。
- [x] A4 `done` RuntimeKernel `audit()` 檢查 window/tab owner、selection、operation terminality、surface/lease/tombstone/revision；System Runtime diagnostics 再以 `audit_native_resource_invariants` 對 logical snapshot 與 exact native handles/window generations/role labels 做跨層稽核，失敗附 bounded privacy-safe trace。Kernel 17 tests、Tauri System Runtime 281 tests通過。
- [x] A5 `done` source hygiene 禁止 owner probing、implicit dirty writer、額外 logical registry、effect-stack Core re-entry、Tauri barrier 外 Kernel write、平台 adapter 退回 shared include；event-topology scanner要求每個 production timer/watchdog/deadline都有分類或 exception ledger 配對。最終反向搜尋另由 Z5 再執行一次。

## B. 建立唯一 RuntimeKernel

- [x] B1 `done` `crates/rion-core/src/runtime_kernel/{types,state,tests}.rs` 為無 Tauri/AppKit/Win32 依賴的純狀態機；`cargo test -p rion-core runtime_kernel --lib` 通過。
- [x] B2 `done` `RuntimeKernel` 以專用 `rion-runtime-kernel` actor thread + mpsc mailbox 序列化 apply/snapshot/audit，AppCore 僅持有該 handle。
- [x] B3 `done` Kernel aggregate 已持有 window generation、tab topology/order/selection、placement/display/persisted name、window zoom、tab audio、role zoom/slots、browser role lease、logical surface lifecycle、operation phase、tombstone 與全域 revision；各 mutation 有 expected-revision fence。
- [x] B4 `done` Kernel 與 LiveWindow facade 已統一 `apply -> RuntimeCommit` 並由 actor 原子 snapshot；每次 apply 只在完整 candidate aggregate 通過 invariants 後發布。已移除 `LiveWindowGuard` drop-time implicit `ReplaceWindow` writer，所有 reader 只取得 immutable snapshot，修改必須顯式提交 intent。
- [x] B5 `done` 名稱、display/placement、active tab、跨視窗 move、generation、tab mute、window zoom、role zoom 與 role slot layout 全經 Kernel transaction；native fanout 失敗以反向 Kernel commit compensation，不再 `touch_live_window_state` 或改寫 duplicated logical fields。
- [x] B6 `done` `LiveWindowTabStore` 僅為 Kernel compatibility facade；舊 mutable/dirty guard writer 已全部移除，source hygiene 禁止 `LiveWindowGuard` 或 `LiveWindowHandle::lock` 回歸，Tauri 281 tests 通過。
- [x] B7 `done` monotonic revision、bounded operation idempotency、duplicate/supersede/cancel皆由 Kernel處理；close/relaunch terminalize舊 operation，`FailEventStream` 將 exact pending operations標成 `Indeterminate` 並保留唯一 terminal outcome；executor Drop 對剩餘 native event stream執行 `NATIVE_EVENT_STREAM_STOPPED` terminalization。17 Kernel tests通過。

## C. 重建 launch、close、restore

- [x] C1 `done` role/workspace/restore 從 admission 傳入永久 UUID `launch_tab_id`，Core effect 與 native create 全程沿用；相關 Core/Tauri no-run 編譯及 admission 測試通過。
- [x] C2 `done` retry 沿用 TabId 並以 attempt generation fencing；alias、replace-tab-id、AppKit replace C ABI 與 completion owner probing 已移除。
- [x] C3 `done` `BrowserRuntimeState::CreateTab` 將 source查找與建立合為單一 transaction；2-thread Kernel admission及 darwin/win32 overlapping role/workspace完整 Core effect replay均證明兩個 caller共用一個 TabId且只有 creator送 native create。Computer Use 重複 role launch維持一個 logical/native surface；restore以同一 exact-ID admission進入。
- [x] C4 `done` Runtime admission/close plan 為 immutable identity plan，Core先提交 pending/close desired state再送 effect；全 repo `launch_plans`為零，effect-stack source hygiene禁止同步 `.core.invoke(`，native lifecycle只經 typed kernel facade回傳。
- [x] C5 `done` Tauri executor 已將 `attached/ready/failed/closed` 以 operation/tab/attempt/window generation/surface generation envelope 實際送回 Kernel；tombstone/attempt tests 證明過期事件為 Duplicate 且不能復活 surface。2026-08-09 實機 SQLite trace 重播 `surface.registered → tab.surface-attached → launch phases → ready/settled` 與 close/release，永久 TabId 與 window generation 全程一致；loading close 後立即 relaunch 的新 surface 計數歸零且舊 callback 未復活。
- [x] C6 `done` `preview_tab_close` 先以 `RuntimeIntent::CloseTab` 原子移除 membership、建立 tombstone/teardown desired effect，native teardown 完成後只 terminalize 同一 Kernel operation；late events 由 tombstone tests 拒絕。
- [x] C7 `done` preview launch、無 preview completion fallback 與 restore 都先提交完整 desired topology／永久 TabId，再建立 native host；native host 失敗保留可重試 desired state。restore/launch 均走同一 Core source admission；source ordering regression 與 dormant hydration test 通過。
- [x] C8 `done` window close由 `BrowserWindowCloseAdmit`先取得 exact lease並以單一 Kernel revision移除 desired tabs/owners；native teardown消費 immutable identity-keyed `closing_tabs`至唯一 terminal。Window persistence lane以 `(window_generation, revision)` latest-wins coalesce/retry，Core batch在單一 SQLite transaction逐 window拒絕 stale/duplicate revision；revision/batch atomic tests通過。
- [x] C9 `done` 全 repo runtime source 已移除 `launch_plans`、`role_tabs`、`native_tab_hosts`、`optimistic_closed_tabs`；需要的 native 查詢由 handle registry 即時計算，不再有額外 logical owner map。

## D. 原生 executor 與跨平台隔離

- [x] D1 `done` authority-sensitive boundary已抽為真正 Rust modules：pure Core `runtime_kernel`/ports、Tauri `kernel_facade`、`native_executor`、`native_resource_registry`、`native_projection`，以及 compile-time `platform::{macos,windows,unsupported}`。模組化並抓出/修正原本誤藏在 Windows lifecycle 的共用 `RuntimeError` impl；hygiene禁止退回 shared include。
- [x] D2 `done` `RuntimeState.native_resources: NativeResourceRegistry`僅集中不可序列化 display host/surface/tab handles；已移除 `Deref/DerefMut`相容層，所有存取顯式經 `native_resources`，lookup名稱標明 `native_*_handle/surface`，membership/role/relaunch只讀 Kernel desired projection。cross-audit與281 tests通過。
- [x] D3 `done` Core 定義 `WindowPort`、`TabChromePort`、`SurfacePort`、`FocusPort`、`RuntimeNativeProjection`、tab/window/surface generation fence；native callback 統一使用 `NativeRuntimeEvent` envelope。
- [x] D4 `done` macOS AppKit tabs與Windows HTML tab strip保留產品差異，兩個 compile-time adapter皆消費同一 `RuntimeNativeProjection`與 callback envelope；平台檔不再 include進shared namespace。
- [x] D5 `done` `RuntimeSnapshot::native_projection(window_id)`原子輸出完整 ordered tabs/settings、global/window revision、window generation與operation/attempt/surface fences；獨立 forward-only desired projection store只接受monotonic revision。workspace template、audio等舊 native metadata fallback已移除。
- [x] D6 `done` fake macOS 與 fake Windows port 以同一 conformance transcript 重播 selection、move、close、restore/stale projection，結果一致；Kernel test suite 通過。
- [x] D7 `done` shared orchestrator定義為 pure Core `runtime_kernel/{ports,state,types}`，除 test module外沒有任何平台 cfg；macOS/Windows/unsupported cfg封裝於Tauri platform adapter/bootstrap邊界，source hygiene禁止平台 cfg回流Core orchestrator。

## E. Renderer revision store

- [x] E1 `done` 單一 `CoreCommand::AppSnapshot`在同一 state mutation guard與Runtime authority read barrier下讀取SQLite revision、單一RuntimeKernel snapshot、role/macro statuses與logical topology；所有persistent mutation及public RuntimeKernel intent持有同一write barrier。`app_snapshot_is_linearized_by_the_runtime_authority_barrier`證明snapshot不能跨越in-flight commit，且native effect不在barrier內等待。
- [x] E2 `done` `useAppData` 先訂閱 `onAppSnapshotChanged` 再讀 snapshot；bridge replayable follower 只提交較新 revision。ordering/recovery 測試通過。
- [x] E3 `done` `appSnapshotStore.ts` + `useSyncExternalStore`，無新增 dependency。
- [x] E4 `done` AppSnapshot 與 DisplayTopology 以獨立 revision fence commit；store 測試涵蓋 duplicate/out-of-order response。
- [x] E5 `done` role/workspace/game/macro workflow 已移除所有 authoritative collection/status setter 與 list-based rollback；2026-08-09 `rg setRoles/setWorkspaces/setGames/setMacros/setStatuses` 為零，typecheck 與 16 個 targeted tests 通過。
- [x] E6 `done` renderer reorder handlers 不建立 authoritative optimistic overlay，只 await bridge command；列表內容始終由 revisioned AppSnapshot 投影，錯誤只寫 transient UI error。
- [x] E7 `done` store tests涵蓋 event-before-snapshot、snapshot-before-event、out-of-order、duplicate、StrictMode subscribe/re-subscribe、跨 collection 單通知與 recursive immutability；System Runtime reload test證明 semantic projection revision 可跨 renderer reload 保留。

## F. 永久測資與本機 fixture

- [x] F1 `done` `scripts/runtimeAuthorityFixtureServer.mjs` 只 listen `127.0.0.1:41739`，具 `/health`、role page、鍵盤/點擊/focus/visibility state API；`curl` health/page 實測通過。
- [x] F2 `done` `tests/fixtures/runtime-authority/portable.json` 為 schema 17，Core portable normalize/deserialize/preview/prepare regression test 通過且不含敏感資料。
- [x] F3 `done` fixture 固定包含 1 game、4 roles、2 workspace layouts、3 個多 tab windows、once/loop/nested macros。
- [x] F4 `done` fixture 全部 launch URL 為 `http://127.0.0.1:41739`；macro 僅有安全 key/click/delay/nested call。
- [x] F5 `done` fixture 使用固定 UUID；Core test 對 imported snapshot 再次 preview，所有 collection 均為 unchanged，證明重跑不增殖。
- [x] F6 `done` 2026-08-09 透過 Rion Studio Dev 正式「設定 → 資料 → 匯入 JSON」UI 匯入；畫面回報新增 13、警告 0，dashboard 顯示總數 +1 game/+4 roles/+2 workspaces/+3 windows/+3 macros，資料永久保留。

## 內部介面

- [x] T1 `RuntimeIntent`涵蓋 Browser launch admission、native lifecycle、selection/order/move topology、close/tombstone、restore topology及 window/settings mutation。
- [x] T2 `RuntimeCommit`輸出 revision、operation_id、status/membership mutation result、desired effects、terminal events及受影響 windows。
- [x] T3 `RuntimeSnapshot`：actor 在單次 mailbox request 中複製完整 Core runtime aggregate 與 revision。
- [x] T4 `RuntimeLaunchAdmission`：已定義 operation_id、永久 tab_id、attempt_id、existing/admitted/joined。
- [x] T5 `NativeRuntimeEvent`：已定義並接線 operation/tab/attempt/window generation/surface generation/event kind，stale/duplicate callback 由 Kernel fence 處理。
- [x] T6 RuntimeTabId、LaunchAttemptId、OperationId、RuntimeWindowGeneration、RuntimeSurfaceGeneration 為不可混用 newtype。
- [x] T7 Renderer AppSnapshot/event 已加 revision envelope，保留 `window.rionStudio` 公開方法。
- [x] T8 `pnpm run generate:rust-types` 成功（230 export tests）；generated files 未手改，資料 migration 未破壞。

## 自動化測試

- [x] V1 Kernel model/property tests：`deterministic_state_machine_stress_audits_every_interleaving`執行10,000 intents/events並逐步 audit/確認pending operation為零；parallel source admission只產生一個logical tab；涵蓋role zoom/slots、audio/window settings、stream failure與fake ports，17 tests通過。
- [x] V2 `done` explicit transcripts涵蓋double/overlapping role+workspace launch、out-of-order ready、duplicate closed、close-before-attach、completed close/relaunch、drag close fence、actor restart、quarantine、restore desired-first+overlapping launch及renderer ordering/reload重播。
- [x] V3 `cross_window_move_is_atomic_and_snapshot_never_tears` 以單一 actor commit 驗證 move 前/後 snapshot，不存在混合 revision。
- [x] V4 `done` AppCore integration以可控effect stream把window close分成admission與native completion，darwin/win32皆證明cleanup前exact tabs/owners為零；failed cleanup、late callback、stream failure與Drop terminalization均有event-bound transcript。
- [x] V5 fake macOS/Windows port 使用同一 full-projection conformance transcript且結果相同；真正 Windows WebView2 runner仍屬 W1/W3 gate。
- [ ] V6 壓力測試後 registry、pending operations 與 leases 歸零。
- [ ] V7 `in-progress` source hygiene、typecheck、lint、Vitest、Rust fmt/clippy/tests、build、system-only validation 曾在 Runtime 改造後完整全綠；AppKit accessibility 驗收修正後 source hygiene（1065 files）、focused Vitest（9 tests）與 native build 再次通過，仍須在所有實機修改結束後跑最後完整 gate。

## macOS Computer Use 實機驗收

- [x] M1 2026-08-09 Computer Use 正式匯入後 dashboard 顯示 4 個 `[Runtime QA]` 角色、2 workspace、3 macro，側欄 totals 證明 3 game windows 亦已合併；匯入成功訊息為新增 13／警告 0。
- [x] M2 `done` 2026-08-09 Computer Use 對 `[Runtime QA] Alpha` 快速雙擊只聚焦同一個 `[Runtime QA] Window One`，fixture 仍只有一個 WebView；緊接著雙擊包含 Alpha/Beta 的 `[Runtime QA] Two Columns` 也只聚焦同一 window/tab aggregate，沒有第二個 logical/native surface。
- [ ] M3 `in-progress` AppKit `ctrl+Tab` 與 accessibility radio-button press 都能切換 Alpha/Beta，active WebView/focus 一致。實機發現 custom tab 原先不是完整可操作的 AX element；已補上 press/menu/reorder accessibility actions與 source regression，待解鎖後完成真實 reorder、跨視窗 move 及 launch/close 交錯。
- [ ] M4 `in-progress` rename 已把 `遊戲視窗 2` 改為 `[Runtime QA] Race Window` 並同步 native title/restore；View → Zoom In 顯示 `Window 105%`；hide/show 保留同一 WKWebView 與 fixture 計數。mute、placement、stop 仍待實機驗收。
- [x] M5 `done` Computer Use 分別驗證 ready、loading、macro-running close：ready close 修正後立即 relaunch 使用新永久 TabId；loop running close 經確認後 role 6→4 且 macro terminal；loading Beta close 後 role 4→2；再次立即 relaunch 得到新 `遊戲視窗 2`，fixture counters 全為 0，舊 surface/callback 未復活。
- [ ] M6 `in-progress` 異常終止後 restore dialog 已重建 4 windows/6 tabs，後續多輪重啟恢復 4 windows/8 tabs；`[Runtime QA] Race Window` 名稱、Alpha/Beta tab order與 active Beta 都恢復。仍待以 UI 優雅 Quit/relaunch 再驗 placement/zoom。
- [x] M7 `done` Once 對 Alpha 精確造成 click +1/keydown +1；Loop 對 Beta 造成 click 累積至 72，停止後 1.5 秒仍為 72；Nested 執行期間顯示 parent+child 兩個 running，terminal 歸零且 Alpha 精確 click +1/keydown +2；macro-running window close 亦完成 cleanup。
- [x] M8 `done` Beta fixture 先保留 click=1，再對主 renderer 執行 reload；AppSnapshot projection 恢復後重新聚焦既有 Beta WKWebView，click 仍為 1，證明 renderer reload 未重建原生 WebView。
- [ ] M9 `in-progress` 已完成多輪 launch/close/relaunch/restore；logs 未出現 duplicate surface、torn revision、orphan、nonterminal 或 lease invariant，且 native lifecycle 皆有 terminal trace。剩餘 AppKit move 壓力與最終 diagnostics resource/pending/lease 歸零稽核待完成。

Computer Use 規則：每次操作後重新讀取 accessibility/App state，不沿用舊 element index；必要時以 screenshot 驗證。只操作本機 Rion Studio 與 localhost fixture，不傳輸敏感資料。

## Windows 門檻

- [ ] W1 windows-latest 實際編譯並執行 Core、shared runtime、Windows adapter conformance、renderer tests 與 Tauri build。
- [ ] W2 `in-progress` 修正 Windows resize helper 錯誤 cfg，macOS-hosted 共用測試已直接覆蓋 Windows tab-strip metrics、reveal recovery 及 superseded identity 欄位；Tauri 278 tests 無 dead-code warning且未使用 `allow(dead_code)`，仍待 Windows runner 實際觸及 WebView2/Win32。
- [ ] W3 Windows desktop smoke 可用時執行 create/show/focus/close；否則 native adapter integration harness 驗證相同 lifecycle fence。
- [ ] W4 macOS 與 Windows 任一 required gate 未通過時保留帳本。

## 舊權威移除表

- [x] R1 provisional tab alias / stable-id replacement（Rust/ObjC/renderer replacement path 已移除）
- [x] R2 live-owner probing 作為行為判斷（`native_tab_for_source` 已移除且 source hygiene 禁止回歸；restore/dormant hydration 查 Kernel/AppCore authoritative snapshot）
- [x] R3 authoritative role_tabs（移除 map；native roles 由 `RuntimeState.tabs[*].roles` handle registry 派生）
- [x] R4 authoritative native_tab_hosts（移除 map；host 由 surface handle registry 與 Kernel live snapshot 派生）
- [x] R5 optimistic-close 作為邏輯真相（移除 `optimistic_closed_tabs`；Kernel tombstone 為唯一 close fence）
- [x] R6 Core launch-plan mutable cache（`launch_plans` 移除；Core browser tab aggregate 由 RuntimeKernel actor 持有）
- [x] R7 bypassed live topology mutations（name/display/placement/generation/selection/move/audio/window+role zoom/role slots 均為顯式 Kernel transaction；drop-time dirty snapshot writer 已移除）
- [x] R8 effect executor synchronous Core re-entry（effect-stack source hygiene 禁止 `.core.invoke(`；projection 使用 Kernel snapshot與 immutable metadata cache，surface lifecycle/focus/input 直接 typed AppCore API 或 async terminal follower）
- [x] R9 per-window reads 可組成 torn multi-window snapshot（LiveWindow `snapshot_all` 由單一 Kernel actor snapshot 產生）
- [x] R10 renderer manual authoritative collection writes（workflow setter/rollback path 搜尋為零）

## 驗證證據

| Gate | 狀態 | 證據 |
| --- | --- | --- |
| 起始工作樹 | done | clean at HEAD 98145ee |
| Source hygiene | done | `pnpm run check:source-hygiene`：1065 tracked files 通過（2026-08-09，含 AppKit AX 修正後重跑） |
| Typecheck | done | `pnpm run typecheck` 2026-08-09 通過 |
| ESLint | done | `pnpm run lint` 通過；僅保留 23 個既有 react-refresh warnings |
| Vitest | done | 最新完整 146 files／813 tests 通過（新增 deadline dirty-readback regression）；AppKit AX focused 9 tests亦通過 |
| Rust fmt/clippy | done | `pnpm run lint:rust` 通過 |
| Rust tests | done | 前次完整 workspace：rion-core 563、rion-platform 20、rion-tauri 368；最新 input-fence 改造後 rion-tauri 367/367 通過（移除一個舊 readback test，新增兩個 deadline fence tests） |
| Build | done | `pnpm run build` 通過；AppKit AX 修正後 native build 再通過 |
| System-only validation | done | `pnpm run validate:system-only` 通過 |
| macOS Computer Use | in-progress | M1/M2/M5/M7/M8 完成；M3/M4/M6/M9剩餘項目待解鎖後驗收 |
| Windows CI | pending | |

## 最終完成與刪除門檻

- [ ] Z1 所有 runtime mutation 只能經 RuntimeKernel。
- [ ] Z2 所有舊權威、alias、probing、同步 Core callback、bypass mutation 已移除。
- [ ] Z3 所有 operation terminal、projection monotonic、native resource 可追溯唯一 live owner。
- [ ] Z4 全部自動測試、macOS 實機測試、Windows CI 全綠。
- [ ] Z5 最終全 repo 搜尋證明無遺漏 writer、registry、timer reconciliation 或舊契約。
- [ ] Z6 每項任務附證據並完成獨立 final audit。
- [ ] Z7 刪除本帳本作為最後一項檔案變更；永久 fixture 與本機 QA 測資保留。

## 執行假設

- 單次完整 initiative 內採漸進 strangler migration；階段內保持綠燈，但不中途交付半套。
- 保留 macOS AppKit 與 Windows HTML 分頁 UI 差異，只統一狀態語意、事件與測試。
- React external store 納入改造，但 React 不接管原生生命週期權威。
- 本機 Computer Use 負責 macOS 實機；Windows 以 required native CI 與 Windows runtime harness 為門檻。

## 發現與決策紀錄

- 2026-08-09：工作樹已 clean；先前未提交 launch-admission 變更已屬目前 HEAD，後續以現況整合而不回退。
- 2026-08-09：帳本建立；開始 A1 authority inventory。
- 2026-08-09：建立 pure RuntimeKernel actor、atomic multi-window snapshot、revision/idempotency/trace/audit；LiveWindowTabStore 轉為 revision-fenced facade。
- 2026-08-09：永久 TabId 串接完成，移除 alias/stable replacement、AppKit replace ABI 與 launch completion owner probing。
- 2026-08-09：Renderer 改用 revisioned external store；四類 workflow 不再直接寫 authoritative collections/status。`pnpm run typecheck` 與 16 個 targeted Vitest 通過。
- 2026-08-09：建立並由 Core parser 驗證永久 localhost fixture；經 Computer Use 正式 UI 匯入本機，共新增 13 筆頂層資料且無警告。
- 2026-08-09：Computer Use 發現既有 release app 的舊 workspace zoom 可使初始載入直接失敗（`Launch workspace browser zoom is invalid`）；需加入 compatible-data sanitization regression。
- 2026-08-09：Computer Use 以快速連續啟動觸發 role 與包含該 role 的 workspace 交錯，Core 回報 `Runtime tab id is invalid or already in use`；跨 source admission 尚未形成單一原子 transaction，列為 C3 阻斷證據。
- 2026-08-09：`CreateTab` 改為單一 state-worker source admission，只有 `tab_created=true` 的 caller 能送出 launch effect；Rust browser/runtime Kernel 測試與 Computer Use 的重複 role launch 證明同一 source 維持一個 logical/native surface。
- 2026-08-09：Core 新增單一 AppSnapshot projection，Tauri 不再分次拼接 state/status/topology；Rust contract generator 228 tests、typecheck、AppCore projection test 通過。
- 2026-08-09：靜態測試盤點發現 Windows resize helper 錯標為 `not(windows)`；已改成 `cfg(any(windows, test))`，並將另外兩個 Windows-only helper 限縮到 adapter/test reachability，`cargo check -p rion-tauri` 無 warning。
- 2026-08-09：相容性盤點確認舊資料中的 workspace zoom 與 game-window role slot 共用語意，原 workspace parser 卻只接受整數 25–300；已統一為 finite 25–500 且允許小數，domain 與 portable regression 通過。
- 2026-08-09：Computer Use 測試環境的 detached dev bundle 會使父 `pnpm dev` 結束時一併終止 Vite，造成路由 lazy chunk 載入失敗；獨立啟動 `pnpm run dev:renderer` 後恢復。此為本機 test harness 生命週期問題，不是 renderer state 回歸。
- 2026-08-09：Computer Use 重現 window close→立即 relaunch 的 split-authority 競態：Tauri 先移除 visible presentation 並顯示 0 running，Core `BrowserWindowStop` 仍在背景才清 owner，期間 launch 回覆 existing 並建立 placeholder。修正為 `BrowserWindowCloseAdmit` 先取得 exact operation lease，以 RuntimeKernel `CloseTabs` 單 revision 移除 desired tabs/role owners，再提交 Tauri tombstone/native teardown；executor 只消費 immutable closing plan，不再重讀 mutable owner snapshot。
- 2026-08-09：close admission 回歸在 darwin/win32 兩種 platform 參數下證明 native cleanup 前 owner 已歸零；Core targeted test、browser runtime 6 tests、Tauri 278 tests、Rust type generator 230 tests與 typecheck 通過，且原本 4 個 cfg(test) dead-code warnings 已由共用 conformance assertions 消除。
- 2026-08-09：第一次套用 close admission 的實機驗收又揭露 Kernel auditor 條件反向：ready surface 建立 tombstone 後被錯判為「non-teardown」，且原 apply 在 validate error 後留下部分 mutation，導致後續 command 全被污染。已新增 `RuntimeSurfaceLifecycle::Closing`、close commit 明確轉入 Closing，並將 apply 改為 candidate aggregate 驗證成功才 publish；Kernel ready→close regression 與 10,000-step audit 通過。
- 2026-08-09：重建 Dev app 後重跑 ready workspace close→immediate role relaunch：舊 exact tab native destroy 成功，Alpha 使用不同永久 TabId 建立單一真實 WKWebView，terminal log 無 invariant/quarantine/placeholder；M5 ready-stage 通過。
- 2026-08-09：將 tab mute、window zoom、role zoom、role slot rectangles 與 persisted window name 收斂到 Kernel transaction；移除 `saved_window_names`、`RoleSurface.zoom_mode`、`touch_live_window_state` 等 duplicated writer，native fanout failure 以 revision-fenced Kernel compensation 回復。
- 2026-08-09：System Runtime 建立單一 `NativeResourceRegistry` 並新增 Kernel↔native cross-invariant audit；diagnostics 現在可精確回報 orphan/mismatched handle、window generation 與最新 operation trace。
- 2026-08-09：抽出四個 pure native ports 與 full desired projection；fake macOS/Windows 以相同 transcript 驗證 selection/move/close/restore/stale callback 語意。
- 2026-08-09：移除 runtime effect stack 對 `CoreCommand` 的同步回查；App projection 改讀 Kernel snapshot與 immutable game/role/preferences metadata cache，macro input lifecycle 改用 typed AppCore fence/drain/resume API。source hygiene、typecheck、cargo check、38 targeted Vitest、Kernel 15 tests與 Tauri 278 tests通過。
- 2026-08-09：發現 native presentation UI callback 仍同步讀 RuntimeKernel，且 desired projection 與 busy native coordinator 共用 mutex；改為獨立 revision-monotonic full desired projection cache，native lifecycle commit 明確回傳受影響 window 並 refresh。`busy_native_projection_never_blocks_or_rolls_back_a_live_commit` 證明 native UI 忙碌不阻塞 logical commit。
- 2026-08-09：反向盤點發現 `LiveWindowHandle::lock()` 是複製 snapshot 並在 guard drop 時偷偷 `ReplaceWindow` 的 dirty writer；已刪除整個 guard API，production/test call sites 改用 immutable snapshot與顯式 commit，source hygiene、Tauri 281 tests、System Runtime source 18 tests通過。
- 2026-08-09：新增 darwin/win32 overlapping role及 workspace launch完整 effect-stream replay；每組兩個並行 caller皆取得同一永久 TabId、恰一個 `admitted`、另一個 `existing|joined`，且 `EmbeddedCreateTab`恰好一次，補齊 A2/C3。
- 2026-08-09：完整自動 gate 首輪全綠：source hygiene、typecheck、lint（23 existing warnings）、146 files/812 Vitest、Rust fmt/clippy、rion-core 563 + rion-platform 20 + rion-tauri 368 tests、build與 system-only validation皆通過；generated Rust types 230 tests及 `git diff --check`亦通過。
- 2026-08-09：Computer Use 補齊快速雙擊與 workspace overlap admission、ready/loading/macro-running close、once/loop/nested macro、renderer reload保留WebView、多輪restore；fixture counter與running role數均提供可觀測 terminal證據。
- 2026-08-09：Computer Use 發現 custom AppKit tab雖可視但原 accessibility tree未將整個 tab暴露為可操作 control，座標 click/drag回報 `AXError.notImplemented`。Tab item現為單一 radio-button accessibility element，press直接選取，另提供 show-menu及increment/decrement reorder actions；程式回傳既有 `reorder` Runtime intent，不建立第二條權威路徑，focused source regression與native build通過。
- 2026-08-09：實機 SQLite trace反向稽核沒有 duplicate/torn/orphan/nonterminal/lease invariant；數次 Computer Use pointer/tracking操作在AppKit主佇列被佔用時，deadline-bound presentation以 `NATIVE_PRESENTATION_FAILED` terminal failure結束，runtimeHealthy仍為true，沒有將timeout當成成功或留下pending operation。此現象保留為M3實機重排測試的觀察項，待AX action路徑重驗。
- 2026-08-09：最終 timer 反向搜尋找到舊 navigation input fence 在40秒後執行 WebView document readback，可能以 dirty reconciliation推導完成；已移除整條 success-by-readback路徑。page-finished原生事件現在是唯一成功來源，deadline只會 terminal failure並啟動 exact epoch/generation-fenced recovery；Rust clippy、Tauri 367 tests、source architecture regression與完整 813 Vitest通過。
