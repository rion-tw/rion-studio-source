import { app, type Input, type WebContents } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ChromiumManagedShortcutCoordinator } from "../main/chromiumManagedShortcutCoordinator";
import { MacosAppKitInputSurfaceAttachmentCoordinator,
  type MacosAppKitInputHostBinding } from "../main/macosAppKitInputSurfaceAttachmentCoordinator";

const capacity = 2_048;
let installed = false;

/** Diagnostic branch only: no input, focus, await, timer, or acknowledgement mutation. */
export function installAppKitFunctionKeyObserver(): void {
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (installed || process.platform !== "darwin" || !directory || !isAbsolute(directory)) return;
  installed = true;
  type Coordinator = MacosAppKitInputSurfaceAttachmentCoordinator;
  type Identity = MacosAppKitInputHostBinding["identity"];
  interface Owner {
    coordinator: Coordinator;
    binding: MacosAppKitInputHostBinding;
    identity: Identity;
    roleId: string;
    generation: number;
    parentNativeHostId: number;
  }
  const owners = new Map<string, Owner>();
  const contentsByRole = new Map<string, WebContents>();
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 1;
  let sequence = 0;
  let dropped = 0;
  const records: unknown[] = [];
  const errorDetails = (error: unknown) => ({
    name: error instanceof Error ? error.name : typeof error,
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  });
  const safe = (operation: () => void): void => {
    try { operation(); } catch { /* Observability cannot alter product terminality. */ }
  };
  const objectId = (value: object): number => {
    let id = objectIds.get(value);
    if (id === undefined) { id = nextObjectId++; objectIds.set(value, id); }
    return id;
  };
  const record = (stage: string, details: unknown): void => safe(() => {
    // Copy now: the producer may reuse a mutable Input or native receipt object.
    records.push({ sequence: ++sequence, capturedAt: new Date().toISOString(), stage,
      details: JSON.parse(JSON.stringify(details)) as unknown });
    if (records.length > capacity) { records.shift(); dropped++; }
  });
  const flush = (stage: string): void => safe(() => {
    writeFileSync(join(directory, "electron-appkit-function-key-observations.json"),
      `${JSON.stringify({ journalVersion: 1, capacity, dropped, flushedAt: new Date().toISOString(),
        flushStage: stage, records }, null, 2)}\n`, "utf8");
  });
  const ownerDetails = (owner: Owner) => ({
    roleId: owner.roleId, generation: owner.generation,
    parentNativeHostId: owner.parentNativeHostId, identity: owner.identity,
    nativeObjectId: objectId(owner.binding.native), coordinatorObjectId: objectId(owner.coordinator),
    webContentsId: contentsByRole.get(owner.roleId)?.id ?? null
  });
  const exactBinding = (binding: MacosAppKitInputHostBinding | null, owner: Owner): boolean =>
    binding === owner.binding && binding.native === owner.binding.native &&
    binding.identity.logicalWindowId === owner.identity.logicalWindowId &&
    binding.identity.launchGeneration === owner.identity.launchGeneration &&
    binding.identity.nativeGeneration === owner.identity.nativeGeneration;
  const attachments = MacosAppKitInputSurfaceAttachmentCoordinator.prototype;
  const resolve = attachments.resolveOwnedInputHost;
  const capture = (stage: string, owner: Owner): void => safe(() => {
    const identity = ownerDetails(owner);
    try {
      const before = resolve.call(owner.coordinator, owner.roleId, owner.generation);
      if (!exactBinding(before, owner)) {
        record(stage, { ...identity, currentOwner: false, probe: null });
        return;
      }
      const probe = owner.binding.native.probeCdpInputSurface(owner.identity, owner.roleId, owner.generation);
      const after = resolve.call(owner.coordinator, owner.roleId, owner.generation);
      record(stage, { ...identity, currentOwnerBefore: true, currentOwnerAfter: exactBinding(after, owner),
        receiptIdentityMatches: probe.roleId === owner.roleId && probe.surfaceGeneration === owner.generation &&
          probe.nativeGeneration === owner.identity.nativeGeneration,
        bindingFocused: owner.binding.isFocused(), probe });
    } catch (error) { record(stage, { ...identity, probeError: errorDetails(error) }); }
  });
  const captureAll = (stage: string): void => safe(() => {
    for (const owner of owners.values()) capture(stage, owner);
    record(stage, { retainedOwnerCount: owners.size });
    flush(stage);
  });
  const observe = <Value>(work: Promise<Value>, completed: (value: Value) => void,
    rejected: (error: unknown) => void): void => safe(() => {
    // Observe the original promise without replacing it or leaking a rejected child.
    void work.then(value => safe(() => completed(value)), error => safe(() => rejected(error)))
      .catch(() => undefined);
  });

  app.on("web-contents-created", (_event, contents) => safe(() => {
    const path = contents.session.storagePath;
    const roleId = typeof path === "string"
      ? /(?:^|\/)roles\/([^/]+)\/browser\/chromium$/u.exec(path.replaceAll("\\", "/"))?.[1] : undefined;
    if (!roleId || contentsByRole.size >= 256) return;
    contentsByRole.set(roleId, contents);
    contents.on("before-input-event", (_inputEvent, input: Input) => safe(() => {
      if (!/^(?:F(?:[1-9]|1[0-2])|ControlLeft|ControlRight)$/u.test(input.code) &&
          !/^(?:F(?:[1-9]|1[0-2])|Control)$/u.test(input.key)) return;
      const owner = owners.get(roleId);
      record("role-before-input", { roleId, webContentsId: contents.id,
        currentRoleContents: contentsByRole.get(roleId) === contents,
        owner: owner ? ownerDetails(owner) : null, input: { ...input } });
    }));
    contents.once("destroyed", () => safe(() => {
      record("role-destroyed", { roleId, webContentsId: contents.id });
      if (contentsByRole.get(roleId) === contents) contentsByRole.delete(roleId);
      flush("role-destroyed");
    }));
  }));

  const attach = attachments.attach;
  attachments.attach = function (...args) {
    const work = Reflect.apply(attach, this, args) as ReturnType<typeof attach>;
    observe(work, () => {
      const input = args[0];
      const binding = resolve.call(this, input.roleId, input.generation);
      if (!binding) { record("attach-owner-missing", { roleId: input.roleId, generation: input.generation }); return; }
      const owner: Owner = { coordinator: this, binding, identity: Object.freeze({ ...binding.identity }),
        roleId: input.roleId, generation: input.generation, parentNativeHostId: input.parent.id };
      if (owners.size >= 256 && !owners.has(input.roleId)) {
        record("owner-capacity", { roleId: input.roleId });
        return;
      }
      owners.set(input.roleId, owner);
      record("attach-owner", ownerDetails(owner));
    }, error => { record("attach-rejected", { roleId: args[0].roleId, error: errorDetails(error) }); flush("attach-rejected"); });
    return work;
  };
  const loaded = attachments.initialLoadCommitted;
  attachments.initialLoadCommitted = function (...args) {
    const result = Reflect.apply(loaded, this, args);
    safe(() => {
      const owner = owners.get(args[0]);
      if (owner?.coordinator === this && owner.generation === args[1]) capture("initial-load-committed", owner);
    });
    return result;
  };
  const retire = attachments.retire;
  attachments.retire = function (...args) {
    const owner = owners.get(args[0]);
    safe(() => {
      if (owner?.coordinator === this && owner.generation === args[1]) capture("retire-begin", owner);
      flush("retire-begin");
    });
    const work = Reflect.apply(retire, this, args) as ReturnType<typeof retire>;
    observe(work, () => {
      record("retire-completed", { roleId: args[0], generation: args[1] });
      if (owners.get(args[0]) === owner) owners.delete(args[0]);
      flush("retire-completed");
    }, error => { record("retire-rejected", { roleId: args[0], generation: args[1], error: errorDetails(error) });
      flush("retire-rejected"); });
    return work;
  };
  const closeHost = attachments.closeHost;
  attachments.closeHost = function (...args) {
    const closing: Owner[] = [];
    safe(() => {
      for (const owner of owners.values()) {
        if (owner.coordinator === this && exactBinding(args[0], owner)) {
          closing.push(owner);
          capture("close-host-begin", owner);
        }
      }
      flush("close-host-begin");
    });
    const work = Reflect.apply(closeHost, this, args) as ReturnType<typeof closeHost>;
    observe(work, () => {
      for (const owner of closing) if (owners.get(owner.roleId) === owner) owners.delete(owner.roleId);
      record("close-host-completed", { identity: args[0].identity });
      flush("close-host-completed");
    }, error => { record("close-host-rejected", { identity: args[0].identity, error: errorDetails(error) });
      flush("close-host-rejected"); });
    return work;
  };

  const shortcuts = ChromiumManagedShortcutCoordinator.prototype;
  const dispatch = shortcuts.dispatch;
  shortcuts.dispatch = function (...args) {
    const [frame, request] = args;
    let details: unknown = { observationUnavailable: true };
    safe(() => {
      const owner = owners.get(frame.roleId);
      const raw = typeof request === "object" && request !== null
        ? request as Record<string, unknown> : {};
      details = { frame: { roleId: frame.roleId, generation: frame.generation,
        documentInstanceId: frame.documentInstanceId, frameToken: frame.frameToken,
        nativeFrameObjectId: objectId(frame.frame) }, request: {
        code: raw.code, macroId: raw.macroId, phase: raw.phase, shortcutCycleId: raw.shortcutCycleId,
        modifierCodes: Array.isArray(raw.modifierCodes) ? raw.modifierCodes.slice(0, 8) : null
      }, coordinatorObjectId: objectId(this), owner: owner ? ownerDetails(owner) : null };
      record("managed-shortcut-start", details);
    });
    let work: ReturnType<typeof dispatch>;
    try { work = Reflect.apply(dispatch, this, args) as ReturnType<typeof dispatch>; }
    catch (error) {
      record("managed-shortcut-threw", { input: details, error: errorDetails(error) });
      flush("managed-shortcut-threw");
      throw error;
    }
    observe(work, receipt => record("managed-shortcut-completed", { input: details, receipt }), error => {
      record("managed-shortcut-rejected", { input: details, error: errorDetails(error) });
      flush("managed-shortcut-rejected");
    });
    return work;
  };
  app.on("before-quit", () => captureAll("application-before-quit"));
  app.on("will-quit", () => captureAll("application-will-quit"));
}
