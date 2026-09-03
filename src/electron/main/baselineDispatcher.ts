import type {
  ApplicationLifecycleStatusRecord,
  DiagnosticExportResultRecord,
  SystemRuntimeOperationSummaryRecord,
  NativeWindowStateRecord
} from "../../shared/generated";
import type {
  ApplicationShortcutCommand,
  AppSnapshot,
  BrowserPerformanceDiagnosticOperation,
  ChromeProfileImportPreview,
  DisplayTopology,
  EmbeddedRuntimeState,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview,
  RendererLogEvent
} from "../../shared/types";
import {
  type RionApiArgs,
  type RionApiDispatchMethod,
  type RionApiResult
} from "../ipc/apiMethods";
import { RionBridgeError } from "../ipc/errors";
import type { RionApiDispatcher } from "./registerIpcBridge";
import type { RendererIdentity } from "./rendererIdentity";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ElectronBaselineActions {
  beginBrowserPerformanceDiagnostics: () =>
    MaybePromise<BrowserPerformanceDiagnosticOperation>;
  cancelBrowserPerformanceDiagnostics: (operationId: string) => MaybePromise<void>;
  confirmApplicationQuit: (identity: RendererIdentity) => MaybePromise<void>;
  getAppSnapshot: () => MaybePromise<AppSnapshot>;
  getAppVersion: () => string;
  getApplicationLifecycleStatus: () => MaybePromise<ApplicationLifecycleStatusRecord>;
  getCurrentWindowState: (identity: RendererIdentity) => MaybePromise<NativeWindowStateRecord>;
  getDisplayTopology: () => MaybePromise<DisplayTopology>;
  getEmbeddedRuntimeState: () => MaybePromise<EmbeddedRuntimeState>;
  consumePendingMacroPageRequest: (
    identity: RendererIdentity
  ) => MaybePromise<import("../../shared/types").MacroPageRequest | null>;
  exportPortableData: (
    input?: PortableExportInput
  ) => MaybePromise<PortableExportResult | null>;
  exportDiagnostics: (
    identity: RendererIdentity
  ) => MaybePromise<DiagnosticExportResultRecord | null>;
  executeApplicationShortcut: (
    identity: RendererIdentity,
    command: ApplicationShortcutCommand
  ) => MaybePromise<void>;
  minimizeCurrentWindow: (identity: RendererIdentity) => MaybePromise<void>;
  notifyRendererReady: (identity: RendererIdentity) => MaybePromise<void>;
  openUpdateDownload: () => MaybePromise<void>;
  previewChromeProfileImport: () => MaybePromise<ChromeProfileImportPreview | null>;
  previewPortableImport: () => MaybePromise<PortableImportPreview | null>;
  revealLogs: () => MaybePromise<void>;
  requestApplicationQuit: (identity: RendererIdentity) => MaybePromise<void>;
  requestCurrentWindowClose: (identity: RendererIdentity) => MaybePromise<void>;
  startCurrentWindowDrag: (
    identity: RendererIdentity
  ) => MaybePromise<SystemRuntimeOperationSummaryRecord>;
  toggleCurrentWindowMaximize: (identity: RendererIdentity) => MaybePromise<void>;
  reportRendererLog: (event: RendererLogEvent) => MaybePromise<void>;
}

function notImplemented(method: RionApiDispatchMethod): never {
  throw new RionBridgeError({
    code: "ELECTRON_SHELL_NOT_IMPLEMENTED",
    message: `The Electron shell method ${method} has not been migrated yet.`
  });
}

export function createElectronBaselineDispatcher(
  actions: ElectronBaselineActions
): RionApiDispatcher {
  return {
    async invoke<Method extends RionApiDispatchMethod>(
      identity: RendererIdentity,
      method: Method,
      args: RionApiArgs<Method>
    ): Promise<RionApiResult<Method>> {
      let value: unknown;
      switch (method) {
        case "beginBrowserPerformanceDiagnostics":
          value = await actions.beginBrowserPerformanceDiagnostics();
          break;
        case "cancelBrowserPerformanceDiagnostics": {
          const [operationId] = args as unknown as
            RionApiArgs<"cancelBrowserPerformanceDiagnostics">;
          value = await actions.cancelBrowserPerformanceDiagnostics(operationId);
          break;
        }
        case "getAppSnapshot":
          value = await actions.getAppSnapshot();
          break;
        case "getAppVersion":
          value = actions.getAppVersion();
          break;
        case "getApplicationLifecycleStatus":
          value = await actions.getApplicationLifecycleStatus();
          break;
        case "getCurrentWindowState":
          value = await actions.getCurrentWindowState(identity);
          break;
        case "getDisplayTopology":
          value = await actions.getDisplayTopology();
          break;
        case "getEmbeddedRuntimeState":
          value = await actions.getEmbeddedRuntimeState();
          break;
        case "notifyRendererReady":
          value = await actions.notifyRendererReady(identity);
          break;
        case "quitApplication":
          value = await actions.requestApplicationQuit(identity);
          break;
        case "confirmApplicationQuit":
          value = await actions.confirmApplicationQuit(identity);
          break;
        case "requestCurrentWindowClose":
          value = await actions.requestCurrentWindowClose(identity);
          break;
        case "toggleCurrentWindowMaximize":
          value = await actions.toggleCurrentWindowMaximize(identity);
          break;
        case "minimizeCurrentWindow":
          value = await actions.minimizeCurrentWindow(identity);
          break;
        case "startCurrentWindowDrag":
          value = await actions.startCurrentWindowDrag(identity);
          break;
        case "executeApplicationShortcut": {
          const [command] = args as unknown as
            RionApiArgs<"executeApplicationShortcut">;
          value = await actions.executeApplicationShortcut(identity, command);
          break;
        }
        case "consumePendingMacroPageRequest":
          value = await actions.consumePendingMacroPageRequest(identity);
          break;
        case "exportPortableData": {
          const [input] = args as unknown as RionApiArgs<"exportPortableData">;
          value = await actions.exportPortableData(input);
          break;
        }
        case "exportDiagnostics":
          value = await actions.exportDiagnostics(identity);
          break;
        case "previewPortableImport":
          value = await actions.previewPortableImport();
          break;
        case "previewChromeProfileImport":
          value = await actions.previewChromeProfileImport();
          break;
        case "revealLogs":
          value = await actions.revealLogs();
          break;
        case "openUpdateDownload":
          value = await actions.openUpdateDownload();
          break;
        case "consumePendingQuickAccessRequest":
          value = null;
          break;
        case "reportRendererLog": {
          const [event] = args as unknown as RionApiArgs<"reportRendererLog">;
          value = await actions.reportRendererLog(event);
          break;
        }
        default:
          return notImplemented(method);
      }
      return value as RionApiResult<Method>;
    }
  };
}
