import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CoreEffectRequest } from "../src/shared/generated";
import type {
  ChromeProfileImportFreshVerificationReceiptInternal,
  ChromeProfileImportJournalPhaseInternal,
  ChromeProfileImportTransactionDescriptorInternal,
  ChromeProfileImportTransactionFenceInternal
} from "../src/electron/core/coreAddonClient";
import {
  ChromeProfileImportCoordinator,
  type ChromeProfileImportCoordinatorCorePort
} from "../src/electron/main/chromeProfileImportCoordinator";

const roleId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const verifierId = "44444444-4444-4444-8444-444444444444";
const chromiumPath = `/RionData/roles/${roleId}/browser/chromium`;
const payload = Buffer.from(JSON.stringify({
  cookies: [{
    name: "sid",
    value: "secret-cookie",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  }],
  localStorage: [{ key: "session", value: "secret-storage" }]
}), "utf8");
const emptyBackup = Buffer.from(JSON.stringify({ cookies: [], localStorage: [] }), "utf8");

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor(
  phase: ChromeProfileImportJournalPhaseInternal,
  revision: number
): ChromeProfileImportTransactionDescriptorInternal {
  return {
    contractVersion: 1,
    leaseId,
    operationId: `chrome-profile-import-${transactionId}`,
    transactionId,
    roleId,
    journalPhase: phase,
    journalRevision: revision,
    launchUrl: "https://game.example/play",
    launchOrigin: "https://game.example",
    replaceExisting: false,
    createdRole: true,
    rolePaths: {
      browserUserDataDir: `/RionData/roles/${roleId}/browser`,
      systemBrowserDataDir: `/RionData/roles/${roleId}/browser/system`,
      webview2UserDataDir: `/RionData/roles/${roleId}/browser/webview2`,
      chromiumUserDataDir: chromiumPath,
      webkitDataStoreKey: `role-${roleId}`,
      webkitDataStoreIdentifier: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    },
    chromiumPathSha256: digest(Buffer.from(chromiumPath)),
    stagingSha256: "5".repeat(64),
    stagingBytes: 512,
    cookieCount: 1,
    localStorageCount: 1,
    unsupported: {
      partitionedCookieCount: 0,
      appBoundCookieCount: 0,
      decryptFailureCount: 0,
      storageReadFailureCount: 0
    },
    warnings: []
  };
}

function commonAction(phase: string, revision: number) {
  return {
    transactionId,
    roleId,
    chromiumUserDataDir: chromiumPath,
    journalPhase: phase,
    journalRevision: BigInt(revision)
  };
}

function effect(action: CoreEffectRequest["action"]): CoreEffectRequest {
  return {
    effectId: "effect-1",
    operationId: "operation-1",
    target: { kind: "app", handleId: roleId },
    completionPolicy: "eventBound",
    action
  };
}

class FakeCore implements ChromeProfileImportCoordinatorCorePort {
  current = descriptor("prepared", 1);
  readonly capability = Buffer.alloc(32, 7);
  readonly launchKinds: string[] = [];
  readonly helperSignals: Array<AbortSignal | undefined> = [];
  readonly release = vi.fn(async () => undefined);
  lastSnapshotSecret: Buffer | null = null;

  async acquireChromeProfileImportTransactionInternal() {
    return this.current;
  }

  async refreshChromeProfileImportTransactionInternal(
    fence: ChromeProfileImportTransactionFenceInternal
  ) {
    if (fence.leaseId !== leaseId || fence.expectedJournalPhase !== this.current.journalPhase ||
      fence.expectedJournalRevision !== this.current.journalRevision) {
      throw new Error("stale fence");
    }
    return this.current;
  }

  async readChromeProfileImportPayloadInternal() {
    return Buffer.from(payload);
  }

  async writeChromeProfileImportBackupInternal(
    _fence: ChromeProfileImportTransactionFenceInternal,
    plaintext: Buffer
  ) {
    expect(digest(plaintext)).toBe(digest(emptyBackup));
    plaintext.fill(0);
    return {
      transactionId,
      roleId,
      journalPhase: "prepared" as const,
      journalRevision: 1,
      protectedSha256: "6".repeat(64),
      inventorySha256: digest(emptyBackup),
      cookieCount: 0,
      localStorageCount: 0
    };
  }

  async readChromeProfileImportBackupInternal() {
    return Buffer.from(emptyBackup);
  }

  async prepareChromeProfileImportFreshVerificationInternal() {
    this.current = descriptor("awaitingFreshVerification", 5);
    return Buffer.from(this.capability);
  }

  async completeChromeProfileImportFreshVerificationInternal(
    _fence: ChromeProfileImportTransactionFenceInternal,
    capability: Buffer,
    receipt: ChromeProfileImportFreshVerificationReceiptInternal
  ) {
    expect(capability.equals(this.capability)).toBe(true);
    expect(receipt.inventorySha256).toBe(digest(payload));
    capability.fill(0);
    this.current = descriptor("freshVerified", 6);
    return this.current;
  }

  async commitChromeProfileImportInternal() {
    this.current = {
      ...descriptor("committing", 8),
      commitMarkerSha256: "8".repeat(64)
    };
    return {
      transactionId,
      roleId,
      journalPhase: "committing" as const,
      journalRevision: 8,
      protectedSha256: "8".repeat(64),
      inventorySha256: digest(payload),
      cookieCount: 1,
      localStorageCount: 1
    };
  }

  async verifyChromeProfileImportCommitMarkerInternal() {
    return {
      transactionId,
      roleId,
      journalPhase: "committing" as const,
      journalRevision: 8,
      protectedSha256: "8".repeat(64),
      inventorySha256: digest(payload),
      cookieCount: 1,
      localStorageCount: 1
    };
  }

  releaseChromeProfileImportTransactionInternal = this.release;

  async launchChromeProfileImportHelperInternal(
    metadata: Buffer,
    secret: Buffer,
    signal?: AbortSignal
  ) {
    const request = JSON.parse(metadata.toString("utf8")) as {
      kind: "snapshot" | "apply" | "verify" | "rollback";
      descriptor: ChromeProfileImportTransactionDescriptorInternal;
      parentExitEvidenceSha256?: string;
    };
    this.launchKinds.push(request.kind);
    this.helperSignals.push(signal);
    const inventory = request.kind === "snapshot" || request.kind === "rollback"
      ? emptyBackup
      : payload;
    const response = {
      version: 1,
      kind: request.kind,
      transactionId,
      roleId,
      journalPhase: request.descriptor.journalPhase,
      journalRevision: request.descriptor.journalRevision,
      inventorySha256: digest(inventory),
      cookieCount: request.kind === "snapshot" || request.kind === "rollback" ? 0 : 1,
      localStorageCount: request.kind === "snapshot" || request.kind === "rollback" ? 0 : 1,
      surfaceDrainEvidenceSha256: "9".repeat(64),
      authState: request.kind === "verify" ? "authenticated" : "notApplicable",
      ...(request.kind === "verify" ? {
        verifierInstanceId: verifierId,
        parentExitEvidenceSha256: request.parentExitEvidenceSha256,
        chromiumPathSha256: request.descriptor.chromiumPathSha256,
        capabilitySha256: digest(secret.subarray(0, 32))
      } : {})
    };
    secret.fill(0);
    const responseSecret = request.kind === "snapshot"
      ? Buffer.from(emptyBackup)
      : Buffer.alloc(0);
    if (request.kind === "snapshot") this.lastSnapshotSecret = responseSecret;
    return {
      outcome: "applied" as const,
      metadataBytes: Buffer.from(JSON.stringify(response)),
      secretBytes: responseSecret,
      exitEvidenceSha256: request.kind === "apply" ? "a".repeat(64) : "b".repeat(64)
    };
  }
}

describe("ChromeProfileImportCoordinator", () => {
  it("uses two clean helper exits before atomically verified metadata can commit", async () => {
    const core = new FakeCore();
    const coordinator = new ChromeProfileImportCoordinator(core);
    const controller = new AbortController();
    await coordinator.execute(effect({
      type: "chromeProfileImportSnapshot",
      ...commonAction("prepared", 1),
      launchUrl: "https://game.example/play",
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit",
      replaceExisting: false
    }), controller.signal);
    core.current = descriptor("applying", 3);
    await coordinator.execute(effect({
      type: "chromeProfileImportApply",
      ...commonAction("applying", 3),
      launchUrl: "https://game.example/play",
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit",
      replaceExisting: false
    }), controller.signal);
    core.current = descriptor("verified", 4);
    await expect(coordinator.execute(effect({
      type: "chromeProfileImportVerify",
      ...commonAction("verified", 4),
      verificationUrl: "https://game.example/account",
      authenticatedPath: "/account",
      loginPath: "/login",
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit"
    }), controller.signal)).resolves.toEqual({ authState: "authenticated" });
    core.current = descriptor("metadataCommitted", 7);
    await coordinator.execute(effect({
      type: "chromeProfileImportCommit",
      ...commonAction("metadataCommitted", 7)
    }));
    expect(core.launchKinds).toEqual(["snapshot", "apply", "verify"]);
    expect(core.helperSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal
    ]);
    expect(core.release).toHaveBeenCalledOnce();
    expect(core.lastSnapshotSecret && [...core.lastSnapshotSecret])
      .toEqual(new Array(emptyBackup.byteLength).fill(0));
  });

  it("refuses fresh verification when the exact apply child-exit evidence was lost", async () => {
    const core = new FakeCore();
    core.current = descriptor("verified", 4);
    const coordinator = new ChromeProfileImportCoordinator(core);
    await expect(coordinator.execute(effect({
      type: "chromeProfileImportVerify",
      ...commonAction("verified", 4),
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit"
    }))).rejects.toMatchObject({
      code: "CHROMIUM_PROFILE_IMPORT_PARENT_EXIT_EVIDENCE_UNAVAILABLE"
    });
    expect(core.launchKinds).toEqual([]);
  });

  it("can reacquire a durable rollback lane without opening a Session in the parent", async () => {
    const core = new FakeCore();
    core.current = descriptor("applying", 3);
    const coordinator = new ChromeProfileImportCoordinator(core);
    const controller = new AbortController();
    await coordinator.execute(effect({
      type: "chromeProfileImportRollback",
      ...commonAction("applying", 3),
      launchUrl: "https://game.example/play",
      replaceExisting: false,
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit"
    }), controller.signal);
    expect(core.launchKinds).toEqual(["rollback"]);
    expect(core.helperSignals).toEqual([controller.signal]);
    expect(core.release).toHaveBeenCalledOnce();
  });

  it("keeps an aborted effect pending until the exact helper process cleanup settles", async () => {
    const core = new FakeCore();
    const helperCleanup = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    core.launchChromeProfileImportHelperInternal = vi.fn(
      async (_metadata: Buffer, _secret: Buffer, signal?: AbortSignal) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            void helperCleanup.promise.then(() => reject(new Error("helper cancelled")));
          }, { once: true });
        });
        throw new Error("unreachable");
      }
    );
    const coordinator = new ChromeProfileImportCoordinator(core);
    const controller = new AbortController();
    const execution = coordinator.execute(effect({
      type: "chromeProfileImportSnapshot",
      ...commonAction("prepared", 1),
      launchUrl: "https://game.example/play",
      webview2UserDataDir: "/legacy/webview2",
      webkitDataStoreIdentifier: "legacy-webkit",
      replaceExisting: false
    }), controller.signal);
    let settled = false;
    void execution.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));

    controller.abort("eventStreamFailure");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(core.release).not.toHaveBeenCalled();

    helperCleanup.resolve();
    await expect(execution).rejects.toThrow("helper cancelled");
    expect(core.release).toHaveBeenCalledOnce();
  });
});
