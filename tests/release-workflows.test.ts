import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("private and public release workflows", () => {
  it("keeps App credentials out of candidate jobs and calls publication after verification", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const publisherJobIndex = workflow.indexOf("\n  publish-public-release:");
    const candidateJobs = workflow.slice(0, publisherJobIndex);
    const publisherJob = workflow.slice(publisherJobIndex);

    expect(workflow).toContain("name: Private Release Candidate");
    expect(workflow).toContain("RION_STUDIO_RELEASE_REPOSITORY: rion-tw/rion-studio");
    expect(workflow).toContain('gh release upload "${tag}" "${assets[@]}" --repo "${GITHUB_REPOSITORY}"');
    expect(publisherJobIndex).toBeGreaterThan(workflow.indexOf("\n  verify-private-release:"));
    expect(candidateJobs).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(candidateJobs).not.toContain("PUBLIC_RELEASE_REPOSITORY");
    expect(publisherJob).toContain("- verify-private-release");
    expect(publisherJob).toContain("if: needs.resolve-release.outputs.has_release == 'true'");
    expect(publisherJob).toContain("uses: ./.github/workflows/publish-public-release.yml");
    expect(publisherJob).toContain("contents: read");
    expect(publisherJob).toContain(
      "RION_RELEASE_APP_PRIVATE_KEY: ${{ secrets.RION_RELEASE_APP_PRIVATE_KEY }}"
    );
  });

  it("supports automatic calls and CI retries with only the named App secret", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("RION_RELEASE_APP_PRIVATE_KEY:\n        required: true");
    expect(workflow).not.toContain("secrets: inherit");
    expect(workflow).toContain("client-id: ${{ vars.RION_RELEASE_APP_CLIENT_ID }}");
    expect(workflow).toContain("private-key: ${{ secrets.RION_RELEASE_APP_PRIVATE_KEY }}");
    expect(workflow).toContain("repositories: rion-studio");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain('GH_TOKEN: ${{ steps.public-token.outputs.token }}');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it("publishes only after draft upload verification", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");

    const draftIndex = workflow.indexOf("gh release create");
    const uploadIndex = workflow.indexOf("gh release upload");
    const verifyIndex = workflow.indexOf("cmp release-assets/SHA256SUMS.txt");
    const publishIndex = workflow.indexOf("gh release edit");

    expect(draftIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(draftIndex);
    expect(verifyIndex).toBeGreaterThan(uploadIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
  });

  it("uses the private token only before public mutations", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");
    const appTokenIndex = workflow.indexOf("- name: Create public repository token");

    expect(appTokenIndex).toBeGreaterThan(
      workflow.indexOf('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    );
    expect(workflow.slice(appTokenIndex)).not.toContain(
      'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'
    );
  });

  it("blocks publication while public source paths remain", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");

    for (const path of [
      "src",
      "tests",
      "native",
      "package.json",
      "pnpm-lock.yaml",
      "electron-builder.config.mjs"
    ]) {
      expect(workflow).toContain(path);
    }
  });

  it("fails closed on a conflicting public tag and safely retries an existing draft", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");

    expect(workflow).toContain("verify_marker");
    expect(workflow).toContain("cmp public-release-marker.md existing-public-marker.md");
    expect(workflow).toContain('if release_json="$(gh release view');
    expect(workflow).toContain('if [[ "$(jq -r .isDraft');
    expect(workflow).toContain("--clobber");
  });

  it("removes only the verified v1.19.1 migration canary after publication", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-public-release.yml");
    const publishIndex = workflow.indexOf("- name: Publish verified public release");
    const cleanupIndex = workflow.indexOf("- name: Remove verified migration canary");
    const deleteReleaseIndex = workflow.indexOf(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/releases/${CANARY_RELEASE_ID}"',
      cleanupIndex
    );
    const deleteTagIndex = workflow.indexOf(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/git/refs/tags/${CANARY_TAG}"',
      deleteReleaseIndex
    );

    expect(cleanupIndex).toBeGreaterThan(publishIndex);
    expect(workflow.slice(cleanupIndex)).toContain("if: inputs.tag == 'v1.19.1'");
    expect(workflow.slice(cleanupIndex)).toContain('CANARY_RELEASE_ID: "354597707"');
    expect(workflow.slice(cleanupIndex)).toContain('CANARY_ASSET_ID: "478185887"');
    expect(workflow.slice(cleanupIndex)).toContain(
      "CANARY_TAG: migration-canary-20260716"
    );
    expect(deleteReleaseIndex).toBeGreaterThan(cleanupIndex);
    expect(deleteTagIndex).toBeGreaterThan(deleteReleaseIndex);
    expect(workflow.slice(cleanupIndex)).toContain(
      'releases/latest" --jq .tag_name)" = "${TAG}"'
    );
    expect(workflow.slice(cleanupIndex)).toContain('grep -Fq "HTTP 404"');
  });

  it("restores public latest only through a verified App-token workflow", async () => {
    const workflow = await readWorkflow(".github/workflows/restore-public-latest.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("CONFIRM: ${{ inputs.confirm }}");
    expect(workflow).toContain("client-id: ${{ vars.RION_RELEASE_APP_CLIENT_ID }}");
    expect(workflow).toContain("private-key: ${{ secrets.RION_RELEASE_APP_PRIVATE_KEY }}");
    expect(workflow).toContain('GH_TOKEN: ${{ steps.public-token.outputs.token }}');
    expect(workflow).not.toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain("node scripts/releaseArtifacts.mjs rollback-assets");
    expect(workflow).toContain("gh release edit");
    expect(workflow).toContain("--latest");
    expect(workflow).toContain('releases/latest" --jq .tag_name)" = "${TAG}"');
  });
});

async function readWorkflow(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}
