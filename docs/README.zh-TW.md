# Rion Studio

[English](../README.md) | 繁體中文 | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

![Rion Studio banner showing isolated roles, browser workspaces, and assistive controls](../.github/assets/rion-studio-github-preview-1280x640.jpg)

**跨平台的網頁遊戲登入啟動器與輔助工作區。**

Rion Studio 幫助網頁遊戲玩家在一個桌面 App 中整理每個角色、登入工作階段與瀏覽器版面。你可以建立專用的瀏覽器角色、降低登入摩擦、啟動熟悉的視窗排列，並在主動掌控遊玩時減少重複的手動操作。

## 下載

- [下載 macOS 版](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-mac.dmg)
- [下載 Windows 版](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-win.exe)

這些連結會指向最新 GitHub Release 附加的安裝檔。如果下載時出現 404，請開啟[最新 release](https://github.com/rion-tw/rion-studio/releases/latest)，確認 release 資產已完成上傳。

### macOS 安裝

macOS 版本使用 ad-hoc 簽章，而不是付費 Developer ID。請開啟 DMG、將 Rion Studio 拖到 Applications，然後先嘗試開啟一次。如果 macOS 阻擋開啟，請前往 **System Settings > Privacy & Security**，再對 Rion Studio 點擊 **Open Anyway**。

如果沒有出現 **Open Anyway**，可以在 Terminal 使用這個一次性的備用指令：

```bash
xattr -dr com.apple.quarantine "/Applications/Rion Studio.app"
```

這個備用指令只會移除 Rion Studio 的 quarantine 屬性，不會在系統層級停用 Gatekeeper。

## 為什麼使用 Rion Studio

網頁遊戲經常讓玩家同時處理多個帳號、瀏覽器視窗、登入狀態與重複的例行操作。Rion Studio 將這些分散的流程整理成一個專注的控制台：

- 讓每個遊戲角色維持各自隔離的瀏覽器工作階段。
- 回到已儲存的視窗版面，不必每次重新配置。
- 在需要時透過系統 Chrome 完成敏感的登入流程。
- 在你的監督下執行小型輔助巨集，例如按鍵、點擊、延遲與循環。
- 不把密碼存進 App。Rion Studio 只儲存瀏覽器工作階段資料。

## 功能

### 隔離角色瀏覽器

為每個遊戲帳號、角色或任務建立一個角色。每個角色都有自己的瀏覽器目錄，因此工作階段會保持分離，並可獨立啟動。

### 更順暢的登入流程

有些服務會阻擋在自動化控制瀏覽器中的登入。Rion Studio 可以使用同一個角色目錄開啟系統 Chrome 進行登入，接著在啟動一般內建瀏覽器前驗證已儲存的工作階段。

### 啟動工作區

將角色分組成啟動工作區，並為每個角色指定視窗版面。你可以啟動單一角色，或一次啟動完整的多角色配置，回到已準備好的排列方式。

### 人為監督的巨集

使用按鍵、點擊、延遲與重複間隔建立精簡的輔助巨集。巨集的設計目標是在你仍然在場、監督並操作遊戲時，減少重複的手動輸入。

## 法律與合理使用聲明

Rion Studio 是一般用途的啟動器與輔助桌面工具。你必須為自己的使用方式負責。

- 請一律遵守每個目標遊戲或平台的服務條款、遊戲規則、自動化政策、社群規範與帳號政策。
- 請勿使用 Rion Studio 繞過反作弊系統、規避偵測、利用遊戲漏洞、干擾其他玩家，或執行無人值守的 botting。
- 只有在你仍主動監督並操作工作階段時，才可使用這個工具改善自己的遊戲體驗。
- 第三方工具可能帶來帳號、執法處置與資料風險。這些風險仍由你自行承擔。

## 貢獻

開發者筆記、本機指令、runtime data 細節與 packaging notes 位於
[`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。
