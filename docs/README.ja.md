# Rion Studio

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | 日本語

![Rion Studio banner showing isolated roles, browser workspaces, and assistive controls](../.github/assets/rion-studio-github-preview-1280x640.jpg)

**Web ゲーム向けのクロスプラットフォームなログインランチャー兼補助ワークスペースです。**

Rion Studio は、Web ゲームのプレイヤーが各ロール、ログインセッション、ブラウザレイアウトを 1 つのデスクトップ App で整理できるようにします。専用のブラウザロールを作成し、ログインの手間を減らし、使い慣れたウィンドウ配置を起動し、プレイを自分で管理しながら反復的な手作業を減らせます。

## ダウンロード

- [macOS 版をダウンロード](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-mac.dmg)
- [Windows 版をダウンロード](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-win.exe)

これらのリンクは、最新の GitHub Release に添付されたインストーラーを指します。ダウンロードが 404 になる場合は、[latest release](https://github.com/rion-tw/rion-studio/releases/latest) を開き、release アセットのアップロードが完了していることを確認してください。

### macOS へのインストール

macOS ビルドは、有料の Developer ID ではなく ad-hoc 署名を使用しています。DMG を開き、Rion Studio を Applications にドラッグしてから、一度起動してみてください。macOS によってブロックされた場合は、**System Settings > Privacy & Security** を開き、Rion Studio の **Open Anyway** をクリックしてください。

**Open Anyway** が表示されない場合は、Terminal で次の一度限りの代替コマンドを使用できます。

```bash
xattr -dr com.apple.quarantine "/Applications/Rion Studio.app"
```

この代替コマンドは Rion Studio から quarantine 属性だけを削除します。Gatekeeper をシステム全体で無効化するものではありません。

## Rion Studio を使う理由

Web ゲームでは、複数のアカウント、ブラウザウィンドウ、ログイン状態、反復的な操作を同時に扱うことがよくあります。Rion Studio は、その散らばったワークフローを集中して扱えるコントロールデスクに変えます。

- 各ゲームロールを、それぞれ隔離されたブラウザセッションに保ちます。
- 毎回セットアップし直す代わりに、保存済みのウィンドウレイアウトへ戻れます。
- 必要に応じて、システム Chrome で慎重なサインインフローを完了できます。
- キー入力、クリック、待機、ループなどの小さな補助マクロを、あなたの監督下で実行できます。
- パスワードは App に保存しません。Rion Studio が保存するのはブラウザセッションデータだけです。

## 機能

### 隔離されたロールブラウザ

ゲームアカウント、キャラクター、タスクごとにロールを作成できます。各ロールは専用のブラウザディレクトリを持つため、セッションは分離されたまま個別に起動できます。

### よりスムーズなログインフロー

一部のサービスは、自動化制御されたブラウザ内でのサインインをブロックします。Rion Studio は同じロールディレクトリをシステム Chrome で開いてログインし、その後、通常の内蔵ブラウザを起動する前に保存済みセッションを検証できます。

### 起動ワークスペース

ロールを起動ワークスペースにまとめ、それぞれにウィンドウレイアウトを割り当てられます。単一ロールを起動することも、準備済みの配置で複数ロール構成をまとめて起動することもできます。

### 人が監督するマクロ

キー入力、クリック、待機、繰り返し間隔からコンパクトな補助マクロを作成できます。マクロは、あなたがその場にいて監督し、ゲームを操作し続ける状態で、反復的な手入力を減らすために設計されています。

## 法的事項とフェアユースに関する注意

Rion Studio は汎用のランチャー兼補助デスクトップユーティリティです。使用方法については利用者自身が責任を負います。

- 対象となるすべてのゲームやプラットフォームの利用規約、ゲームルール、自動化ポリシー、コミュニティガイドライン、アカウントポリシーを必ず守ってください。
- Rion Studio を、アンチチートシステムの回避、検出の回避、ゲームの悪用、他のプレイヤーへの妨害、無人 botting の実行に使用しないでください。
- このツールは、あなたがセッションを能動的に監督し操作している状態で、自分のゲーム体験を改善する目的にのみ使用してください。
- サードパーティツールには、アカウント、取り締まり、データに関するリスクが伴う場合があります。それらのリスクは利用者自身の責任です。

## コントリビューション

開発者向けノート、ローカルコマンド、runtime data の詳細、packaging notes は
[`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md) にあります。
