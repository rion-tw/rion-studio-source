# Rion Studio

[English](../README.md) | [繁體中文](README.zh-TW.md) | 简体中文 | [日本語](README.ja.md)

![Rion Studio banner showing isolated roles, browser workspaces, and assistive controls](../.github/assets/rion-studio-github-preview-1280x640.jpg)

**跨平台的网页游戏启动器与辅助工作区。**

Rion Studio 帮助网页游戏玩家在一个桌面 App 中整理每个角色、浏览器工作阶段和窗口布局。你可以创建专用的浏览器角色、直接打开游戏页面、导入 Chrome 工作阶段，并在主动掌控游戏时减少重复的手动操作。

## 下载

- [下载 macOS 版](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-mac.dmg)
- [下载 Windows 版](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-win.exe)

这些链接会指向最新 GitHub Release 附加的安装文件。如果下载时出现 404，请打开[最新 release](https://github.com/rion-tw/rion-studio/releases/latest)，确认 release 资源已完成上传。

### macOS 安装

macOS 内测版使用 ad-hoc 签名，尚未通过 Apple Developer ID notarization。请打开 DMG、将 Rion Studio 拖到 Applications，然后先尝试打开一次。如果 macOS 阻止打开，请前往 **System Settings > Privacy & Security**，再对 Rion Studio 点击 **Open Anyway**。

如果没有出现 **Open Anyway**，且你信任下载来源，可以在 Terminal 使用这个一次性的备用命令：

```bash
xattr -dr com.apple.quarantine "/Applications/Rion Studio.app"
```

这个备用命令只会移除 Rion Studio 的 quarantine 属性，不会替 App 完成 notarization，也不会在系统层级停用 Gatekeeper。

## 为什么使用 Rion Studio

网页游戏经常让玩家同时处理多个账号、浏览器窗口、保存的浏览器工作阶段和重复的例行操作。Rion Studio 将这些分散的流程整理成一个专注的控制台：

- 让每个游戏角色保持各自隔离的浏览器会话。
- 回到已保存的窗口布局，不必每次重新配置。
- 在需要时从 Chrome 导入已有的浏览器工作阶段。
- 在你的监督下执行小型辅助宏，例如按键、点击、延迟和循环。
- 不把密码存进 App。Rion Studio 只保存浏览器会话数据。

## 功能

### 隔离角色浏览器

为每个游戏账号、角色或任务创建一个角色。每个角色都有自己的浏览器目录，因此会话会保持分离，并可独立启动。

### 直接启动游戏

角色与启动工作区始终直接打开设定好的游戏网址。Rion Studio 不保存、判断或显示角色的登录状态，也不提供重新登录流程。

### Chrome 工作阶段导入

Chrome 关闭并同意导入后，Rion Studio 会将选定的浏览器存储复制到角色，并将 Cookie 注入内嵌工作阶段。密码、自动填充、历史、书签和扩展不会导入。外部 Chrome 仅保留作游戏兼容模式。

### 启动工作区

将角色分组成启动工作区，并为每个角色指定窗口布局。你可以启动单个角色，或一次启动完整的多角色配置，回到已准备好的排列方式。

### 中国大陆 CDN 兼容模式

改善 Google 托管资源无法连接时的加载状况。可选的兼容模式能够自动检测受限连接，并在内嵌与外部 Chrome 会话中，将支持的 Google Fonts、Hosted Libraries、reCAPTCHA、Gravatar、Bootstrap 和 jQuery 资源网址替换为更容易连接的替代来源。这是针对特定资源的网址改写功能，不是 VPN 或代理服务。

### 人为监督的宏

使用按键、点击、延迟和重复间隔创建精简的辅助宏。宏的设计目标是在你仍然在场、监督并操作游戏时，减少重复的手动输入。

## 法律与合理使用声明

Rion Studio 是独立的通用启动器及人工监督辅助工具，与任何游戏、身份验证服务或第三方平台均无隶属或背书关系。请遵守目标服务规则，且不得用于无人机器人、反作弊规避、漏洞利用、干扰或违法活动。

- [使用条款](legal/terms.zh-CN.md)
- [隐私声明](legal/privacy.zh-CN.md)
- [公平使用规范](legal/fair-use.zh-CN.md)
- [第三方软件声明](legal/THIRD_PARTY_NOTICES.md)

## 贡献

开发者笔记、本地命令、runtime data 细节和 packaging notes 位于
[`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。
