# Rion Studio Design System

Rion Studio 採用 compact glass 桌面介面。所有產品自有介面共用
[`src/shared/designTokens.css`](../src/shared/designTokens.css)；React renderer、啟動畫面、
Windows runtime tab strip 與注入遊戲頁面的 Shadow DOM overlays 不得各自維護另一份色盤或尺寸。

## 視覺原則

- 主操作（CTA）使用中性黑／白 `primary`，避免把所有操作都表現成品牌色。
- `activity` 藍色只表達選取、focus、開關、drop target、執行中與即時狀態。
- `success`、`warning`、`destructive` 只分別表達成功結果、警告、錯誤／破壞性操作。
- 未啟用、未執行與次要資訊使用 `muted`，不得以綠色表達「正在執行」。
- 預設控制項與 floating hit target 都是 30px；圖示按鈕的標準圖示是 14px。
- 所有數字使用 lining/tabular figures，確保計數、時間與診斷資料不跳動。

## Token 分類

### Typography

| 語意 | Token | 尺寸／行高 | 用途 |
| --- | --- | --- | --- |
| Page title | `--type-page-title-*` | 30/36 | route 主標題 |
| Title | `--type-title-*` | 17/24 | dialog、主要卡片標題 |
| Heading | `--type-heading-*` | 15/20 | section、次級標題 |
| Body | `--type-body-*` | 13/20 | 一般內容 |
| Control | `--type-control-*` | 12/16 | 導覽、按鈕、欄位、選單、設定列、表格控制 |
| Caption | `--type-caption-*` | 11/16 | 輔助資訊、badge |
| Micro | `--type-micro-*` | 10/12 | 空間受限的 metadata |

React 優先使用 `text-page-title`、`text-title`、`text-heading`、`text-body`、
`text-control`、`text-caption`、`text-micro`。既有 `text-xs` 至 `text-2xl` 已映射到同一
type ramp，新增程式碼仍應選擇語意名稱。這些語意名稱也必須註冊在 renderer 的
`tailwind-merge` theme 中；否則與 `text-foreground` 等顏色 class 合併時會被誤刪並回退到
瀏覽器預設 16px。

compact shell 的導覽標籤與 30px 高的 Button、Input、Select、menu、segmented control 固定
使用 `control` 12px；badge 與輔助資訊使用 `caption` 11px，空間受限的計數使用 `micro`
10px。頁面內容不得以縮小 body 文字的方式補償版面問題。

### Spacing、control 與 radius

- 間距只取 `2/4/6/8/10/12/16/20/24/32/40/56px`；segmented control 的必要 inset
  使用 component token `--segmented-inset: 3px`。
- 控制尺寸使用 `--control-height`、`--control-hit-size`、`--control-min-size` 與
  `--icon-button-icon-size`。
- 圓角使用 `--radius-xs/sm/md/lg/pill`（4/6/8/12px/pill）。Tailwind 的 `rounded-*`
  utilities 會讀取相同 variables。

### Color

基礎語意包含 canvas/background、sidebar、card/surface、popover、muted、control、text、
border、ring、scrim 與 on-media。狀態色使用 `activity`、`success`、`warning`、
`destructive`，文字應搭配對應 foreground token。不可在 component 中直接使用 Tailwind
色盤（例如 `blue-500`）或 raw hex/rgb/hsl 色值。

Light/dark palette 都定義在共享 token stylesheet。`system` 是 preference，不是 resolved
palette；renderer 解析後只將 `light | dark` 傳給 runtime。

### Elevation 與材質

一般內容、選取、toast、modal、popover、tooltip 依序使用 `--layer-*`。browser overlays
使用獨立的最高層級 token。不要新增數字型 `z-index`。

玻璃表面使用 `.glass-panel`、`.glass-panel-strong`、`.glass-modal`、`.glass-popover`、
`.glass-control`、`.glass-inset`，其 border、shadow、blur 與 reduced-transparency fallback
由 tokens 和 `styles.css` 統一提供。

## 共用元件

- `Surface`：panel、strong、modal、popover、control、inset 材質。
- `Button`：default（中性 CTA）、outline、secondary、ghost、subtle、destructive；角色封面上的
  `media` variant 使用固定的 on-media liquid glass，確保明暗圖片上都有可見邊界與高光。
- `Badge`：default、secondary、outline、activity、success、warning、destructive。
- `Field` / `FieldHeader`、`Input`、`Textarea`、`Select`、`Checkbox`、`Switch`、`Slider`：
  共用 30px rhythm、focus 與 disabled 狀態。
- `SegmentedControl`、`NavItem`：選取狀態使用 `activity`。
- `DialogLayer`：React portal/dialog 以外的 modal shell 與 backdrop。
- `StatusCallout`：muted、activity、success、warning、destructive 訊息。
- `SettingsSection` / `SettingsRow`：設定頁的 section、divider、標題、說明與 control 對齊。
- `PageFrame` / `PageHeader`、`EmptyState`、`IconTile`：route、空／錯誤／loading 狀態的基礎節奏。

新增 feature 應先組合上述元件，只有跨畫面確實無法表達的狀態才增加 variant。

## Theme 與 runtime

- Renderer 保留 `light | dark | system` preference 與既有 localStorage／portable 行為。
- `ResolvedTheme = "light" | "dark"` 是 shared contract。renderer 每次 resolved theme 改變時
  呼叫 `setRuntimeTheme`；runtime 僅保存在記憶體。
- Windows runtime tab document 從 projection 更新 `data-theme` 與 `color-scheme`，因此已開啟
  視窗也會立即切換。
- macOS native tab controller 不接收 theme，外觀與 API 保持原狀。
- Shadow DOM overlays 注入同一份 token 命名，但由 `:host` 固定使用高對比 dark palette，
  不繼承遊戲頁面的字體、root font size 或背景。

## 允許例外

- Role cover 的 dominant color 是使用者／圖片導出的動態資料，可透過
  `--role-cover-accent` 傳入；fallback 與遮罩仍必須用 token。
- Cover/canvas 圖片產生流程可使用影像像素色值；它不是 component 色盤。
- 圖片遮罩、normalized workspace rect、pointer 座標、可視 viewport 與 media aspect ratio
  屬於版面／媒體幾何，可使用動態 inline style 或計算值。
- `rounded-[inherit]` 可用於 selection overlay 繼承宿主形狀；不得以 arbitrary radius 建立新規格。

## 新增 token 流程

1. 先確認現有 semantic token 或 component variant 無法表達需求。
2. 在 `src/shared/designTokens.css` 以用途命名；不得以單一頁面或實際色名命名。
3. 同時定義 light/dark；overlay 若需要，確認 `:host` dark palette 的對比。
4. 在 `styles.css` 的 `@theme` 只做 Tailwind 映射，不複製 raw value。
5. 更新相關 component、本文與 focused tests；執行 token governance、light/dark、reduced motion／
   transparency 與 960×640 驗收。
