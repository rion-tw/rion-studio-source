import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS,
  acquireElectronProductionPublicLatestLease,
  assertElectronProductionPublicLatestLease,
  assertElectronProductionPublicLatestLeaseHeldObservation,
  assertElectronProductionPublicLatestLeaseSuccessor,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLeasePurpose
} from "../scripts/electronProductionPublicLatestLease.mjs";

const TRANSACTION_ID = "10000000-0000-4000-8000-000000000001";
const LEASE_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_STATE = "a".repeat(64);
const TARGET_STATE = "b".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production durable public-latest lease", () => {
  it("acquires genesis only from explicit generation zero without an expiry", () => {
    const lease = acquireLease();

    expect(lease).toMatchObject({
      transactionId: TRANSACTION_ID,
      leaseId: LEASE_ID,
      vacantGeneration: 0,
      generation: 1,
      status: "held",
      purpose: "electron-v23-provisional-publication",
      revision: 1,
      acquiredFromEventSha256: null,
      previousEventSha256: null,
      acquiredAt: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
      source: { runtime: "tauri-v22", version: "8.4.2", stateSha256: SOURCE_STATE },
      target: { runtime: "electron-v23", version: "8.5.0-beta.1", stateSha256: TARGET_STATE }
    });
    expect(lease.holder).toEqual({
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
      workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
        "electron-v23-provisional-publication"
      ],
      runId: "123456789",
      runAttempt: 2,
      headSha: "c".repeat(40)
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.holder)).toBe(true);
    expect(JSON.stringify(lease)).not.toMatch(/expir|timeout|stale/iu);

    expect(() => acquireLease({ vacantGeneration: 1 }))
      .toThrow("genesis vacant public-latest lease generation");
  });

  it("chains the next generation only from the exact released predecessor", () => {
    const firstHeld = acquireLease();
    const firstReleased = releaseLease(firstHeld, "2026-09-01T00:10:00Z");
    const secondHeld = acquireLease({
      previous: firstReleased,
      vacantGeneration: 1,
      transactionId: "30000000-0000-4000-8000-000000000003",
      leaseId: "40000000-0000-4000-8000-000000000004",
      purpose: "tauri-v22-publication",
      sourceVersion: "8.5.0",
      targetRuntime: "tauri-v22",
      targetVersion: "8.6.0",
      recordedAt: "2026-09-01T00:20:00Z"
    });

    expect(secondHeld).toMatchObject({
      vacantGeneration: 1,
      generation: 2,
      revision: 3,
      acquiredFromEventSha256:
        electronProductionPublicLatestLeaseEventSha256(firstReleased),
      previousEventSha256:
        electronProductionPublicLatestLeaseEventSha256(firstReleased),
      purpose: "tauri-v22-publication",
      holder: {
        workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
          "tauri-v22-publication"
        ]
      }
    });
    expect(assertElectronProductionPublicLatestLeaseSuccessor({
      next: secondHeld,
      previous: firstReleased
    })).toEqual(secondHeld);

    const secondReleased = releaseLease(secondHeld, "2026-09-01T00:30:00Z");
    expect(secondReleased).toMatchObject({
      generation: 2,
      revision: 4,
      previousEventSha256:
        electronProductionPublicLatestLeaseEventSha256(secondHeld)
    });
  });

  it("rejects held takeover, stale vacancy, and predecessor identity reuse", () => {
    const held = acquireLease();
    expect(() => acquireLease({
      previous: held,
      vacantGeneration: held.generation
    })).toThrow("only from the exact released record");

    const released = releaseLease(held, "2026-09-01T00:10:00Z");
    expect(() => acquireLease({
      previous: released,
      vacantGeneration: 0,
      transactionId: "30000000-0000-4000-8000-000000000003",
      leaseId: "40000000-0000-4000-8000-000000000004",
      recordedAt: "2026-09-01T00:20:00Z"
    })).toThrow("reacquired vacant public-latest lease generation");
    expect(() => acquireLease({
      previous: released,
      vacantGeneration: 1,
      recordedAt: "2026-09-01T00:20:00Z"
    })).toThrow("must use new transaction and lease IDs");

    const successor = acquireLease({
      previous: released,
      vacantGeneration: 1,
      transactionId: "30000000-0000-4000-8000-000000000003",
      leaseId: "40000000-0000-4000-8000-000000000004",
      recordedAt: "2026-09-01T00:20:00Z"
    });
    expect(() => assertElectronProductionPublicLatestLeaseSuccessor({
      next: {
        ...successor,
        transactionId: released.transactionId,
        leaseId: released.leaseId
      },
      previous: released
    })).toThrow("must use new transaction and lease IDs");
  });

  it("accepts the same exact held observation for every window consumer", () => {
    const lease = acquireLease();
    for (const consumer of ["provisional", "evidence", "recovery", "finalizer"]) {
      const observed = assertElectronProductionPublicLatestLeaseHeldObservation({
        expected: lease,
        observed: JSON.parse(JSON.stringify(lease))
      });
      expect(observed, consumer).toEqual(lease);
    }
  });

  it("fails closed for unknown, foreign, or no-longer-held observations", () => {
    const expected = acquireLease();
    expect(() => assertElectronProductionPublicLatestLeaseHeldObservation({
      expected,
      observed: null
    })).toThrow("unknown and must fail closed");

    const foreign = acquireLease({
      leaseId: "30000000-0000-4000-8000-000000000003"
    });
    expect(() => assertElectronProductionPublicLatestLeaseHeldObservation({
      expected,
      observed: foreign
    })).toThrow("foreign and must fail closed");

    const released = releaseLease(expected, "2026-09-01T00:10:00Z");
    expect(() => assertElectronProductionPublicLatestLeaseHeldObservation({
      expected,
      observed: released
    })).toThrow("not held and must fail closed");
  });

  it("releases only the same transaction, lease, generation, and state digests", () => {
    const held = acquireLease();
    const released = releaseLease(held, "2026-09-01T00:10:00Z");

    expect(released).toMatchObject({
      status: "released",
      generation: 1,
      revision: 2,
      acquiredFromEventSha256: null,
      previousEventSha256: electronProductionPublicLatestLeaseEventSha256(held),
      acquiredAt: held.acquiredAt,
      recordedAt: "2026-09-01T00:10:00Z",
      source: held.source,
      target: held.target
    });
    expect(() => releaseLease(released, "2026-09-01T00:20:00Z"))
      .toThrow("exactly held");

    const tampered = { ...released, previousEventSha256: "f".repeat(64) };
    expect(() => assertElectronProductionPublicLatestLease(tampered))
      .toThrow("previous-event SHA-256 does not match");
  });

  it.each([
    ["transactionId", "40000000-0000-4000-8000-000000000004", "transaction ID fence"],
    ["leaseId", "50000000-0000-4000-8000-000000000005", "release ID fence"],
    ["generation", 2, "generation fence"],
    ["sourceStateSha256", "d".repeat(64), "source state SHA-256 fence"],
    ["targetStateSha256", "e".repeat(64), "target state SHA-256 fence"]
  ] as const)("rejects a mismatched release %s", (field, value, message) => {
    const held = acquireLease();
    expect(() => releaseElectronProductionPublicLatestLease(held, {
      ...releaseInput(held, "2026-09-01T00:10:00Z"),
      [field]: value
    })).toThrow(message);
  });

  it("applies runtime and arbitrary application SemVer rules per purpose", () => {
    expect(() => acquireLease({
      sourceVersion: "8.4.2",
      targetVersion: "8.5.0-beta.1"
    })).not.toThrow();
    expect(() => acquireLease({
      purpose: "tauri-v22-publication",
      targetRuntime: "tauri-v22",
      sourceVersion: "8.4.2",
      targetVersion: "8.5.0"
    })).not.toThrow();
    expect(() => acquireLease({
      purpose: "tauri-v22-latest-restore",
      targetRuntime: "tauri-v22",
      sourceVersion: "8.6.0",
      targetVersion: "8.4.2"
    })).not.toThrow();
    expect(() => acquireLease({ targetVersion: "8.4.2" }))
      .toThrow("strictly newer");
    expect(() => acquireLease({ targetRuntime: "tauri-v22" }))
      .toThrow("target runtime for purpose does not match");
    expect(() => acquireLease({ sourceRuntime: "electron-v23" }))
      .toThrow("source runtime for purpose does not match");
    expect(() => acquireLease({
      purpose: "tauri-v22-publication",
      sourceRuntime: "electron-v23",
      targetRuntime: "electron-v23"
    })).toThrow("source runtime for purpose does not match");
    expect(() => acquireLease({
      purpose: "tauri-v22-latest-restore",
      sourceRuntime: "electron-v23",
      sourceVersion: "8.5.0-beta.1",
      targetRuntime: "tauri-v22",
      targetVersion: "8.4.2"
    })).not.toThrow();
  });

  it("rejects a purpose/workflow mismatch and all schema expansion", () => {
    const input = acquisitionInput();
    expect(() => acquireElectronProductionPublicLatestLease({
      ...input,
      holder: {
        ...input.holder,
        workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
          "tauri-v22-publication"
        ]
      }
    })).toThrow("holder workflow for purpose does not match");
    expect(() => assertElectronProductionPublicLatestLease({
      ...acquireLease(),
      expiresAt: "2026-09-01T01:00:00Z"
    })).toThrow("unexpected schema");
    expect(() => acquireElectronProductionPublicLatestLease({
      ...input,
      purpose: "foreign-purpose" as ElectronProductionPublicLatestLeasePurpose
    })).toThrow("purpose is invalid");
  });

  it("rejects unsafe generations, time reversal, and a false successor chain", () => {
    expect(() => acquireLease({ vacantGeneration: -1 }))
      .toThrow("safely incrementable");
    const held = acquireLease();
    expect(() => releaseElectronProductionPublicLatestLease(held, {
      ...releaseInput(held, "2026-08-31T23:59:59Z")
    })).toThrow("cannot precede its acquisition");

    const released = releaseLease(held, "2026-09-01T00:10:00Z");
    const next = acquireLease({
      previous: released,
      vacantGeneration: 1,
      transactionId: "30000000-0000-4000-8000-000000000003",
      leaseId: "40000000-0000-4000-8000-000000000004",
      recordedAt: "2026-09-01T00:20:00Z"
    });
    const falsePrevious = releaseLease(
      acquireLease({ leaseId: "50000000-0000-4000-8000-000000000005" }),
      "2026-09-01T00:10:00Z"
    );
    expect(() => assertElectronProductionPublicLatestLeaseSuccessor({
      next,
      previous: falsePrevious
    })).toThrow("acquisition-event SHA-256 does not match");
  });

  it("writes and reads only canonical create-new fixed-name records", async () => {
    const root = await temporaryDirectory();
    const lease = acquireLease();
    const outputPath = path.join(root, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE);
    const source = serializeElectronProductionPublicLatestLease(lease);
    const sha256 = digest(source);

    const written = await writeElectronProductionPublicLatestLease({ lease, outputPath });
    expect(written).toMatchObject({
      lease,
      leaseIdentity: {
        bytes: source.length,
        fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
        sha256
      }
    });
    expect(path.basename(written.leasePath))
      .toBe(ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE);
    expect(await readFile(outputPath)).toEqual(source);
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: sha256,
      leasePath: outputPath
    })).resolves.toMatchObject({ lease });
    await expect(writeElectronProductionPublicLatestLease({ lease, outputPath }))
      .rejects.toThrow("create-new");
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: "f".repeat(64),
      leasePath: outputPath
    })).rejects.toThrow("SHA-256 does not match");

    const noncanonicalPath = path.join(
      await temporaryDirectory(),
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
    );
    await writeFile(noncanonicalPath, JSON.stringify(lease, null, 2));
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: digest(await readFile(noncanonicalPath)),
      leasePath: noncanonicalPath
    })).rejects.toThrow("not canonical JSON");
  });
});

interface AcquireOverrides {
  leaseId?: string;
  previous?: ElectronProductionPublicLatestLease | null;
  purpose?: ElectronProductionPublicLatestLeasePurpose;
  recordedAt?: string;
  sourceRuntime?: "tauri-v22" | "electron-v23";
  sourceVersion?: string;
  targetRuntime?: "tauri-v22" | "electron-v23";
  targetVersion?: string;
  transactionId?: string;
  vacantGeneration?: number;
}

function acquireLease(overrides: AcquireOverrides = {}) {
  return acquireElectronProductionPublicLatestLease(acquisitionInput(overrides));
}

function acquisitionInput(overrides: AcquireOverrides = {}) {
  const purpose = overrides.purpose ?? "electron-v23-provisional-publication";
  return {
    transactionId: overrides.transactionId ?? TRANSACTION_ID,
    leaseId: overrides.leaseId ?? LEASE_ID,
    previous: overrides.previous ?? null,
    vacantGeneration: overrides.vacantGeneration ?? 0,
    purpose,
    holder: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
      workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[purpose],
      runId: "123456789",
      runAttempt: 2,
      headSha: "c".repeat(40)
    },
    source: {
      runtime: overrides.sourceRuntime ?? "tauri-v22",
      version: overrides.sourceVersion ?? "8.4.2",
      stateSha256: SOURCE_STATE
    },
    target: {
      runtime: overrides.targetRuntime ?? "electron-v23",
      version: overrides.targetVersion ?? "8.5.0-beta.1",
      stateSha256: TARGET_STATE
    },
    recordedAt: overrides.recordedAt ?? "2026-09-01T00:00:00Z"
  };
}

function releaseLease(lease: ElectronProductionPublicLatestLease, recordedAt: string) {
  return releaseElectronProductionPublicLatestLease(
    lease,
    releaseInput(lease, recordedAt)
  );
}

function releaseInput(lease: ElectronProductionPublicLatestLease, recordedAt: string) {
  return {
    transactionId: lease.transactionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    sourceStateSha256: lease.source.stateSha256,
    targetStateSha256: lease.target.stateSha256,
    recordedAt
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-public-latest-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
