import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("private and public release workflows", () => {
  it("builds candidates only in the private repository", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("name: Private Release Candidate");
    expect(workflow).toContain("RION_STUDIO_RELEASE_REPOSITORY: rion-tw/rion-studio");
    expect(workflow).toContain('gh release upload "${tag}" "${assets[@]}" --repo "${GITHUB_REPOSITORY}"');
    expect(workflow).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflow).not.toContain("PUBLIC_RELEASE_REPOSITORY");
  });

  it("uses the scoped GitHub App token and publishes only after draft verification", async () => {
    const workflow = await readFile(".github/workflows/publish-public-release.yml", "utf8");

    expect(workflow).toContain("client-id: ${{ vars.RION_RELEASE_APP_CLIENT_ID }}");
    expect(workflow).toContain("private-key: ${{ secrets.RION_RELEASE_APP_PRIVATE_KEY }}");
    expect(workflow).toContain("repositories: rion-studio");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain('GH_TOKEN: ${{ steps.public-token.outputs.token }}');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');

    const draftIndex = workflow.indexOf("gh release create");
    const uploadIndex = workflow.indexOf("gh release upload");
    const verifyIndex = workflow.indexOf("cmp release-assets/SHA256SUMS.txt");
    const publishIndex = workflow.indexOf("gh release edit");

    expect(draftIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(draftIndex);
    expect(verifyIndex).toBeGreaterThan(uploadIndex);
    expect(publishIndex).toBeGreaterThan(verifyIndex);
  });

  it("blocks publication while public source paths remain", async () => {
    const workflow = await readFile(".github/workflows/publish-public-release.yml", "utf8");

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
    const workflow = await readFile(".github/workflows/publish-public-release.yml", "utf8");

    expect(workflow).toContain("verify_marker");
    expect(workflow).toContain("cmp public-release-marker.md existing-public-marker.md");
    expect(workflow).toContain('if release_json="$(gh release view');
    expect(workflow).toContain('if [[ "$(jq -r .isDraft');
    expect(workflow).toContain("--clobber");
  });
});
