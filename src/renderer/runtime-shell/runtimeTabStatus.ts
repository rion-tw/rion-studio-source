import { invoke } from "@tauri-apps/api/core";

import type { RuntimeTabStatusIdentityRecord } from "../../shared/generated";

type RuntimeTabFailureStatusProjection = {
  body: string;
  identity: RuntimeTabStatusIdentityRecord;
  language: string;
  retryLabel: string;
  tabName: string;
  theme: "light" | "dark";
  title: string;
};

declare global {
  var __rionInitialRuntimeTabFailureStatus:
    | RuntimeTabFailureStatusProjection
    | undefined;
  var __rionApplyRuntimeTabFailureStatus:
    | ((projection: RuntimeTabFailureStatusProjection) => void)
    | undefined;
}

const title = document.querySelector<HTMLElement>("#failure-title")!;
const body = document.querySelector<HTMLElement>("#failure-body")!;
const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;

let current: RuntimeTabFailureStatusProjection | undefined;

function apply(projection: RuntimeTabFailureStatusProjection): void {
  current = projection;
  document.documentElement.lang = projection.language;
  document.documentElement.dataset.theme = projection.theme;
  document.documentElement.style.colorScheme = projection.theme;
  title.textContent = projection.title;
  body.textContent = projection.body;
  retry.textContent = projection.retryLabel;
  retry.ariaLabel = projection.retryLabel;
  retry.disabled = false;
}

window.__rionApplyRuntimeTabFailureStatus = apply;

retry.addEventListener("click", () => {
  const projection = current;
  if (!projection || retry.disabled) return;
  retry.disabled = true;
  void invoke("rion_runtime_tab_action", {
    action: {
      type: "retryFailed",
      identity: projection.identity
    }
  }).catch(() => {
    if (current?.identity.attemptId === projection.identity.attemptId) {
      retry.disabled = false;
    }
  });
});

if (window.__rionInitialRuntimeTabFailureStatus) {
  apply(window.__rionInitialRuntimeTabFailureStatus);
}

export {};
