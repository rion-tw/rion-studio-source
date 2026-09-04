import { describe, expect, it, vi } from "vitest";

import type { ChromiumRoleSurfaceParentPort } from
  "../src/electron/main/chromiumRoleSurfacePorts";
import {
  MacosAppKitInputSurfaceAttachmentCoordinator,
  type MacosAppKitInputHostBinding,
  type RawNativeAppKitInputSurfaceHost
} from "../src/electron/main/macosAppKitInputSurfaceAttachmentCoordinator";

function parent(id: number): ChromiumRoleSurfaceParentPort {
  return {
    id,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false
  };
}

function harness() {
  const order: string[] = [];
  let captureSequence = 0;
  let failCommitRole: string | null = null;
  let failCommitWindow: string | null = null;
  let failCancelRole: string | null = null;
  let failRetireRole: string | null = null;
  const owned = new Map<string, number>();
  let focused = false;
  let launcherFocused = false;
  const native: RawNativeAppKitInputSurfaceHost = {
    beginInputSurfaceCapture: (_identity, roleId, surfaceGeneration) => {
      order.push(`begin:${roleId}`);
      captureSequence += 1;
      return {
        roleId,
        surfaceGeneration,
        captureSequence: String(captureSequence),
        observedNodeCount: 2
      };
    },
    commitInputSurfaceCapture: (
      identity,
      roleId,
      surfaceGeneration,
      sequence
    ) => {
      order.push(`commit:${roleId}`);
      if (
        failCommitRole === roleId &&
        (failCommitWindow === null || failCommitWindow === identity.logicalWindowId)
      ) {
        throw new Error("commit failed");
      }
      owned.set(roleId, surfaceGeneration);
      return {
        roleId,
        surfaceGeneration,
        nativeGeneration: identity.nativeGeneration,
        captureSequence: sequence
      };
    },
    cancelInputSurfaceCapture: (_identity, roleId) => {
      order.push(`cancel:${roleId}`);
      return failCancelRole !== roleId;
    },
    retireInputSurface: (_identity, roleId, generation) => {
      order.push(`retire:${roleId}`);
      if (failRetireRole === roleId) return false;
      if (owned.get(roleId) !== generation) return false;
      owned.delete(roleId);
      return true;
    }
  };
  const binding: MacosAppKitInputHostBinding = {
    identity: {
      logicalWindowId: "window-1",
      launchGeneration: "launch-1",
      nativeGeneration: 1
    },
    native,
    focus: () => {
      order.push("focus:window-1");
      focused = true;
    },
    isFocused: () => focused
  };
  const host = parent(1);
  const targetHost = parent(2);
  const targetBinding: MacosAppKitInputHostBinding = {
    identity: {
      logicalWindowId: "window-2",
      launchGeneration: "launch-2",
      nativeGeneration: 2
    },
    native,
    focus: () => order.push("focus:window-2"),
    isFocused: () => false
  };
  const coordinator = new MacosAppKitInputSurfaceAttachmentCoordinator({
    resolve: (candidate) => candidate === host
      ? binding
      : candidate === targetHost ? targetBinding : null,
    shouldRestoreInitialFocus: () => launcherFocused
  });
  const input = (roleId: string) => ({
    roleId,
    generation: 1,
    parent: host,
    isCancelled: () => false,
    attach: () => order.push(`add:${roleId}`),
    detach: () => order.push(`remove:${roleId}`)
  });
  return {
    binding,
    coordinator,
    input,
    native,
    order,
    owned,
    targetBinding,
    targetHost,
    setCommitFailure: (roleId: string | null, windowId: string | null = null) => {
      failCommitRole = roleId;
      failCommitWindow = windowId;
    },
    setCancelFailure: (roleId: string | null) => { failCancelRole = roleId; },
    setFocused: (value: boolean) => { focused = value; },
    setLauncherFocused: (value: boolean) => { launcherFocused = value; },
    setRetireFailure: (roleId: string | null) => { failRetireRole = roleId; }
  };
}

describe("macOS AppKit input-surface attachment coordinator", () => {
  it("serializes two concurrent role captures across the entire native add interval", async () => {
    const subject = harness();
    const first = subject.coordinator.attach(subject.input("role-1"));
    const second = subject.coordinator.attach(subject.input("role-2"));

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(subject.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1",
      "begin:role-2", "add:role-2", "commit:role-2"
    ]);
    expect(subject.owned).toEqual(new Map([["role-1", 1], ["role-2", 1]]));
    expect(subject.coordinator.resolveOwnedInputHost("role-1", 1))
      .toBe(subject.binding);
    expect(subject.coordinator.resolveOwnedInputHost("role-1", 2)).toBeNull();
  });

  it("reasserts exact foreground ownership after attachment before a queued blur", async () => {
    const foreground = harness();
    foreground.setFocused(true);
    await foreground.coordinator.attach(foreground.input("role-1"));
    expect(foreground.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1", "focus:window-1"
    ]);

    const background = harness();
    await background.coordinator.attach(background.input("role-1"));
    expect(background.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1"
    ]);
  });

  it("settles a captured focus lease at initial load only from the same-app launcher", async () => {
    const subject = harness();
    subject.setFocused(true);
    await subject.coordinator.attach(subject.input("role-1"));
    subject.setFocused(false);
    subject.setLauncherFocused(true);

    subject.coordinator.initialLoadCommitted(
      "role-1",
      1,
      subject.input("x").parent
    );
    expect(subject.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1",
      "focus:window-1", "focus:window-1"
    ]);

    subject.coordinator.initialLoadCommitted(
      "role-1",
      1,
      subject.input("x").parent
    );
    expect(subject.order.filter((entry) => entry === "focus:window-1"))
      .toHaveLength(2);

    const external = harness();
    external.setFocused(true);
    await external.coordinator.attach(external.input("role-1"));
    external.setFocused(false);
    external.coordinator.initialLoadCommitted(
      "role-1",
      1,
      external.input("x").parent
    );
    expect(external.order.filter((entry) => entry === "focus:window-1"))
      .toHaveLength(1);
  });

  it("serializes a non-input Web surface add between role capture intervals", async () => {
    const subject = harness();
    const first = subject.coordinator.attach(subject.input("role-1"));
    const web = subject.coordinator.attachNonInputSurface({
      surfaceId: "global-web-1",
      generation: 1,
      parent: subject.input("x").parent,
      isCancelled: () => false,
      attach: () => subject.order.push("add:global-web-1"),
      detach: () => subject.order.push("remove:global-web-1")
    });
    const second = subject.coordinator.attach(subject.input("role-2"));

    await expect(Promise.all([first, web, second])).resolves.toHaveLength(3);
    expect(subject.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1",
      "add:global-web-1",
      "begin:role-2", "add:role-2", "commit:role-2"
    ]);
    await subject.coordinator.detachNonInputSurface(
      "global-web-1",
      1,
      subject.input("x").parent
    );
    expect(subject.order.at(-1)).toBe("remove:global-web-1");
  });

  it("rolls back and cancels a failed first capture before the second begins", async () => {
    const subject = harness();
    subject.setCommitFailure("role-1");
    const first = subject.coordinator.attach(subject.input("role-1"));
    const second = subject.coordinator.attach(subject.input("role-2"));

    await expect(first).rejects.toThrow("commit failed");
    await expect(second).resolves.toBeUndefined();
    expect(subject.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1", "remove:role-1",
      "cancel:role-1", "begin:role-2", "add:role-2", "commit:role-2"
    ]);
  });

  it("retires the source before capturing the exact target host", async () => {
    const subject = harness();
    await subject.coordinator.attach(subject.input("role-1"));
    subject.order.splice(0);

    await expect(subject.coordinator.reparent({
      roleId: "role-1",
      generation: 1,
      sourceParent: subject.input("x").parent,
      targetParent: subject.targetHost,
      isCancelled: () => false,
      detachSource: () => subject.order.push("remove:source"),
      attachTarget: () => subject.order.push("add:target"),
      detachTarget: () => subject.order.push("remove:target"),
      restoreSource: () => subject.order.push("restore:source")
    })).resolves.toBeUndefined();
    expect(subject.order).toEqual([
      "retire:role-1", "remove:source",
      "begin:role-1", "add:target", "commit:role-1"
    ]);
    expect(subject.coordinator.resolveOwnedInputHost("role-1", 1))
      .toBe(subject.targetBinding);
  });

  it("recaptures source ownership when target AppKit capture fails", async () => {
    const subject = harness();
    await subject.coordinator.attach(subject.input("role-1"));
    subject.order.splice(0);
    subject.setCommitFailure("role-1", "window-2");

    await expect(subject.coordinator.reparent({
      roleId: "role-1",
      generation: 1,
      sourceParent: subject.input("x").parent,
      targetParent: subject.targetHost,
      isCancelled: () => false,
      detachSource: () => subject.order.push("remove:source"),
      attachTarget: () => subject.order.push("add:target"),
      detachTarget: () => subject.order.push("remove:target"),
      restoreSource: () => subject.order.push("restore:source")
    })).rejects.toThrow("commit failed");
    expect(subject.order).toEqual([
      "retire:role-1", "remove:source",
      "begin:role-1", "add:target", "commit:role-1", "remove:target",
      "cancel:role-1",
      "begin:role-1", "restore:source", "commit:role-1"
    ]);
    expect(subject.owned).toEqual(new Map([["role-1", 1]]));
    expect(subject.coordinator.resolveOwnedInputHost("role-1", 1))
      .toBe(subject.binding);
  });

  it("restores source ownership when the target host closes before capture", async () => {
    const subject = harness();
    await subject.coordinator.attach(subject.input("role-1"));
    subject.order.splice(0);
    const move = subject.coordinator.reparent({
      roleId: "role-1",
      generation: 1,
      sourceParent: subject.input("x").parent,
      targetParent: subject.targetHost,
      isCancelled: () => false,
      detachSource: () => subject.order.push("remove:source"),
      attachTarget: () => subject.order.push("add:target"),
      detachTarget: () => subject.order.push("remove:target"),
      restoreSource: () => subject.order.push("restore:source")
    });
    await subject.coordinator.closeHost(subject.targetBinding);

    await expect(move).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_CLOSED"
    });
    expect(subject.order).toEqual([
      "retire:role-1", "remove:source",
      "begin:role-1", "restore:source", "commit:role-1"
    ]);
    expect(subject.owned).toEqual(new Map([["role-1", 1]]));
  });

  it("cancels queued attachment when the exact host starts closing", async () => {
    const subject = harness();
    const queued = subject.coordinator.attach(subject.input("role-1"));
    const closing = subject.coordinator.closeHost(subject.binding);

    await expect(queued).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_CANCELLED"
    });
    await expect(closing).resolves.toBeUndefined();
    expect(subject.order).toEqual([]);
  });

  it("retires exact owned generations and rejects a stale host binding", async () => {
    const subject = harness();
    await subject.coordinator.attach(subject.input("role-1"));
    await expect(subject.coordinator.retire("role-1", 1, subject.input("x").parent))
      .resolves.toBeUndefined();
    expect(subject.order.at(-1)).toBe("retire:role-1");
    expect(subject.coordinator.resolveOwnedInputHost("role-1", 1)).toBeNull();

    await expect(subject.coordinator.closeHost({
      ...subject.binding,
      native: { ...subject.native }
    })).rejects.toMatchObject({ code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_STALE" });
  });

  it("keeps failed host-close retirement quarantined until an exact retry succeeds", async () => {
    const subject = harness();
    await subject.coordinator.attach(subject.input("role-1"));
    subject.setRetireFailure("role-1");

    await expect(subject.coordinator.closeHost(subject.binding)).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_RETIRE_FAILED"
    });
    await expect(subject.coordinator.closeHost(subject.binding)).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_RETIRE_FAILED"
    });
    expect(subject.owned).toEqual(new Map([["role-1", 1]]));
    expect(subject.order.filter((entry) => entry === "retire:role-1"))
      .toHaveLength(2);

    subject.setRetireFailure(null);
    await expect(subject.coordinator.closeHost(subject.binding))
      .resolves.toBeUndefined();
    expect(subject.owned).toEqual(new Map());
    await expect(subject.coordinator.closeHost(subject.binding))
      .resolves.toBeUndefined();
  });

  it("quarantines a failed capture rollback and rejects every later capture", async () => {
    const subject = harness();
    subject.setCommitFailure("role-1");
    subject.setCancelFailure("role-1");

    await expect(subject.coordinator.attach(subject.input("role-1")))
      .rejects.toMatchObject({
        code: "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_ROLLBACK_FAILED"
      });
    await expect(subject.coordinator.attach(subject.input("role-2")))
      .rejects.toMatchObject({
        code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_QUARANTINED"
      });
    expect(subject.order).toEqual([
      "begin:role-1", "add:role-1", "commit:role-1", "remove:role-1",
      "cancel:role-1"
    ]);

    subject.setCancelFailure(null);
    await expect(subject.coordinator.closeHost(subject.binding))
      .resolves.toBeUndefined();
    expect(subject.order.at(-1)).toBe("cancel:role-1");
  });

  it("retries an exact non-input detach instead of converting failure to success", async () => {
    const subject = harness();
    let detachAttempts = 0;
    await subject.coordinator.attachNonInputSurface({
      surfaceId: "global-web-1",
      generation: 1,
      parent: subject.input("x").parent,
      isCancelled: () => false,
      attach: vi.fn(),
      detach: () => {
        detachAttempts += 1;
        if (detachAttempts === 1) throw new Error("detach failed");
      }
    });

    await expect(subject.coordinator.closeHost(subject.binding)).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_RETIRE_FAILED"
    });
    expect(detachAttempts).toBe(1);
    await expect(subject.coordinator.closeHost(subject.binding))
      .resolves.toBeUndefined();
    expect(detachAttempts).toBe(2);
  });
});
