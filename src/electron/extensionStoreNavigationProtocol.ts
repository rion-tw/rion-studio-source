import { chromeStoreExtensionId } from "../shared/extensions";

export const EXTENSION_STORE_NAVIGATION_CHANNEL =
  "rion:extension-store-navigation";

export interface ExtensionStoreNavigationRequest {
  readonly url: string;
}

export function parseExtensionStoreNavigationRequest(
  value: unknown
): ExtensionStoreNavigationRequest | null {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1
  ) return null;
  const url = (value as Record<string, unknown>).url;
  return typeof url === "string" && chromeStoreExtensionId(url)
    ? Object.freeze({ url })
    : null;
}
