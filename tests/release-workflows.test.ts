import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { v1Case } from "./helpers/v1Parity";

describe("private and public release workflows", () => {
  it("keeps App credentials out of candidate jobs and calls publication after verification", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const publisherJobIndex = workflow.indexOf("\n  publish-public-release:");
    const candidateJobs = workflow.slice(0, publisherJobIndex);
    const publisherJob = workflow.slice(publisherJobIndex);

    expect(workflow).toContain("name: Private Release Candidate");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("- Ubuntu CI");
    expect(workflow).toContain("- completed");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("ref: ${{ needs.validate-ci-run.outputs.source_ref }}");
    expect(workflow).toContain("needs.semantic-release.result == 'success'");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("inputs:");
    expect(workflow).toContain("RION_STUDIO_RELEASE_REPOSITORY: rion-tw/rion-studio");
    expect(workflow).toContain('gh release upload "${tag}" "${assets[@]}" --repo "${GITHUB_REPOSITORY}"');
    expect(publisherJobIndex).toBeGreaterThan(workflow.indexOf("\n  verify-private-release:"));
    expect(candidateJobs).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(candidateJobs).not.toContain("PUBLIC_RELEASE_REPOSITORY");
    expect(publisherJob).toContain("- verify-private-release");
    expect(publisherJob).toContain("needs.verify-private-release.result == 'success'");
    expect(publisherJob).toContain("uses: ./.github/workflows/publish-public-release.yml");
    expect(publisherJob).toContain("contents: read");
    expect(publisherJob).toContain(
      "RION_RELEASE_APP_PRIVATE_KEY: ${{ secrets.RION_RELEASE_APP_PRIVATE_KEY }}"
    );
  });

  it("runs common checks on Ubuntu plus macOS and Windows package smoke jobs", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("ref: ${{ inputs.ref || github.ref }}");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("pnpm run typecheck");
    expect(workflow).toContain("pnpm run test");
    expect(workflow).toContain("pnpm run lint");
    expect(workflow).toContain("pnpm exec electron-vite build");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("pnpm run test:rust");
    expect(workflow).toContain("pnpm run build:rust && pnpm run verify:rust");
    expect(workflow).toContain("pnpm run build:native:macos && pnpm run test:native:macos");
    expect(workflow).toContain("rust-concurrency-sanitizer:");
    expect(workflow).toContain("RUSTFLAGS: -Zsanitizer=address");
    expect(workflow).toContain("one_thousand_start_stop_cycles");
    expect(workflow).toContain("external_health_lane_does_not_block");
    expect(workflow).toContain("Build unpacked application");
    expect(workflow).toContain("Verify packaged Rust Node-API core");
    expect(workflow).toContain("verifyPackagedRustCore.mjs");
    v1Case("platform-effect-lifecycle-80bc80cb3517", () => {
      expect(workflow).toContain("workflow_call:");
      expect(workflow).toContain("ref: ${{ inputs.ref || github.ref }}");
      expect(workflow).toContain("runs-on: ubuntu-latest");
    });
  });

  it("keeps platform packaging behind the Ubuntu gate and enables macOS compiler caching", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");

    expect(workflow).toContain("fail-fast: true");
    expect(workflow).toContain("actions/cache@v5");
    expect(workflow).toContain("CC=ccache clang");
    expect(workflow).toContain("CXX=ccache clang++");
    expect(workflow).toContain(".ccache");
    expect(workflow).toContain("ELECTRON_BUILDER_CACHE");
    expect(workflow).toContain("needs.resolve-release.outputs.has_release == 'true'");
    expect(workflow).toContain('gh release view "${tag}" --repo "${GITHUB_REPOSITORY}"');
    expect(workflow).not.toContain("Build platform preflight artifact");
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
