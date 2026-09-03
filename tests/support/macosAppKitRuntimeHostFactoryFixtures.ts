import type {
  ChromiumPopupAdmissionRecord,
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord
} from "../../src/shared/generated";
import { expect, vi, type Mock } from "vitest";
import {
  MacosAppKitChromiumRuntimeHostFactory,
  RION_APPKIT_RUNTIME_ABI_VERSION,
  type AppKitRuntimeHostIdentity,
  type MacosAppKitBaseWindowFactoryPort,
  type MacosAppKitBaseWindowPort,
  type MacosAppKitRuntimeHostFactoryInput,
  type RawAppKitRuntimeAddon,
  type RawNativeAppKitRuntimeHost
} from "../../src/electron/main/macosAppKitRuntimeHostFactory";

type Listener = (...arguments_: unknown[]) => unknown;

export class FakeBaseWindow {
  readonly nativeId: number;
  readonly contentView: {
    addChildView(view: unknown): void;
    removeChildView(view: unknown): void;
  } = {
    addChildView: vi.fn(),
    removeChildView: vi.fn()
  };
  readonly listeners = new Map<string, Set<Listener>>();
  readonly removedListeners: Array<readonly [string, Listener]> = [];
  readonly order: string[];
  readonly nativeHandle: Buffer;
  contentBounds = { x: 100, y: 80, width: 960, height: 680 };
  normalBounds = { x: 100, y: 80, width: 960, height: 680 };
  destroyed = false;
  focused = false;
  visible = false;
  fullScreen = false;
  maximized = false;
  minimized = false;
  closeCalls = 0;
  destroyCalls = 0;
  destroyError: Error | null = null;

  constructor(id: number, order: string[]) {
    this.nativeId = id;
    this.order = order;
    this.nativeHandle = Buffer.from(0x1000n.toString(16).padStart(16, "0"), "hex").reverse();
  }

  get id(): number {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.nativeId;
  }

  close(): void {
    this.closeCalls += 1;
    this.order.push("window-close-submitted");
    const event = { preventDefault: vi.fn() };
    this.emit("close", event);
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.order.push("window-destroy-submitted");
    if (this.destroyError) throw this.destroyError;
  }

  focus(): void {
    this.order.push("window-focus");
  }

  hide(): void {
    this.visible = false;
    this.order.push("window-hide");
  }

  getContentBounds() {
    return { ...this.contentBounds };
  }

  getNormalBounds() {
    return { ...this.normalBounds };
  }

  getNativeWindowHandle(): Buffer {
    return this.nativeHandle;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    return this.focused;
  }

  isFullScreen(): boolean {
    return this.fullScreen;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  maximize(): void {
    this.order.push("window-maximize");
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.removedListeners.push([event, listener]);
    this.listeners.get(event)?.delete(listener);
  }

  setFullScreen(fullscreen: boolean): void {
    this.order.push(`window-fullscreen-${fullscreen}`);
  }

  show(): void {
    this.visible = true;
    this.order.push("window-show");
  }

  showInactive(): void {
    this.visible = true;
    this.order.push("window-show-inactive");
  }

  emit(event: string, ...arguments_: unknown[]): void {
    if (event === "closed") this.destroyed = true;
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
  }
}

export function target(
  overrides: Partial<EmbeddedLaunchTargetRecord> = {}
): EmbeddedLaunchTargetRecord {
  return {
    windowId: "window-1",
    persistedName: "Game Window 1",
    displayId: 7,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 100, y: 80, width: 960, height: 680 },
    presentation: "normal",
    ...overrides
  };
}

export function tab(
  launchTarget: EmbeddedLaunchTargetRecord
): EmbeddedTabEffectRecord {
  return {
    tabId: "tab-1",
    audioMuted: false,
    appkitWindowGeneration: 1,
    appkitTopologyRevision: 1,
    attemptGeneration: "launch-generation-1",
    sourceId: "role-1",
    name: "Role 1",
    target: launchTarget,
    workspaceAppearance: { background: "black", gap: 4 },
    slots: [],
    roles: []
  } as EmbeddedTabEffectRecord;
}

export function popupAdmission(): ChromiumPopupAdmissionRecord {
  const popupId = "10000000-0000-4000-8000-000000000001";
  const openOperationId = "20000000-0000-4000-8000-000000000001";
  return {
    requestId: "30000000-0000-4000-8000-000000000001",
    popupId,
    openOperationId,
    lifecycleRevision: 1,
    parent: {
      ownerKind: "role",
      ownerId: "role-1",
      ownerNativeGeneration: 3,
      roleOwnerGeneration: 5,
      parentWindowId: "window-parent",
      parentWindowGeneration: 2,
      parentTopologyRevision: 9,
      parentTabId: "tab-parent",
      parentAttemptGeneration: "parent-attempt",
      parentNativeHostId: 41,
      parentAppkitIdentity: {
        logicalWindowId: "window-parent",
        launchGeneration: "initial-parent-tab-attempt",
        nativeGeneration: 6
      }
    },
    target: target({
      windowId: `popup-${popupId}`,
      persistedName: "popup.example.test",
      bounds: { x: 120, y: 100, width: 800, height: 600 }
    }),
    title: "popup.example.test",
    creationUrl: "about:blank",
    targetUrl: "https://popup.example.test/path",
    disposition: "newWindow",
    openerPolicy: "isolatedNoopener"
  };
}

export async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

export class FakeNativeHost implements RawNativeAppKitRuntimeHost {
  readonly logicalWindowId: string;
  readonly launchGeneration: string;
  readonly nativeGeneration: number;
  readonly order: string[];
  layout = { heightInset: 40, yOffset: 0, valid: true };
  destroyed = false;
  destroyResult = true;
  readonly destroyAttempts: AppKitRuntimeHostIdentity[] = [];
  projectionRevisionOverride: string | undefined;
  projectionTabCountOverride: number | undefined;
  restoreThrows = false;
  throwTabClosePolicyFor: boolean | undefined;
  readonly windowNameFailures = new Set<string>();
  onSetFullscreenPolicy: (() => void) | undefined;
  fullscreenPolicy = false;
  tabCloseButtonsHidden = false;
  windowName = "";
  verifiedProjectionRevision = "0";
  verifiedProjectionTabCount = 0;
  verifiedProjectionActiveTabId: string | undefined;
  verifiedProjectionTabs: ReadonlyArray<Readonly<{
    tabId: string;
    name?: string;
    phase?: string;
    tabType?: string;
  }>> = [];
  workspaceDividerRevision = "0";
  workspaceDividerContentBounds = { x: 0, y: 40, width: 960, height: 640 };
  workspaceDividers: ReadonlyArray<Readonly<{
    tabId: string;
    attemptGeneration: string;
    dividerIndex: number;
    axis: "horizontal" | "vertical";
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
  }>> = [];

  constructor(identity: AppKitRuntimeHostIdentity, order: string[]) {
    this.logicalWindowId = identity.logicalWindowId;
    this.launchGeneration = identity.launchGeneration;
    this.nativeGeneration = identity.nativeGeneration;
    this.order = order;
  }

  destroy(expected: AppKitRuntimeHostIdentity): boolean {
    this.destroyAttempts.push({ ...expected });
    if (
      expected.logicalWindowId !== this.logicalWindowId ||
      expected.launchGeneration !== this.launchGeneration ||
      expected.nativeGeneration !== this.nativeGeneration
    ) {
      return false;
    }
    if (this.destroyed) return false;
    if (!this.destroyResult) return false;
    this.destroyed = true;
    this.order.push("controller-destroy");
    return true;
  }

  focusWindow(expected: AppKitRuntimeHostIdentity): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-window-focus");
  }

  desktopE2eAccessibilityShowMenu(
    expected: AppKitRuntimeHostIdentity,
    tabId: string
  ): boolean {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push(`controller-tab-menu-${tabId}`);
    return true;
  }

  snapshotContentLayout(expected: AppKitRuntimeHostIdentity) {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-layout");
    return { ...this.layout };
  }

  applyTabProjection(
    expected: AppKitRuntimeHostIdentity,
    projectionRevision: string,
    tabs: ReadonlyArray<Readonly<{
      tabId: string;
      name?: string;
      phase?: string;
      tabType?: string;
    }>>,
    activeTabId?: string
  ) {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-project");
    const receipt = {
      projectionRevision: this.projectionRevisionOverride ?? projectionRevision,
      tabCount: this.projectionTabCountOverride ?? tabs.length,
      ...(activeTabId === undefined ? {} : { activeTabId })
    };
    if (receipt.projectionRevision === projectionRevision) {
      this.verifiedProjectionRevision = projectionRevision;
      this.verifiedProjectionTabCount = tabs.length;
      this.verifiedProjectionActiveTabId = activeTabId;
      this.verifiedProjectionTabs = tabs.map((tab) => ({ ...tab }));
    }
    return receipt;
  }

  restoreLastVerifiedTabProjection(expected: AppKitRuntimeHostIdentity) {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-project-restore");
    if (this.restoreThrows) throw new Error("native projection restoration failed");
    return {
      projectionRevision: this.verifiedProjectionRevision,
      tabCount: this.verifiedProjectionTabCount,
      ...(this.verifiedProjectionActiveTabId === undefined
        ? {}
        : { activeTabId: this.verifiedProjectionActiveTabId })
    };
  }

  applyWorkspaceDividerProjection(
    expected: AppKitRuntimeHostIdentity,
    projectionRevision: string,
    contentBounds: { x: number; y: number; width: number; height: number },
    dividers: typeof this.workspaceDividers
  ) {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-project-workspace-dividers");
    this.workspaceDividerRevision = projectionRevision;
    this.workspaceDividerContentBounds = { ...contentBounds };
    this.workspaceDividers = dividers.map((divider) => ({
      ...divider,
      bounds: { ...divider.bounds }
    }));
    return {
      projectionRevision,
      dividerCount: dividers.length,
      contentBounds: { ...contentBounds }
    };
  }

  restoreLastVerifiedWorkspaceDividerProjection(
    expected: AppKitRuntimeHostIdentity
  ) {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-project-workspace-dividers-restore");
    return {
      projectionRevision: this.workspaceDividerRevision,
      dividerCount: this.workspaceDividers.length,
      contentBounds: { ...this.workspaceDividerContentBounds }
    };
  }

  prepareFullscreen(
    expected: AppKitRuntimeHostIdentity,
    fullscreen: boolean
  ): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push(`controller-prepare-fullscreen-${fullscreen}`);
  }

  setFullscreenPolicy(
    expected: AppKitRuntimeHostIdentity,
    alwaysShow: boolean
  ): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.fullscreenPolicy = alwaysShow;
    this.order.push(`controller-fullscreen-policy-${alwaysShow}`);
    this.onSetFullscreenPolicy?.();
  }

  setTabCloseButtonsHidden(
    expected: AppKitRuntimeHostIdentity,
    alwaysHide: boolean
  ): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.tabCloseButtonsHidden = alwaysHide;
    this.order.push(`controller-tab-close-hidden-${alwaysHide}`);
    if (this.throwTabClosePolicyFor === alwaysHide) {
      throw new Error("native tab-close policy failed after mutation");
    }
  }

  setRevealLocked(expected: AppKitRuntimeHostIdentity, locked: boolean): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push(`controller-reveal-locked-${locked}`);
  }

  setWindowName(
    expected: AppKitRuntimeHostIdentity,
    windowName?: string
  ): void {
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.windowName = windowName ?? "";
    this.order.push(`controller-window-name-${this.windowName}`);
    if (this.windowNameFailures.has(this.windowName)) {
      throw new Error(`native window-name ${this.windowName} failed after mutation`);
    }
  }

  desktopE2eFullscreenToolbarState(expected: AppKitRuntimeHostIdentity) {
    expect(this).toBeInstanceOf(FakeNativeHost);
    expect(expected.nativeGeneration).toBe(this.nativeGeneration);
    this.order.push("controller-fullscreen-toolbar-readback");
    return {
      accessoryOnScreen: true,
      accessoryVisibleHeight: 40,
      alwaysHideTabCloseButton: false,
      alwaysShowInFullScreen: false,
      fullscreen: false,
      fullscreenHostReady: true,
      presentationAutoHideToolbar: false,
      revealLocked: false,
      tabCloseButtonEnabledCount: 1,
      tabStripOnScreen: true,
      toolbarPinned: false,
      valid: true,
      visibleTrafficLightCount: 3
    };
  }

  beginInputSurfaceCapture(
    _expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number
  ) {
    return {
      roleId,
      surfaceGeneration,
      captureSequence: "1",
      observedNodeCount: 1
    };
  }

  commitInputSurfaceCapture(
    _expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number,
    captureSequence: string
  ) {
    return {
      roleId,
      surfaceGeneration,
      nativeGeneration: this.nativeGeneration,
      captureSequence
    };
  }

  cancelInputSurfaceCapture(): boolean {
    return true;
  }

  retireInputSurface(): boolean {
    return true;
  }
}

export class FakeAddon implements RawAppKitRuntimeAddon {
  readonly order: string[];
  readonly controllers: FakeNativeHost[] = [];
  readonly callbacks: Array<(eventJson: string) => void> = [];
  abiVersion = RION_APPKIT_RUNTIME_ABI_VERSION;
  invalidControllerResult = false;
  mismatchIdentity = false;
  nextControllerOverride: FakeNativeHost | null = null;

  constructor(order: string[]) {
    this.order = order;
  }

  appKitRuntimeAbiVersion(): number {
    return this.abiVersion;
  }

  attachAppKitRuntimeHost(
    nativeViewHandle: Buffer,
    identity: AppKitRuntimeHostIdentity,
    callback: (eventJson: string) => void
  ): RawNativeAppKitRuntimeHost {
    expect(Buffer.isBuffer(nativeViewHandle)).toBe(true);
    expect(nativeViewHandle.byteLength).toBe(BigUint64Array.BYTES_PER_ELEMENT);
    this.order.push("controller-attach");
    this.callbacks.push(callback);
    const controller = this.nextControllerOverride ?? new FakeNativeHost(
      this.mismatchIdentity
        ? { ...identity, nativeGeneration: identity.nativeGeneration + 1 }
        : identity,
      this.order
    );
    this.nextControllerOverride = null;
    this.controllers.push(controller);
    return this.invalidControllerResult
      ? null as unknown as RawNativeAppKitRuntimeHost
      : controller;
  }

  emit(index: number, event: unknown): void {
    this.callbacks[index]!(JSON.stringify(event));
  }
}

export class Fixture {
  readonly order: string[] = [];
  readonly addon = new FakeAddon(this.order);
  lifecycleEpoch = 1;
  readonly windows: FakeBaseWindow[] = [];
  readonly options: unknown[] = [];
  readonly onAction: Mock<MacosAppKitRuntimeHostFactoryInput["onAction"]> =
    vi.fn<MacosAppKitRuntimeHostFactoryInput["onAction"]>();
  readonly onCloseRequested: Mock<
    MacosAppKitRuntimeHostFactoryInput["onCloseRequested"]
  > = vi.fn<MacosAppKitRuntimeHostFactoryInput["onCloseRequested"]>();
  readonly onError: Mock<MacosAppKitRuntimeHostFactoryInput["onError"]> =
    vi.fn<MacosAppKitRuntimeHostFactoryInput["onError"]>();
  readonly onLayout: Mock<
    NonNullable<MacosAppKitRuntimeHostFactoryInput["onLayout"]>
  > = vi.fn<NonNullable<MacosAppKitRuntimeHostFactoryInput["onLayout"]>>();
  readonly onHostClosing: Mock<
    NonNullable<MacosAppKitRuntimeHostFactoryInput["onHostClosing"]>
  > = vi.fn(async () => {
    this.order.push("input-host-close");
  });
  readonly factory = new MacosAppKitChromiumRuntimeHostFactory({
    addon: this.addon,
    displays: {
      displayMatching: () => ({
        id: 7,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      })
    },
    lifecycleEpoch: () => this.lifecycleEpoch,
    windows: {
      create: (options) => {
        this.options.push(options);
        const window = new FakeBaseWindow(this.windows.length + 1, this.order);
        this.windows.push(window);
        this.order.push("window-created-hidden");
        return window as unknown as MacosAppKitBaseWindowPort;
      }
    } satisfies MacosAppKitBaseWindowFactoryPort,
    onAction: this.onAction,
    onCloseRequested: this.onCloseRequested,
    onError: this.onError,
    onHostClosing: this.onHostClosing,
    onLayout: this.onLayout
  });
}
