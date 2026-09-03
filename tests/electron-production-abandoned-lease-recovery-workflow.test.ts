import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH =
  ".github/workflows/electron-production-abandoned-lease-recovery.yml";
const PUBLISHER_WORKFLOW_PATH =
  ".github/workflows/electron-production-provisional-publish.yml";
const UPDATER_CONTRACT_PATH = "docs/updater-transaction-contract.md";
const PINNED_ACTION = /uses: [^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/gmu;

describe("Electron production abandoned-lease recovery workflow", () => {
  it("discovers the authoritative lease instead of accepting guessed identity input", async () => {
    const source = await workflow();
    const dispatch = source.slice(
      source.indexOf("  workflow_dispatch:\n"),
      source.indexOf("permissions:\n")
    );

    expect(dispatch.match(/^ {6}[a-z0-9_]+:$/gmu)).toEqual([
      "      owner_approval:"
    ]);
    expect(dispatch).not.toMatch(/transaction|lease_id|run_id|sha256|generation/iu);
    expect(source).toContain("Type RELEASE ABANDONED ELECTRON LEASE");
    expect(source).toContain(
      'test "${OWNER_APPROVAL}" = "RELEASE ABANDONED ELECTRON LEASE"'
    );
    expect(source).toContain(
      "contents/releases/electron-production-public-latest-lease.json?ref=main"
    );
  });

  it("is serialized with public-latest writers and hard-disabled as one mutation job", async () => {
    const source = await workflow();

    expect(topLevelSection(source, "concurrency")).toContain(
      "  group: public-latest-rion-studio"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  cancel-in-progress: false"
    );
    expect(topLevelSection(source, "concurrency")).toContain("  queue: max");
    expect(jobNames(source)).toEqual(["release-abandoned-provisional-lease"]);
    expect(job(source, "release-abandoned-provisional-lease")).toMatch(
      /^ {2}release-abandoned-provisional-lease:\n(?:.*\n){0,8} {4}if: \$\{\{ false \}\}/mu
    );
  });

  it("fences protected main and checks exact owner approval before credential creation", async () => {
    const source = await workflow();
    const body = job(source, "release-abandoned-provisional-lease");
    const control = workflowStep(
      body,
      "Fence dispatch to the protected trusted-main control plane"
    );
    const approval = workflowStep(body, "Validate the exact owner recovery approval");

    expect(control).toContain('test "${GITHUB_EVENT_NAME}" = "workflow_dispatch"');
    expect(control).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(control).toContain('test "${REF_PROTECTED}" = "true"');
    expect(control).toContain('test "${WORKFLOW_REF}" = "${EXPECTED_WORKFLOW_REF}"');
    expect(control).toContain(
      ".github/workflows/electron-production-abandoned-lease-recovery.yml"
    );
    expect(body).toContain("Checkout only the trusted recovery control implementation");
    expect(approval).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
    expect(body.indexOf(approval)).toBeLessThan(
      body.indexOf("Create the sole narrow public lease-write credential")
    );
  });

  it("uses one public-repository credential and no private recovery-store authority", async () => {
    const source = await workflow();
    const body = job(source, "release-abandoned-provisional-lease");
    const token = workflowStep(
      body,
      "Create the sole narrow public lease-write credential"
    );

    expect(body).toContain("environment: electron-production-release");
    expect(body.match(/actions\/create-github-app-token@/gu)).toHaveLength(1);
    expect(token).toContain("vars.RION_RELEASE_APP_CLIENT_ID");
    expect(token).toContain("secrets.RION_RELEASE_APP_PRIVATE_KEY");
    expect(token).toContain("repositories: rion-studio");
    expect(token).toContain("permission-contents: write");
    expect(body.indexOf("Discover the current lease and prove its holder"))
      .toBeLessThan(body.indexOf("Create the sole narrow public lease-write"));
    expect(source).not.toMatch(/RECOVERY_STORE|RION_RECOVERY/iu);
    expect(source).not.toMatch(/private-key:.*(?:candidate|updater)/iu);
  });

  it("accepts only the exact held provisional lease whose latest holder attempt failed or was cancelled", async () => {
    const source = await workflow();
    const inspect = workflowStep(
      source,
      "Discover the current lease and prove its holder is terminally abandoned"
    );

    for (const binding of [
      'lease.status !== "held"',
      'lease.purpose !== "electron-v23-provisional-publication"',
      'lease.holder.repository !== "rion-tw/rion-studio-source"',
      'lease.holder.workflow !==',
      'lease.source.runtime !== "tauri-v22"',
      'lease.target.runtime !== "electron-v23"'
    ]) expect(inspect).toContain(binding);
    expect(inspect).toContain(
      '"repos/${SOURCE_CONTROL_REPOSITORY}/actions/runs/${holder_run_id}"'
    );
    expect(inspect).toContain(
      '"repos/${SOURCE_CONTROL_REPOSITORY}/actions/runs/${holder_run_id}/attempts/${holder_run_attempt}"'
    );
    expect(inspect).toContain('test "$(jq -er .status <<< "${run_json}")" = "completed"');
    expect(inspect).toContain("failure|cancelled) ;;");
    expect(inspect).toContain('test "$(jq -er .run_attempt <<< "${run_json}")"');
    expect(inspect).toContain('test "$(jq -er .head_sha <<< "${run_json}")"');
    expect(inspect).toContain(
      '= ".github/workflows/electron-production-provisional-publish.yml"'
    );
    expect(inspect).not.toMatch(/success\)\s*;;|in_progress\)\s*;;/u);
  });

  it("requires bounded exact-attempt evidence that neither public mutation job ran", async () => {
    const source = await workflow();
    const inspect = workflowStep(
      source,
      "Discover the current lease and prove its holder is terminally abandoned"
    );

    expect(inspect).toContain(
      "actions/runs/${holder_run_id}/attempts/${holder_run_attempt}/jobs"
    );
    expect(inspect).toContain("?per_page=100&page=1");
    expect(inspect).toContain('test "${total_count}" -le 256');
    expect(inspect).toContain("page <= page_count");
    expect(inspect).toContain("[.[].id] | unique | length");
    expect(inspect).toContain(
      "Compare-and-swap public latest into non-terminal provisional state"
    );
    expect(inspect).toContain(
      "Release an unmutated source lease after recovery-store failure"
    );
    expect(inspect).toContain("publish job is not unique");
    expect(inspect).toContain("cleanup job is not unique");
    expect(inspect).toContain(
      'test "$(jq -er .status "${publish_job}")" = "completed"'
    );
    expect(inspect).toContain(
      'test "$(jq -er .conclusion "${publish_job}")" = "skipped"'
    );
    expect(inspect).toContain(
      "Submit the latest mutation without converting an unknown acknowledgement to success"
    );
    expect(inspect).toContain(
      "'.steps | type == \"array\" and length == 0'"
    );
    expect(inspect).toContain(
      'echo "publish_job_id=${publish_job_id}" >> "${GITHUB_OUTPUT}"'
    );
    expect(inspect).toContain(
      'echo "cleanup_job_id=${cleanup_job_id}" >> "${GITHUB_OUTPUT}"'
    );
    expect(inspect).toContain(
      'test "$(jq -er .conclusion "${cleanup_job}")" = "skipped"'
    );
    expect(inspect).toContain(
      "'.steps | type == \"array\" and length == 0'"
    );
  });

  it("pins the live API job name to the publisher job and mutation-step contract", async () => {
    const [source, publisher] = await Promise.all([
      workflow(),
      normalizedFile(PUBLISHER_WORKFLOW_PATH)
    ]);
    const publishJob = job(publisher, "publish-provisional");
    const cleanupJob = job(
      publisher,
      "cleanup-held-lease-after-store-failure"
    );

    expect(publishJob).toMatch(
      /^ {2}publish-provisional:\n {4}name: Compare-and-swap public latest into non-terminal provisional state$/mu
    );
    expect(publishJob).toContain(
      "- name: Submit the latest mutation without converting an unknown acknowledgement to success"
    );
    expect(publishJob).toContain("if: ${{ false }}");
    expect(cleanupJob).toMatch(
      /^ {2}cleanup-held-lease-after-store-failure:\n {4}name: Release an unmutated source lease after recovery-store failure$/mu
    );
    expect(cleanupJob).toContain("if: ${{ false && always()");
    expect(publisher.match(
      /Submit the latest mutation without converting an unknown acknowledgement to success/gu
    )).toHaveLength(1);
    expect(source).toContain(
      "EXPECTED_PUBLISH_JOB_NAME: Compare-and-swap public latest into non-terminal provisional state"
    );
    expect(source).toContain(
      "EXPECTED_MUTATION_STEP_NAME: Submit the latest mutation without converting an unknown acknowledgement to success"
    );
    expect(source).toContain(
      "EXPECTED_CLEANUP_JOB_NAME: Release an unmutated source lease after recovery-store failure"
    );
  });

  it("documents both skipped-job fences and the marker-before-enable gate", async () => {
    const contract = await normalizedFile(UPDATER_CONTRACT_PATH);

    expect(contract).toContain("both possible public\nmutation jobs");
    expect(contract).toContain("`publish-provisional` job");
    expect(contract).toContain("`cleanup-held-lease-after-store-failure` job");
    expect(contract).toContain("terminal `skipped` with no executed steps");
    expect(contract).toContain("durable\none-shot public-mutation marker");
    expect(contract).toContain("owner-approved recovery\ndrill has passed");
  });

  it("rebuilds the exact Tauri source inside the mutation invocation", async () => {
    const source = await workflow();
    const observe = workflowStep(
      source,
      "Submit the single fenced lease release and preserve its exact outcome"
    );

    expect(observe).toContain(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/releases/latest"'
    );
    expect(observe).toContain(
      'test "${initial_tag}" = "v${HELD_SOURCE_VERSION}"'
    );
    expect(observe).toContain("electronProductionPublicationCli.mjs snapshot");
    expect(observe).toContain(
      "snapshot.stateSha256 !== process.env.HELD_SOURCE_STATE_SHA256"
    );
    expect(observe).toContain("snapshot.candidateReceipt !== null");
    expect(observe).toContain("snapshot.release.isLatest !== true");
    expect(observe).toContain(
      'find "${assets_root}" -mindepth 1 -maxdepth 1 -type f -delete'
    );
    expect(observe).toContain('head -c "$((expected_bytes + 1))"');
    expect(observe).toContain('test "${expected_bytes}" -le 1073741824');
  });

  it("uses the existing one-shot fenced release authority and fails closed on unknown", async () => {
    const source = await workflow();
    const body = job(source, "release-abandoned-provisional-lease");
    const release = workflowStep(
      body,
      "Submit the single fenced lease release and preserve its exact outcome"
    );
    const finish = workflowStep(
      body,
      "Fail closed unless the exact release was confirmed"
    );

    expect(release.match(/electronProductionPublicLatestLeaseRemoteCli\.mjs release/gu))
      .toHaveLength(1);
    for (const option of [
      "--held-lease",
      "--held-lease-sha256",
      "--recorded-at",
      "--output"
    ]) expect(release).toContain(option);
    expect(release).toContain("rejected|indeterminate) ;;");
    expect(release).toContain('test ! -e "${released}"');
    expect(release).toContain(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/releases/latest"'
    );
    expect(release).toContain(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/git/ref/tags/${closing_tag}"'
    );
    const latestReads = [...release.matchAll(
      /"repos\/\$\{PUBLIC_RELEASE_REPOSITORY\}\/releases\/latest"/gu
    )];
    expect(latestReads).toHaveLength(3);
    const initialTagRead = release.indexOf(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/git/ref/tags/${initial_tag}"'
    );
    const assetRead = release.indexOf(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/releases/assets/${asset_id}"'
    );
    const closingTagRead = release.indexOf(
      '"repos/${PUBLIC_RELEASE_REPOSITORY}/git/ref/tags/${closing_tag}"'
    );
    expect(latestReads[0].index).toBeLessThan(initialTagRead);
    expect(initialTagRead).toBeLessThan(assetRead);
    expect(assetRead).toBeLessThan(latestReads[1].index);
    expect(latestReads[1].index).toBeLessThan(closingTagRead);
    expect(closingTagRead).toBeLessThan(latestReads[2].index);
    expect(release).toContain(
      "The final latest reread changed after the tag read."
    );
    expect(release).toContain(
      "latest release asset identities changed."
    );
    expect(release).toContain("The closing latest tag identity changed.");
    expect(release).toContain(
      "!Number.isSafeInteger(release?.id)"
    );
    expect(release).toContain(
      "reference.object?.sha !== snapshot.release.targetCommitish"
    );
    const releaseAuthority = release.indexOf(
      "electronProductionPublicLatestLeaseRemoteCli.mjs release"
    );
    for (const closingFence of [
      "actions/runs/${HOLDER_RUN_ID}/attempts/${HOLDER_RUN_ATTEMPT}/jobs",
      "final_total_count",
      'test "$(jq -er .conclusion "${final_holder_job}")" = "skipped"',
      'test "$(jq -er .conclusion "${final_cleanup_job}")" = "skipped"',
      'cmp "${operation_root}/initial-publish-job-identity.json"',
      'cmp "${operation_root}/initial-cleanup-job-identity.json"',
      "CLOSING_RELEASE=",
      "!isDeepStrictEqual(finalIdentity, closingIdentity)",
      "!Number.isSafeInteger(release?.id)",
      "!isDeepStrictEqual(assets, snapshot.assets)",
      "reference.object?.sha !== snapshot.release.targetCommitish"
    ]) expect(release.indexOf(closingFence), closingFence)
      .toBeLessThan(releaseAuthority);
    expect(release.lastIndexOf("GH_TOKEN=")).toBeLessThan(
      releaseAuthority
    );
    expect(release).not.toMatch(/--method PUT|-X PUT/iu);
    expect(release).not.toMatch(/retry|takeover|expir|force/iu);
    expect(source).not.toContain("observe-release");
    expect(source).not.toContain("reconcile-lease-release");
    expect(finish).toContain('test "${COMMAND_EXIT_CODE}" = "0"');
    expect(body).not.toMatch(/gh release (?:create|edit|upload|delete)/iu);
    expect(body).not.toMatch(/make_latest|releases\/[^\s"]+.*--method PATCH/iu);
  });

  it("never checks out holder code and pins every third-party action", async () => {
    const source = await workflow();
    const uses = source.match(/^\s*uses: .*$/gmu) ?? [];

    expect(source).not.toContain("ref: ${{ steps.held");
    expect(source).not.toContain("ref: ${{ steps.release");
    expect(source).not.toMatch(/gh run download|actions\/download-artifact/iu);
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line.trim(), line).toMatch(PINNED_ACTION);
  });
});

async function workflow(): Promise<string> {
  return normalizedFile(WORKFLOW_PATH);
}

async function normalizedFile(filePath: string): Promise<string> {
  return (await readFile(filePath, "utf8")).replaceAll("\r\n", "\n");
}

function jobNames(source: string): string[] {
  const jobsStart = source.indexOf("jobs:\n");
  return [...source.slice(jobsStart).matchAll(/^ {2}([a-z0-9-]+):$/gmu)]
    .map((match) => match[1]);
}

function job(source: string, name: string): string {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  const next = source.slice(start + startMarker.length)
    .search(/^ {2}[a-z0-9-]+:$/mu);
  return next < 0
    ? source.slice(start)
    : source.slice(start, start + startMarker.length + next);
}

function workflowStep(source: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step ${name}.`);
  const end = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

function topLevelSection(source: string, name: string): string {
  const marker = `${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing top-level section ${name}.`);
  const bodyStart = start + marker.length;
  const body = source.slice(bodyStart);
  const next = body.search(/^[-\w]+:/mu);
  return next < 0 ? body : body.slice(0, next);
}
