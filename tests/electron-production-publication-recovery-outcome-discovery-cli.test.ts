import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runElectronProductionPublicationRecoveryOutcomeDiscoveryCli
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  writeElectronProductionPublicationRecoveryOutcomeDiscovery
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  electronProductionPublicationRecoveryOutcomeSha256,
  serializeElectronProductionPublicationRecoveryOutcome
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  readStableFile
} from "../scripts/electronUpdaterCompatibilityReceiptIo.mjs";
import {
  createOutcomeDiscoveryFixture,
  writeOutcomeDiscoveryFoundation
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publication recovery outcome discovery CLI", () => {
  it("materializes a redacted same-head discovery receipt", async () => {
    const root = await temporaryDirectory();
    const fixture = await createOutcomeDiscoveryFixture(root);
    const outcome = fixture.createOutcome({
      runId: "9701",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const discovery = fixture.discovery([fixture.entry(outcome)]);
    const discoverRemote = vi.fn(async () => discovery);
    const stdout: Buffer[] = [];
    const output = path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE
    );

    const summary = await runElectronProductionPublicationRecoveryOutcomeDiscoveryCli([
      "discover",
      "--transaction-id", fixture.heldLease.transactionId,
      "--owner", "recovery-owner",
      "--repo", "recovery-vault",
      "--ref", "recovery-main",
      "--repository-default-branch", "recovery-main",
      "--repository-visibility", "private",
      "--observed-at", "2026-09-01T01:00:00Z",
      "--output", output
    ], {
      discoverRemote,
      environment: { GH_TOKEN: "private-reader-token" },
      fetchImpl: vi.fn(),
      writeStdout: (source) => {
        stdout.push(source);
      }
    });

    expect(discoverRemote).toHaveBeenCalledWith(expect.objectContaining({
      token: "private-reader-token",
      transactionId: fixture.heldLease.transactionId
    }));
    expect(summary).toMatchObject({
      command: "discover",
      status: "materialized",
      output: {
        fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
        sha256:
          electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
      },
      currentObservation: discovery.currentObservation
    });
    expect(stdout).toHaveLength(1);
    expect(stdout[0]!.toString("utf8")).not.toContain("contentBase64");
    expect((await readFile(output, "utf8"))).toContain("contentBase64");
  });

  it("verifies the chain and writes the unique canonical head without jq", async () => {
    const setup = await setupOpenChain("9801");
    const stdout: Buffer[] = [];
    const summary = await runElectronProductionPublicationRecoveryOutcomeDiscoveryCli(
      verifyChainArguments(setup),
      { writeStdout: (source) => {
        stdout.push(source);
      } }
    );

    expect(summary).toMatchObject({
      command: "verify-chain",
      status: "verified",
      output: {
        fileName:
          ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      },
      latestOutcome: {
        fileName: setup.entry.fileName,
        sha256: electronProductionPublicationRecoveryOutcomeSha256(setup.outcome)
      },
      terminal: null
    });
    expect(await readFile(path.join(setup.latestDirectory, setup.entry.fileName)))
      .toEqual(serializeElectronProductionPublicationRecoveryOutcome(setup.outcome));
    expect(stdout[0]!.toString("utf8")).not.toContain("contentBase64");
  });

  it("keeps an empty latest root empty for a zero-attempt chain", async () => {
    const root = await temporaryDirectory();
    const fixture = await createOutcomeDiscoveryFixture(root);
    const foundation = await writeOutcomeDiscoveryFoundation(root, fixture);
    const discovery = fixture.discovery([], { status: "outcome-directory-absent" });
    const discoveryFile = await writeDiscovery(root, discovery);
    const latestDirectory = path.join(root, "latest-empty");
    await mkdir(latestDirectory);
    const output = path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
    );

    const summary = await runElectronProductionPublicationRecoveryOutcomeDiscoveryCli([
      "verify-chain",
      ...foundationArguments(foundation),
      "--discovery", discoveryFile.path,
      "--discovery-sha256", discoveryFile.sha256,
      "--latest-outcome-output-directory", latestDirectory,
      "--output", output
    ], { writeStdout: () => undefined });

    expect(summary.latestOutcome).toBeNull();
    expect(await readdir(latestDirectory)).toEqual([]);
  });

  it("verifies initial/fresh continuity and binds the fresh expected head", async () => {
    const setup = await setupOpenChain("9810");
    const freshRoot = path.join(setup.root, "fresh");
    await mkdir(freshRoot);
    const fresh = setup.fixture.discovery([setup.entry], {
      observedAt: "2026-09-01T01:01:00Z"
    });
    const freshFile = await writeDiscovery(freshRoot, fresh);
    const latestDirectory = path.join(setup.root, "continuity-latest");
    await mkdir(latestDirectory);
    const output = path.join(
      setup.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE
    );

    const summary = await runElectronProductionPublicationRecoveryOutcomeDiscoveryCli([
      "verify-continuity",
      ...foundationArguments(setup.foundation),
      "--initial-discovery", setup.discovery.path,
      "--initial-discovery-sha256", setup.discovery.sha256,
      "--fresh-discovery", freshFile.path,
      "--fresh-discovery-sha256", freshFile.sha256,
      "--latest-outcome-output-directory", latestDirectory,
      "--output", output
    ], { writeStdout: () => undefined });

    expect(summary).toMatchObject({
      command: "verify-continuity",
      status: "verified",
      currentObservation: fresh.currentObservation,
      latestOutcome: { fileName: setup.entry.fileName }
    });
  });

  it("preflights proof collisions before writing a latest outcome", async () => {
    const setup = await setupOpenChain("9820");
    await writeFile(setup.output, "occupied", { flag: "wx" });

    await expect(runElectronProductionPublicationRecoveryOutcomeDiscoveryCli(
      verifyChainArguments(setup),
      { writeStdout: () => undefined }
    )).rejects.toThrow("must be create-new");
    expect(await readdir(setup.latestDirectory)).toEqual([]);
  });

  it("detects same-byte inode replacement and preserves the detached replacement", async () => {
    const setup = await setupOpenChain("9830");
    const rereadLatestFile = vi.fn(async (
      filePath: string,
      maximumBytes: number,
      label: string
    ) => {
      const source = await readFile(filePath);
      await unlink(filePath);
      await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
      return readStableFile(filePath, maximumBytes, label);
    });

    await expect(runElectronProductionPublicationRecoveryOutcomeDiscoveryCli(
      verifyChainArguments(setup),
      { rereadLatestFile, writeStdout: () => undefined }
    )).rejects.toThrow("inode changed");
    expect(rereadLatestFile).toHaveBeenCalledOnce();
    expect(await readFile(path.join(setup.latestDirectory, setup.entry.fileName)))
      .toEqual(serializeElectronProductionPublicationRecoveryOutcome(setup.outcome));
    await expect(readFile(setup.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["token", "expected-head-sha", "source-root", "operation"])(
    "rejects forbidden --%s authority",
    async (option) => {
      const setup = await setupOpenChain(`99${option.length}0`);
      await expect(runElectronProductionPublicationRecoveryOutcomeDiscoveryCli([
        ...verifyChainArguments(setup),
        `--${option}`,
        "forbidden"
      ])).rejects.toThrow(`Unknown recovery outcome discovery option --${option}`);
    }
  );
});

async function setupOpenChain(runId: string) {
  const root = await temporaryDirectory();
  const fixture = await createOutcomeDiscoveryFixture(root);
  const foundation = await writeOutcomeDiscoveryFoundation(root, fixture);
  const outcome = fixture.createOutcome({
    runId,
    runAttempt: 1,
    previousOutcomeSha256: null,
    startedAt: "2026-09-01T00:03:00Z",
    determinedAt: "2026-09-01T00:04:00Z"
  });
  const entry = fixture.entry(outcome);
  const discoveryValue = fixture.discovery([entry]);
  const discovery = await writeDiscovery(root, discoveryValue);
  const latestDirectory = path.join(root, "latest");
  await mkdir(latestDirectory);
  return {
    root,
    fixture,
    foundation,
    outcome,
    entry,
    discovery,
    latestDirectory,
    output: path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
    )
  };
}

function verifyChainArguments(setup: Awaited<ReturnType<typeof setupOpenChain>>) {
  return [
    "verify-chain",
    ...foundationArguments(setup.foundation),
    "--discovery", setup.discovery.path,
    "--discovery-sha256", setup.discovery.sha256,
    "--latest-outcome-output-directory", setup.latestDirectory,
    "--output", setup.output
  ];
}

function foundationArguments(
  foundation: Awaited<ReturnType<typeof writeOutcomeDiscoveryFoundation>>
) {
  return [
    "--held-lease", foundation.heldLease,
    "--held-lease-sha256", foundation.heldLeaseSha256,
    "--source-snapshot", foundation.sourceSnapshot,
    "--source-snapshot-sha256", foundation.sourceSnapshotSha256,
    "--store-seal", foundation.storeSeal,
    "--store-seal-sha256", foundation.storeSealSha256,
    "--target-snapshot", foundation.targetSnapshot,
    "--target-snapshot-sha256", foundation.targetSnapshotSha256
  ];
}

async function writeDiscovery(root: string, value: Parameters<
  typeof writeElectronProductionPublicationRecoveryOutcomeDiscovery
>[0]["value"]) {
  const written = await writeElectronProductionPublicationRecoveryOutcomeDiscovery({
    outputPath: path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE
    ),
    value
  });
  return {
    path: written.valuePath,
    sha256: written.valueIdentity.sha256
  };
}

async function temporaryDirectory() {
  const root = await mkdtemp(`${tmpdir()}/rion-outcome-discovery-cli-`);
  temporaryDirectories.push(root);
  return root;
}
