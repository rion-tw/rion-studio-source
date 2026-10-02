import { randomUUID } from "node:crypto";
import { RionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import type { ElectronFocusedRuntimeShortcutTarget } from "./electronFocusedApplicationShortcutController";

type Role = ChromiumRuntimeExecutorSnapshot["roles"][number];

export function createChromiumRoleZoomShortcut(core: ElectronCoreCommandPort,
  runtime: () => { focusedRole: () => Role | null; snapshot: () => ChromiumRuntimeExecutorSnapshot } | null) {
  const controller = new ChromiumRoleZoomShortcutController({ core,
    focusedRole: () => runtime()?.focusedRole() ?? null,
    snapshot: () => {
      const current = runtime();
      if (!current) throw new Error("The Chromium runtime retired before Role zoom admission.");
      return current.snapshot();
    }
  });
  return controller.execute.bind(controller);
}

/** The native focused WebContents selects a Role once; queued work never retargets. */
export class ChromiumRoleZoomShortcutController {
  readonly #lanes = new Map<string, Promise<void>>();
  constructor(readonly input: {
    core: ElectronCoreCommandPort;
    focusedRole: () => Role | null;
    snapshot: () => ChromiumRuntimeExecutorSnapshot;
  }) {}

  async execute(target: ElectronFocusedRuntimeShortcutTarget, action: "in" | "out" | "reset"): Promise<boolean> {
    const admitted = this.input.focusedRole();
    if (!admitted) return false;
    // Workspace slots own independent zoom. Standalone Role tabs retain the
    // established window multiplier and its menu/shortcut receipts.
    if (!admitted.workspaceId) return false;
    const stale = () => new RionBridgeError({ code: "ELECTRON_RUNTIME_ROLE_ZOOM_SHORTCUT_STALE",
      message: "The focused Role zoom shortcut lost its exact window and surface owner." });
    if (admitted.windowId !== target.windowId || admitted.tabId !== target.activeTabId) throw stale();
    const begin = async () => {
      const role = this.input.focusedRole();
      const window = this.input.snapshot().windows.find(candidate => candidate.windowId === target.windowId);
      if (!role || role.roleId !== admitted.roleId || role.generation !== admitted.generation ||
          role.ownerGeneration !== admitted.ownerGeneration || role.tabId !== admitted.tabId ||
          role.windowId !== target.windowId || !window?.visible || !window.focused ||
          window.windowGeneration !== target.windowGeneration || window.parentNativeHostId !== target.parentNativeHostId ||
          window.activeTabId !== role.tabId || window.topologyRevision < target.topologyRevision ||
          role.zoomFactor === undefined) throw stale();
      const operationId = randomUUID();
      const receipt = await this.input.core.invoke({ type: "browserRuntimeRoleZoom", request: {
        operationId, roleId: role.roleId, tabId: role.tabId, windowId: role.windowId,
        ownerGeneration: role.ownerGeneration, surfaceGeneration: role.generation,
        windowGeneration: window.windowGeneration, topologyRevision: window.topologyRevision,
        previousZoomFactor: role.zoomFactor, action
      } });
      if (receipt.status !== "applied" || receipt.operationId !== operationId ||
          receipt.roleId !== role.roleId || receipt.tabId !== role.tabId || receipt.windowId !== role.windowId ||
          receipt.surfaceGeneration !== role.generation || receipt.windowGeneration !== window.windowGeneration) {
        throw new RionBridgeError({ code: receipt.failureCode ?? "ELECTRON_RUNTIME_ROLE_ZOOM_NOT_APPLIED",
          message: "Core did not confirm the exact focused Role zoom." });
      }
    };
    const prior = this.#lanes.get(target.windowId);
    const operation = prior ? prior.then(begin) : begin();
    const tail = operation.then(() => undefined, () => undefined);
    this.#lanes.set(target.windowId, tail);
    try { await operation; return true; }
    finally { if (this.#lanes.get(target.windowId) === tail) this.#lanes.delete(target.windowId); }
  }
}
