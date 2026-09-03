import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH =
  ".github/workflows/electron-production-provisional-recovery.yml";
const PINNED_ACTION = /uses: [^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/gmu;

describe("Electron production provisional recovery workflow", () => {
  it("accepts only a transaction ID and explicit recovery approval", async () => {
    const source = await workflow();
    const dispatch = source.slice(
      source.indexOf("  workflow_dispatch:\n"),
      source.indexOf("permissions:\n")
    );

    for (const input of [
      "transaction_id:",
      "owner_approval:"
    ]) expect(dispatch).toContain(input);
    expect(dispatch.match(/^ {6}[a-z0-9_]+:$/gmu)).toHaveLength(2);
    expect(dispatch).not.toMatch(/manifest|lease|source_snapshot|target_snapshot|base64/iu);
    expect(dispatch).not.toMatch(/capsule_sha256|publisher_run_id/iu);
    expect(source).toContain("Type RECOVER ELECTRON PROVISIONAL PUBLICATION");
    expect(source).toContain(
      'test "${OWNER_APPROVAL}" = "RECOVER ELECTRON PROVISIONAL PUBLICATION"'
    );
  });

  it("is serialized with public-latest writers and hard-disables every job", async () => {
    const source = await workflow();

    expect(topLevelSection(source, "concurrency")).toContain(
      "  group: public-latest-rion-studio"
    );
    expect(topLevelSection(source, "concurrency")).toContain(
      "  cancel-in-progress: false"
    );
    expect(topLevelSection(source, "concurrency")).toContain("  queue: max");
    for (const name of jobNames(source)) {
      expect(job(source, name), name).toMatch(
        new RegExp(`^  ${name}:\\n(?:.*\\n){0,8}    if: \\$\\{\\{ false \\}\\}`, "mu")
      );
    }
  });

  it("fences trusted control to protected main before reading recovery state", async () => {
    const source = await workflow();
    const plan = job(
      source,
      "verify-recovery-plan",
      "read-private-recovery-store"
    );
    const read = job(
      source,
      "read-private-recovery-store",
      "verify-recovered-foundation"
    );

    expect(plan).toContain("Fence the dispatch to protected trusted main");
    expect(plan).toContain('test "${GITHUB_EVENT_NAME}" = "workflow_dispatch"');
    expect(plan).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(plan).toContain('test "${REF_PROTECTED}" = "true"');
    expect(plan).toContain('test "${WORKFLOW_REF}" = "${EXPECTED_WORKFLOW_REF}"');
    expect(plan).toContain(
      '= ".github/workflows/electron-production-provisional-recovery.yml"'
    );
    expect(plan).toContain("electronProductionRecoveryStoreTransactionPaths");
    for (const trusted of [plan, read]) {
      expect(trusted).toContain(
        "Checkout the trusted default-branch control implementation"
      );
      expect(trusted).toContain('test "$(git rev-parse HEAD)" = "${CONTROL_SHA}"');
    }
  });

  it("uses a dedicated private read-only credential job with protected coordinates", async () => {
    const source = await workflow();
    const read = job(
      source,
      "read-private-recovery-store",
      "verify-recovered-foundation"
    );
    const target = workflowStep(
      read,
      "Derive exact transaction paths and validate protected store coordinates"
    );
    const remoteRead = workflowStep(
      read,
      "Create-new read the exact capsule and store seal"
    );

    expect(read).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(read).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_READER_APP_CLIENT_ID"
    );
    expect(read).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_DEFAULT_BRANCH"
    );
    expect(read).toContain("vars.ELECTRON_PRODUCTION_RECOVERY_STORE_OWNER");
    expect(read).toContain(
      "vars.ELECTRON_PRODUCTION_RECOVERY_STORE_REPOSITORY"
    );
    expect(read).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(read).toContain("permission-contents: read");
    expect(read).not.toContain("permission-contents: write");
    expect(read).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(read).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(target).toContain("electronProductionRecoveryStoreTransactionPaths");
    expect(target).toContain(".capsulePath");
    expect(target).toContain(".storeSealPath");
    expect(read.indexOf(target)).toBeLessThan(
      read.indexOf("Create a narrow private recovery-store read token")
    );
    expect(read).toContain(
      'test "$(jq -er .default_branch <<< "${repository_json}")"'
    );
    expect(remoteRead.match(/electronProductionRecoveryStoreRemoteCli\.mjs read/gu))
      .toHaveLength(2);
    expect(remoteRead).toContain(
      "electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs"
    );
    expect(remoteRead).toContain("discover");
    expect(remoteRead).toContain('--transaction-id "${TRANSACTION_ID}"');
    expect(remoteRead).not.toContain("--expected-content-sha256");
    expect(remoteRead).not.toContain("RemoteCli.mjs create");
    expect(remoteRead).not.toContain("--token");
  });

  it("reproves current readback and store bindings before attestation and materialization", async () => {
    const source = await workflow();
    const verify = job(source, "verify-recovered-foundation");
    const foundation = workflowStep(
      verify,
      "Reprove readback, store bindings, publisher identity, and attestations"
    );

    expect(verify).not.toContain("environment:");
    expect(verify).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(verify).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(verify).not.toContain("actions/create-github-app-token@");
    expect(verify).toContain("actions: read");
    expect(verify).toContain("attestations: write");
    expect(verify).toContain("id-token: write");
    expect(foundation).toContain(
      "electronProductionRecoveryStoreReadbackFoundationCli.mjs"
    );
    expect(foundation).toContain("verify-readback-foundation");
    expect(foundation).toContain(
      "electronProductionRecoveredCapsuleCli.mjs verify-recovered"
    );
    expect(foundation).toContain(
      'test "$(jq -er .verification.status "${verification}")"'
    );
    expect(foundation).toContain('= "verified-store-foundation"');
    expect(foundation).not.toContain("verified-attested-store-foundation");
    expect(foundation).toContain(
      'publisher_run_id="$(jq -er .verification.publisher.runId "${verification}")"'
    );
    expect(foundation).toContain(
      '.github/workflows/electron-production-provisional-publish.yml'
    );
    expect(foundation).not.toContain(
      'gh api "repos/${SOURCE_CONTROL_REPOSITORY}/actions/runs/'
    );
    expect(foundation).toContain("gh attestation verify");
    expect(foundation).toContain("runInvocationURI == $invocation_uri");
    expect(foundation.indexOf("verify-recovered"))
      .toBeLessThan(foundation.indexOf("gh attestation verify"));
    expect(foundation.indexOf("gh attestation verify"))
      .toBeLessThan(foundation.indexOf("materialize-recovered"));
    expect(foundation).toContain('--output-root "${root}/materialized"');
    expect(foundation).toContain(
      "electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs"
    );
    expect(foundation).toContain("verify-chain");
    expect(foundation).toContain(
      "electronProductionRecoveryStoreReadbackOutcomeBindingCli.mjs"
    );
    expect(foundation).toContain("verify-readback-outcome-binding");
    expect(foundation).toContain(
      'terminal) recovery_action="verified-terminal-no-mutation"'
    );
    expect(foundation).toContain(
      'empty|open) recovery_action="continue-recovery"'
    );
    expect(verify).toContain(
      "electron-production-publication-recovery-outcome-discovery.json"
    );
    expect(verify).toContain(
      "electron-production-publication-recovery-outcome-chain-proof.json"
    );
    expect(verify).toContain(
      "electron-production-recovery-store-readback-outcome-binding.json"
    );
    expect(foundation).toContain(
      "electronProductionRecoveryStoreOptionalIntentObservationCli.mjs"
    );
    expect(foundation).toContain("materialize-intent");
    expect(foundation).toContain('terminal) recovery_action="verified-terminal-no-mutation"');
    expect(foundation).toContain('intent_action="terminal-no-mutation"');
    expect(foundation).toContain('intent_action="create-intent"');
    expect(foundation).toContain('intent_action="resume-intent"');
    expect(verify.match(/actions\/attest-build-provenance@/gu)).toHaveLength(11);
  });

  it("fresh-reads with the separate reader App and seals unchanged continuity", async () => {
    const source = await workflow();
    const reread = job(
      source,
      "reread-private-recovery-store",
      "seal-fresh-recovery-evidence"
    );
    const gate = job(source, "seal-fresh-recovery-evidence");
    const freshRead = workflowStep(
      reread,
      "Create-new fresh-read the exact capsule and store seal"
    );
    const continuity = workflowStep(
      gate,
      "Verify initial attestations and exact readback continuity"
    );

    expect(reread).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(reread).toContain("- observe-public-latest");
    expect(reread).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(reread).toContain("permission-contents: read");
    expect(reread).not.toContain("permission-contents: write");
    expect(reread).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(reread).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(freshRead.match(/electronProductionRecoveryStoreRemoteCli\.mjs read/gu))
      .toHaveLength(2);
    expect(freshRead).toContain(
      '--expected-content-sha256 "${EXPECTED_CAPSULE_SHA256}"'
    );
    expect(freshRead).toContain(
      '--expected-content-sha256 "${EXPECTED_STORE_SEAL_SHA256}"'
    );
    expect(freshRead).toContain(
      "electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs"
    );
    expect(freshRead).toContain("discover");

    expect(gate).not.toContain("environment:");
    expect(gate).not.toContain("APP_PRIVATE_KEY");
    expect(gate).not.toContain("actions/create-github-app-token@");
    expect(gate).toContain("attestations: write");
    expect(gate).toContain("id-token: write");
    expect(continuity).toContain("gh attestation verify");
    expect(continuity).toContain(
      "electronProductionRecoveryStoreReadbackContinuityCli.mjs"
    );
    expect(continuity).toContain("verify-readback-continuity");
    expect(continuity).toContain("verify-chain");
    expect(continuity).toContain("verify-continuity");
    expect(continuity).toContain(
      "electronProductionRecoveryStoreReadbackOutcomeBindingCli.mjs"
    );
    expect(continuity).toContain(
      '--initial-discovery-sha256 "${INITIAL_OUTCOME_DISCOVERY_SHA256}"'
    );
    expect(continuity).toContain(
      '--fresh-discovery-sha256 "${FRESH_OUTCOME_DISCOVERY_SHA256}"'
    );
    expect(continuity).toContain(
      '--outcome-chain-proof-sha256 "${outcome_chain_proof_sha256}"'
    );
    expect(continuity).toContain(
      "electronProductionRecoveryStoreOptionalIntentObservationCli.mjs"
    );
    expect(continuity).toContain("verify-continuity");
    expect(continuity).toContain(
      "create-intent:absent-at-head|resume-intent:present-at-head"
    );
    expect(continuity).toContain(
      'test "$(jq -r .terminal "${outcome_chain_continuity}")" = "null"'
    );
    expect(continuity).toContain("--initial-capsule");
    expect(continuity).toContain("--fresh-capsule");
    expect(continuity).toContain(
      "electron-production-public-latest-recovery-observation.json"
    );
    expect(continuity).toContain(
      'cp -R "${observation}" sealed-recovery-evidence/public-observation'
    );
    expect(continuity).toContain("cmp \"${initial_readback}/capsule/");
    expect(continuity).toContain("cmp \"${initial_readback}/store-seal/");
    expect(continuity.indexOf("gh attestation verify"))
      .toBeLessThan(continuity.indexOf("verify-readback-continuity"));
    expect(continuity.indexOf("verify-readback-continuity"))
      .toBeLessThan(continuity.indexOf("materialize-recovered"));
    expect(gate).toContain(
      "electron-production-provisional-recovery-sealed-evidence-${{ github.run_id }}-attempt-${{ github.run_attempt }}"
    );
    expect(gate.match(/actions\/attest-build-provenance@/gu)).toHaveLength(11);
  });

  it("observes public latest without prematurely requiring the lease to remain held", async () => {
    const source = await workflow();
    const observe = job(
      source,
      "observe-public-latest",
      "reread-private-recovery-store"
    );
    const operation = workflowStep(
      observe,
      "Reverify the foundation then observe exact public state"
    );

    expect(observe).not.toContain("environment:");
    expect(observe).not.toContain("APP_PRIVATE_KEY");
    expect(observe).not.toContain("actions/create-github-app-token@");
    expect(observe).toContain("attestations: write");
    expect(observe).toContain("id-token: write");
    expect(operation).toContain("gh attestation verify");
    expect(operation).toContain(
      'test "${RECOVERY_ACTION}" = "continue-recovery"'
    );
    expect(operation.indexOf('test "${RECOVERY_ACTION}" = "continue-recovery"'))
      .toBeLessThan(operation.indexOf("gh attestation verify"));
    expect(operation).toContain(
      "electronProductionRecoveryStoreReadbackFoundationCli.mjs"
    );
    expect(operation).toContain(
      "electronProductionRecoveredCapsuleCli.mjs materialize-recovered"
    );
    expect(operation).not.toContain(
      "electronProductionPublicLatestLeaseRemoteCli.mjs observe"
    );
    expect(operation).toContain(
      "electronProductionPublicLatestRecoveryCli.mjs observe"
    );
    expect(operation).toContain("set +e");
    expect(operation).toContain("observation_status=$?");
    expect(operation).toContain("observation_status=${observation_status}");
    expect(operation.indexOf("gh attestation verify"))
      .toBeLessThan(operation.indexOf("PublicLatestRecoveryCli.mjs observe"));
    expect(observe).not.toContain("public-observation/held");
    expect(observe).toContain("if: always()");
    expect(observe.match(/actions\/attest-build-provenance@/gu)).toHaveLength(2);
  });

  it("persists an absent intent only after tokenless attestation and continuity checks", async () => {
    const source = await workflow();
    const writer = job(
      source,
      "persist-recovery-release-intent",
      "read-durable-recovery-release-intent"
    );
    const preflight = workflowStep(
      writer,
      "Reverify the no-mutation foundation before requesting a writer token"
    );
    const token = workflowStep(
      writer,
      "Create the narrow private recovery-store writer token"
    );
    const persist = workflowStep(
      writer,
      "Create-new persist only an absent durable release intent"
    );

    expect(writer).toContain("environment: electron-production-recovery-store");
    expect(writer).toContain("secrets.RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY");
    expect(preflight).toContain("gh attestation verify");
    expect(preflight).toContain(
      "electronProductionRecoveryStoreOptionalIntentObservationCli.mjs"
    );
    expect(preflight).toContain("verify-continuity");
    expect(preflight).toContain(
      "readElectronProductionPublicationRecoveryLeaseReleaseIntent"
    );
    expect(preflight).toContain("expectedHeadCommitSha");
    expect(writer.indexOf(preflight)).toBeLessThan(writer.indexOf(token));
    expect(token).toContain(
      "if: needs.verify-recovered-foundation.outputs.intent_action == 'create-intent'"
    );
    expect(token).toContain("permission-contents: write");
    expect(persist).toContain(
      "electronProductionRecoveryStoreRemoteCli.mjs create"
    );
    expect(persist).toContain('--expected-head-sha "${EXPECTED_HEAD_SHA}"');
    expect(persist).toContain('--path "${INTENT_PATH}"');
    expect(persist).toContain('= "applied"');
  });

  it("fresh-reads the durable intent with a distinct reader and proves resume history", async () => {
    const source = await workflow();
    const reader = job(
      source,
      "read-durable-recovery-release-intent",
      "authorize-durable-recovery-release"
    );
    const read = workflowStep(
      reader,
      "Read the exact intent and its same-head private foundation"
    );

    expect(reader).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(reader).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(reader).toContain("permission-contents: read");
    expect(reader).not.toContain("permission-contents: write");
    expect(reader).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(reader).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(read.match(/electronProductionRecoveryStoreRemoteCli\.mjs read/gu))
      .toHaveLength(3);
    expect(read).toContain('--expected-content-bytes "${EXPECTED_INTENT_BYTES}"');
    expect(read).toContain(
      "electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs"
    );
    expect(read).toContain(
      "electronProductionRecoveryStoreOptionalIntentObservationCli.mjs"
    );
    expect(read).toContain('= "present-at-head"');
    expect(read).toContain(
      "electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs"
    );
    expect(read).toContain("--intent-read-operation");
    expect(read).toContain("--intent-read-operation-sha256");
    expect(read).toContain('if test "${INTENT_ACTION}" = "resume-intent"');
  });

  it("authorizes only a same-head durable intent and complete open outcome chain", async () => {
    const source = await workflow();
    const authorization = job(source, "authorize-durable-recovery-release");
    const authorize = workflowStep(
      authorization,
      "Verify the post-intent head and materialize the authorization"
    );

    expect(authorization).not.toContain("environment:");
    expect(authorization).not.toContain("APP_PRIVATE_KEY");
    expect(authorization).not.toContain("actions/create-github-app-token@");
    expect(authorization).toContain("attestations: write");
    expect(authorization).toContain("id-token: write");
    expect(authorize).toContain("gh attestation verify");
    expect(authorize).toContain("verify-chain");
    expect(authorize).toContain("verify-readback-foundation");
    expect(authorize).toContain("verify-readback-outcome-binding");
    expect(authorize).toContain(
      "electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs"
    );
    expect(authorize).toContain('authorize\n');
    expect(authorize).toContain("--create-operation");
    expect(authorize).toContain("--intent-history-proof");
    expect(authorize).toContain('--current-run-id "${GITHUB_RUN_ID}"');
    expect(authorize).toContain(
      '--current-run-attempt "${GITHUB_RUN_ATTEMPT}"'
    );
    expect(authorize).toContain('--current-control-sha "${CONTROL_SHA}"');
    expect(authorize).toContain(
      '--current-run-started-at "${RECOVERY_RUN_STARTED_AT}"'
    );
    expect(authorize).toContain('--verified-at "$(date -u');
    expect(authorize).toContain(".headTransition.currentHeadCommitSha");
    expect(authorize).toContain(".currentObservation.headCommitSha");
    expect(authorization).toContain(
      "electron-production-publication-recovery-lease-release-authorization.json"
    );
  });

  it("reserves one proof-derived marker slot before any public credential exists", async () => {
    const source = await workflow();
    const prepare = job(
      source,
      "prepare-recovery-public-mutation-attempt",
      "observe-recovery-public-mutation-attempt"
    );
    const observe = job(
      source,
      "observe-recovery-public-mutation-attempt",
      "persist-recovery-public-mutation-attempt"
    );
    const writer = job(
      source,
      "persist-recovery-public-mutation-attempt",
      "read-durable-recovery-public-mutation-attempt"
    );

    expect(prepare).not.toContain("environment:");
    expect(prepare).not.toContain("APP_PRIVATE_KEY");
    expect(workflowStep(
      prepare,
      "Reverify the base authority and materialize at most one marker candidate"
    )).toContain("GH_TOKEN: ${{ github.token }}");
    expect(prepare).toContain(
      "electronProductionPublicationRecoveryPublicMutationAttemptCli.mjs"
    );
    expect(prepare).toContain("materialize-attempt");
    expect(prepare).toContain('= "0:source:release-held"');
    expect(prepare).toContain('attempt_operation="release-held-lease"');
    expect(prepare).toContain('= "0:target"');
    expect(prepare).toContain('attempt_operation="rollback-public-latest"');
    expect(prepare).toContain(
      "electronProductionPublicationRecoveryPublicMutationAttemptPath"
    );
    expect(prepare).toContain("previousOutcomeSha256:");
    expect(prepare).toContain("attempt_status=probe-marker");
    expect(prepare).not.toContain("attempt_status=no-marker");

    expect(observe).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(observe).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(observe).toContain("permission-contents: read");
    expect(observe).not.toContain("permission-contents: write");
    expect(observe).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(observe).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflowStep(
      observe,
      "Reverify the marker candidate before requesting a reader token"
    )).toContain("GH_TOKEN: ${{ github.token }}");
    expect(observe).toContain("observe-mutation-attempt");
    expect(observe).toContain("--outcome-chain-proof");
    expect(observe).toContain(
      '= "${AUTHORIZED_HEAD_SHA}"'
    );
    expect(observe).toContain('attempt_action="create-marker"');
    expect(observe).toContain('attempt_action="resume-marker"');

    expect(writer).toContain(
      "environment: electron-production-recovery-store"
    );
    expect(writer).toContain("secrets.RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(writer).toContain("verify-mutation-attempt");
    expect(workflowStep(
      writer,
      "Reverify the exact marker decision before requesting a writer token"
    )).toContain("GH_TOKEN: ${{ github.token }}");
    expect(writer.indexOf("verify-mutation-attempt"))
      .toBeLessThan(writer.indexOf("Create the narrow private recovery-store writer token"));
    expect(writer).toContain(
      "if: needs.observe-recovery-public-mutation-attempt.outputs.attempt_action == 'create-marker'"
    );
    expect(writer).toContain("permission-contents: write");
    expect(writer).toContain("electronProductionRecoveryStoreRemoteCli.mjs create");
    expect(writer).toContain('--expected-head-sha "${EXPECTED_HEAD_SHA}"');
    expect(writer).toContain("unknown-acknowledgement");
    expect(workflowStep(
      writer,
      "Download the attested marker-slot observation"
    )).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(workflowStep(
      writer,
      "Create-new persist the predecessor marker or retain the existing slot"
    )).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(workflowStep(
      writer,
      "Create-new persist the predecessor marker or retain the existing slot"
    )).not.toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("fresh-reads and authorizes a marker while resume remains zero-mutation", async () => {
    const source = await workflow();
    const reader = job(
      source,
      "read-durable-recovery-public-mutation-attempt",
      "authorize-recovery-public-mutation-attempt"
    );
    const authorization = job(
      source,
      "authorize-recovery-public-mutation-attempt"
    );
    const read = workflowStep(
      reader,
      "Fresh-read and classify the exact durable predecessor marker"
    );
    const authorize = workflowStep(
      authorization,
      "Verify provenance then close the marker authorization"
    );

    expect(reader).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(reader).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(reader).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(reader).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(workflowStep(
      reader,
      "Create the narrow private recovery-store reader token"
    )).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(read).toContain("verify-readback-foundation");
    expect(read).toContain("verify-readback-outcome-binding");
    expect(read).toContain("verify-chain");
    expect(read).toContain("observe-mutation-attempt");
    expect(read).toContain(
      "electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs"
    );
    expect(read).toContain("--intent-read-operation");
    expect(read).toContain(
      "electronProductionPublicationRecoveryPublicMutationAttemptCli.mjs"
    );
    expect(read).toContain("--attempt-read-operation");
    expect(read).toContain('marker_mode="created-now"');
    expect(read).toContain('marker_mode="resumed-existing"');
    expect(read).toContain("marker_mode=no-durable-marker");
    expect(read).toContain(
      '= "$(jq -er .currentObservation.headCommitSha "${chain_proof}")"'
    );

    expect(authorization).not.toContain("environment:");
    expect(authorization).not.toContain("APP_PRIVATE_KEY");
    expect(authorization).not.toContain("actions/create-github-app-token@");
    expect(authorize).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(authorize).toContain("gh attestation verify");
    expect(authorize).toContain(
      "electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs"
    );
    expect(authorize).toContain("GH_TOKEN: ${{ github.token }}");
    expect(authorize).toContain("--intent-history-proof");
    expect(authorize).toContain(
      "electronProductionPublicationRecoveryPublicMutationAttemptCli.mjs"
    );
    expect(authorize).toContain("authorize-attempt");
    expect(authorize).toContain("--pre-marker-authorization");
    expect(authorize).toContain("--create-operation");
    expect(authorize).toContain("--attempt-history-proof");
    expect(authorize).toContain(
      'test "$(jq -er .headTransition.mode "${marker_authorization}")"'
    );
    expect(source).not.toMatch(
      /electronProductionPublicLatestRecoveryCli\.mjs\s+(?:rollback|release-lease)(?:\s|\\)/u
    );
  });

  it("routes source-state lease recovery read-only before any marker can be created", async () => {
    const source = await workflow();
    const route = job(
      source,
      "route-recovery-lease-release",
      "prepare-recovery-public-mutation-attempt"
    );
    const operation = workflowStep(
      route,
      "Reverify authority and classify the lease without mutation"
    );

    expect(route).not.toContain("environment:");
    expect(route).not.toContain("APP_PRIVATE_KEY");
    expect(route).not.toContain("actions/create-github-app-token@");
    expect(operation).toContain("GH_TOKEN: ${{ github.token }}");
    expect(operation).toContain(
      "electronProductionPublicLatestRecoveryCli.mjs"
    );
    expect(operation).toContain("route-lease-release");
    expect(operation).toContain("--release-authorization");
    expect(operation).toContain("--previous-outcome");
    expect(operation).toContain("--current-run-id");
    expect(operation).toContain("set +e");
    for (const routeName of [
      "release-held",
      "reconcile-released",
      "reconcile-pending",
      "blocked"
    ]) expect(operation).toContain(routeName);
    expect(route).toContain("if: always()");
    expect(route).toContain(
      "electron-production-public-latest-recovery-observation.json"
    );
  });

  it("probes every predecessor slot and lets the same-head observation decide create, resume, or no-marker", async () => {
    const source = await workflow();
    const prepare = job(
      source,
      "prepare-recovery-public-mutation-attempt",
      "observe-recovery-public-mutation-attempt"
    );
    const observe = job(
      source,
      "observe-recovery-public-mutation-attempt",
      "persist-recovery-public-mutation-attempt"
    );
    const writer = job(
      source,
      "persist-recovery-public-mutation-attempt",
      "read-durable-recovery-public-mutation-attempt"
    );
    const reader = job(
      source,
      "read-durable-recovery-public-mutation-attempt",
      "authorize-recovery-public-mutation-attempt"
    );
    const authorization = job(
      source,
      "authorize-recovery-public-mutation-attempt",
      "reconcile-recovery-lease-release"
    );

    expect(prepare).toContain("attempt_status=probe-marker");
    expect(prepare).not.toContain("attempt_status=no-marker");
    expect(prepare).toContain("create_allowed=false");
    expect(prepare).toContain('create_allowed="true"');
    expect(prepare).toContain("release-held");
    expect(prepare).toContain("rollback-public-latest");
    expect(observe).toContain('if test "${CREATE_ALLOWED}" = "true"');
    expect(observe).toContain('attempt_action="create-marker"');
    expect(observe).toContain('attempt_action="no-marker"');
    expect(observe).toContain('attempt_action="resume-marker"');
    expect(observe).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(writer).toContain(
      "if: needs.observe-recovery-public-mutation-attempt.outputs.attempt_action == 'create-marker'"
    );
    expect(writer).toContain("not-requested-route");
    expect(writer.indexOf('test "${ATTEMPT_ACTION}" = "no-marker"'))
      .toBeLessThan(writer.indexOf('test -n "${GH_TOKEN}"'));
    expect(authorization).toContain(
      "if: needs.prepare-recovery-public-mutation-attempt.outputs.attempt_status != 'no-marker'"
    );
    expect(authorization).toContain('MARKER_PRESENCE}" = "absent-at-head"');
    expect(authorization).toContain('MARKER_PRESENCE}" = "present-at-head"');
    expect(reader).toContain("marker_mode=no-durable-marker");
    expect(authorization).toContain(
      'test "${MARKER_MODE}" = "no-durable-marker"'
    );
    expect(workflowStep(
      authorization,
      "Attest the creator-or-resume one-shot marker authorization"
    )).toContain("marker_presence == 'present-at-head'");
  });

  it("uses marker-aware execution and gives write authority only to a created-now marker", async () => {
    const source = await workflow();
    const execution = job(
      source,
      "execute-recovery-public-mutation",
      "materialize-recovery-outcome"
    );
    const token = workflowStep(
      execution,
      "Create the narrow public-latest recovery token"
    );
    const operation = workflowStep(
      execution,
      "Execute created-now once or reconcile resumed without mutation"
    );

    expect(token).toContain("marker_presence == 'present-at-head'");
    expect(token).toContain("authorization_mode == 'created-now'");
    expect(operation).toContain(
      "electronProductionPublicationRecoveryPublicMutationExecutionCli.mjs"
    );
    expect(operation).toContain(
      "authorization_mode == 'created-now' && steps.release-token.outputs.token || github.token"
    );
    expect(operation).toContain('= "resumed-existing"');
    expect(operation).toContain('= "marker-reconciliation"');
    expect(operation).toContain("set +e");
    expect(execution).toContain(
      "if: always() && needs.read-durable-recovery-public-mutation-attempt.outputs.marker_presence == 'present-at-head'"
    );
    expect(operation).not.toMatch(/--(?:submitted|attempted|resolved)-at/u);
  });

  it("reconciles released and pending routes with zero PUT then binds that operation into the outcome", async () => {
    const source = await workflow();
    const reconcile = job(
      source,
      "reconcile-recovery-lease-release",
      "execute-recovery-public-mutation"
    );
    const operation = workflowStep(
      reconcile,
      "Fresh reconcile the released successor with zero public writes"
    );
    const materialize = job(source, "materialize-recovery-outcome");

    expect(reconcile).not.toContain("environment:");
    expect(reconcile).not.toContain("APP_PRIVATE_KEY");
    expect(reconcile).not.toContain("actions/create-github-app-token@");
    expect(operation).toContain("GH_TOKEN: ${{ github.token }}");
    expect(operation).toContain("reconcile-released");
    expect(operation).toContain("reconcile-pending");
    expect(operation).toContain("reconcile-lease-release");
    expect(operation).not.toMatch(/(?:rollback|release-lease)\s*\\/u);
    expect(operation).toContain("set +e");
    expect(reconcile).toContain("if: always()");
    expect(materialize).toContain("RECONCILIATION_OPERATION_SHA256");
    expect(materialize).toContain("--lease-release-operation");
    expect(materialize).toContain("--lease-release-operation-sha256");
    expect(materialize).toContain('MARKER_PRESENCE}" = "present-at-head"');
    expect(materialize).toContain('MARKER_PRESENCE}" = "absent-at-head"');
    expect(materialize).not.toContain("MARKER_STATUS");
    expect(materialize).toContain("jq -r .outcome.terminal");
    expect(materialize).toContain('test "${terminal}" = "false"');
  });

  it("preflights one outcome CAS, fresh-reads it with the reader App, and fails closed until terminal", async () => {
    const source = await workflow();
    const writer = job(
      source,
      "persist-recovery-outcome",
      "read-durable-recovery-outcome"
    );
    const reader = job(
      source,
      "read-durable-recovery-outcome",
      "attest-recovery-outcome-store"
    );
    const detached = job(source, "attest-recovery-outcome-store");
    const preflight = workflowStep(
      writer,
      "Tokenless verify the exact append foundation"
    );
    const persist = workflowStep(
      writer,
      "Create-new append the attempt or atomic terminal pair"
    );
    const readback = workflowStep(
      reader,
      "Fresh-read the outcome paths and verify the complete appended chain"
    );

    expect(writer).toContain("environment: electron-production-recovery-store");
    expect(writer).toContain("secrets.RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY");
    expect(writer).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(preflight).toContain("GH_TOKEN: ${{ github.token }}");
    expect(preflight).toContain("verify-outcome-append-foundation");
    expect(preflight).toContain("verify-marker-outcome");
    expect(preflight).toContain("verify-outcome");
    expect(writer.indexOf("verify-outcome-append-foundation"))
      .toBeLessThan(writer.indexOf("Create the narrow private recovery-store writer token"));
    expect(persist).toContain("create-atomic-pair");
    expect(persist).toContain("create --path");
    expect(persist).toContain('--expected-head-sha "${EXPECTED_HEAD_SHA}"');
    expect(persist).toContain("verify-outcome-create-chain");
    expect(persist).toContain("continue-on-error: true");
    expect(writer).toContain("if: always()");

    expect(reader).toContain(
      "environment: electron-production-recovery-store-read"
    );
    expect(reader).toContain(
      "secrets.RION_RECOVERY_STORE_READER_APP_PRIVATE_KEY"
    );
    expect(reader).not.toContain("RION_RECOVERY_STORE_APP_PRIVATE_KEY");
    expect(reader).not.toContain("RION_RELEASE_APP_PRIVATE_KEY");
    expect(reader).toContain(
      "Fail closed unless a canonical outcome append was applied"
    );
    expect(readback.match(/electronProductionRecoveryStoreRemoteCli\.mjs read/gu))
      .toHaveLength(2);
    expect(readback).toContain(
      "electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs"
    );
    expect(readback).toContain("verify-chain");
    expect(readback).toContain('= "${applied_commit}"');
    expect(reader).toContain(
      "Require a terminal durable outcome before recovery succeeds"
    );

    expect(detached).not.toContain("environment:");
    expect(detached).not.toContain("APP_PRIVATE_KEY");
    expect(detached).not.toContain("actions/create-github-app-token@");
    expect(detached).toContain("GH_TOKEN: ${{ github.token }}");
    expect(detached).toContain("verify-outcome-append-foundation");
    expect(detached).toContain("verify-outcome-create-chain");
    expect(detached).toContain("verify-chain");
    expect(detached).toContain('test "${OPERATION_CLASSIFICATION}" = "applied"');
    expect(detached).toContain('test "${TERMINAL}" = "true"');
    expect(detached).toContain('= "terminal"');
    expect(workflowStep(
      detached,
      "Attest the detached durable outcome closure"
    )).not.toContain("if: always()");
  });

  it("never executes recovered payloads or mixes private and public credentials", async () => {
    const source = await workflow();

    expect(source).not.toMatch(/(?:node|bash|sh|source)\s+[^\n]*materialized\//iu);
    expect(source).not.toMatch(/chmod\s+[^\n]*materialized|\.\/materialized/iu);
    for (const name of jobNames(source)) {
      const body = job(source, name);
      expect(
        body.includes("RION_RECOVERY_STORE_APP_PRIVATE_KEY") &&
          body.includes("RION_RELEASE_APP_PRIVATE_KEY"),
        name
      ).toBe(false);
    }
  });

  it("pins every third-party action to an immutable commit", async () => {
    const source = await workflow();
    const uses = source.match(/^\s*uses: .*$/gmu) ?? [];

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line.trim(), line).toMatch(PINNED_ACTION);
  });
});

async function workflow(): Promise<string> {
  return (await readFile(WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");
}

function jobNames(source: string): string[] {
  const jobsStart = source.indexOf("jobs:\n");
  return [...source.slice(jobsStart).matchAll(/^ {2}([a-z0-9-]+):$/gmu)]
    .map((match) => match[1]);
}

function job(source: string, name: string, nextName?: string): string {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job ${name}.`);
  if (nextName) {
    const end = source.indexOf(`  ${nextName}:\n`, start + startMarker.length);
    if (end < 0) throw new Error(`Missing workflow job ${nextName}.`);
    return source.slice(start, end);
  }
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
