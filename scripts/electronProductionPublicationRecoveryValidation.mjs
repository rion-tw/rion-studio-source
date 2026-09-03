import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "./electronProductionRecoveryCapsule.mjs";
import {
  assertElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredDigest,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const FORBIDDEN_REF_CHARACTERS = new Set([
  "~", "^", ":", "?", "*", "[", "\\"
]);

export function assertSourceSnapshot(value) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(value);
  assertEqual(snapshot.observationKind, "observed-release",
    "recovery source observation kind");
  assertEqual(snapshot.release.isLatest, true, "recovery source latest status");
  assertEqual(snapshot.candidateReceipt, null, "recovery source candidate receipt");
  return snapshot;
}

export function assertTargetSnapshot(value) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(value);
  assertEqual(snapshot.observationKind, "expected-latest-projection",
    "recovery target observation kind");
  assertEqual(snapshot.release.isLatest, true, "recovery target latest status");
  if (!snapshot.candidateReceipt) {
    throw new Error("The recovery target must bind an Electron candidate receipt.");
  }
  return snapshot;
}

export async function writeRecoveryFile(
  input,
  expectedName,
  label,
  parser
) {
  assertExactKeys(input, ["outputPath", "receipt"], `${label} write input`);
  const receipt = parser(input.receipt);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    expectedName,
    label
  );
  await writeExclusive(outputPath, serializeCanonicalJson(receipt));
  const file = await readCanonicalJsonFile(
    outputPath,
    MAX_RECEIPT_BYTES,
    label
  );
  const reread = parser(file.value);
  return deepFreeze({
    receipt: reread,
    receiptIdentity: publicIdentity(outputPath, file),
    receiptPath: outputPath
  });
}

export async function readRecoveryFile(
  input,
  expectedName,
  label,
  parser
) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    `${label} read input`);
  const receiptPath = requiredAbsolutePath(input.receiptPath, label);
  assertEqual(path.basename(receiptPath), expectedName, `${label} filename`);
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    label
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, `${label} SHA-256`),
    `${label} SHA-256`
  );
  return deepFreeze({
    receipt: parser(file.value),
    receiptIdentity: publicIdentity(receiptPath, file),
    receiptPath
  });
}

export function requiredRepository(value, label) {
  const [owner, repository, extra] = typeof value === "string"
    ? value.split("/")
    : [];
  if (
    typeof value !== "string" || extra !== undefined ||
    typeof owner !== "string" || owner.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    typeof repository !== "string" || repository.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository) ||
    repository === "." || repository === ".."
  ) throw new Error(`The ${label} must be an explicit GitHub repository slug.`);
  return value;
}

export function requiredWorkflow(value, label) {
  if (
    typeof value !== "string" || value.length > 255 ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(value)
  ) throw new Error(`The ${label} must be an explicit workflow path.`);
  return value;
}

export function assertRepositoryPolicy(value) {
  assertExactKeys(value, ["defaultBranch", "visibility"],
    "durable recovery store repository policy");
  const defaultBranch = requiredBranch(
    value.defaultBranch,
    "durable recovery store default branch"
  );
  assertEqual(value.visibility, "private", "durable recovery store visibility");
  return { defaultBranch, visibility: "private" };
}

export function requiredRepositoryPath(value) {
  if (
    typeof value !== "string" || value.length > 1024 || value.startsWith("/") ||
    value.endsWith("/") || value.includes("//") || value.includes("\\") ||
    !value.split("/").every((part) =>
      part.length > 0 && part.length <= 255 && /^[A-Za-z0-9._-]+$/u.test(part) &&
      part !== "." && part !== ".." && part.toLowerCase() !== ".git"
    )
  ) throw new Error("The durable recovery store path must be repository-relative.");
  return value;
}

export function assertCapsuleFileName(value) {
  assertEqual(value, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "recovery capsule filename");
  return value;
}

export function assertCapsuleIdentity(
  capsuleBytes,
  capsuleSha256,
  manifestBytes,
  manifestSha256
) {
  if (manifestBytes >= capsuleBytes) {
    throw new Error("The packed recovery capsule must be larger than its manifest.");
  }
  if (manifestSha256 === capsuleSha256) {
    throw new Error("The recovery capsule and manifest identities must differ.");
  }
}

export function requiredReleaseId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d{0,30}$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal identifier.`);
  }
  return value;
}

export function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal GitHub run ID.`);
  }
  return value;
}

export function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

export function optionalDigest(value, label) {
  return value === null ? null : requiredDigest(value, label);
}

export function assertMarkerAuthority(value, label) {
  assertExactKeys(value, ["attemptSha256", "authorizationSha256"],
    `${label} public-mutation reservation authority`);
  return {
    attemptSha256: requiredDigest(
      value.attemptSha256,
      `${label} public-mutation attempt SHA-256`
    ),
    authorizationSha256: requiredDigest(
      value.authorizationSha256,
      `${label} public-mutation authorization SHA-256`
    )
  };
}

export function requiredEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

export function assertTimeOrder(previous, next, message) {
  if (Date.parse(next) < Date.parse(previous)) throw new Error(message);
}

export function sameObservation(left, right) {
  return left.classification === right.classification &&
    left.stateSha256 === right.stateSha256;
}

export function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function requiredBranch(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.startsWith("-") || value.startsWith("/") || value.endsWith("/") ||
    value.endsWith(".") || value.includes("//") || value.includes("..") ||
    value.includes("@{") || [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code <= 32 || code === 127 ||
        FORBIDDEN_REF_CHARACTERS.has(character);
    }) || value.split("/").some((part) =>
      part === "." || part === ".." || part.endsWith(".lock")
    )
  ) throw new Error(`The ${label} is invalid.`);
  return value;
}
