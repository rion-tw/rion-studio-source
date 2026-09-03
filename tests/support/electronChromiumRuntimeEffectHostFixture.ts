import type { EmbeddedTabEffectRecord } from "../../src/shared/generated";
import type { ChromiumRuntimeHostPort } from
  "../../src/electron/main/chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeWindowStateObserver,
  ChromiumRuntimeWindowStateSource
} from "../../src/electron/main/chromiumRuntimeHostPorts";
import { type Mock, vi } from "vitest";

export class FakeChromiumRuntimeEffectHost implements ChromiumRuntimeHostPort {
  readonly id: number;
  readonly logicalWindowId: string;
  readonly appKitIdentity;
  readonly initializeAppKitTab: Mock<NonNullable<
    ChromiumRuntimeHostPort["initializeAppKitTab"]
  >> = vi.fn();
  readonly releaseAppKitSurfaceAttachment: Mock<NonNullable<
    ChromiumRuntimeHostPort["releaseAppKitSurfaceAttachment"]
  >> = vi.fn();
  readonly discardAppKitSurfaceAttachment: Mock<NonNullable<
    ChromiumRuntimeHostPort["discardAppKitSurfaceAttachment"]
  >> = vi.fn();
  readonly prepareAppKitProjection: Mock<NonNullable<
    ChromiumRuntimeHostPort["prepareAppKitProjection"]
  >> = vi.fn(() => ({
    commit: vi.fn(),
    requiresQuarantine: vi.fn(() => false),
    rollback: vi.fn()
  }));
  readonly applyAppKitPhaseProjection: Mock<NonNullable<
    ChromiumRuntimeHostPort["applyAppKitPhaseProjection"]
  >> = vi.fn((projection) => {
    this.windowGeneration = projection.windowGeneration;
    this.topologyRevision = projection.topologyRevision;
  });
  readonly added: unknown[] = [];
  readonly removed: unknown[] = [];
  readonly contentView = {
    addChildView: (view: unknown): void => { this.added.push(view); },
    removeChildView: (view: unknown): void => { this.removed.push(view); }
  } as ChromiumRuntimeHostPort["contentView"];
  readonly observers = new Set<ChromiumRuntimeWindowStateObserver>();
  readonly close: Mock<ChromiumRuntimeHostPort["close"]> = vi.fn(async () => {
    this.destroyed = true;
    this.#emit("closed");
  });
  readonly focus: Mock<ChromiumRuntimeHostPort["focus"]> = vi.fn(() => {
    this.visible = true;
    this.focused = true;
    this.#emit("focus");
  });
  readonly hide: Mock<ChromiumRuntimeHostPort["hide"]> = vi.fn(() => {
    this.visible = false;
    this.focused = false;
    this.#emit("hide");
  });
  readonly getContentBounds: Mock<ChromiumRuntimeHostPort["getContentBounds"]> =
    vi.fn(() => ({
    x: 0, y: 44, width: 1000, height: 656
    }));
  projection: ReturnType<ChromiumRuntimeHostPort["readProjection"]>;
  readonly readProjection: Mock<ChromiumRuntimeHostPort["readProjection"]> =
    vi.fn(() => ({
    ...this.projection,
    bounds: { ...this.projection.bounds },
    visible: this.visible,
    focused: this.focused
    }));
  readonly show: Mock<ChromiumRuntimeHostPort["show"]> = vi.fn(() => {
    this.visible = true;
    this.#emit("show");
  });
  readonly showInactive: Mock<NonNullable<
    ChromiumRuntimeHostPort["showInactive"]
  >> = vi.fn(() => {
    this.visible = true;
    this.#emit("show");
  });
  readonly bindRuntimeWindowState = (
    observer: ChromiumRuntimeWindowStateObserver
  ): (() => void) => {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  };
  readonly readRuntimeWindowState = () => Object.freeze({
    platform: "macos" as const,
    source: "initial" as const,
    sequence: this.sequence,
    lifecycleEpoch: 1,
    logicalWindowId: this.logicalWindowId,
    nativeHostId: this.id,
    nativeGeneration: this.id,
    windowGeneration: this.windowGeneration,
    topologyRevision: this.topologyRevision,
    visible: this.visible,
    minimized: false,
    focused: this.focused,
    foreground: this.focused,
    appKitIdentity: this.appKitIdentity
  });
  destroyed = false;
  focused = false;
  sequence = 1;
  windowGeneration: number;
  topologyRevision: number;
  visible = true;

  constructor(
    logicalWindowId: string,
    id: number,
    target: EmbeddedTabEffectRecord["target"],
    launchGeneration = `launch-${logicalWindowId}`,
    visible = true,
    windowGeneration = 1,
    topologyRevision = 1
  ) {
    this.logicalWindowId = logicalWindowId;
    this.id = id;
    this.projection = {
      displayId: target.displayId,
      bounds: { ...target.bounds },
      visible,
      focused: false,
      presentation: target.presentation
    };
    this.appKitIdentity = {
      logicalWindowId,
      launchGeneration,
      nativeGeneration: id
    };
    this.visible = visible;
    this.windowGeneration = windowGeneration;
    this.topologyRevision = topologyRevision;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  #emit(source: ChromiumRuntimeWindowStateSource): void {
    this.sequence += 1;
    const observation = Object.freeze({
      ...this.readRuntimeWindowState(),
      source,
      sequence: this.sequence
    });
    for (const observer of this.observers) observer(observation);
  }
}
