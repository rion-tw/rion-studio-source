import { join } from "node:path";

import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import { ChromiumExtensionSessions } from "./chromiumExtensionSessions";
import type { ElectronOperationalLogger } from "./electronOperationalLogger";

export function createChromiumExtensionSessions(
  core: ElectronCoreCommandPort,
  logger: Pick<ElectronOperationalLogger, "extensionDiagnostic">
): ChromiumExtensionSessions {
  return new ChromiumExtensionSessions(core, {
    compatibilityPreloadPath: join(import.meta.dirname, "../preload/extensionCompat.cjs"),
    logger
  });
}
