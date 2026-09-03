import { serializeCanonicalJson } from "./canonicalJson.mjs";

export function serializeElectronProductionPlatformReceipt(receipt) {
  return serializeCanonicalJson(receipt);
}
