import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  PUBLIC_DOCUMENT_FILES,
  assertPublicDocumentsMatch,
  assertUniqueDocumentTargets,
  collectPublicDocuments,
  gitBlobSha,
  planPublicDocumentChanges,
  shouldSynchronizeLatestTag,
  synchronizePublicDocuments
} from "../scripts/syncPublicRepositoryDocs.mjs";
import type {
  PublicDocumentEntry,
  RemoteTreeEntry
} from "../scripts/syncPublicRepositoryDocs.mjs";

describe("public document synchronization", () => {
  it("collects the fixed manifest, legal tree, and binary image without changing bytes", async () => {
    const entries = await collectPublicDocuments(process.cwd());
    const targets = entries.map(({ targetPath }) => targetPath);

    for (const { targetPath } of PUBLIC_DOCUMENT_FILES) expect(targets).toContain(targetPath);
    expect(targets).toContain("docs/legal/terms.en.md");
    expect(targets).toContain("docs/legal/privacy.zh-TW.md");

    const imagePath = ".github/assets/rion-studio-github-preview-1280x640.jpg";
    const image = entries.find(({ targetPath }) => targetPath === imagePath);
    const sourceImage = await readFile(imagePath);
    expect(image?.content.equals(sourceImage)).toBe(true);
    expect(image?.sha).toBe(gitBlobSha(sourceImage));
  });

  it("rejects duplicate and unsafe target mappings", () => {
    expect(() => assertUniqueDocumentTargets([
      { targetPath: "README.md" },
      { targetPath: "README.md" }
    ])).toThrow("Duplicate public document target: README.md");
    expect(() => assertUniqueDocumentTargets([
      { targetPath: "../README.md" }
    ])).toThrow("Unsafe public document target");
  });

  it("plans additions, updates, and managed deletions while preserving public-only files", () => {
    const desired = [
      documentEntry("README.md", "new readme"),
      documentEntry("docs/legal/terms.en.md", "current terms"),
      documentEntry(".github/assets/banner.jpg", Buffer.from([0, 1, 2, 255]))
    ];
    const remote: RemoteTreeEntry[] = [
      remoteEntry("README.md", "old readme"),
      remoteEntry("docs/legal/terms.en.md", "current terms"),
      remoteEntry("docs/legal/retired.md", "retired"),
      remoteEntry("releases/v1.0.0.md", "release marker"),
      remoteEntry(".github/ISSUE_TEMPLATE/bug_report.yml", "issue form")
    ];

    expect(planPublicDocumentChanges(desired, remote).map(({ action, path }) => ({ action, path })))
      .toEqual([
        { action: "add", path: ".github/assets/banner.jpg" },
        { action: "delete", path: "docs/legal/retired.md" },
        { action: "update", path: "README.md" }
      ]);
  });

  it("treats an exact managed tree as a no-op and reports verification drift", () => {
    const desired = [
      documentEntry("README.md", "readme"),
      documentEntry("docs/legal/terms.en.md", "terms")
    ];
    const matching = desired.map(({ targetPath, sha }) => ({
      path: targetPath,
      mode: "100644",
      type: "blob" as const,
      sha
    }));

    expect(planPublicDocumentChanges(desired, matching)).toEqual([]);
    expect(() => assertPublicDocumentsMatch(desired, matching)).not.toThrow();
    expect(() => assertPublicDocumentsMatch(desired, [
      ...matching,
      remoteEntry("docs/legal/stale.md", "stale")
    ])).toThrow("delete:docs/legal/stale.md");
  });

  it("synchronizes only the current latest tag", async () => {
    expect(shouldSynchronizeLatestTag("v2.0.0", "v2.0.0")).toBe(true);
    expect(shouldSynchronizeLatestTag("v1.9.0", "v2.0.0")).toBe(false);

    const skippedRequest = vi.fn().mockResolvedValue({ tag_name: "v2.0.0" });
    await expect(synchronizePublicDocuments({
      api: { request: skippedRequest },
      root: "/path-that-must-not-be-read",
      tag: "v1.9.0"
    })).resolves.toEqual({ status: "skipped-not-latest", latestTag: "v2.0.0" });
    expect(skippedRequest).toHaveBeenCalledTimes(1);

    const desired = await collectPublicDocuments(process.cwd());
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const currentRequest = vi.fn(async (endpoint: string) => {
      if (endpoint === "releases/latest") return { tag_name: "v2.0.0" };
      if (endpoint === "git/ref/heads/main") return { object: { sha: commitSha } };
      if (endpoint === `git/commits/${commitSha}`) return { tree: { sha: treeSha } };
      if (endpoint === `git/trees/${treeSha}?recursive=1`) {
        return {
          truncated: false,
          tree: desired.map(({ targetPath, sha }) => ({
            path: targetPath,
            mode: "100644",
            type: "blob",
            sha
          }))
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    await expect(synchronizePublicDocuments({
      api: { request: currentRequest },
      tag: "v2.0.0"
    })).resolves.toEqual({ status: "unchanged", commitSha });
  });
});

function documentEntry(targetPath: string, content: string | Buffer): PublicDocumentEntry {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { sourcePath: targetPath, targetPath, content: bytes, sha: gitBlobSha(bytes) };
}

function remoteEntry(path: string, content: string): RemoteTreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: gitBlobSha(Buffer.from(content))
  };
}
