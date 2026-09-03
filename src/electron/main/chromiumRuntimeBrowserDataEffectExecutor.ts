import type {
  CoreEffectRequest,
  GlobalWebProfilePathsRecord
} from "../../shared/generated";
import { CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES } from
  "./chromiumRoleBrowserDataClearCoordinator";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectPorts";
import {
  requireIdentifier,
  runtimeError
} from "./chromiumRuntimeEffectExecutorSupport";

type RoleBrowserDataClearAction = Extract<
  CoreEffectRequest["action"],
  { type: "roleBrowserDataClearSession" }
>;

function hasExactClearedStorages(storages: readonly string[]): boolean {
  return storages.length === CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES.length &&
    storages.every(
      (storage, index) =>
        storage === CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES[index]
    );
}

export async function executeChromiumRuntimeRoleBrowserDataClear(
  input: ChromiumRuntimeEffectExecutorInput,
  hasLiveRole: boolean,
  effect: CoreEffectRequest,
  action: RoleBrowserDataClearAction,
  signal?: AbortSignal
): Promise<unknown> {
  const roleId = requireIdentifier(action.roleId, "role");
  if (effect.target.handleId !== roleId) {
    throw runtimeError(
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_EFFECT_IDENTITY_MISMATCH",
      "The Core effect target does not match its browser-data role."
    );
  }
  if (hasLiveRole) {
    throw runtimeError(
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SESSION_ACTIVE",
      "A live Chromium role surface cannot be cleared."
    );
  }
  const rolePaths = await input.rolePaths.resolve(roleId);
  if (
    action.webview2UserDataDir !== rolePaths.webview2UserDataDir ||
    action.webkitDataStoreIdentifier !== rolePaths.webkitDataStoreIdentifier
  ) {
    throw runtimeError(
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SOURCE_IDENTITY_MISMATCH",
      "The v22 browser-data identity does not match the exact Rust-owned role paths."
    );
  }

  const clearInput = {
    roleId,
    effectId: effect.effectId,
    operationId: effect.operationId,
    rolePaths
  };
  const result = await (signal
    ? input.browserDataClear.clear(clearInput, signal)
    : input.browserDataClear.clear(clearInput));
  if (result.status !== "applied") {
    throw runtimeError(
      result.stableErrorCode,
      result.status === "indeterminate"
        ? "Chromium could not establish the terminal browser-data clear outcome."
        : "Chromium rejected the browser-data clear operation."
    );
  }
  const receipt = result.receipt;
  if (
    receipt.roleId !== roleId ||
    receipt.operationId !== effect.operationId ||
    receipt.cookieReadbackCount !== 0 ||
    receipt.evidence !==
      "electron-clear-storage-data-promise-and-cookie-readback" ||
    !hasExactClearedStorages(receipt.clearedStorages)
  ) {
    throw runtimeError(
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RECEIPT_INVALID",
      "Chromium did not return the exact browser-data clear receipt."
    );
  }
  return receipt;
}

export async function executeChromiumRuntimeGlobalWebBrowserDataClear(
  input: ChromiumRuntimeEffectExecutorInput,
  hasLiveWebSurfaces: boolean,
  effect: CoreEffectRequest,
  profile: GlobalWebProfilePathsRecord
): Promise<unknown> {
  if (effect.target.handleId !== "global-web") {
    throw runtimeError(
      "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_EFFECT_IDENTITY_MISMATCH",
      "The Core effect target does not match the global Web profile."
    );
  }
  if (hasLiveWebSurfaces) {
    throw runtimeError(
      "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_SESSION_ACTIVE",
      "Live global Web surfaces must close before clearing their profile."
    );
  }
  const result = await input.globalWebBrowserDataClear.clear({
    operationId: effect.operationId,
    profile
  });
  if (result.status !== "applied") {
    throw runtimeError(
      result.stableErrorCode,
      result.status === "indeterminate"
        ? "Chromium could not establish the terminal global Web clear outcome."
        : "Chromium rejected the global Web browser-data clear operation."
    );
  }
  const receipt = result.receipt;
  if (
    receipt.profileKey !== "global-web" ||
    receipt.operationId !== effect.operationId ||
    receipt.cookieReadbackCount !== 0 ||
    !hasExactClearedStorages(receipt.clearedStorages) ||
    receipt.evidence !==
      "electron-clear-storage-data-promise-and-cookie-readback"
  ) {
    throw runtimeError(
      "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_RECEIPT_INVALID",
      "Chromium did not return the exact global Web browser-data clear receipt."
    );
  }
  return Object.freeze({
    operationId: effect.operationId,
    profile: Object.freeze({ ...profile }),
    status: "applied" as const
  });
}
