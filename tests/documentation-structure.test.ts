import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateDocumentation } from "../scripts/documentationPolicy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function documentationFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "rion-doc-policy-"));
  await Promise.all([
    mkdir(resolve(root, ".agents/context"), { recursive: true }),
    mkdir(resolve(root, "docs/contracts/system-runtime"), { recursive: true }),
    mkdir(resolve(root, "docs/validation/archive/example"), { recursive: true })
  ]);
  const archive = "# Historical evidence\n";
  const digest = createHash("sha256").update(archive).digest("hex");
  await Promise.all([
    writeFile(resolve(root, "AGENTS.md"), "# Rules\n"),
    writeFile(resolve(root, ".agents/context.md"), "# Context\n"),
    writeFile(resolve(root, ".agents/context/topic.md"), "# Topic\n"),
    writeFile(resolve(root, ".agents/context-map.json"), '{"schemaVersion":1}\n'),
    writeFile(resolve(root, "docs/README.md"), "# Docs\n\n[Guide](guide.md)\n[Contract](contracts/system-runtime/example.md)\n"),
    writeFile(resolve(root, "docs/guide.md"), "# Guide\n"),
    writeFile(resolve(root, "docs/contracts/system-runtime/example.md"), "# Contract\n"),
    writeFile(resolve(root, "docs/validation/archive/example/report.md"), archive),
    writeFile(resolve(root, "docs/validation/archive/manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      entries: [{
        path: "docs/validation/archive/example/report.md",
        sourcePath: "old.md",
        capturedAt: "2026-01-01",
        contentSha256: digest
      }]
    }, null, 2)}\n`)
  ]);
  return root;
}

describe("documentation structure", () => {
  it("accepts the repository documentation graph", async () => {
    await expect(validateDocumentation(repositoryRoot)).resolves.toEqual([]);
  });

  it("rejects broken links and unlisted active documents", async () => {
    const root = await documentationFixture();
    await writeFile(resolve(root, "docs/guide.md"), "# Guide\n\n[Missing](missing.md)\n");
    await writeFile(resolve(root, "docs/unlisted.md"), "# Unlisted\n");
    const failures = await validateDocumentation(root);
    expect(failures.join("\n")).toContain("broken link missing.md");
    expect(failures.join("\n")).toContain("missing active document docs/unlisted.md");
  });

  it("rejects non-English active engineering documentation", async () => {
    const root = await documentationFixture();
    await writeFile(resolve(root, "docs/guide.md"), "# Guide\n\n中文內容\n");
    expect((await validateDocumentation(root)).join("\n"))
      .toContain("active engineering documentation must be English");
  });

  it("rejects archive mutation", async () => {
    const root = await documentationFixture();
    await writeFile(resolve(root, "docs/validation/archive/example/report.md"), "changed\n");
    expect((await validateDocumentation(root)).join("\n")).toContain("archive hash changed");
  });

  it("rejects oversized contract parts", async () => {
    const root = await documentationFixture();
    await writeFile(
      resolve(root, "docs/contracts/system-runtime/example.md"),
      `${Array.from({ length: 221 }, (_, index) => `line ${index}`).join("\n")}\n`
    );
    expect((await validateDocumentation(root)).join("\n")).toContain("exceeds contract limits");
  });

  it("rejects archive paths in routine AI context", async () => {
    const root = await documentationFixture();
    const map = await readFile(resolve(root, ".agents/context-map.json"), "utf8");
    await writeFile(
      resolve(root, ".agents/context-map.json"),
      `${map.trimEnd()}\ndocs/validation/archive/example/report.md\n`
    );
    expect((await validateDocumentation(root)).join("\n"))
      .toContain("must not route directly to validation archive files");
  });
});
