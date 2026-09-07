import { closedValidation as check } from "./coreEffectActionValidation";

export const isRoleSessionRecoveryRecord = (value: unknown): boolean => check.closed(value, {
  roleId: check.identity,
  attemptId: check.nullable(check.identity),
  revision: check.nonnegativeInteger,
  journalRevision: check.nullable(check.nonnegativeInteger),
  phase: check.oneOf("inspected", "reading", "isolatedImport", "formalImport", "complete", "failed", "cancelled", "freshReady"),
  blockers: check.arrayOf(check.text),
  candidates: check.arrayOf((candidate) => check.closed(candidate, {
    token: check.identity,
    application: check.text,
    kind: check.oneOf("authenticatedExport", "retainedStore"),
    supported: check.bool,
    blockers: check.arrayOf(check.text),
    cookieCount: check.nullable(check.nonnegativeInteger),
    localStorageOriginCount: check.nonnegativeInteger,
    localStorageEntryCount: check.nullable(check.nonnegativeInteger),
    otherWebsiteDataPresent: check.bool
  })),
  sourceIntegrity: check.oneOf("unverified", "verified"),
  targetEquality: check.oneOf("notRun", "isolatedVerified", "verified"),
  persistence: check.oneOf("notRun", "isolatedVerified", "verified"),
  login: check.oneOf("notTested", "requiresSignIn"),
  upgradeResult: check.nullable(value => check.closed(value, {
    cookies: check.oneOf("unavailable", "failed", "transferred", "partiallyTransferred"),
    localStorage: check.oneOf("unavailable", "failed", "transferred", "partiallyTransferred"),
    cookieCount: check.nonnegativeInteger,
    localStorageOriginCount: check.nonnegativeInteger,
    localStorageEntryCount: check.nonnegativeInteger,
    reasons: check.arrayOf(check.text)
  }))
});
