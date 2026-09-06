import { ChromiumViewInputSubmission, type ChromiumViewInputIdentity,
  type ChromiumViewInputObservation } from "./chromiumViewInputSubmission";
import type { ChromiumRoleSurfaceNativeAttachmentInput, ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceNativePresentationInput, ChromiumRoleSurfaceNativeReparentInput,
  ChromiumRoleSurfaceNativeRetirementInput, ChromiumRoleSurfaceParentPort,
  ChromiumRoleWebContentsViewPort } from "./chromiumRoleSurfacePorts";

export interface ChromiumViewParentBinding {
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly nativeGeneration: number;
  readonly revision: string;
  readonly children: () => readonly unknown[];
  readonly read: () => Readonly<{
    parentIdentity: string; focusIdentity: string; parentForeground: boolean;
    parentVisible: boolean; parentMinimized: boolean; focusedWebContentsId: number | null;
  }>;
  readonly contentsFocused: (view: ChromiumRoleWebContentsViewPort) => boolean;
  readonly subscribe: (listener: (event: "changed" | "focused" | "closed") => void) => () => void;
}

type PresentationListener = (event: Readonly<{
  roleId: string; surfaceGeneration: number; visible: boolean; previousVisible: boolean;
}>) => void;
type ParentResolver = (parent: ChromiumRoleSurfaceParentPort) => ChromiumViewParentBinding | null;

interface Record {
  readonly logicalParent: ChromiumRoleSurfaceParentPort;
  readonly binding: ChromiumViewParentBinding;
  readonly view: ChromiumRoleWebContentsViewPort;
  readonly identity: ChromiumViewInputIdentity;
  readonly input: ChromiumViewInputSubmission;
  readonly observe: () => ChromiumViewInputObservation;
  unsubscribe: () => void;
  visible: boolean;
  state: "active" | "moving" | "retired" | "quarantined";
}

/** Exact View lifetime ownership. This owner never creates or closes a parent window. */
export class ChromiumViewAttachmentCoordinator implements ChromiumRoleSurfaceNativeAttachmentPort {
  readonly #records = new Map<string, Record>();
  readonly #rolesByContents = new WeakMap<object, string>();
  readonly #invalidations = new Set<(roleId: string, generation: number) => void>();
  readonly #presentations = new Set<PresentationListener>();
  readonly #resolveParent: ParentResolver;
  readonly #nowMs: () => number;
  readonly #onError: (error: unknown) => void;
  #revision = 0n;
  #disposed = false;

  constructor(input: { resolveParent: ParentResolver;
    nowMs: () => number; onError: (error: unknown) => void }) {
    this.#resolveParent = input.resolveParent;
    this.#nowMs = input.nowMs;
    this.#onError = input.onError;
  }

  async attach(input: ChromiumRoleSurfaceNativeAttachmentInput): Promise<void> {
    if (this.#disposed || this.#records.has(input.roleId) || !input.view || !input.attachTo ||
        this.#rolesByContents.has(input.view.webContents)) {
      throw new Error("Chromium View attachment has no unique live owner.");
    }
    const record = this.#create(input.roleId, input.generation, input.parent, input.view);
    if (input.isCancelled()) throw new Error("Chromium View attachment was cancelled.");
    let attempted = false;
    try {
      attempted = true;
      input.attachTo(record.binding.parent);
      this.#requireMembership(record);
      if (input.isCancelled()) throw new Error("Chromium View attachment was cancelled before commit.");
      this.#records.set(input.roleId, record);
      this.#rolesByContents.set(record.view.webContents, input.roleId);
      this.#subscribe(record);
    } catch (error) {
      if (attempted) {
        try {
          input.detach();
          if (record.binding.children().includes(record.view)) throw new Error("View rollback remained attached.", { cause: error });
          this.#records.delete(input.roleId);
          this.#rolesByContents.delete(record.view.webContents);
          record.unsubscribe();
          record.state = "retired";
        } catch (rollback) {
          this.#records.set(input.roleId, record);
          this.#rolesByContents.set(record.view.webContents, input.roleId);
          this.#quarantine(record, rollback);
        }
      }
      throw error;
    }
  }

  async reparent(input: ChromiumRoleSurfaceNativeReparentInput): Promise<void> {
    const source = this.#requireRecord(input.roleId, input.generation);
    if (source.logicalParent !== input.sourceParent || source.view !== input.view ||
        !input.attachTargetTo || !input.restoreSourceTo) throw new Error("Chromium View move is stale.");
    const target = this.#create(input.roleId, input.generation, input.targetParent, source.view);
    if (input.isCancelled()) throw new Error("Chromium View move was cancelled.");
    let detached = false;
    let targetAttempted = false;
    try {
      source.state = "moving";
      this.#invalidate(source);
      source.unsubscribe();
      detached = true;
      input.detachSource();
      if (source.binding.children().includes(source.view)) throw new Error("Source View did not detach.");
      targetAttempted = true;
      input.attachTargetTo(target.binding.parent);
      this.#requireMembership(target);
      if (input.isCancelled()) throw new Error("Chromium View move was cancelled before commit.");
      source.unsubscribe();
      source.state = "retired";
      this.#records.set(input.roleId, target);
      this.#subscribe(target);
    } catch (error) {
      try {
        target.unsubscribe();
        if (targetAttempted) input.detachTarget();
        if (targetAttempted && target.binding.children().includes(target.view)) throw new Error("Target rollback remained attached.", { cause: error });
        target.unsubscribe();
        target.state = "retired";
        if (detached && !source.binding.children().includes(source.view)) input.restoreSourceTo(source.binding.parent);
        this.#requireMembership(source);
        if (source.view.getVisible() !== source.visible) source.view.setVisible(source.visible);
        if (source.view.getVisible() !== source.visible) throw new Error("Source visibility did not restore.", { cause: error });
        source.state = "active";
        this.#records.set(input.roleId, source);
        source.unsubscribe();
        this.#subscribe(source);
      } catch (rollback) {
        target.unsubscribe();
        this.#records.set(input.roleId, source);
        this.#quarantine(source, rollback);
      }
      throw error;
    }
  }

  async retire(roleId: string, generation: number, parent: ChromiumRoleSurfaceParentPort,
    physical?: ChromiumRoleSurfaceNativeRetirementInput): Promise<void> {
    const record = this.#records.get(roleId);
    if (!record) return;
    if (record.identity.surfaceGeneration !== generation || record.logicalParent !== parent ||
        (!physical && record.binding.parent !== parent) ||
        (physical && (physical.view !== record.view || physical.physicalParent !== record.binding.parent))) {
      throw new Error("Chromium View retirement is stale.");
    }
    this.#invalidate(record);
    // The registry detaches after retirement when logical and physical parents
    // are identical; otherwise its exact physical callback owns the detach.
    if (physical) {
      try {
        physical.detach();
        if (record.binding.children().includes(record.view)) throw new Error("Retired View remained attached.");
      } catch (error) {
        this.#quarantine(record, error);
        throw error;
      }
    }
    record.state = "retired";
    record.unsubscribe();
    this.#records.delete(roleId);
    this.#rolesByContents.delete(record.view.webContents);
  }

  syncPresentation(input: ChromiumRoleSurfaceNativePresentationInput): void {
    const record = this.#requireRecord(input.roleId, input.generation);
    if (record.logicalParent !== input.parent || record.binding.parent !== input.physicalParent ||
        record.view !== input.view) throw new Error("Chromium View presentation is stale.");
    this.#publish(record);
  }

  resolve(roleId: string, generation: number) {
    try {
      const record = this.#requireRecord(roleId, generation);
      return Object.freeze({ identity: record.identity, input: record.input, observe: record.observe });
    } catch { return null; }
  }

  resolveFocusTarget(roleId: string, generation: number) {
    try {
      const record = this.#requireRecord(roleId, generation);
      return { identity: record.identity, input: record.input, observe: record.observe,
        view: record.view, binding: record.binding, logicalParent: record.logicalParent };
    } catch { return null; }
  }

  subscribeInvalidation(listener: (roleId: string, generation: number) => void): () => void {
    if (this.#disposed) throw new Error("Chromium View owner is disposed.");
    this.#invalidations.add(listener);
    return () => { this.#invalidations.delete(listener); };
  }

  subscribePresentation(listener: PresentationListener): () => void {
    if (this.#disposed) throw new Error("Chromium View owner is disposed.");
    this.#presentations.add(listener);
    return () => this.#presentations.delete(listener);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const record of this.#records.values()) {
      this.#invalidate(record);
      record.unsubscribe();
      record.state = "retired";
      this.#rolesByContents.delete(record.view.webContents);
    }
    this.#records.clear();
    this.#presentations.clear();
    this.#invalidations.clear();
  }

  #create(roleId: string, generation: number, logicalParent: ChromiumRoleSurfaceParentPort,
    view: ChromiumRoleWebContentsViewPort): Record {
    const candidate = this.#resolveParent(logicalParent);
    if (!candidate || candidate.parent.isDestroyed() || this.#revision >= 18_446_744_073_709_551_615n) {
      throw new Error("Chromium View has no current parent binding.");
    }
    const binding = Object.freeze({ ...candidate });
    if (!/^[1-9][0-9]*$/u.test(binding.revision)) throw new Error("Chromium View parent revision is invalid.");
    const native = binding.read();
    const identity = Object.freeze({ roleId, surfaceGeneration: generation,
      nativeGeneration: binding.nativeGeneration, bindingRevision: String(++this.#revision),
      parentIdentity: native.parentIdentity, webContentsId: view.webContents.id! });
    const record = {} as Record;
    const observe = (): ChromiumViewInputObservation => {
      this.#requireRecord(roleId, generation, record);
      const parent = binding.read();
      return { identity: { ...identity, parentIdentity: parent.parentIdentity }, ...parent,
        viewAttached: binding.children().includes(view), viewVisible: view.getVisible(),
        contentsDestroyed: view.webContents.isDestroyed(), contentsFocused: binding.contentsFocused(view),
        bounds: view.getBounds(), zoomFactor: view.webContents.getZoomFactor() };
    };
    const contents = view.webContents;
    const input = new ChromiumViewInputSubmission({ identity, nowMs: this.#nowMs, observe,
      contents: { get id() { return contents.id!; }, isDestroyed: () => contents.isDestroyed(),
        sendInputEvent(event) {
          if (!contents.sendInputEvent) throw new Error("Chromium input API is unavailable.");
          contents.sendInputEvent(event);
        } } });
    Object.assign(record, { logicalParent, binding, view, identity, input, observe,
      unsubscribe: () => {}, visible: view.getVisible(), state: "active" });
    return record;
  }

  #requireRecord(roleId: string, generation: number, exact?: Record): Record {
    const record = this.#records.get(roleId);
    if (this.#disposed || !record || record.state !== "active" || (exact && exact !== record) ||
        record.identity.surfaceGeneration !== generation) throw new Error("Chromium View binding was superseded.");
    this.#requireMembership(record);
    return record;
  }

  #requireMembership(record: Record): void {
    const current = this.#resolveParent(record.logicalParent);
    if (!current || current.parent !== record.binding.parent ||
        current.nativeGeneration !== record.binding.nativeGeneration || current.revision !== record.binding.revision ||
        current.parent.isDestroyed() || record.view.webContents.isDestroyed() || current.children().filter(view => view === record.view).length !== 1) {
      throw new Error("Chromium View lost exact parent membership.");
    }
  }

  #subscribe(record: Record): void {
    const destroyed = () => this.#quarantine(record, new Error("Chromium View contents were destroyed."));
    let unsubscribeParent = () => {};
    record.unsubscribe = () => {
      unsubscribeParent();
      record.view.webContents.removeListener("destroyed", destroyed);
    };
    record.view.webContents.on("destroyed", destroyed);
    try {
      unsubscribeParent = record.binding.subscribe(event => {
        if (record.state !== "active") return;
        try {
          if (event === "closed") throw new Error("Chromium View parent closed before retirement.");
          this.#requireRecord(record.identity.roleId, record.identity.surfaceGeneration, record);
          this.#publish(record);
        } catch (error) { this.#quarantine(record, error); }
      });
      if (record.state !== "active") throw new Error("Chromium View parent retired during subscription.");
    } catch (error) {
      record.unsubscribe();
      throw error;
    }
  }

  #publish(record: Record): void {
    const visible = record.view.getVisible();
    if (visible === record.visible) return;
    const previousVisible = record.visible;
    record.visible = visible;
    for (const listener of this.#presentations) listener({ roleId: record.identity.roleId,
      surfaceGeneration: record.identity.surfaceGeneration, visible, previousVisible });
  }

  #invalidate(record: Record): void {
    for (const listener of this.#invalidations) listener(record.identity.roleId, record.identity.surfaceGeneration);
  }

  #quarantine(record: Record, error: unknown): void {
    if (record.state === "retired" || record.state === "quarantined") return;
    record.state = "quarantined";
    this.#invalidate(record);
    record.unsubscribe();
    try { record.view.setVisible(false); } catch { /* Retain quarantine if native state is unknown. */ }
    this.#onError(error);
  }
}
