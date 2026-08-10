# Rion Studio Runtime 單一權威全面改造帳本

> 建立日期：2026-08-09
> 狀態：final-audit-complete；等待以獨立最後 commit 移除本帳本
> 執行原則：這是唯一完成清單。所有非帳本任務、macOS 實機驗收、Windows CI 與最終反向盤點完成前不得刪除本檔；真正阻塞時保留本檔並記錄 blocker。

## 基線

- Branch：`main`
- HEAD：`98145ee77d3c36b155ab8a643714ebbca3245be1`
- 起始工作樹：clean
- 既有 launch-admission 變更：已在目前 HEAD，視為不可回退的整合基線。
- 功能凍結：本帳本存在期間，不新增 Runtime／視窗／分頁／角色生命週期功能。
- 完成狀態規則：每項任務使用 `pending / in-progress / done / blocked`，`done` 必須附程式或測試證據。

## 外部 blockers

- [x] BL1 `done` 使用者已於2026-08-09手動解鎖macOS；Computer Use可繼續，未繞過登入鎖。
- [x] BL2 `done` Windows WR9已在validated code `e468b39685016595323dd56a42bf8292ae37890a`完成822 Vitest、956 Rust、Windows all-targets/native/production build、正式WebView2 dormant admission/duplicate/HTML chrome close/immediate relaunch與全idle-zero；report commit `f85e4424309912ff4047eab224fc10bc236df121`已push，local/tracking/remote三方一致，無剩餘blocker。

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
- [x] I6 Native registry 不得存在沒有 live logical owner的 handle。System Runtime diagnostics cross-audit logical surface、exact native instance/window generation/role label並附 trace；最終 Tauri 372 tests與macOS idle-zero diagnostics通過。
- [x] I7 Native effect executor 不得在 effect call stack 內同步回查 Core。證據：native presentation callback 僅讀獨立 revision-monotonic desired projection cache 與 native surface identity；source hygiene 禁止 `request.live`／`LiveWindowHandle` re-entry，最終 Tauri 372 tests通過。

## A. 基線穩定與可觀測性

- [x] A1 `done` 建立帳本並保存 clean baseline；以全 repo `rg`、architecture source tests 與 source-hygiene guard 盤點 Runtime writer、registry、snapshot、effect、native callback、renderer refresh。所有找到的舊 writer/authority 已登錄 R1–R10 並移除或收斂。
- [x] A2 `done` completed/pending admission、cancelled attempt/relaunch、close-before-native lifecycle皆有 regression；新增 darwin/win32 overlapping role/workspace完整 Core effect replay，兩個 admission共用一個 TabId且只有一個 native create。
- [x] A3 `done` RuntimeKernel 使用 512 筆 bounded privacy-safe trace，僅含 operation/revision/window/tab/attempt/generation/phase/event source；`SystemRuntimeDiagnosticsRecord` 已輸出 Kernel revision/count/trace，不含 URL、Cookie、頁面內容或憑證。
- [x] A4 `done` RuntimeKernel `audit()` 檢查 window/tab owner、selection、operation terminality、surface/lease/tombstone/revision；System Runtime diagnostics 再以 `audit_native_resource_invariants` 對 logical snapshot 與 exact native handles/window generations/role labels 做跨層稽核，失敗附 bounded privacy-safe trace。Kernel tests、最終 Tauri 372 tests與macOS idle-zero diagnostics通過。
- [x] A5 `done` source hygiene 禁止 owner probing、implicit dirty writer、額外 logical registry、effect-stack Core re-entry、Tauri barrier 外 Kernel write、平台 adapter 退回 shared include；event-topology scanner要求每個 production timer/watchdog/deadline都有分類或 exception ledger 配對。最終反向搜尋另由 Z5 再執行一次。

## B. 建立唯一 RuntimeKernel

- [x] B1 `done` `crates/rion-core/src/runtime_kernel/{types,state,tests}.rs` 為無 Tauri/AppKit/Win32 依賴的純狀態機；`cargo test -p rion-core runtime_kernel --lib` 通過。
- [x] B2 `done` `RuntimeKernel` 以專用 `rion-runtime-kernel` actor thread + mpsc mailbox 序列化 apply/snapshot/audit，AppCore 僅持有該 handle。
- [x] B3 `done` Kernel aggregate 已持有 window generation、tab topology/order/selection、placement/display/persisted name、window zoom、tab audio、role zoom/slots、browser role lease、logical surface lifecycle、operation phase、tombstone 與全域 revision；各 mutation 有 expected-revision fence。
- [x] B4 `done` Kernel 與 LiveWindow facade 已統一 `apply -> RuntimeCommit` 並由 actor 原子 snapshot；每次 apply 只在完整 candidate aggregate 通過 invariants 後發布。已移除 `LiveWindowGuard` drop-time implicit `ReplaceWindow` writer，所有 reader 只取得 immutable snapshot，修改必須顯式提交 intent。
- [x] B5 `done` 名稱、display/placement、active tab、跨視窗 move、generation、tab mute、window zoom、role zoom 與 role slot layout 全經 Kernel transaction；native fanout 失敗以反向 Kernel commit compensation，不再 `touch_live_window_state` 或改寫 duplicated logical fields。
- [x] B6 `done` `LiveWindowTabStore` 僅為 Kernel compatibility facade；舊 mutable/dirty guard writer 已全部移除，source hygiene 禁止 `LiveWindowGuard` 或 `LiveWindowHandle::lock` 回歸，最終 Tauri 372 tests通過。
- [x] B7 `done` monotonic revision、bounded operation idempotency、duplicate/supersede/cancel皆由 Kernel處理；close/relaunch terminalize舊 operation，`FailEventStream` 將 exact pending operations標成 `Indeterminate` 並保留唯一 terminal outcome；executor Drop 對剩餘 native event stream執行 `NATIVE_EVENT_STREAM_STOPPED` terminalization。17 Kernel tests通過。

## C. 重建 launch、close、restore

- [x] C1 `done` role/workspace/restore 從 admission 傳入永久 UUID `launch_tab_id`，Core effect 與 native create 全程沿用。2026-08-10反向實機稽核發現獨立dormant hydration path仍在相容欄位產生`provisional-<uuid>`；現已讓live/dormant共同使用`allocate_launch_preview_handle`，相容欄位名稱保留但值從配置起就是Core-compatible permanent UUID。focused Rust/source tests與macOS真實dormant launch通過。
- [x] C2 `done` retry 沿用 TabId 並以 attempt generation fencing；alias、replace-tab-id、AppKit replace C ABI 與 completion owner probing 已移除。
- [x] C3 `done` `BrowserRuntimeState::CreateTab` 將 source查找與建立合為單一 transaction；2-thread Kernel admission及 darwin/win32 overlapping role/workspace完整 Core effect replay均證明兩個 caller共用一個 TabId且只有 creator送 native create。Computer Use 重複 role launch維持一個 logical/native surface；restore以同一 exact-ID admission進入。
- [x] C4 `done` Runtime admission/close plan 為 immutable identity plan，Core先提交 pending/close desired state再送 effect；全 repo `launch_plans`為零，effect-stack source hygiene禁止同步 `.core.invoke(`，native lifecycle只經 typed kernel facade回傳。
- [x] C5 `done` Tauri executor 已將 `attached/ready/failed/closed` 以 operation/tab/attempt/window generation/surface generation envelope 實際送回 Kernel；tombstone/attempt tests 證明過期事件為 Duplicate 且不能復活 surface。2026-08-09 實機 SQLite trace 重播 `surface.registered → tab.surface-attached → launch phases → ready/settled` 與 close/release，永久 TabId 與 window generation 全程一致；loading close 後立即 relaunch 的新 surface 計數歸零且舊 callback 未復活。
- [x] C6 `done` `preview_tab_close` 先以 `RuntimeIntent::CloseTab` 原子移除 membership、建立 tombstone/teardown desired effect，native teardown 完成後只 terminalize同一Kernel operation；late events由tombstone tests拒絕。2026-08-10實機又證明logical close成功後舊程式漏送native tab-chrome removal，現於commit後、successor presentation/surface isolation前投影既有`try_remove_native_tab_reservation`；AppKit ghost tab regression已由source order test與Computer Use關閉重播證明移除。
- [x] C7 `done` preview launch、無 preview completion fallback 與 restore 都先提交完整 desired topology／永久 TabId，再建立 native host；native host失敗保留可重試desired state。2026-08-10把先前漏盤的dormant append-source orchestration改為同一permanent UUID allocator；`dormant_hydration_first_commit_contains_saved_tabs_and_appended_launch`與真實`first-eligible-dormant-window`重播皆通過。
- [x] C8 `done` window close由 `BrowserWindowCloseAdmit`先取得 exact lease並以單一 Kernel revision移除 desired tabs/owners；native teardown消費 immutable identity-keyed `closing_tabs`至唯一 terminal。Window persistence lane以 `(window_generation, revision)` latest-wins coalesce/retry，Core batch在單一 SQLite transaction逐 window拒絕 stale/duplicate revision；revision/batch atomic tests通過。
- [x] C9 `done` 全 repo runtime source 已移除 `launch_plans`、`role_tabs`、`native_tab_hosts`、`optimistic_closed_tabs`；需要的 native 查詢由 handle registry 即時計算，不再有額外 logical owner map。

## D. 原生 executor 與跨平台隔離

- [x] D1 `done` authority-sensitive boundary已抽為真正 Rust modules：pure Core `runtime_kernel`/ports、Tauri `kernel_facade`、`native_executor`、`native_resource_registry`、`native_projection`，以及 compile-time `platform::{macos,windows,unsupported}`。模組化並抓出/修正原本誤藏在 Windows lifecycle 的共用 `RuntimeError` impl；hygiene禁止退回 shared include。
- [x] D2 `done` `RuntimeState.native_resources: NativeResourceRegistry`僅集中不可序列化 display host/surface/tab handles；已移除 `Deref/DerefMut`相容層，所有存取顯式經 `native_resources`，lookup名稱標明 `native_*_handle/surface`，membership/role/relaunch只讀 Kernel desired projection。cross-audit、最終 Tauri 372 tests與macOS idle-zero diagnostics通過。
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
- [x] F3 `done` fixture 固定包含1 game、6 roles、3 workspace layouts、3個多tab windows、once/loop/nested macros；新增Epsilon/Zeta與不屬於任何saved window的`[Runtime QA] Dormant Admission`，永久覆蓋append-source dormant hydration。
- [x] F4 `done` fixture 全部 launch URL 為 `http://127.0.0.1:41739`；macro 僅有安全 key/click/delay/nested call。
- [x] F5 `done` fixture 使用固定 UUID；Core test 對 imported snapshot 再次 preview，所有 collection 均為 unchanged，證明重跑不增殖。
- [x] F6 `done` 2026-08-09透過正式UI匯入原fixture；2026-08-10再以正式UI匯入delta，preview為2 new roles/1 new workspace、警告0，結果`新增3／覆蓋0／不變7／略過0`。dashboard永久保留Epsilon、Zeta、Dormant Admission；為避免覆寫既有本機QA window位置，delta匯入時未選game windows/macros。

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
- [x] V6 `done` Kernel deterministic state machine 10,000步逐步 audit且每步/final pending operation=0；browser mutation coordinator 10,000次 normal/recoverable/destructive complete/abort後 tickets、queues、blocked role leases全空；macOS/Windows native operation各5,000次 register/in-flight/terminal後 active registry=0；macro runtime 1,000次 start/stop後role owners與pending actions歸零。精準 leak regressions均通過。
- [x] V7 `done` 所有macOS實機修正完成後重跑最終完整gate：source hygiene 1066 files、typecheck、lint（0 errors／23既有react-refresh warnings）、Vitest 146 files／814 tests、Rust fmt/clippy、Core 565／Platform 20／Tauri 372 tests、renderer+native build、Tauri-only boundary、dependency hygiene及`git diff --check`全部通過。首次沙盒內Rust run僅有4個Unix-socket activation tests遭OS permission拒絕；在允許local socket的相同主機重跑完整workspace後全部通過。

## macOS Computer Use 實機驗收

- [x] M1 2026-08-09 Computer Use 正式匯入後 dashboard 顯示 4 個 `[Runtime QA]` 角色、2 workspace、3 macro，側欄 totals 證明 3 game windows 亦已合併；匯入成功訊息為新增 13／警告 0。
- [x] M2 `done` 2026-08-09 Computer Use 對 `[Runtime QA] Alpha` 快速雙擊只聚焦同一個 `[Runtime QA] Window One`，fixture 仍只有一個 WebView；緊接著雙擊包含 Alpha/Beta 的 `[Runtime QA] Two Columns` 也只聚焦同一 window/tab aggregate，沒有第二個 logical/native surface。
- [x] M3 `done` AppKit `ctrl+Tab`、AX radio-button press及active WebView/focus一致；Beta的AX `Decrement/Increment`實際完成前移再還原。將Two Columns從live Window One移到live Race後，source最後一tab關閉、target成為3 tabs且active/focus正確；對無live host的move被明確拒絕且沒有duplicate surface。launch/close交錯另由M5覆蓋。
- [x] M4 `done` rename把`遊戲視窗 2`改為`[Runtime QA] Race Window`並在native title/restore一致；mute後AX顯示`Tab muted`且menu轉為Unmute，再成功解除；maximize/restore、View Zoom In的`Window 105%`及Actual Size的`Window 100%`均實機確認；hide/show保留同一WKWebView/fixture count，stop走M5 exact release。測試機只有一個monitor，跨display實體移動不適用並已記錄限制。
- [x] M5 `done` Computer Use 分別驗證 ready、loading、macro-running close：ready close 修正後立即 relaunch 使用新永久 TabId；loop running close 經確認後 role 6→4 且 macro terminal；loading Beta close 後 role 4→2；再次立即 relaunch 得到新 `遊戲視窗 2`，fixture counters 全為 0，舊 surface/callback 未復活。
- [x] M6 `done` 先由sample定位舊正式Quit在AppKit `applicationWillTerminate`同步`close_all()`造成主執行緒與WKWebView teardown互等；移除irreversible Exit中的native teardown並加入single-flight shutdown coordinator。再發現macOS原生`.quit()`可繞過renderer admission，改為自訂Cmd+Q/menu event共用同一確認與coordinator。最新版正式Quit後PID消失、instance lock釋放、SQLite `cleanExit:true`，`application.shutdown-outcome`為`applied/shutdownClosed/nativeAcknowledgement`；重開未顯示異常關閉並自動還原Race的名稱、3-tab order與active Beta。
- [x] M7 `done` Once 對 Alpha 精確造成 click +1/keydown +1；Loop 對 Beta 造成 click 累積至 72，停止後 1.5 秒仍為 72；Nested 執行期間顯示 parent+child 兩個 running，terminal 歸零且 Alpha 精確 click +1/keydown +2；macro-running window close 亦完成 cleanup。
- [x] M8 `done` Beta fixture 先保留 click=1，再對主 renderer 執行 reload；AppSnapshot projection 恢復後重新聚焦既有 Beta WKWebView，click 仍為 1，證明 renderer reload 未重建原生 WebView。
- [x] M9 `done` 多輪launch/close/relaunch/restore與AppKit move完成。第一次正式Diagnostics揭露native handles歸零但Kernel仍有3 logical surfaces/3 pending closes及4 input fences；根因是window-close destroy path退休Tauri tombstone卻未送Kernel `closed`，且成功native effect未terminalize Core macro stopping、native input lane亦未neutralize。三層均改為exact native/effect terminal event並補regression。最終隱私安全snapshot：`healthy=true`、`snapshotComplete=true`、`collectionErrorCodes=[]`、native invariant=true/failures=0，Kernel pending/logical=0，managed/closing/quarantine/pending-close/native-creation/lifecycle/navigation/input/recovery/tab/role皆=0，recent nonterminal=[]。含本機logs的ZIP移至`/private/tmp`，repo只留數值證據。
- [x] M10 `done` 2026-08-10 Computer Use從首頁以4個dormant saved windows重播新`[Runtime QA] Dormant Admission`及使用者原`坦法雙開`。兩者均記錄`first-eligible-dormant-window`，使用普通永久UUID、terminal success且WebView ready，`RUNTIME_TAB_ID_INVALID`/error/runtime crash為0。QA workspace close前實機發現AppKit ghost tab；補上commit後native chrome removal後重播，AX由3 tabs確實降為2、SQLite一致，projection submission成功且沒有`tab.chrome-removal-submit-failed`。立即relaunch取得新TabId，duplicate launch terminal為`existing-live-source`且無新surface；原`坦法雙開`兩個真實WKWebView ready後以正式close移除。最終正式Diagnostics ZIP解析：`healthy=true`、`snapshotComplete=true`、`collectionErrorCodes=[]`、invariant=true/failures=0，display/tab/role/managed/retired/closing/quarantine/pending-close/input/native-creation/lifecycle/navigation/Kernel logical/pending/tombstone全部0。ZIP移至`/tmp/rion-runtime-authority-diagnostics.UFwrtx/`，repo未保留。

Computer Use 規則：每次操作後重新讀取 accessibility/App state，不沿用舊 element index；必要時以 screenshot 驗證。只操作本機 Rion Studio 與 localhost fixture，不傳輸敏感資料。

## Windows 門檻

- [x] W1 `done` Windows原生WR9在`e468b396`完成source/system/dependency hygiene、typecheck、lint、146 files/822 Vitest、Core 568/Platform 18/Tauri 370（956 Rust）、all-targets check、native build與production build；首次production relink只因已無UI的精確QA process持有exe，確認並停止該process後原命令不變重跑通過。
- [x] W2 `done` Windows 11 ARM64 + WebView2 `151.0.4129.72`實際觸及shared native removal與HTML tab strip `remove/applied` acknowledgement；strict Core UUID validation、Windows cfg reachability與無`allow(dead_code)`反向audit通過。
- [x] W3 `done` WR9正式UI重複匯入不增殖；`first-eligible-dormant-window`以永久TabId啟動Epsilon/Zeta兩個WebView2，duplicate以`existing-live-source`終結；HTML tab close完整移除chrome/SQLite/logical/surfaces，立即relaunch取得新TabId且舊callback命中0。最終Diagnostics所有required count為0、invariant=true/failures=0、`collectionErrorCodes=[]`。
- [x] W4 `done` `.agents/windows-runtime-authority-validation-report.md`已新增完整WR9 transcript，validated code為`e468b39685016595323dd56a42bf8292ae37890a`，report/final SHA為`f85e4424309912ff4047eab224fc10bc236df121`；local/tracking/remote三方一致且無blocker。

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
| Source hygiene | done | `pnpm run check:source-hygiene`：1066 tracked files 通過（2026-08-09最終重跑） |
| Typecheck | done | `pnpm run typecheck` 2026-08-09 通過 |
| ESLint | done | `pnpm run lint` 通過；僅保留 23 個既有 react-refresh warnings |
| Vitest | done | 最終完整 146 files／814 tests 通過 |
| Rust fmt/clippy | done | `pnpm run lint:rust` 通過 |
| Rust tests | done | `pnpm run test:rust`最終完整workspace：rion-core 565、rion-platform 20、rion-tauri 372，全部通過 |
| Build | done | `pnpm run build`最終重跑通過（typecheck、Vite renderer、`cargo build -p rion-tauri`） |
| System-only validation | done | `pnpm run verify:system-only`通過；`pnpm run check:hygiene`亦以exit 0通過 |
| macOS Computer Use | done | M1–M9全部完成；正式Quit/restore與Diagnostics idle zero均有實機證據；單monitor限制已記錄 |
| Windows CI | done | WR9在`e468b396`完成822 Vitest、956 Rust、all-targets/native/production build、正式WebView2 dormant/duplicate/HTML close/relaunch與idle-zero diagnostics；報告已push為`f85e4424` |
| Final-audit delta local gates | done | source hygiene 1068、typecheck、lint 0 errors/23既有warnings、Vitest 146/822、Rust fmt/clippy、Core 565/Platform 20/Tauri 372、all-targets check、build、system-only與dependency hygiene全綠；Windows cross-target在進入project code前因macOS主機缺Windows C SDK header停止，不作Windows通過證據 |
| Final-ledger audit local gates | done | tombstone normal/indeterminate focused 2/2；source hygiene 1068、typecheck、lint 0 errors/23既有warnings、Vitest 146/822、Rust fmt/clippy、Core 567/Platform 20/Tauri 372、macOS all-targets check、build、system-only與dependency hygiene全部通過；generated diff與`git diff --check`為空 |
| Dormant admission/tab-chrome delta local gates | done | 2026-08-10 source hygiene 1068、typecheck、lint 0 errors/23既有warnings、Vitest 146/822、Rust fmt/clippy、Core 567/Platform 20/Tauri 373（total 960）、build、system-only、dependency hygiene、generated clean與`git diff --check`全部通過。Computer Use另完成QA與原`坦法雙開`真實dormant launch、close/relaunch/duplicate及idle-zero diagnostics。 |

## 最終完成與刪除門檻

- [x] Z1 `done` 最終source hygiene與writer反向搜尋證明logical runtime mutation只經typed Kernel facade／RuntimeIntent；LiveWindow只剩immutable snapshot與Kernel commit facade。
- [x] Z2 `done` legacy token反搜只有否定式regression與hygiene規則命中；production無alias、owner probing、舊authority map、implicit dirty writer或System Runtime effect-stack `core.invoke`。
- [x] Z3 `done` Kernel model/stress、Tauri lifecycle regressions、revision store tests與macOS idle diagnostics共同證明operation terminal、projection monotonic及native owner可追溯；所有required idle count為0且native invariant為true。
- [x] Z4 `done` macOS完整自動測試、Computer Use與idle-zero Diagnostics全綠；Windows WR9已把原生pass延伸到本次validated code exact SHA `e468b396`，report/final SHA `f85e4424`三方一致。
- [x] Z5 `done` 2026-08-09最終全repo反搜：舊authority關鍵字僅存在於禁止回歸測試／hygiene規則；pure RuntimeKernel無平台cfg；crates/Tauri無`allow(dead_code)`；generated無diff；repo無diagnostic ZIP。所有production timer/deadline通過event-topology分類；`reconcile`命中逐筆屬event-triggered projection/display/install-journal套用，不從timer、readback或dirty scan建立logical truth。
- [x] Z6 `done` 2026-08-10獨立final audit核對Windows report與SHA；重跑source hygiene 1068、System Runtime focused Vitest 18、Rust fmt、generated clean與`git diff --check`。production反搜無provisional prefix、舊authority maps/owner probing/dirty guard/effect-stack Core re-entry、`allow(dead_code)`或RuntimeKernel平台cfg，repo無diagnostic ZIP/dump/trace。
- [ ] Z7 `in-progress` 所有非帳本任務與Z6均完成；下一個獨立commit只刪除本帳本。永久fixture、已匯入本機QA測資、Windows checklist/report全部保留。

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
- 2026-08-09：V6 補上直接 leak 證據：BrowserOperationCoordinator 10,000次 lease cycle後 tickets/queues/blocked roles全空；NativeOperationRegistry在fake macOS與fake Windows各5,000次 lifecycle後 active count=0。搭配Kernel 10,000步 pending=0與macro 1,000次歸零，四層壓力測試均有明確 final assertion。
- 2026-08-09：Computer Use以AX action完成AppKit tab前移/還原、跨live window move、mute/unmute、maximize/restore及100%/105% zoom；無live native host的move明確失敗且未建立duplicate surface。測試機僅一個display，跨DPI實體驗證保留給Windows清單。
- 2026-08-09：正式Quit殘留PID的sample證明AppKit `applicationWillTerminate`在主執行緒同步`runtime.close_all()`，而WKWebView teardown worker等待主執行緒，形成循環等待。`RunEvent::Exit`不再啟動native teardown；single-flight coordinator在可阻塞worker完成exact native shutdown、clean marker與trace後才`app.exit`。
- 2026-08-09：macOS原生`.quit()`仍可直接走AppKit `terminate:`而繞過renderer確認/admission，導致程序雖退出但`cleanExit:false`。改用自訂`rion-application-quit` menu item/Cmd+Q，首次發出同一quit-request事件、確認後直接進coordinator；實機證明PID/lock釋放、`cleanExit:true`及`application.shutdown-outcome=applied`，重開無異常提示且restore正確。
- 2026-08-09：最終Diagnostics不是只做驗收，而是反向找到三個terminalization缺口：`destroy_tab_event_bound`退休Tauri close preview卻未送Kernel closed；成功Core stop未呼叫既有MacroReleaseRole且release本身未清stopping/quiesced；exact native release後input lane仍disabled。修正後保留單調epoch、移除exact owner fence，Core 565 tests及Tauri focused regressions通過，實機idle snapshot全部required count為0且`collectionErrorCodes=[]`。
- 2026-08-09：同步更新`.agents/context/{architecture,system-runtime}.md`，移除已過時的LiveWindowTabStore唯一權威敘述，改為RuntimeKernel actor/commit、handle-only NativeResourceRegistry與revisioned follower架構。
- 2026-08-09：final review發現update-install同步drain若失敗，新的shutdown coordinator會停在started且沒有worker，攔住caller的fail-closed restart。`prepare_application_update_exit`現在對success/failed/indeterminate terminal drain都先shutdown Core並mark ready，再原樣回傳clean-marker/drain錯誤；focused contract/Rust test及第二輪完整gate全部通過。
- 2026-08-09：最新版idle狀態再以Computer Use走自訂application menu正式Quit；Finder fresh state證明UI已離開，instance lock無owner，SQLite `cleanExit=1`，最新privacy-safe trace為`applied/shutdownClosed/nativeAcknowledgement`。
- 2026-08-10：Windows原生驗收report以`a055e170`記錄WUI-1–WUI-7、20/20壓力、5/5正式Quit/relaunch、Vitest 822、Rust 953與required idle-zero全部pass；獨立檢查commit range時發現WebView2 `AcceleratorKeyPressed`的application shortcut雖已defer，Ctrl+Tab fallback仍透過helper在callback stack內同步讀Core／提交selection。已將整條tab shortcut派送移到`run_on_main_thread`之後，source regression同時檢查callback與defer helper邊界。
- 2026-08-10：final-audit本機Rust lint再抓出Windows新增的tab-chrome bootstrap failure cleanup call未受`#[cfg(windows)]`保護，使`a055e170`在macOS無法編譯；已對failure detection與retirement call加入明確cfg並補source regression。修正後本機完整gates全綠；Windows pass仍只屬祖先SHA，依WR7完成final exact SHA增量複驗前不刪帳本。
- 2026-08-10：Windows WR7在`87a3c8bb`完成954 Rust、20/20實體shortcut與含`tombstone=0`的idle audit，並從真實`RemoveWindow -> Closed`順序補上雙順序cleanup。主工作逐行稽核後發現cleanup predicate使用`phase.is_terminal()`，會連`Indeterminate/Cancelled`未知結果也移除close fence；這不會在正常closed實機路徑顯現。已改為僅在logical surface已消失且operation為`Completed|Failed`時清除；regression逐一直接terminalize為`Indeterminate/Cancelled/Failed`及走`FailEventStream`，四者只要Closing surface仍存在都必須保留tombstone，且晚到ready為duplicate。正常兩種closed順序與未知結果focused tests共2項通過；WR8 final exact SHA複驗前帳本保留。
- 2026-08-10：使用者既有`坦法雙開`在dormant window重播時回傳`RUNTIME_TAB_ID_INVALID`。Git blame與資料庫反搜證明不是舊SQLite資料：所有目前／歷史backup皆無`provisional-*`持久值；真正根因是2026-08-08加入的`section_12_window_restore_contract.rs`每次動態產生`provisional-<uuid>`，先commit desired/native preview後才把它當`launch_tab_id`送進新Core嚴格UUID契約。2026-08-09 single-authority migration只修到normal live preview，漏掉獨立dormant hydration orchestration。決策是不清空角色／工作區／視窗／巨集，也不放寬Core；改為live/dormant共用permanent UUID allocator並加入fixture保證覆蓋該path。
- 2026-08-10：修正admission後的Computer Use close揭露第二個既有投影缺口：Kernel membership、SQLite、surface registry與tombstone皆正確terminal，但AppKit tab chrome仍顯示ghost tab。根因是`preview_tab_close_with_presentation`在logical commit後只dispatch successor內容與surface isolation，未送已存在的native reservation removal。現於commit後投影同一remove effect，失敗只記錄並保持forward-only close，不回滾Kernel或建立timer/probing；AppKit/SQLite/Diagnostics重播全一致。
- 2026-08-10：Windows WR9在`e468b396`以真實Windows 11 ARM64/WebView2完成dormant admission、duplicate、HTML chrome close、immediate relaunch、完整822 Vitest/956 Rust/native+production build與idle-zero Diagnostics；報告commit `f85e4424`已push且三方SHA一致。macOS主工作核對report後重跑source hygiene/focused contract/fmt並完成全repo legacy/registry/timer/cfg/artifact反向audit，無剩餘blocker；ledger已進入獨立最後刪除步驟。
