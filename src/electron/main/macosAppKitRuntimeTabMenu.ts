import type {
  AppKitRuntimeHostIdentityRecord,
  AppKitRuntimeHostObservationRecord,
  CoreAppSnapshotRecord
} from "../../shared/generated";
import type { AppLanguage } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";

export interface MacosAppKitRuntimeTabMenuFence {
  readonly appKitIdentity: AppKitRuntimeHostIdentityRecord;
  readonly lifecycleEpoch: number;
  readonly parentNativeHostId: number;
  readonly tabAudioMuted: readonly boolean[];
  readonly tabIds: readonly string[];
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export type MacosAppKitRuntimeTabMenuAction =
  | Readonly<{ type: "hide"; tabId: string }>
  | Readonly<{ type: "move"; tabId: string; windowId: string }>
  | Readonly<{ type: "moveToNewWindow"; tabId: string }>
  | Readonly<{ type: "reload"; tabId: string }>
  | Readonly<{ muted: boolean; type: "setMuted"; tabId: string }>
  | Readonly<{ type: "stop"; tabId: string }>;

export interface MacosAppKitRuntimeTabMenuActionRequest {
  readonly action: MacosAppKitRuntimeTabMenuAction;
  readonly source: MacosAppKitRuntimeTabMenuFence;
  readonly target?: MacosAppKitRuntimeTabMenuFence;
}

export interface MacosAppKitRuntimeTabMenuItem {
  readonly id?: string;
  readonly label?: string;
  readonly checked?: boolean;
  readonly type?: "checkbox" | "normal" | "separator" | "submenu";
  readonly enabled?: boolean;
  readonly submenu?: readonly MacosAppKitRuntimeTabMenuItem[];
  readonly click?: () => void;
}

export interface MacosAppKitRuntimeTabMenuInput {
  readonly actions: Readonly<{
    execute: (request: MacosAppKitRuntimeTabMenuActionRequest) => Promise<void>;
  }>;
  readonly language: () => AppLanguage;
  readonly lifecycleEpoch: () => number;
  readonly nativeMenu: Readonly<{
    popup: (input: Readonly<{
      items: readonly MacosAppKitRuntimeTabMenuItem[];
      parentNativeHostId: number;
    }>) => void;
  }>;
  readonly onError: (error: unknown) => void;
  readonly readCoreSnapshot: () => Promise<CoreAppSnapshotRecord>;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
}

export interface MacosAppKitRuntimeTabMenuOpenRequest {
  readonly hosts: readonly AppKitRuntimeHostObservationRecord[];
  readonly identity: AppKitRuntimeHostIdentityRecord;
  readonly tabId: string;
}

interface ExactWindow {
  readonly fence: MacosAppKitRuntimeTabMenuFence;
  readonly name: string;
}

interface ExactMenuContext {
  readonly audioMuted: boolean;
  readonly source: ExactWindow;
  readonly tabId: string;
  readonly targets: readonly ExactWindow[];
}

type Labels = Readonly<{
  hide: string;
  mute: string;
  moveToNewWindow: string;
  moveToWindow: string;
  reload: string;
  stop: string;
  unmute: string;
}>;

const LABELS: Readonly<Record<AppLanguage, Labels>> = Object.freeze({
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

function menuError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactIdentity(
  left: AppKitRuntimeHostIdentityRecord | undefined,
  right: AppKitRuntimeHostIdentityRecord
): boolean {
  return left?.logicalWindowId === right.logicalWindowId &&
    left.launchGeneration === right.launchGeneration &&
    left.nativeGeneration === right.nativeGeneration;
}

function exactFence(
  left: MacosAppKitRuntimeTabMenuFence,
  right: MacosAppKitRuntimeTabMenuFence
): boolean {
  return left.windowId === right.windowId &&
    left.windowGeneration === right.windowGeneration &&
    left.topologyRevision === right.topologyRevision &&
    left.lifecycleEpoch === right.lifecycleEpoch &&
    left.parentNativeHostId === right.parentNativeHostId &&
    exactIdentity(left.appKitIdentity, right.appKitIdentity) &&
    exactIds(left.tabIds, right.tabIds) &&
    left.tabAudioMuted.length === right.tabAudioMuted.length &&
    left.tabAudioMuted.every(
      (muted, index) => muted === right.tabAudioMuted[index]
    );
}

/**
 * Builds the macOS runtime-tab NSMenu only from a coherent Core/AppKit/native
 * snapshot. Menu selection is re-fenced before it enters the existing
 * Core-owned Chromium action lane, so a modal native menu can never mutate a
 * replacement window generation.
 */
export class MacosAppKitRuntimeTabMenuController {
  readonly #input: MacosAppKitRuntimeTabMenuInput;

  constructor(input: MacosAppKitRuntimeTabMenuInput) {
    this.#input = input;
  }

  async open(request: MacosAppKitRuntimeTabMenuOpenRequest): Promise<void> {
    const context = await this.#openContext(request);
    const labels = LABELS[this.#input.language()];
    const targetItems = context.targets.map((target) =>
      target.fence.windowId === context.source.fence.windowId
        ? Object.freeze({
            enabled: false,
            id: `runtime-tab-menu-move-${target.fence.windowId}`,
            label: target.name,
            type: "normal" as const
          })
        : Object.freeze({
          id: `runtime-tab-menu-move-${target.fence.windowId}`,
          label: target.name,
          type: "normal" as const,
          click: () => this.#dispatch(context, {
            type: "move",
            tabId: context.tabId,
            windowId: target.fence.windowId
          }, target.fence)
        })
    );
    this.#input.nativeMenu.popup({
      parentNativeHostId: context.source.fence.parentNativeHostId,
      items: Object.freeze([
        Object.freeze({
          id: "runtime-tab-menu-reload",
          label: labels.reload,
          type: "normal" as const,
          click: () => this.#dispatch(context, {
            type: "reload",
            tabId: context.tabId
          })
        }),
        Object.freeze({ type: "separator" as const }),
        Object.freeze({
          id: "runtime-tab-menu-move",
          label: labels.moveToWindow,
          submenu: Object.freeze(targetItems),
          type: "submenu" as const
        }),
        Object.freeze({
          id: "runtime-tab-menu-move-new",
          label: labels.moveToNewWindow,
          type: "normal" as const,
          click: () => this.#dispatch(context, {
            type: "moveToNewWindow",
            tabId: context.tabId
          })
        }),
        Object.freeze({
          checked: context.audioMuted,
          id: "runtime-tab-menu-mute",
          label: context.audioMuted ? labels.unmute : labels.mute,
          type: "checkbox" as const,
          click: () => this.#dispatch(context, {
            muted: !context.audioMuted,
            type: "setMuted",
            tabId: context.tabId
          })
        }),
        Object.freeze({ type: "separator" as const }),
        Object.freeze({
          id: "runtime-tab-menu-hide",
          label: labels.hide,
          type: "normal" as const,
          click: () => this.#dispatch(context, {
            type: "hide",
            tabId: context.tabId
          })
        }),
        Object.freeze({ type: "separator" as const }),
        Object.freeze({
          id: "runtime-tab-menu-stop",
          label: labels.stop,
          type: "normal" as const,
          click: () => this.#dispatch(context, {
            type: "stop",
            tabId: context.tabId
          })
        })
      ])
    });
  }

  #dispatch(
    context: ExactMenuContext,
    action: MacosAppKitRuntimeTabMenuAction,
    target?: MacosAppKitRuntimeTabMenuFence
  ): void {
    void this.#execute(context, action, target).catch(this.#input.onError);
  }

  async #execute(
    context: ExactMenuContext,
    action: MacosAppKitRuntimeTabMenuAction,
    target?: MacosAppKitRuntimeTabMenuFence
  ): Promise<void> {
    const current = await this.#exactWindows();
    const source = current.get(context.source.fence.windowId);
    const currentTarget = target ? current.get(target.windowId) : undefined;
    if (
      !source || !exactFence(source.fence, context.source.fence) ||
      (target !== undefined && (
        !currentTarget || !exactFence(currentTarget.fence, target)
      ))
    ) {
      throw menuError(
        "ELECTRON_MACOS_APPKIT_TAB_MENU_FENCE_STALE",
        "The native tab menu lost its exact Core/AppKit window generation."
      );
    }
    await this.#input.actions.execute(Object.freeze({
      action,
      source: context.source.fence,
      ...(target === undefined ? {} : { target })
    }));
  }

  async #openContext(
    request: MacosAppKitRuntimeTabMenuOpenRequest
  ): Promise<ExactMenuContext> {
    if (
      request.hosts.length !== 1 ||
      !exactIdentity(request.hosts[0]?.identity, request.identity) ||
      request.identity.logicalWindowId.length === 0 ||
      request.tabId.length === 0
    ) {
      throw menuError(
        "ELECTRON_MACOS_APPKIT_TAB_MENU_HOST_STALE",
        "The native tab menu omitted its exact retained AppKit host."
      );
    }
    const host = request.hosts[0]!;
    const windows = await this.#exactWindows();
    const source = windows.get(request.identity.logicalWindowId);
    if (
      !source || !host.visible || host.minimized ||
      source.fence.windowGeneration !== host.windowGeneration ||
      source.fence.topologyRevision !== host.topologyRevision ||
      !exactIdentity(source.fence.appKitIdentity, request.identity) ||
      !source.fence.tabIds.includes(request.tabId)
    ) {
      throw menuError(
        "ELECTRON_MACOS_APPKIT_TAB_MENU_HOST_STALE",
        "The native tab menu target is outside the exact visible AppKit topology."
      );
    }
    return Object.freeze({
      audioMuted: source.fence.tabAudioMuted[
        source.fence.tabIds.indexOf(request.tabId)
      ]!,
      source,
      tabId: request.tabId,
      targets: Object.freeze([...windows.values()])
    });
  }

  async #exactWindows(): Promise<Map<string, ExactWindow>> {
    const core = await this.#input.readCoreSnapshot();
    const native = this.#input.readNativeSnapshot();
    const lifecycleEpoch = this.#input.lifecycleEpoch();
    if (!Number.isSafeInteger(lifecycleEpoch) || lifecycleEpoch < 1) {
      throw menuError(
        "ELECTRON_MACOS_APPKIT_TAB_MENU_LIFECYCLE_STALE",
        "The native tab menu could not capture the application lifecycle epoch."
      );
    }
    const result = new Map<string, ExactWindow>();
    for (const logical of core.logicalWindows) {
      const matches = native.windows.filter(
        (candidate) => candidate.windowId === logical.windowId
      );
      const owner = matches[0];
      const saved = core.state.gameWindows.find(
        (candidate) => candidate.id === logical.windowId
      );
      const logicalTabIds = logical.tabs.map((tab) => tab.id);
      const nativeTabs = native.tabs.filter(
        (candidate) => candidate.windowId === logical.windowId
      );
      if (
        matches.length !== 1 || !owner || !saved ||
        logical.windowGeneration !== owner.windowGeneration ||
        logical.revision !== owner.topologyRevision ||
        logical.presentation !== owner.presentation ||
        !exactIds(logicalTabIds, owner.tabIds) ||
        nativeTabs.length !== logical.tabs.length ||
        logical.tabs.some((tab) => {
          const matches = nativeTabs.filter(
            (candidate) => candidate.tabId === tab.id
          );
          return matches.length !== 1 || matches[0]!.audioMuted !== tab.audioMuted;
        }) ||
        !Number.isSafeInteger(owner.parentNativeHostId) ||
        (owner.parentNativeHostId ?? 0) < 1 ||
        !owner.appKitIdentity ||
        owner.appKitIdentity.logicalWindowId !== logical.windowId ||
        owner.appKitIdentity.launchGeneration.length === 0 ||
        !Number.isSafeInteger(owner.appKitIdentity.nativeGeneration) ||
        owner.appKitIdentity.nativeGeneration < 1
      ) {
        throw menuError(
          "ELECTRON_MACOS_APPKIT_TAB_MENU_TOPOLOGY_STALE",
          "The native tab menu could not prove an exact Core/AppKit parent fence."
        );
      }
      result.set(logical.windowId, Object.freeze({
        fence: Object.freeze({
          appKitIdentity: Object.freeze({ ...owner.appKitIdentity }),
          lifecycleEpoch,
          parentNativeHostId: owner.parentNativeHostId!,
          tabAudioMuted: Object.freeze(logical.tabs.map((tab) => tab.audioMuted)),
          tabIds: Object.freeze([...logicalTabIds]),
          topologyRevision: logical.revision,
          windowGeneration: logical.windowGeneration,
          windowId: logical.windowId
        }),
        name: saved.name
      }));
    }
    if (result.size !== native.windows.length) {
      throw menuError(
        "ELECTRON_MACOS_APPKIT_TAB_MENU_TOPOLOGY_STALE",
        "The native tab menu observed an unowned AppKit runtime window."
      );
    }
    return result;
  }
}
