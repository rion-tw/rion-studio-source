import type { AppLanguage } from "./types";

type Labels = Readonly<{
  hide: string;
  mute: string;
  moveToNewWindow: string;
  moveToWindow: string;
  reload: string;
  stop: string;
  unmute: string;
}>;

export const runtimeTabMenuLabels: Readonly<Record<AppLanguage, Labels>> = Object.freeze({
  en: Object.freeze({
    hide: "Hide tab (keeps running)",
    mute: "Mute Tab",
    moveToNewWindow: "Move to New Game Window",
    moveToWindow: "Move to Game Window",
    reload: "Reload",
    stop: "Stop and Close",
    unmute: "Unmute Tab"
  }),
  ja: Object.freeze({
    hide: "タブを非表示（実行を継続）",
    mute: "タブをミュート",
    moveToNewWindow: "新しいゲームウィンドウへ移動",
    moveToWindow: "ゲームウィンドウへ移動",
    reload: "再読み込み",
    stop: "停止して閉じる",
    unmute: "タブのミュートを解除"
  }),
  "zh-CN": Object.freeze({
    hide: "隐藏标签页（保持运行）",
    mute: "将标签页静音",
    moveToNewWindow: "移至新游戏窗口",
    moveToWindow: "移至游戏窗口",
    reload: "重新加载",
    stop: "停止并关闭",
    unmute: "取消标签页静音"
  }),
  "zh-TW": Object.freeze({
    hide: "隱藏分頁（保持運行）",
    mute: "將分頁靜音",
    moveToNewWindow: "移至新遊戲視窗",
    moveToWindow: "移至遊戲視窗",
    reload: "重新整理",
    stop: "停止並關閉",
    unmute: "取消分頁靜音"
  })
});
