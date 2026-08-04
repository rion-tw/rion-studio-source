import { invoke } from "@tauri-apps/api/core";

type RoleSlotIdentity = {
  blocked: boolean;
  ownerGeneration?: number;
  ownerTabName?: string;
  roleId: string;
  roleName: string;
  slotId: string;
  tabId: string;
};

declare global {
  var __rionRoleSlotIdentity: RoleSlotIdentity | undefined;
}

const translations = {
  en: { blocked: "This role is open in “{tab}”.", unknownTab: "another tab", available: "This role is currently stopped.", claim: "Stop there and open here", open: "Open here", busy: "Opening…", failed: "Could not open the role. Try again." },
  "zh-TW": { blocked: "這個角色目前在「{tab}」分頁。", unknownTab: "另一個", available: "這個角色目前已停止。", claim: "停止原位置並在這裡開啟", open: "在這裡開啟", busy: "正在開啟…", failed: "無法開啟角色，請再試一次。" },
  "zh-CN": { blocked: "这个角色目前在“{tab}”标签页。", unknownTab: "另一个", available: "这个角色目前已停止。", claim: "停止原位置并在这里打开", open: "在这里打开", busy: "正在打开…", failed: "无法打开角色，请重试。" },
  ja: { blocked: "このロールは「{tab}」タブで開いています。", unknownTab: "別の", available: "このロールは停止しています。", claim: "元の場所で停止してここで開く", open: "ここで開く", busy: "開いています…", failed: "ロールを開けませんでした。もう一度お試しください。" }
} as const;

const locale = navigator.language === "zh-TW" || navigator.language === "zh-CN" || navigator.language === "ja"
  ? navigator.language
  : "en";
const text = translations[locale];
const identity = globalThis.__rionRoleSlotIdentity;
const roleName = document.querySelector<HTMLElement>("#role-name")!;
const message = document.querySelector<HTMLElement>("#message")!;
const claim = document.querySelector<HTMLButtonElement>("#claim")!;
const error = document.querySelector<HTMLElement>("#error")!;

if (!identity) {
  document.body.replaceChildren();
} else {
  roleName.textContent = identity.roleName;
  message.textContent = identity.blocked
    ? text.blocked.replace("{tab}", identity.ownerTabName ?? text.unknownTab)
    : text.available;
  claim.textContent = identity.blocked ? text.claim : text.open;
  claim.addEventListener("click", async () => {
    claim.disabled = true;
    claim.textContent = text.busy;
    error.hidden = true;
    try {
      await invoke("rion_runtime_role_slot_action", { action: identity });
    } catch {
      claim.disabled = false;
      claim.textContent = identity.blocked ? text.claim : text.open;
      error.textContent = text.failed;
      error.hidden = false;
    }
  });
}
