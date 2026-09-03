import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH =
  ".github/workflows/electron-production-provisional-publish.yml";
const PUBLIC_REPOSITORY = "rion-tw/rion-studio";
const PINNED_ACTION = /uses: [^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/gmu;

describe("Electron production provisional publisher workflow", () => {
  it("is owner-gated, serialized with every public-latest writer, and read-only by default", async () => {
    const source = await workflow();

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: electron-production-release");
    expect(source).toContain("Type STAGE ELECTRON PRODUCTION PUBLICATION");
    expect(source).toContain(
      'test "${OWNER_APPROVAL}" = "STAGE ELECTRON PRODUCTION PUBLICATION"'
    );
    expect(section(source, "permissions")).toBe(
      "  actions: read\n  attestations: read\n  contents: read\n\n"
    );
    expect(section(source, "concurrency")).toContain(
      "  group: public-latest-rion-studio"
    );
    expect(section(source, "concurrency")).toContain(
      "  cancel-in-progress: false"
    );
    expect(section(source, "concurrency")).toContain("  queue: max");
    expect(source).toContain(`PUBLIC_RELEASE_REPOSITORY: ${PUBLIC_REPOSITORY}`);
    expect(source).toContain(
      "SOURCE_CONTROL_REPOSITORY: rion-tw/rion-studio-source"
    );
    expect(source).not.toContain("RION_STUDIO_UPDATER_PRIVATE_KEY");
    expect(source).not.toContain("RION_STUDIO_UPDATER_KEY_PASSWORD");
  });

  it("fences dispatch provenance and keeps credential runners on trusted main code", async () => {
    const source = await workflow();
    const plan = job(source, "verify-plan", "attest-plan");
    const stage = job(source, "stage-target", "attest-staged-target");
    const acquire = job(
      source,
      "acquire-public-latest-lease",
      "attest-public-latest-lease"
    );
    const intent = job(source, "create-intent", "attest-intent");
    const persist = job(
      source,
      "persist-recovery-capsule",
      "attest-recovery-capsule-store"
    );
    const publish = job(source, "publish-provisional", "attest-provisional");
    const cleanup = job(source, "cleanup-held-lease-after-store-failure");

    expect(plan).toContain(
      "Fence dispatch to the trusted default-branch control plane"
    );
    expect(plan).toContain('test "${GITHUB_REPOSITORY}" = "${SOURCE_CONTROL_REPOSITORY}"');
    expect(plan).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(plan).toContain('test "${EVENT_DEFAULT_BRANCH}" = "main"');
    expect(plan).toContain('test "${REF_PROTECTED}" = "true"');
    expect(plan).toContain('test "${WORKFLOW_REF}" = "${EXPECTED_WORKFLOW_REF}"');
    expect(plan).toContain('test "$(jq -r .head_branch <<< "${run_json}")" = "main"');
    expect(plan).toContain('test "$(jq -r .head_sha <<< "${run_json}")" = "${GITHUB_SHA}"');
    expect(plan).toContain("control_sha=${GITHUB_SHA}");

    for (const trustedControlJob of [plan, stage, acquire, intent, persist, publish]) {
      expect(trustedControlJob).toContain(
        "Checkout the trusted default-branch control implementation"
      );
      expect(trustedControlJob).not.toContain("ref: ${{ inputs.source_sha }}");
    }
    expect(plan).toContain("ref: ${{ steps.control-plane.outputs.control_sha }}");
    expect(plan).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
    for (const downstreamControlJob of [stage, acquire, intent, persist, publish]) {
      expect(downstreamControlJob).toContain(
        "ref: ${{ needs.verify-plan.outputs.control_sha }}"
      );
    }
    for (const credentialJob of [stage, acquire, persist, publish, cleanup]) {
      expect(credentialJob).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
      expect(credentialJob).toContain("actions/create-github-app-token@");
    }
    for (const nonWriterJob of [plan, intent]) {
      expect(nonWriterJob).not.toContain("actions/create-github-app-token@");
      expect(nonWriterJob).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    }
    expect(intent).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
    expect(stage).toContain('--signer-digest "${CONTROL_SHA}"');
    expect(acquire).toContain('--control-head-sha "${CONTROL_SHA}"');
    expect(publish).toContain('--signer-digest "${CONTROL_SHA}"');
  });

  it("derives every producer artifact from API-verified run attempts", async () => {
    const source = await workflow();
    const plan = job(source, "verify-plan", "attest-plan");

    expect(plan).toContain('test "$(jq -r .event <<< "${run_json}")" = "workflow_dispatch"');
    expect(plan).toContain('test "$(jq -r .conclusion <<< "${run_json}")" = "success"');
    expect(plan).toContain('test "$(jq -r .head_branch <<< "${run_json}")" = "main"');
    expect(plan).toContain("${output_prefix}_control_sha=${control_sha}");
    expect(plan).toContain("PRIOR_CANDIDATE_RUN_ID: ${{ inputs.prior_candidate_run_id }}");
    expect(plan).toContain("verify_candidate_run \"${PRIOR_CANDIDATE_RUN_ID}\" prior_candidate");
    expect(plan).toContain(
      '".github/workflows/electron-production-candidate.yml"'
    );
    expect(plan).toContain(
      '".github/workflows/electron-updater-tauri-v22-compatibility.yml"'
    );
    expect(plan).toContain(
      "electron-production-candidate-${VERSION}-${SOURCE_SHA}-attempt-${CANDIDATE_RUN_ATTEMPT}"
    );
    expect(plan).toContain(
      "electron-production-candidate-${prior_version}-${prior_source_sha}-attempt-${PRIOR_CANDIDATE_RUN_ATTEMPT}"
    );
    expect(plan).toContain(
      "electron-production-candidate-trusted-control-${prior_version}-${prior_source_sha}-attempt-${PRIOR_CANDIDATE_RUN_ATTEMPT}"
    );
    expect(plan).toContain(
      "tauri-v22-public-lineage-darwin-aarch64-${LINEAGE_RUN_ID}-${LINEAGE_RUN_ATTEMPT}"
    );
    expect(plan).toContain(
      "tauri-v22-public-lineage-windows-x86_64-${LINEAGE_RUN_ID}-${LINEAGE_RUN_ATTEMPT}"
    );
    expect(plan).toContain("gh attestation verify");
    expect(plan).toContain("runInvocationURI == $invocation_uri");
  });

  it("requires the target app version to be newer than both source versions", async () => {
    const source = await workflow();
    const plan = job(source, "verify-plan", "attest-plan");
    const stage = job(source, "stage-target", "attest-staged-target");
    const publish = job(source, "publish-provisional", "attest-provisional");

    expect(source).toContain("tauri_version:");
    expect(source).toContain("prior_electron_version:");
    expect(source).toContain("prior_candidate_run_id:");
    expect(source).toContain("prior_candidate_receipt_sha256:");
    expect(plan).toContain("PRIOR_ELECTRON_VERSION: ${{ inputs.prior_electron_version }}");
    expect(plan).toContain("TAURI_VERSION: ${{ inputs.tauri_version }}");
    expect(plan).toContain("assertSemanticVersionIsNewer(");
    expect(plan).toContain(
      "Electron target app version relative to the published Tauri source"
    );
    expect(plan).toContain(
      "Electron target app version relative to the independently verified prior Electron candidate"
    );
    expect(plan).toContain(
      "jq -r .release.version plan-input/tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json"
    );
    expect(plan).toContain(
      "jq -r .source.version plan-input/electron-production-publication-staging-plan-receipt.json"
    );
    expect(stage).toContain(
      "trusted staging target relative to the published Tauri source"
    );
    expect(stage).toContain(
      "trusted staging target relative to the independently verified prior Electron candidate"
    );
    expect(publish).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(publish).toContain('--candidate-version "${VERSION}"');
    expect(publish).toContain(
      '--prior-candidate-version "${PRIOR_ELECTRON_VERSION}"'
    );
    expect(source).not.toMatch(/startsWith\("2[23]\."\)|==\s*2[23]/u);
  });

  it("closes and independently re-verifies the prior candidate before either public writer", async () => {
    const source = await workflow();
    const plan = job(source, "verify-plan", "attest-plan");
    const stage = job(source, "stage-target", "attest-staged-target");
    const publish = job(source, "publish-provisional", "attest-provisional");

    for (const candidateJob of [plan, stage, publish]) {
      expect(candidateJob).toContain("verifyElectronProductionCandidateBundle");
      expect(candidateJob).toContain("readTrustedControlReceipt");
      expect(candidateJob).toContain("PRIOR_CANDIDATE_RECEIPT_SHA256");
    }
    for (const prePublicationJob of [plan, stage]) {
      expect(prePublicationJob).toContain("prior-platform-candidates/macos");
      expect(prePublicationJob).toContain("prior-platform-candidates/windows");
    }
    expect(publish).toContain("publisher-prior-candidate/macos");
    expect(publish).toContain("publisher-prior-candidate/windows");
    expect(plan).toContain("prior aggregate candidate artifact is not unique");
    expect(plan).toContain("electron-production-prior-candidate-verification.json");
    expect(stage).toContain(
      "cmp plan-input/electron-production-prior-candidate-verification.json"
    );
    expect(publish).toContain(
      "Independently re-verify the pinned prior candidate before exposure"
    );
    expect(publish).toContain(
      'test "$(jq -r .head_sha <<< "${run_json}")" = "${PRIOR_CANDIDATE_CONTROL_SHA}"'
    );
    expect(publish).toContain(
      "publisher-prior-candidate/bundle/electron-production-candidate-receipt.json"
    );
    expect(publish.indexOf("Independently re-verify the pinned prior candidate before exposure"))
      .toBeLessThan(publish.indexOf("Create the narrow public-latest writer token"));
  });

  it("uploads and attests a non-authorizing staging plan before either writer token", async () => {
    const source = await workflow();
    const plan = job(source, "verify-plan", "attest-plan");
    const attestPlan = job(source, "attest-plan", "stage-target");
    const stage = job(source, "stage-target", "attest-staged-target");
    const acquire = job(
      source,
      "acquire-public-latest-lease",
      "attest-public-latest-lease"
    );
    const publish = job(source, "publish-provisional", "attest-provisional");

    expect(plan).toContain("electronProductionPublicationCli.mjs staging-plan");
    expect(plan).toContain(
      "electron-production-publication-staging-plan-receipt.json"
    );
    expect(plan).toContain(
      "Upload the exact staging plan before any public write token exists"
    );
    expect(plan).not.toContain("actions/create-github-app-token@");
    expect(attestPlan).toContain("subject-path:");
    expect(stage).toContain("if: ${{ false }}");
    expect(acquire).toContain("if: ${{ false }}");
    expect(publish).toContain("if: ${{ false }}");
    expect(stage).toContain("- attest-plan");
    expect(stage.indexOf("Verify the exact staging-plan attestation"))
      .toBeLessThan(stage.indexOf("Create the narrow public repository staging token"));
    expect(publish.indexOf("Verify all capsule attestations"))
      .toBeLessThan(publish.indexOf("Create the narrow public-latest writer token"));
  });

  it("keeps release credentials out of every detached attestation job", async () => {
    const source = await workflow();
    const detachedJobs = [
      job(source, "attest-plan", "stage-target"),
      job(source, "attest-staged-target", "acquire-public-latest-lease"),
      job(source, "attest-public-latest-lease", "create-intent"),
      job(source, "attest-intent", "persist-recovery-capsule"),
      job(
        source,
        "attest-recovery-capsule-store",
        "publish-provisional"
      ),
      job(
        source,
        "attest-provisional",
        "cleanup-held-lease-after-store-failure"
      )
    ];

    for (const detached of detachedJobs) {
      expect(detached).toContain("attestations: write");
      expect(detached).toContain("id-token: write");
      expect(detached).not.toContain("environment: electron-production-release");
      expect(detached).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
      expect(detached).not.toContain("actions/create-github-app-token@");
      expect(detached).not.toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    }
    expect(source.match(/actions\/create-github-app-token@/gu)).toHaveLength(5);
    expect(source.match(/permission-contents: write/gu)).toHaveLength(5);
  });

  it("stages exactly seven immutable candidate assets as non-latest", async () => {
    const source = await workflow();
    const stage = job(source, "stage-target", "attest-staged-target");
    const expectedAssets = [
      "Rion.Studio-mac.app.tar.gz",
      "Rion.Studio-mac.app.tar.gz.sig",
      "Rion.Studio-mac.dmg",
      "Rion.Studio-win.exe",
      "Rion.Studio-win.exe.sig",
      "SHA256SUMS.txt",
      "latest.json"
    ];

    for (const asset of expectedAssets) expect(stage).toContain(asset);
    expect(stage).toContain("test \"$(jq '.assets | length'");
    expect(stage).toContain("--latest=false");
    expect(stage).toContain("isLatest: false");
    expect(stage).toContain("electronProductionPublicationCli.mjs snapshot");
    expect(stage).toContain("cmp \"${expected}\" \"existing-public-assets/${name}\"");
    expect(stage).not.toContain("--clobber");
    expect(stage).not.toMatch(/release delete|git\/refs\/tags.*DELETE/iu);
  });

  it("generates fresh operation identities on trusted control code", async () => {
    const source = await workflow();
    const dispatch = source.slice(
      source.indexOf("  workflow_dispatch:\n"),
      source.indexOf("permissions:\n")
    );
    const plan = job(source, "verify-plan", "attest-plan");
    const identity = step(
      plan,
      "Generate fresh publication transaction and lease identities"
    );
    const stage = job(source, "stage-target", "attest-staged-target");
    const acquire = job(
      source,
      "acquire-public-latest-lease",
      "attest-public-latest-lease"
    );

    expect(dispatch).not.toContain("transaction_id:");
    expect(dispatch).not.toContain("lease_id:");
    expect(dispatch).toContain("lease_generation:");
    expect(identity.match(/randomUUID\(\)/gu)).toHaveLength(2);
    expect(identity).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
    expect(identity).toContain("transaction_id=${transactionId}");
    expect(identity).toContain("lease_id=${leaseId}");
    expect(plan).toContain(
      "TRANSACTION_ID: ${{ steps.operation-identity.outputs.transaction_id }}"
    );
    expect(stage).toContain(
      "TRANSACTION_ID: ${{ needs.verify-plan.outputs.transaction_id }}"
    );
    expect(acquire).toContain(
      "TRANSACTION_ID: ${{ needs.verify-plan.outputs.transaction_id }}"
    );
    expect(source).not.toContain("inputs.transaction_id");
    expect(source).not.toContain("inputs.lease_id");
  });

  it("acquires an exact attempt-bound durable lease after staged attestation", async () => {
    const source = await workflow();
    const acquire = job(
      source,
      "acquire-public-latest-lease",
      "attest-public-latest-lease"
    );
    const upload = step(acquire, "Upload the exact attempt-bound held lease evidence");

    expect(acquire).toContain("if: ${{ false }}");
    expect(acquire).toContain("- attest-staged-target");
    expect(source.indexOf("Attest the exact observed staged-target snapshot"))
      .toBeLessThan(source.indexOf("Acquire and close the exact held remote lease evidence"));
    expect(source.indexOf("Acquire and close the exact held remote lease evidence"))
      .toBeLessThan(source.indexOf("Create the exact intent and canonical recovery capsule"));
    expect(acquire.indexOf("Verify staged attestations before any lease credential exists"))
      .toBeLessThan(acquire.indexOf("Create the narrow durable-lease repository token"));
    expect(acquire.indexOf("Derive the exact source and target lease states"))
      .toBeLessThan(acquire.indexOf("Create the narrow durable-lease repository token"));
    expect(acquire).toContain(
      "electronProductionPublicLatestLeaseRemoteCli.mjs acquire"
    );
    for (const option of [
      '--purpose electron-v23-provisional-publication',
      '--holder-workflow .github/workflows/electron-production-provisional-publish.yml',
      '--holder-run-id "${GITHUB_RUN_ID}"',
      '--holder-run-attempt "${GITHUB_RUN_ATTEMPT}"',
      '--control-head-sha "${CONTROL_SHA}"',
      '--source-runtime tauri-v22',
      '--source-state-sha256 "${SOURCE_STATE_SHA256}"',
      '--target-runtime electron-v23',
      '--target-state-sha256 "${TARGET_STATE_SHA256}"'
    ]) expect(acquire).toContain(option);
    expect(acquire).toContain(
      'lease.generation !== Number(process.env.EXPECTED_LEASE_GENERATION)'
    );
    expect(acquire).toContain(
      "electron-production-public-latest-held-lease-evidence.json"
    );
    expect(upload).toContain(
      "electron-production-public-latest-held-lease-${{ github.run_id }}-attempt-${{ github.run_attempt }}"
    );
    expect(upload).toContain("path: lease-evidence");
    expect(upload).not.toMatch(/token|response/iu);
    expect(acquire).not.toContain("--repository");
    expect(acquire).not.toContain("--ref");
    expect(acquire).not.toContain("--path");
    expect(acquire).not.toContain("--token");
  });

  it("hash-binds the held lease and acquisition operation into the intent capsule", async () => {
    const source = await workflow();
    const leaseAttestation = job(
      source,
      "attest-public-latest-lease",
      "create-intent"
    );
    const intent = job(source, "create-intent", "attest-intent");
    const publish = job(source, "publish-provisional", "attest-provisional");
    const publisherVerification = step(
      publish,
      "Verify all capsule attestations and the exact canonical binding"
    );

    expect(leaseAttestation).toContain("attestations: write");
    expect(leaseAttestation).toContain("Attest the closed held lease evidence");
    expect(leaseAttestation).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(intent).toContain("- acquire-public-latest-lease");
    expect(intent).toContain("- attest-public-latest-lease");
    expect(intent).toContain("Verify all detached pre-mutation attestations");
    expect(intent).toContain("electron-production-public-latest-lease.json");
    expect(intent).toContain(
      "electron-production-public-latest-lease-acquire-operation.json"
    );
    expect(intent).toContain(
      "electron-production-public-latest-held-lease-evidence.json"
    );
    expect(intent).toContain("electronProductionRecoveryCapsuleCli.mjs create");
    expect(intent).toContain(
      "LEASE_EVENT_SHA256: ${{ needs.acquire-public-latest-lease.outputs.lease_event_sha256 }}"
    );
    expect(intent).toContain('--lease-event-sha256 "${LEASE_EVENT_SHA256}"');
    expect(intent).toContain('--control-head-sha "${CONTROL_SHA}"');
    expect(intent).toContain('--candidate-control-sha "${CANDIDATE_CONTROL_SHA}"');
    expect(intent).toContain(
      '--prior-candidate-control-sha "${PRIOR_CANDIDATE_CONTROL_SHA}"'
    );
    expect(intent).toContain('--transaction-id "${TRANSACTION_ID}"');
    expect(intent).toContain('--lease-id "${LEASE_ID}"');
    expect(intent).toContain('--lease-generation "${LEASE_GENERATION}"');
    expect(publisherVerification).toContain(
      'for subject in "${capsule}" "${manifest}" "${intent}"'
    );
    expect(publisherVerification).toContain(
      "electronProductionRecoveryCapsuleCli.mjs verify"
    );
    expect(publisherVerification).toContain(
      '--lease-event-sha256 "${LEASE_EVENT_SHA256}"'
    );
    expect(publisherVerification.indexOf("gh attestation verify"))
      .toBeLessThan(
        publisherVerification.indexOf(
          "electronProductionRecoveryCapsuleCli.mjs verify"
        )
      );
    expect(publisherVerification).not.toContain("manifest.durableLease");
    expect(publisherVerification).not.toContain("manifest.publisher");
    expect(publisherVerification).not.toContain("node --input-type=module");
  });

  it("observes immediately before CAS and retains the held lease for a provisional target", async () => {
    const source = await workflow();
    const publish = job(source, "publish-provisional", "attest-provisional");
    const observe = step(
      publish,
      "Observe the exact held remote lease immediately before last-moment CAS"
    );
    const release = step(
      publish,
      "Release the durable lease only for rejected exact-source cleanup"
    );
    const gate = step(
      publish,
      "Require a confirmed exact-target provisional state with its held lease retained"
    );

    expect(observe).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs observe");
    expect(observe).toContain('--held-lease-sha256 "${HELD_LEASE_SHA256}"');
    expect(publish.indexOf("Observe the exact held remote lease immediately before"))
      .toBeLessThan(publish.indexOf("Re-read exact target then source"));
    expect(publish.indexOf("Re-read exact target then source"))
      .toBeLessThan(publish.indexOf("Submit the latest mutation"));
    expect(release).toContain("acknowledgement == 'rejected'");
    expect(release).toContain("classification == 'source'");
    expect(release).not.toContain("acknowledgement == 'confirmed'");
    expect(release).not.toContain("classification == 'target'");
    expect(release.indexOf(".mjs observe")).toBeLessThan(release.indexOf(".mjs release"));
    expect(gate).toContain('test "${RELEASE_OUTCOME}" = "skipped"');
    expect(gate).toContain('test "${RECEIPT_PHASE}" = "provisional"');
    expect(source).not.toMatch(/\b(?:retry|retries|sleep|timeout|expiry|stale takeover)\b/iu);
  });

  it("seals a complete attempt-derived recovery capsule before latest mutation", async () => {
    const source = await workflow();
    const intent = job(source, "create-intent", "attest-intent");
    const attest = job(source, "attest-intent", "persist-recovery-capsule");
    const publish = job(source, "publish-provisional", "attest-provisional");
    const capsuleName =
      "electron-production-publication-recovery-capsule-${{ github.run_id }}-attempt-${{ github.run_attempt }}";
    const packageName =
      "electron-production-publication-recovery-capsule-package-${{ github.run_id }}-attempt-${{ github.run_attempt }}";
    const packageFile =
      "electron-production-publication-recovery-capsule.capsule.json";

    expect(intent).toContain("electronProductionPublicationCli.mjs project-target");
    expect(intent).toContain("electronProductionPublicationCli.mjs intent");
    expect(intent).toContain("electronProductionRecoveryCapsuleCli.mjs create");
    expect(intent).toContain(capsuleName);
    expect(intent).toContain(packageName);
    expect(intent).toContain(`recovery-capsule-package/${packageFile}`);
    expect(intent).toContain("path: recovery-capsule\n");
    expect(intent).toContain(`path: recovery-capsule-package/${packageFile}`);
    expect(intent).toContain("capsule_bytes: ${{ steps.intent.outputs.capsule_bytes }}");
    expect(intent).toContain("capsule_sha256: ${{ steps.intent.outputs.capsule_sha256 }}");
    expect(intent).toContain("manifest_bytes: ${{ steps.intent.outputs.manifest_bytes }}");
    expect(intent).not.toContain("node --input-type=module <<'NODE'");
    expect(intent).toContain("source-public-latest-snapshot.json");
    expect(intent).toContain("target-public-latest-projection.json");
    expect(intent).toContain("electron-production-publication-intent-receipt.json");
    expect(intent).toContain("electron-production-candidate-receipt.json");
    expect(intent).toContain("electron-production-prior-candidate-receipt.json");
    expect(intent).toContain("electron-production-prior-candidate-verification.json");
    expect(intent).toContain("tauri-lineage/darwin-aarch64");
    expect(intent).toContain("tauri-lineage/windows-x86_64");
    expect(attest).toContain(capsuleName);
    expect(attest).toContain(packageName);
    expect(attest).toContain(
      "path: ${{ runner.temp }}/publication-recovery-capsule-package"
    );
    expect(attest).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(attest).toContain('--capsule-sha256 "${EXPECTED_CAPSULE_SHA256}"');
    expect(attest).toContain('--manifest-sha256 "${EXPECTED_MANIFEST_SHA256}"');
    expect(attest).toContain(
      "subject-path: ${{ runner.temp }}/publication-recovery-capsule-package/" +
      packageFile
    );
    expect(publish).toContain(capsuleName);
    expect(publish).toContain(packageName);
    expect(publish).toContain(`path: recovery-capsule-package`);
    expect(publish).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(publish).toContain('--capsule-sha256 "${EXPECTED_CAPSULE_SHA256}"');
    expect(publish).toContain('--manifest-sha256 "${EXPECTED_MANIFEST_SHA256}"');
    expect(source.indexOf("Upload the complete recovery capsule before latest mutation"))
      .toBeLessThan(source.indexOf("Submit the latest mutation"));
  });

  it("persists and attests a UUID-fenced private recovery-store chain before public credentials", async () => {
    const source = await workflow();
    const persist = job(
      source,
      "persist-recovery-capsule",
      "attest-recovery-capsule-store"
    );
    const detached = job(
      source,
      "attest-recovery-capsule-store",
      "publish-provisional"
    );
    const publish = job(source, "publish-provisional", "attest-provisional");
    const precredential = step(
      persist,
      "Verify the capsule attestations and exact binding before credentials"
    );
    const paths = step(
      persist,
      "Derive the fenced transaction paths and validate owner configuration"
    );
    const head = step(
      persist,
      "Read the exact private default-branch head after credential creation"
    );
    const durableVerification = step(
      publish,
      "Verify the durable recovery-store evidence before public credentials"
    );

    expect(persist).toContain("if: ${{ false }}");
    expect(persist).toContain("environment: electron-production-recovery-store");
    expect(persist).toContain("- attest-intent");
    expect(persist).toContain(
      "ref: ${{ needs.verify-plan.outputs.control_sha }}"
    );
    expect(persist.indexOf(precredential))
      .toBeLessThan(persist.indexOf("Create the narrow private recovery-store writer token"));
    expect(precredential).toContain("gh attestation verify");
    expect(precredential).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(paths).toContain("electronProductionRecoveryStoreTransactionPaths");
    expect(paths).toContain(".capsulePath");
    expect(paths).toContain(".storeSealPath");
    expect(paths).toContain(".recoveryOutcomeTerminalPath");
    expect(paths).toContain("transactions/${TRANSACTION_ID}");
    expect(persist).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_APP_CLIENT_ID"
    );
    expect(persist).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_DEFAULT_BRANCH"
    );
    expect(persist).toContain("vars.ELECTRON_PRODUCTION_RECOVERY_STORE_OWNER");
    expect(persist).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_REPOSITORY"
    );
    expect(persist).toContain("secrets.RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(persist).toContain("permission-contents: write");
    expect(head).toContain(
      'test "${default_branch}" = "${RECOVERY_DEFAULT_BRANCH}"'
    );
    expect(head).toContain("git/ref/heads/${default_branch}");
    expect(head).toContain('test "$(jq -er .private');
    expect(head).toContain('test "$(jq -er .visibility');
    expect(persist.match(/electronProductionRecoveryStoreRemoteCli\.mjs create/gu))
      .toHaveLength(2);
    expect(persist.indexOf('--package "${capsule}"'))
      .toBeLessThan(persist.indexOf("materialize-store-seal"));
    expect(persist.indexOf("materialize-store-seal"))
      .toBeLessThan(persist.indexOf('--package "${store_seal}"'));
    expect(persist).toContain('--expected-head-sha "${capsule_commit_sha}"');
    expect(persist).toContain(
      'test "$(jq -er .applied.parentCommitSha "${seal_operation}")"'
    );
    expect(persist).toContain(
      "electron-production-publication-recovery-store-evidence-${{ github.run_id }}-attempt-${{ github.run_attempt }}"
    );
    expect(persist).toContain("path: recovery-store-evidence");
    expect(paths).not.toContain('echo "recovery_outcome_path=');
    expect(persist).not.toContain('--path "${recovery_outcome_path}"');
    expect(persist).not.toContain("repos.create");

    expect(detached).toContain("actions: read");
    expect(detached).toContain("attestations: write");
    expect(detached).toContain("id-token: write");
    expect(detached).not.toContain("environment:");
    expect(detached).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(detached).not.toContain("actions/create-github-app-token@");
    expect(detached).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(detached).toContain("electronProductionPublicationRecoveryCli.mjs verify-store-seal");
    expect(detached).toContain(
      "electronProductionRecoveryStoreCreateChainCli.mjs"
    );
    expect(detached).toContain("verify-create-chain");
    expect(detached).toContain('--transaction-id "${TRANSACTION_ID}"');
    expect(detached).toContain('--ref "${RECOVERY_DEFAULT_BRANCH}"');
    expect(detached).not.toContain(
      "verifyElectronProductionRecoveryStoreRemoteOperationRequest"
    );
    expect(detached.match(/actions\/attest-build-provenance@/gu)).toHaveLength(3);

    expect(publish).toContain("- persist-recovery-capsule");
    expect(publish).toContain("- attest-recovery-capsule-store");
    expect(publish).toContain(
      "Download the attested durable recovery-store evidence"
    );
    expect(durableVerification).toContain(
      'for subject in "${capsule_operation}" "${store_seal}" "${seal_operation}"'
    );
    expect(durableVerification).toContain(
      "electronProductionPublicationRecoveryCli.mjs verify-store-seal"
    );
    expect(durableVerification).toContain(
      "electronProductionRecoveryStoreCreateChainCli.mjs"
    );
    expect(durableVerification.indexOf("gh attestation verify"))
      .toBeLessThan(durableVerification.indexOf("verify-store-seal"));
    expect(publish.indexOf("Verify the durable recovery-store evidence"))
      .toBeLessThan(publish.indexOf("Create the narrow public-latest writer token"));

    for (const hardDisabled of [
      job(source, "stage-target", "attest-staged-target"),
      job(
        source,
        "acquire-public-latest-lease",
        "attest-public-latest-lease"
      ),
      persist,
      publish
    ]) expect(hardDisabled).toContain("if: ${{ false }}");
  });

  it("uses exact pre/post observations and never treats unknown acknowledgement as success", async () => {
    const source = await workflow();
    const publish = job(source, "publish-provisional", "attest-provisional");

    expect(publish).toContain("Observe the CAS precondition before creating a write token");
    expect(publish).toContain(
      "cmp -s recovery-capsule/source-public-latest-snapshot.json"
    );
    expect(publish).toContain('ACKNOWLEDGEMENT="not-submitted"');
    expect(publish).toContain('echo "acknowledgement=confirmed"');
    expect(publish).toContain('echo "acknowledgement=unknown"');
    expect(publish).toContain('echo "acknowledgement=rejected"');
    expect(publish).toContain("capture_restorable_source");
    expect(publish).toContain(
      "assertElectronProductionRestorableSourceRelease({ source, observed })"
    );
    expect(publish).toContain(
      "Re-read exact target then source at the last-moment CAS boundary"
    );
    expect(publish).toContain(
      'capture_release "releases/tags/v${VERSION}" "${target_root}" false true'
    );
    expect(publish).toContain(
      "cmp recovery-capsule/staged-target-public-release-snapshot.json"
    );
    expect(publish).toContain(
      "electronProductionPublicationCli.mjs project-target"
    );
    expect(publish).toContain(
      "cmp recovery-capsule/target-public-latest-projection.json"
    );
    expect(publish).toContain(
      'capture_release "releases/latest" "${source_root}" true false'
    );
    expect(publish).toContain(
      "cmp recovery-capsule/source-public-latest-snapshot.json"
    );
    const targetReread = publish.indexOf(
      'capture_release "releases/tags/v${VERSION}"'
    );
    const sourceReread = publish.indexOf(
      'capture_release "releases/latest" "${source_root}"'
    );
    const mutation = publish.indexOf("Submit the latest mutation");
    expect(targetReread).toBeGreaterThan(-1);
    expect(targetReread).toBeLessThan(sourceReread);
    expect(sourceReread).toBeLessThan(mutation);
    expect(publish).toContain(
      "steps.last-moment-cas.outputs.verified == 'true'"
    );
    expect(publish).toContain('effective_acknowledgement="unknown"');
    expect(publish).toContain("recordElectronProductionPublicationResult");
    expect(publish).toContain(
      "electron-production-publication-recovery-required-${GITHUB_RUN_ID}-attempt-${GITHUB_RUN_ATTEMPT}"
    );
    expect(publish).toContain(
      'test "${RECEIPT_PHASE}" = "provisional"'
    );
    expect(publish).not.toContain("terminalPromotionReceipt: true");
    expect(publish).not.toContain("phase: \"terminal\"");
  });

  it("cleans up only an unmutated exact-source lease after private persistence fails", async () => {
    const source = await workflow();
    const cleanup = job(source, "cleanup-held-lease-after-store-failure");
    const verify = step(
      cleanup,
      "Verify the exact capsule and attestations before public credentials"
    );
    const observe = step(
      cleanup,
      "Fresh-observe exact source and the held lease before credentials"
    );
    const release = step(
      cleanup,
      "Release the exact held lease from a fresh exact source"
    );
    const gate = step(
      cleanup,
      "Require a confirmed lease release without claiming unknown success"
    );

    expect(cleanup).toContain(
      "if: ${{ false && always() && needs.persist-recovery-capsule.result == 'failure' }}"
    );
    for (const dependency of [
      "verify-plan",
      "acquire-public-latest-lease",
      "create-intent",
      "attest-intent",
      "persist-recovery-capsule"
    ]) expect(cleanup).toContain(`- ${dependency}`);
    expect(cleanup).toContain("environment: electron-production-release");
    expect(cleanup).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(cleanup).not.toContain("ELECTRON_PRODUCTION_RECOVERY_STORE_REPOSITORY");
    expect(verify).toContain("gh attestation verify");
    expect(verify).toContain("electronProductionRecoveryCapsuleCli.mjs verify");
    expect(observe).toContain("electronProductionPublicLatestRecoveryCli.mjs observe");
    expect(observe).toContain("electronProductionPublicLatestLeaseRemoteCli.mjs observe");
    expect(observe).toContain('= "source"');
    expect(observe).toContain('= "observed"');
    expect(cleanup.indexOf("Fresh-observe exact source"))
      .toBeLessThan(cleanup.indexOf("Create the narrow public lease-cleanup token"));
    expect(release).toContain("electronProductionPublicLatestRecoveryCli.mjs release-lease");
    expect(release).toContain("set +e");
    expect(release).toContain('acknowledgement="pre-fence-failed"');
    expect(cleanup).toContain(
      "Upload cleanup evidence including indeterminate acknowledgements"
    );
    expect(gate).toContain('test "${ACKNOWLEDGEMENT}" = "confirmed"');
    expect(gate).toContain('test "${RELEASE_STATUS}" = "0"');
  });

  it("emits and detached-attests the exact readiness provisional artifact", async () => {
    const source = await workflow();
    const publish = job(source, "publish-provisional", "attest-provisional");
    const attest = job(
      source,
      "attest-provisional",
      "cleanup-held-lease-after-store-failure"
    );
    const artifact =
      "electron-production-publication-provisional-${VERSION}-${SOURCE_SHA}-attempt-${GITHUB_RUN_ATTEMPT}";

    expect(publish).toContain(artifact);
    expect(attest).toContain(
      "electron-production-publication-provisional-${{ inputs.version }}-${{ inputs.source_sha }}-attempt-${{ github.run_attempt }}"
    );
    expect(attest).toContain(
      "electron-production-publication-provisional-receipt.json"
    );
    expect(attest).toContain("actions/attest-build-provenance@");
  });

  it("pins every third-party action to an immutable commit", async () => {
    const source = await workflow();
    const uses = source.match(/^\s*uses: .*$/gmu) ?? [];

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line.trim(), line).toMatch(PINNED_ACTION);
    }
  });

  it("does not equate the public marker commit with either private source identity", async () => {
    const source = await workflow();

    expect(source).toContain('targetCommitish: process.env.TAG_COMMIT');
    expect(source).not.toMatch(/tag_commit[^\n]*SOURCE_SHA|SOURCE_SHA[^\n]*tag_commit/iu);
    expect(source).not.toMatch(/public_main_sha[^\n]*SOURCE_SHA|SOURCE_SHA[^\n]*public_main_sha/iu);
    expect(source).not.toMatch(/startsWith\("2[23]\."\)|==\s*2[23]/u);
  });
});

async function workflow(): Promise<string> {
  return (await readFile(WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");
}

function job(source: string, name: string, nextName?: string): string {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  if (!nextName) return source.slice(start);
  const end = source.indexOf(`  ${nextName}:\n`, start + startMarker.length);
  if (end < 0) throw new Error(`Missing workflow job ${nextName}.`);
  return source.slice(start, end);
}

function step(source: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step ${name}.`);
  const end = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

function section(source: string, name: string): string {
  const marker = `${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing top-level section ${name}.`);
  const bodyStart = start + marker.length;
  const body = source.slice(bodyStart);
  const next = body.search(/^[-\w]+:/mu);
  return next < 0 ? body : body.slice(0, next);
}
