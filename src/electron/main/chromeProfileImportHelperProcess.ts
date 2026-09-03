import type {
  ChromeProfileImportAuthProbeViewFactoryPort
} from "./chromeProfileImportAuthProbe";
import { ChromeProfileImportAuthProbe } from "./chromeProfileImportAuthProbe";
import {
  ChromeProfileImportFreshHelper,
  parseChromeProfileImportFreshHelperRequest
} from "./chromeProfileImportFreshHelper";
import { ChromiumSessionMigrationFreshHelper } from
  "./chromiumSessionMigrationFreshHelper";
import {
  isSessionMigrationFreshHelperMetadata,
  parseChromiumSessionMigrationFreshHelperRequest
} from "./chromiumSessionMigrationFreshHelperContract";
import type { ChromiumMigrationWebContentsViewFactoryPort } from
  "./chromiumSessionMigrationLocalStorage";
import {
  ChromeProfileImportLocalStorageCodec,
  type ChromeProfileImportHelperViewFactoryPort
} from "./chromeProfileImportLocalStorage";
import {
  decodeChromeProfileImportHelperRequest,
  encodeChromeProfileImportHelperResponse
} from "./chromeProfileImportHelperProtocol";
import { ChromiumRoleBrowserDataClearFreshHelper } from
  "./chromiumRoleBrowserDataClearFreshHelper";
import {
  isRoleBrowserDataClearFreshHelperMetadata,
  parseChromiumRoleBrowserDataClearFreshHelperRequest
} from "./chromiumRoleBrowserDataClearFreshHelperContract";
import type { ChromiumSessionFactoryPort } from "./chromiumRoleSessionRegistry";
import { normalizeRionBridgeError } from "../ipc/errors";

export interface ChromeProfileImportHelperProcessPort {
  readonly platform: "darwin" | "win32";
  readonly sessions: ChromiumSessionFactoryPort;
  readonly views: ChromeProfileImportHelperViewFactoryPort &
    ChromeProfileImportAuthProbeViewFactoryPort &
    ChromiumMigrationWebContentsViewFactoryPort;
  exit: (code: number) => void;
  readInheritedRequest: () => Buffer;
  ready: () => Promise<void>;
  writeInheritedResponse: (bytes: Buffer) => Promise<void>;
}

/**
 * Owns the fixed-mode helper process. It reads exactly one inherited request,
 * executes exactly one Session lane, writes one terminal frame, and exits.
 * No argv/environment value carries transaction identity or plaintext.
 */
export async function runChromeProfileImportHelperProcess(
  port: ChromeProfileImportHelperProcessPort
): Promise<void> {
  let requestWire: Buffer | null = null;
  let requestMetadata: Buffer | null = null;
  let requestSecret: Buffer | null = null;
  let responseWire: Buffer | null = null;
  let responseSecret: Buffer | null = null;
  let exitCode = 0;
  try {
    requestWire = port.readInheritedRequest();
    const decoded = decodeChromeProfileImportHelperRequest(requestWire);
    requestWire = null;
    requestMetadata = decoded.metadataBytes;
    requestSecret = decoded.secretBytes;
    const roleBrowserDataClear = isRoleBrowserDataClearFreshHelperMetadata(
      requestMetadata
    );
    const sessionMigration = isSessionMigrationFreshHelperMetadata(
      requestMetadata
    );
    const request = roleBrowserDataClear
      ? parseChromiumRoleBrowserDataClearFreshHelperRequest(requestMetadata)
      : sessionMigration
        ? parseChromiumSessionMigrationFreshHelperRequest(requestMetadata)
        : parseChromeProfileImportFreshHelperRequest(requestMetadata);
    requestMetadata.fill(0);
    requestMetadata = null;
    await port.ready();
    const result = roleBrowserDataClear
      ? await new ChromiumRoleBrowserDataClearFreshHelper({
        platform: port.platform,
        sessions: port.sessions
      }).run(
        request as ReturnType<
          typeof parseChromiumRoleBrowserDataClearFreshHelperRequest
        >,
        requestSecret
      )
      : sessionMigration
        ? await new ChromiumSessionMigrationFreshHelper({
          platform: port.platform,
          sessions: port.sessions,
          views: port.views
        }).run(
          request as ReturnType<
            typeof parseChromiumSessionMigrationFreshHelperRequest
          >,
          requestSecret
        )
        : await new ChromeProfileImportFreshHelper({
          platform: port.platform,
          sessions: port.sessions,
          localStorage: new ChromeProfileImportLocalStorageCodec(port.views),
          auth: new ChromeProfileImportAuthProbe(port.views)
        }).run(
          request as ReturnType<
            typeof parseChromeProfileImportFreshHelperRequest
          >,
          requestSecret
        );
    requestSecret = null;
    responseSecret = result.secretBytes;
    responseWire = encodeChromeProfileImportHelperResponse(
      result.outcome,
      result.metadataBytes,
      responseSecret
    );
    result.metadataBytes.fill(0);
    responseSecret.fill(0);
    responseSecret = null;
    await port.writeInheritedResponse(responseWire);
  } catch (error) {
    const normalized = normalizeRionBridgeError(
      error,
      "CHROMIUM_PROFILE_IMPORT_HELPER_PROCESS_FAILED"
    );
    const metadata = Buffer.from(JSON.stringify({
      version: 1,
      stableErrorCode: normalized.code
    }), "utf8");
    responseWire?.fill(0);
    responseWire = encodeChromeProfileImportHelperResponse(
      "indeterminate",
      metadata,
      Buffer.alloc(0)
    );
    metadata.fill(0);
    try {
      await port.writeInheritedResponse(responseWire);
    } catch {
      exitCode = 71;
    }
  } finally {
    requestWire?.fill(0);
    requestMetadata?.fill(0);
    requestSecret?.fill(0);
    responseSecret?.fill(0);
    responseWire?.fill(0);
    port.exit(exitCode);
  }
}
