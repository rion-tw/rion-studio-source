import type { CoreAppSnapshotRecord, DisplayTopologySnapshotRecord, RuntimeTabDragEventRecord,
  RuntimeTabDragReceiptRecord, RuntimeWindowProvisionTargetRecord } from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import type { MacosAppKitRuntimeHostFactoryPort } from "./chromiumRuntimeHostFactory";
import type { MacosAppKitRendererActionPort } from "./macosAppKitRuntimeEventBridge";
import type { DragPoint, RuntimeTabDragHostPort } from "./runtimeTabDragHost";
import { RionBridgeError } from "../ipc/errors";

export interface RuntimeTabDragStart {
  sessionId: string;
  sourceWindowId: string;
  tabId: string;
  point: DragPoint;
  ratio: DragPoint;
}
export type RuntimeTabDragInput = RuntimeTabDragStart & { phase: "start" }
  | { sessionId: string; phase: "move" | "end" | "cancel"; point: DragPoint };
interface Session {
  start: RuntimeTabDragStart;
  event: RuntimeTabDragEventRecord;
  receipt?: RuntimeTabDragReceiptRecord;
  pending?: Extract<RuntimeTabDragInput, { phase: "move" | "end" | "cancel" }>;
  terminal: boolean;
  finished: boolean;
  abort: AbortController;
  released: boolean;
  queued: boolean;
  retire: Map<string, number>;
  hosts: Map<string, { generation: number; port: RuntimeTabDragHostPort }>;
  bounds: ChromiumRuntimeExecutorSnapshot["windows"][number]["bounds"];
}
interface Input {
  core: ElectronCoreCommandPort;
  platform: "darwin" | "win32";
  native: () => ChromiumRuntimeExecutorSnapshot;
  displays: () => DisplayTopologySnapshotRecord;
  epoch: () => number;
  host: (id: string, generation: number) => RuntimeTabDragHostPort;
  appKit?: { factory: MacosAppKitRuntimeHostFactoryPort; events: MacosAppKitRendererActionPort };
  onError: (error: unknown) => void;
  canTarget?: (windowId: string, point: DragPoint) => boolean;
  onTerminal?: (sessionId: string) => void;
}
type Window = CoreAppSnapshotRecord["logicalWindows"][number];
function fail(message: string): never {
  throw new RionBridgeError({ code: "RUNTIME_TAB_DRAG_FAILED", message });
}

/** Serializes semantic transitions; only motion samples coalesce. Rust admits
 * every transition and resolves the current owner. No timer discovers truth. */
export class RuntimeTabDragController {
  readonly #input: Input;
  #session: Session | null = null;
  #lane = Promise.resolve();
  #disposed = false;
  constructor(input: Input) { this.#input = input; }

  receive(input: RuntimeTabDragInput): void {
    if (this.#disposed) return;
    if (input.phase === "start") {
      if (this.#session?.start.sessionId === input.sessionId) return;
      const source = this.#input.native().windows.find(w => w.windowId === input.sourceWindowId);
      if (!source || !source.tabIds.includes(input.tabId)) return;
      const prior = this.#session;
      if (prior) { prior.terminal = true; prior.abort.abort(); this.#release(prior); }
      const session: Session = { start: input, terminal: false, finished: false, abort: new AbortController(), released: false, queued: false, retire: new Map([[source.windowId, source.windowGeneration]]), hosts: new Map(), bounds: this.#input.host(source.windowId, source.windowGeneration).frameBounds?.() ?? source.bounds,
        event: { sessionId: input.sessionId, tabId: input.tabId, sourceWindowId: input.sourceWindowId,
          sourceWindowGeneration: source.windowGeneration, lifecycleEpoch: this.#input.epoch(), sequence: 0, phase: "start" } };
      this.#session = session;
      this.#enqueue(session, async () => {
        if (prior) await this.#finish(prior, "cancel");
        session.receipt = await this.#admit(session, "start");
        if (session.receipt.status !== "applied") { session.terminal = true; await this.#finish(session, "cancel"); return; }
        this.#host(session, source.windowId, source.windowGeneration);
        await this.#drain(session);
      });
      return;
    }
    const session = this.#session;
    if (!session || session.start.sessionId !== input.sessionId || session.terminal) return;
    if (session.pending?.phase === "end" || session.pending?.phase === "cancel") return;
    session.pending = input;
    if (input.phase === "cancel") session.abort.abort();
    // Physical release always restores interaction immediately, including while
    // a provision/transfer callback is pending. Queued work checks this barrier.
    if (input.phase !== "move") { session.released = true; this.#release(session); }
    this.#enqueue(session, () => this.#drain(session));
  }

  observeNativeProjection(): void {
    const session = this.#session;
    if (!session || session.terminal) return;
    const source = this.#input.native().windows.find(w => w.windowId === session.start.sourceWindowId);
    if (!source || source.windowGeneration !== session.event.sourceWindowGeneration) {
      this.receive({ sessionId: session.start.sessionId, phase: "cancel", point: session.start.point });
    }
  }

  failEventStream(): void {
    const session = this.#session;
    if (!session) return;
    session.terminal = true;
    session.abort.abort();
    this.#release(session);
    this.#input.onTerminal?.(session.start.sessionId);
  }

  async settle(): Promise<void> {
    let observed: Promise<void>;
    do { observed = this.#lane; await observed; } while (observed !== this.#lane);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const session = this.#session;
    if (session) { session.terminal = true; session.abort.abort(); this.#release(session); }
    await this.#lane;
    if (session) await this.#finish(session, "cancel");
  }

  #enqueue(session: Session, work: () => Promise<void>): void {
    if (session.queued) return;
    session.queued = true;
    this.#lane = this.#lane.then(work).catch(async (error: unknown) => {
      session.terminal = true;
      this.#release(session);
      try { await this.#finish(session, "fail"); } catch (cleanup) { this.#input.onError(cleanup); }
      this.#input.onError(error);
    }).finally(() => {
      session.queued = false;
      if (session.pending && !session.terminal) this.#enqueue(session, () => this.#drain(session));
    });
  }

  async #admit(session: Session, phase: RuntimeTabDragEventRecord["phase"], floatingWindowId?: string) {
    session.event = { ...session.event, phase, sequence: session.event.sequence + 1,
      ...(floatingWindowId === undefined ? {} : { floatingWindowId }) };
    const receipt = await this.#input.core.invoke({ type: "runtimeTabDrag", event: session.event });
    session.receipt = receipt;
    return receipt;
  }

  async #drain(session: Session): Promise<void> {
    while (session.pending && !session.terminal && session.receipt) {
      const sample = session.pending;
      session.pending = undefined;
      if (sample.phase !== "cancel") await this.#sample(session, sample.point);
      if (sample.phase !== "move") {
        session.terminal = true;
        await this.#finish(session, sample.phase);
      }
    }
  }

  #host(session: Session, id: string, generation: number): RuntimeTabDragHostPort {
    const prior = session.hosts.get(id);
    if (prior?.generation === generation) return prior.port;
    const port = this.#input.host(id, generation);
    session.hosts.set(id, { generation, port });
    return port;
  }

  async #sample(session: Session, point: DragPoint): Promise<void> {
    const receipt = await this.#admit(session, "sample");
    if (receipt.status !== "applied") { session.terminal = true; await this.#finish(session, "cancel"); return; }
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    if (session.terminal || session.abort.signal.aborted) return;
    const source = core.logicalWindows.find(w => w.windowId === receipt.currentWindowId);
    if (!source) fail("The dragged tab no longer has a live owner.");
    const natives = this.#input.native().windows;
    const findTarget = () => natives.filter(w => w.visible && w.windowId !== receipt.floatingWindowId)
      .find(w => this.#host(session, w.windowId, w.windowGeneration).contains(point) &&
        (this.#input.canTarget?.(w.windowId, point) ?? true));
    const floatingNative = natives.find(w => w.windowId === receipt.floatingWindowId);
    // Physical release restored interaction before asynchronous admission. Keep
    // the floating host out of this synchronous desktop hit-test as well, or its
    // own titlebar can obscure a just-accepted destination and detach it again.
    const floatingPort = floatingNative && this.#host(session, floatingNative.windowId, floatingNative.windowGeneration);
    const target = floatingPort?.withoutOcclusion ? floatingPort.withoutOcclusion(findTarget) : findTarget();
    if (target) {
      const logical = core.logicalWindows.find(w => w.windowId === target.windowId);
      if (!logical) fail("The drag destination has no Core projection.");
      const before = this.#host(session, target.windowId, target.windowGeneration)
        .before(point, session.start.tabId, target.tabIds);
      await this.#move(session, source, logical, before);
      if (floatingNative && floatingNative.windowId !== target.windowId &&
          this.#input.native().windows.find(w => w.windowId === floatingNative.windowId)?.tabIds.length === 0) {
        this.#host(session, floatingNative.windowId, floatingNative.windowGeneration).park?.();
      }
      return;
    }
    let floatingId = receipt.floatingWindowId;
    if (!floatingId) {
      const target = this.#placement(session, point, { x: 120 * session.start.ratio.x, y: 20 });
      const provision = await this.#input.core.invoke({ type: "embeddedWindowProvisionForTabMove",
        operationId: `${session.start.sessionId}:provision`, tabId: session.start.tabId,
        sourceWindowId: source.windowId, sourceWindowGeneration: source.windowGeneration,
        sourceTopologyRevision: source.revision, target });
      floatingId = provision.target.windowId;
      session.retire.set(floatingId, provision.windowGeneration);
      await this.#admit(session, "bindFloating", floatingId);
    }
    const fresh = await this.#input.core.invoke({ type: "appSnapshot" });
    const floating = fresh.logicalWindows.find(w => w.windowId === floatingId);
    const current = fresh.logicalWindows.find(w => w.tabs.some(t => t.id === session.start.tabId));
    if (!floating || !current) fail("The floating drag host lost its ownership fence.");
    if (session.terminal || session.pending?.phase === "cancel") return;
    if (!await this.#move(session, current, floating)) return;
    const nativeFloating = this.#input.native().windows.find(w => w.windowId === floating.windowId);
    if (nativeFloating && nativeFloating.presentation !== "normal") {
      const current = (await this.#input.core.invoke({ type: "appSnapshot" })).logicalWindows.find(w => w.windowId === floating.windowId)!;
      const result = await this.#input.core.invoke({ type: "embeddedWindowPresentation",
        operationId: `${session.start.sessionId}:windowed`, windowId: current.windowId,
        windowGeneration: current.windowGeneration, topologyRevision: current.revision, presentation: "normal" });
      if (result.status === "superseded" || result.status === "cancelled") {
        session.terminal = true;
        await this.#finish(session, "cancel");
        return;
      }
      if (result.status !== "applied") fail("The floating drag host could not leave fullscreen/maximized presentation.");
    }
    const host = this.#host(session, floating.windowId, floating.windowGeneration);
    await host.ready?.(session.start.tabId, session.abort.signal);
    if (session.abort.signal.aborted) return;
    const anchor = host.anchor(session.start.tabId, session.start.ratio);
    const placement = this.#placement(session, point, anchor);
    if (!session.terminal) {
      host.position(session.start.sessionId, placement.bounds, !session.released);
    }
  }

  #placement(session: Session, point: DragPoint, anchor: DragPoint): RuntimeWindowProvisionTargetRecord {
    const topology = this.#input.displays();
    const display = topology.displays.find(d => point.x >= d.bounds.x && point.y >= d.bounds.y &&
      point.x < d.bounds.x + d.bounds.width && point.y < d.bounds.y + d.bounds.height)
      ?? topology.displays.find(d => d.isPrimary);
    if (!display) fail("The drag destination display is unavailable.");
    const area = display.workArea;
    const width = Math.min(Math.max(640, session.bounds.width), area.width);
    const height = Math.min(Math.max(480, session.bounds.height), area.height);
    return { displayId: display.id, scaleFactor: display.scaleFactor, workArea: area, presentation: "normal",
      bounds: { width, height,
        x: Math.round(Math.max(area.x, Math.min(point.x - anchor.x, area.x + area.width - width))),
        y: Math.round(Math.max(area.y, Math.min(point.y - anchor.y, area.y + area.height - height))) } };
  }

  async #move(session: Session, source: Window, target: Window, beforeTabId?: string): Promise<boolean> {
    const tabId = session.start.tabId;
    const ids = target.tabs.map(t => t.id).filter(id => id !== tabId);
    const index = beforeTabId === undefined ? ids.length : ids.indexOf(beforeTabId);
    ids.splice(index < 0 ? ids.length : index, 0, tabId);
    if (source.windowId === target.windowId && ids.every((id, i) => target.tabs[i]?.id === id)) return true;
    const operationId = `${session.start.sessionId}:move:${session.event.sequence}`;
    const appkit = this.#input.appKit;
    const result = appkit ? await appkit.events.moveTab(appkit.factory.captureHostObservations(
      [...new Set([target.windowId, source.windowId])]), {
      sessionId: operationId, sourceWindowId: source.windowId, targetWindowId: target.windowId,
      tabId, orderedTabIds: ids, refreshHosts: true, ...(beforeTabId ? { beforeTabId } : {})
    }) : await this.#input.core.invoke({ type: "embeddedTabMove", operationId, tabId,
      sourceWindowId: source.windowId, sourceWindowGeneration: source.windowGeneration,
      sourceTopologyRevision: source.revision, targetWindowId: target.windowId,
      targetWindowGeneration: target.windowGeneration, targetTopologyRevision: target.revision,
      ...(beforeTabId ? { beforeTabId } : {}) });
    if (result.status === "superseded" || result.status === "cancelled") {
      session.terminal = true;
      await this.#finish(session, "cancel");
      return false;
    }
    if (result.status !== "applied" && result.status !== "degraded") fail("The drag surface transfer did not apply.");
    session.retire.set(source.windowId, source.windowGeneration);
    session.retire.set(target.windowId, target.windowGeneration);
    return true;
  }

  #release(session: Session): void {
    for (const { port } of session.hosts.values()) {
      try { port.release(session.start.sessionId); } catch (error) { this.#input.onError(error); }
    }
  }

  async #finish(session: Session, phase: "end" | "cancel" | "fail"): Promise<void> {
    if (session.finished) return;
    session.finished = true;
    this.#release(session);
    if (this.#session === session) this.#session = null;
    this.#input.onTerminal?.(session.start.sessionId);
    if (session.receipt && !session.receipt.terminal) await this.#admit(session, phase);
    if (phase === "end" && session.receipt?.currentWindowId) {
      await this.#input.core.invoke({ type: "embeddedWindowsShow", windowId: session.receipt.currentWindowId });
    }
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    for (const [id, generation] of session.retire) {
      const window = core.logicalWindows.find(w => w.windowId === id);
      if (!window || window.windowGeneration !== generation || window.tabs.length !== 0) continue;
      await this.#input.core.invoke({ type: "embeddedWindowRetireProvision",
        operationId: `${session.start.sessionId}:retire:${id}`, windowId: window.windowId,
        windowGeneration: window.windowGeneration, topologyRevision: window.revision });
    }
  }
}
