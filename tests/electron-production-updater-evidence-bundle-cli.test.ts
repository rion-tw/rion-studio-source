import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
  type ElectronProductionUpdaterEvidenceBundle
} from "../scripts/electronProductionUpdaterEvidenceBundle.mjs";
import {
  runElectronProductionUpdaterEvidenceBundleCli,
  type ElectronProductionUpdaterEvidenceBundleCliDependencies
} from "../scripts/electronProductionUpdaterEvidenceBundleCli.mjs";

const RECEIPT_SHA256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater evidence bundle CLI", () => {
  it("assembles from exact canonical bindings and an exact attachment directory", async () => {
    const fixture = await createInputs();
    const calls: unknown[] = [];
    const stdout: Buffer[] = [];
    const dependencies = cliDependencies({
      assembleBundle: async (input) => {
        calls.push(input);
        return bundleResult(input.outputRoot);
      },
      writeStdout: (source) => {
        stdout.push(Buffer.from(source));
      }
    });

    const summary = await runElectronProductionUpdaterEvidenceBundleCli([
      "--",
      "assemble",
      "--bindings", fixture.bindingsPath,
      "--attachments", fixture.attachmentRoot,
      "--output-root", fixture.outputRoot
    ], dependencies);

    expect(calls).toEqual([{
      attachments: Object.fromEntries(
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
          name,
          path.join(fixture.attachmentRoot, name)
        ])
      ),
      outputRoot: fixture.outputRoot,
      provenance: fixture.bindings.provenance,
      sourceBinding: fixture.bindings.sourceBinding,
      targetBinding: fixture.bindings.targetBinding
    }]);
    expect(summary).toEqual({
      outputRoot: fixture.outputRoot,
      receiptSha256: RECEIPT_SHA256
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(Object.keys(JSON.parse(stdout[0]!.toString("utf8"))).sort()).toEqual([
      "outputRoot",
      "receiptSha256"
    ]);
    expect(stdout[0]!.toString("utf8")).not.toContain("binding-must-stay-private");
  });

  it("verifies with an optional exact receipt SHA and emits the same closed summary", async () => {
    const root = await temporaryDirectory();
    const bundleRoot = path.join(root, "bundle");
    await mkdir(bundleRoot);
    const calls: unknown[] = [];
    const stdout: Buffer[] = [];
    const dependencies = cliDependencies({
      readBundle: async (input) => {
        calls.push(input);
        return bundleResult(input.outputRoot);
      },
      writeStdout: (source) => {
        stdout.push(Buffer.from(source));
      }
    });

    const summary = await runElectronProductionUpdaterEvidenceBundleCli([
      "verify",
      "--bundle-root", bundleRoot,
      "--expected-receipt-sha256", RECEIPT_SHA256
    ], dependencies);
    await runElectronProductionUpdaterEvidenceBundleCli([
      "verify",
      "--bundle-root", bundleRoot
    ], dependencies);

    expect(calls).toEqual([
      { expectedReceiptSha256: RECEIPT_SHA256, outputRoot: bundleRoot },
      { expectedReceiptSha256: undefined, outputRoot: bundleRoot }
    ]);
    expect(stdout[0]).toEqual(serializeCanonicalJson(summary));
    expect(Object.keys(summary).sort()).toEqual(["outputRoot", "receiptSha256"]);
  });

  it("rejects noncanonical or non-exact bindings before assembly", async () => {
    const noncanonical = await createInputs();
    await writeFile(
      noncanonical.bindingsPath,
      JSON.stringify(noncanonical.bindings)
    );
    const assembleBundle = vi.fn();

    await expect(runAssemble(noncanonical, { assembleBundle }))
      .rejects.toThrow("not canonical JSON");

    const unknownField = await createInputs({
      ...noncanonical.bindings,
      secret: "unexpected"
    });
    await expect(runAssemble(unknownField, { assembleBundle }))
      .rejects.toThrow("unexpected schema");
    expect(assembleBundle).not.toHaveBeenCalled();
  });

  it("requires exactly the eight attachment names before assembly", async () => {
    const fixture = await createInputs();
    await writeFile(path.join(fixture.attachmentRoot, "unexpected.json"), "{}\n");
    const assembleBundle = vi.fn();

    await expect(runAssemble(fixture, { assembleBundle }))
      .rejects.toThrow("attachment directory inventory is not exact");
    expect(assembleBundle).not.toHaveBeenCalled();
  });

  it("requires a create-new output root outside the attachment directory", async () => {
    const existing = await createInputs();
    await mkdir(existing.outputRoot);
    const assembleBundle = vi.fn();
    await expect(runAssemble(existing, { assembleBundle }))
      .rejects.toThrow("output root must be create-new");

    const nested = await createInputs();
    nested.outputRoot = path.join(nested.attachmentRoot, "bundle");
    await expect(runAssemble(nested, { assembleBundle }))
      .rejects.toThrow("must stay outside the attachment directory");
    expect(assembleBundle).not.toHaveBeenCalled();
  });

  it("enforces command-specific allowlists, duplicate rejection, and values", async () => {
    const dependencies = cliDependencies({
      assembleBundle: vi.fn(),
      readBundle: vi.fn(),
      writeStdout: vi.fn()
    });
    await expect(runElectronProductionUpdaterEvidenceBundleCli([
      "assemble", "--bindings", "/tmp/bindings.json",
      "--attachments", "/tmp/attachments", "--output-root", "/tmp/output",
      "--bundle-root", "/tmp/forbidden"
    ], dependencies)).rejects.toThrow("Unknown assemble option --bundle-root");
    await expect(runElectronProductionUpdaterEvidenceBundleCli([
      "verify", "--bundle-root", "/tmp/a", "--bundle-root", "/tmp/b"
    ], dependencies)).rejects.toThrow("Duplicate");
    await expect(runElectronProductionUpdaterEvidenceBundleCli([
      "verify", "--bundle-root"
    ], dependencies)).rejects.toThrow("must have one value");
    await expect(runElectronProductionUpdaterEvidenceBundleCli([
      "verify", "--bindings", "/tmp/bindings.json"
    ], dependencies)).rejects.toThrow("Unknown verify option --bindings");
    await expect(runElectronProductionUpdaterEvidenceBundleCli([
      "verify", "--bundle-root", "/tmp/bundle",
      "--expected-receipt-sha256", "not-a-digest"
    ], dependencies)).rejects.toThrow("lowercase SHA-256 digest");
    expect(dependencies.assembleBundle).not.toHaveBeenCalled();
    expect(dependencies.readBundle).not.toHaveBeenCalled();
    expect(dependencies.writeStdout).not.toHaveBeenCalled();
  });
});

interface CliInputs {
  attachmentRoot: string;
  bindings: Record<string, unknown> & {
    provenance: Record<string, unknown>;
    sourceBinding: Record<string, unknown>;
    targetBinding: Record<string, unknown>;
  };
  bindingsPath: string;
  outputRoot: string;
}

async function createInputs(
  bindings: Record<string, unknown> = defaultBindings()
): Promise<CliInputs> {
  const root = await temporaryDirectory();
  const attachmentRoot = path.join(root, "attachments");
  const bindingsPath = path.join(root, "bindings.json");
  const outputRoot = path.join(root, "bundle");
  await mkdir(attachmentRoot);
  await Promise.all(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) =>
      writeFile(path.join(attachmentRoot, name), `${name}\n`)
    )
  );
  await writeFile(bindingsPath, serializeCanonicalJson(bindings));
  return {
    attachmentRoot,
    bindings: bindings as CliInputs["bindings"],
    bindingsPath,
    outputRoot
  };
}

function defaultBindings() {
  return {
    provenance: { marker: "binding-must-stay-private" },
    sourceBinding: { marker: "source" },
    targetBinding: { marker: "target" }
  };
}

function runAssemble(
  fixture: CliInputs,
  dependencies: ElectronProductionUpdaterEvidenceBundleCliDependencies
) {
  return runElectronProductionUpdaterEvidenceBundleCli([
    "assemble",
    "--bindings", fixture.bindingsPath,
    "--attachments", fixture.attachmentRoot,
    "--output-root", fixture.outputRoot
  ], {
    ...dependencies,
    writeStdout: vi.fn()
  });
}

function cliDependencies(
  overrides: ElectronProductionUpdaterEvidenceBundleCliDependencies
) {
  return overrides as Required<ElectronProductionUpdaterEvidenceBundleCliDependencies>;
}

function bundleResult(outputRoot: string): ElectronProductionUpdaterEvidenceBundle {
  return {
    attachments: {},
    outputRoot,
    receipt: {},
    receiptSha256: RECEIPT_SHA256
  } as unknown as ElectronProductionUpdaterEvidenceBundle;
}

async function temporaryDirectory() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "rion-updater-evidence-bundle-cli-"))
  );
  temporaryDirectories.push(directory);
  return directory;
}
