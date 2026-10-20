import type { ExtensionRoleRecord } from "../../../../shared/generated";

/**
 * The extension's own runtime status on one Role lease. Another package's
 * terminal on the same Role never applies; null means it was not attempted.
 */
export function extensionRuntimeStatus(role: ExtensionRoleRecord, extensionId: string): string | null {
  if (!role.extensionIds.includes(extensionId)) return null;
  if (role.status === "loading") return "loading";
  return role.outcomes.find(outcome => outcome.extensionId === extensionId)?.status ?? null;
}

export const isExtensionLoadFailure = (status: string | null) =>
  status === "failed" || status === "indeterminate";
