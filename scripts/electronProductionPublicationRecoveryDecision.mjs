import {
  assertEqual,
  assertExactKeys,
  requiredRfc3339
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  requiredEnum
} from "./electronProductionPublicationRecoveryValidation.mjs";

const OUTCOMES = new Set([
  "source-observed-noop",
  "rollback-confirmed",
  "indeterminate",
  "lease-release-acknowledgement-unknown"
]);

export function deriveRecoveryDecision(input) {
  const noop = input.mutation.kind === "none" &&
    input.beforeMutation.classification === "source" &&
    input.finalObservation.classification === "source";
  const rollbackConfirmed = input.mutation.kind === "rollback" &&
    input.mutation.acknowledgement === "confirmed" &&
    input.beforeMutation.classification === "target" &&
    input.finalObservation.classification === "source";
  if (input.leaseRelease.attempted === false) {
    return {
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false
    };
  }
  if (input.leaseRelease.acknowledgement === "unknown") {
    return {
      classification: "lease-release-acknowledgement-unknown",
      terminal: false,
      safeToReleaseLease: false
    };
  }
  if (input.leaseRelease.acknowledgement === "rejected") {
    return {
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false
    };
  }
  if (!noop && !rollbackConfirmed) {
    return {
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false
    };
  }
  if (noop) {
    return {
      classification: "source-observed-noop",
      terminal: true,
      safeToReleaseLease: true
    };
  }
  return {
    classification: "rollback-confirmed",
    terminal: true,
    safeToReleaseLease: true
  };
}

export function assertRecoveryOutcomeDecision(value, expected) {
  assertExactKeys(value, [
    "classification",
    "determinedAt",
    "safeToReleaseLease",
    "terminal"
  ], "publication recovery decision");
  const classification = requiredEnum(
    value.classification,
    OUTCOMES,
    "publication recovery outcome"
  );
  assertEqual(classification, expected.classification,
    "derived publication recovery outcome");
  assertEqual(value.terminal, expected.terminal,
    "derived publication recovery terminality");
  assertEqual(value.safeToReleaseLease, expected.safeToReleaseLease,
    "derived safe-to-release decision");
  return {
    classification,
    terminal: expected.terminal,
    safeToReleaseLease: expected.safeToReleaseLease,
    determinedAt: requiredRfc3339(value.determinedAt,
      "publication recovery outcome time")
  };
}
