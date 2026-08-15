import { invoke } from "@tauri-apps/api/core";

import type { RuntimeTabStatusIdentityRecord } from "../../shared/generated";

type RuntimeTabStatusProjection = {
  accessibilityLabel: string;
  body: string;
  identity: RuntimeTabStatusIdentityRecord;
  language: string;
  retryLabel: string;
  state: "failed" | "loading";
  tabName: string;
  theme: "light" | "dark";
  title: string;
};

declare global {
  var __rionInitialRuntimeTabStatus:
    | RuntimeTabStatusProjection
    | undefined;
  var __rionApplyRuntimeTabStatus:
    | ((projection: RuntimeTabStatusProjection) => void)
    | undefined;
}

const status = document.querySelector<HTMLElement>("#tab-status")!;
const loading = document.querySelector<HTMLElement>("#loading-status")!;
const failure = document.querySelector<HTMLElement>("#failure-status")!;
const title = document.querySelector<HTMLElement>("#failure-title")!;
const body = document.querySelector<HTMLElement>("#failure-body")!;
const retry = document.querySelector<HTMLButtonElement>("#failure-retry")!;

let current: RuntimeTabStatusProjection | undefined;

function apply(projection: RuntimeTabStatusProjection): void {
  current = projection;
  document.documentElement.lang = projection.language;
  document.documentElement.dataset.theme = projection.theme;
  document.documentElement.style.colorScheme = projection.theme;
  status.dataset.state = projection.state;
  status.ariaLabel = projection.accessibilityLabel;
  loading.hidden = projection.state !== "loading";
  failure.hidden = projection.state !== "failed";
  title.textContent = projection.title;
  body.textContent = projection.body;
  retry.textContent = projection.retryLabel;
  retry.ariaLabel = projection.retryLabel;
  retry.disabled = projection.state !== "failed";
}

window.__rionApplyRuntimeTabStatus = apply;

retry.addEventListener("click", () => {
  const projection = current;
  if (!projection || projection.state !== "failed" || retry.disabled) return;
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

if (window.__rionInitialRuntimeTabStatus) {
  apply(window.__rionInitialRuntimeTabStatus);
}

export {};
