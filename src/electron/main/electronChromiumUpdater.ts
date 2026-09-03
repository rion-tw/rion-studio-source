import { posix } from "node:path";

import type {
  AppUpdateInstallAttemptRecord,
  AppUpdateStatusRecord,
  CoreErrorPayload
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";

type MaybePromise<Value> = Value | Promise<Value>;

export interface RawChromiumUpdaterOptions {
  userDataDir: string;
  platform: "darwin" | "win32";
  currentVersion: string;
  packaged: boolean;
}

export interface RawChromiumUpdaterBinding {
  getUpdateStatusInternal: () => string;
  checkForUpdatesInternal: () => Promise<string>;
  setAutoUpdateEnabledInternal: (enabled: boolean) => Promise<string>;
  acceptUpdateInstallInternal: () => Promise<string>;
  prepareUpdateInstallInternal: (attemptId: string) => Promise<string>;
  beginUpdateInstallDrainInternal: (attemptId: string) => Promise<string>;
  failUpdateInstallAfterDrainInternal: (
    attemptId: string,
    failureCode: "UPDATE_INSTALL_DRAIN_FAILED" | "UPDATE_INSTALL_SHELL_DRAIN_FAILED"
  ) => Promise<string>;
  handoffUpdateInstallAfterDrainInternal: (
    attemptId: string,
    parentProcessId: number
  ) => Promise<string>;
  subscribeUpdateStatusInternal: (
    listener: (eventJson: string) => void,
    failureListener: (failureJson: string) => void
  ) => void;
}

export interface RawChromiumUpdaterFactory {
  createChromiumUpdater: (
    options: RawChromiumUpdaterOptions
  ) => MaybePromise<RawChromiumUpdaterBinding>;
  runMacosUpdateRelaunchHelperInternal: (options: {
    userDataDir: string;
    attemptId: string;
    currentVersion: string;
    parentProcessId: number;
  }) => Promise<number>;
  verifyMacosUpdateRecoveryLocatorInternal: (options: {
    userDataDir: string;
    attemptId: string;
    currentVersion: string;
  }) => void;
}

export interface ElectronChromiumUpdaterInput {
  drainShellAndCore: () => Promise<void>;
  exitAfterHandoff: () => void;
  restartAfterFailedDrain: (
    failure: "drain" | "handoff"
  ) => MaybePromise<void>;
  publishStatus: (status: AppUpdateStatusRecord) => void;
  onFatalEventStreamFailure: (
    terminal: ElectronUpdaterEventStreamFailureTerminal
  ) => void;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  processId: number;
}

export interface ElectronUpdaterEventStreamFailureTerminal {
  readonly error: CoreErrorPayload;
  readonly drained: Promise<void>;
}

interface UpdateStatusEnvelope {
  revision: number;
  status: AppUpdateStatusRecord;
}

interface InstallAcceptance {
  attempt: AppUpdateInstallAttemptRecord;
  leader: boolean;
}

const UPDATE_STATES = new Set([
  "unsupported",
  "idle",
  "checking",
  "available",
  "not_available",
  "downloading",
  "downloaded",
  "preparing",
  "installing",
  "draining",
  "restart_pending",
  "install_failed",
  "error"
]);

const INSTALL_PHASES = new Set([
  "accepted",
  "preparing",
  "installing",
  "draining",
  "installerHandoff",
  "restartPending",
  "applied",
  "failedBeforeDrain",
  "failedAfterDrain"
]);

const NATIVE_UPDATE_EVENT_STREAM_FAILURE_CODES = new Set<string>([
  "UPDATE_EVENT_STREAM_CLOSED",
  "UPDATE_EVENT_SERIALIZATION_FAILED",
  "UPDATE_EVENT_CALLBACK_FAILED",
  "UPDATE_EVENT_BRIDGE_FAILED"
]);

export const MACOS_UPDATE_RELAUNCH_HELPER_SWITCH =
  "--rion-internal-update-relaunch-helper";
export const MACOS_UPDATE_RECOVERY_SWITCH =
  "--rion-internal-update-recovery";
const UPDATE_PARENT_PID_ARGUMENT = "--rion-update-parent-pid=";
const UPDATE_ATTEMPT_ID_ARGUMENT = "--rion-update-attempt-id=";
const UPDATE_USER_DATA_DIR_ARGUMENT = "--rion-update-user-data-dir=";
const UPDATE_RECOVERY_ATTEMPT_ID_ARGUMENT =
  "--rion-update-recovery-attempt-id=";
const UPDATE_RECOVERY_USER_DATA_DIR_ARGUMENT =
  "--rion-update-recovery-user-data-dir=";
const CHROMIUM_USER_DATA_DIR_ARGUMENT = "--user-data-dir=";

export class ElectronChromiumUpdater {
  readonly #binding: RawChromiumUpdaterBinding;
  readonly #input: ElectronChromiumUpdaterInput;
  #checkPromise: Promise<AppUpdateStatusRecord> | null = null;
  #lastEventRevision = 0;
  #installWorkflow: Promise<void> | null = null;
  #eventStreamFailure: CoreErrorPayload | null = null;
  #disposed = false;

  private constructor(
    binding: RawChromiumUpdaterBinding,
    input: ElectronChromiumUpdaterInput
  ) {
    this.#binding = binding;
    this.#input = input;
    try {
      this.#binding.subscribeUpdateStatusInternal(
        (eventJson) => this.#receiveStatusEvent(eventJson),
        (failureJson) => this.#receiveNativeEventStreamFailure(failureJson)
      );
    } catch (error) {
      const nativeFailure = nativeUpdaterError(error);
      const failure = nativeFailure.code === "ELECTRON_NATIVE_UPDATER_FAILED"
        ? new RionBridgeError({
            code: "ELECTRON_UPDATE_EVENT_STREAM_START_FAILED",
            message: "The native updater event stream could not be started."
          })
        : nativeFailure;
      this.#failEventStream(failure, "ELECTRON_UPDATE_EVENT_STREAM_START_FAILED");
      throw failure;
    }
  }

  static async create(
    factory: RawChromiumUpdaterFactory,
    options: RawChromiumUpdaterOptions,
    input: ElectronChromiumUpdaterInput
  ): Promise<ElectronChromiumUpdater> {
    return new ElectronChromiumUpdater(
      await factory.createChromiumUpdater(options),
      input
    );
  }

  getUpdateStatus(): AppUpdateStatusRecord {
    const ingressError = this.#commandIngressError();
    if (ingressError) throw ingressError;
    try {
      return parseStatusEnvelope(this.#binding.getUpdateStatusInternal()).status;
    } catch (error) {
      throw this.#nativeCommandError(error);
    }
  }

  checkForUpdates(): Promise<AppUpdateStatusRecord> {
    const ingressError = this.#commandIngressError();
    if (ingressError) return Promise.reject(ingressError);
    if (this.#checkPromise) return this.#checkPromise;
    const operation = this.#binding.checkForUpdatesInternal()
      .then((value) => parseStatusEnvelope(value).status)
      .catch((error: unknown) => {
        throw this.#nativeCommandError(error);
      })
      .finally(() => {
        if (this.#checkPromise === operation) this.#checkPromise = null;
      });
    this.#checkPromise = operation;
    return operation;
  }

  setAutoUpdateEnabled(enabled: boolean): Promise<AppUpdateStatusRecord> {
    const ingressError = this.#commandIngressError();
    if (ingressError) return Promise.reject(ingressError);
    return this.#binding.setAutoUpdateEnabledInternal(enabled)
      .then((value) => parseStatusEnvelope(value).status)
      .catch((error: unknown) => {
        throw this.#nativeCommandError(error);
      });
  }

  async installDownloadedUpdate(): Promise<AppUpdateInstallAttemptRecord> {
    const ingressError = this.#commandIngressError();
    if (ingressError) throw ingressError;
    const acceptance = parseInstallAcceptance(
      await this.#binding.acceptUpdateInstallInternal().catch((error: unknown) => {
        throw this.#nativeCommandError(error);
      })
    );
    if (acceptance.leader && !this.#installWorkflow) {
      const workflow = this.#runInstall(acceptance.attempt)
        .catch((error: unknown) => {
          if (this.#eventStreamFailure) return;
          this.#input.onError(normalizeRionBridgeError(
            nativeUpdaterError(error),
            "ELECTRON_UPDATE_INSTALL_FAILED"
          ));
        })
        .finally(() => {
          if (this.#installWorkflow === workflow) this.#installWorkflow = null;
        });
      this.#installWorkflow = workflow;
    }
    return acceptance.attempt;
  }

  dispose(): void {
    this.#disposed = true;
  }

  async #runInstall(attempt: AppUpdateInstallAttemptRecord): Promise<void> {
    await this.#binding.prepareUpdateInstallInternal(attempt.attemptId)
      .catch((error: unknown) => {
        throw this.#nativeCommandError(error);
      });
    await this.#binding.beginUpdateInstallDrainInternal(attempt.attemptId)
      .catch((error: unknown) => {
        throw this.#nativeCommandError(error);
      });
    try {
      await this.#input.drainShellAndCore();
    } catch {
      try {
        await this.#binding.failUpdateInstallAfterDrainInternal(
          attempt.attemptId,
          "UPDATE_INSTALL_DRAIN_FAILED"
        ).catch((error: unknown) => {
          throw this.#nativeCommandError(error);
        });
      } finally {
        await this.#input.restartAfterFailedDrain("drain");
      }
      throw new RionBridgeError({
        code: "UPDATE_INSTALL_DRAIN_FAILED",
        message: "The shell or Core drain did not reach a successful terminal receipt."
      });
    }
    try {
      await this.#binding.handoffUpdateInstallAfterDrainInternal(
        attempt.attemptId,
        this.#input.processId
      );
    } catch (error) {
      await this.#input.restartAfterFailedDrain("handoff");
      throw this.#nativeCommandError(error);
    }
    this.#input.exitAfterHandoff();
  }

  #receiveStatusEvent(value: string): void {
    if (this.#disposed || this.#eventStreamFailure) return;
    try {
      const event = parseStatusEnvelope(value);
      if (event.revision <= this.#lastEventRevision) return;
      if (
        this.#lastEventRevision !== 0 &&
        event.revision !== this.#lastEventRevision + 1
      ) {
        throw new RionBridgeError({
          code: "ELECTRON_UPDATE_EVENT_REVISION_GAP",
          message: "The native updater status stream skipped an authoritative revision."
        });
      }
      this.#lastEventRevision = event.revision;
      this.#input.publishStatus(event.status);
    } catch (error) {
      this.#failEventStream(error, "ELECTRON_UPDATE_EVENT_INVALID");
    }
  }

  #receiveNativeEventStreamFailure(failureJson: string): void {
    if (this.#disposed || this.#eventStreamFailure) return;
    try {
      this.#failEventStream(
        parseNativeEventStreamFailure(failureJson),
        "ELECTRON_UPDATE_EVENT_STREAM_FAILED"
      );
    } catch (error) {
      this.#failEventStream(
        error,
        "ELECTRON_UPDATE_EVENT_STREAM_FAILURE_INVALID"
      );
    }
  }

  #failEventStream(error: unknown, fallbackCode: string): void {
    if (this.#disposed || this.#eventStreamFailure) return;
    const failure = Object.freeze({
      ...normalizeRionBridgeError(error, fallbackCode)
    });
    this.#eventStreamFailure = failure;
    this.#reportEventStreamError(failure);
    try {
      this.#input.onFatalEventStreamFailure(Object.freeze({
        error: failure,
        drained: Promise.resolve()
      }));
    } catch (listenerError) {
      this.#reportEventStreamError(normalizeRionBridgeError(
        listenerError,
        "ELECTRON_UPDATE_EVENT_FAILURE_LISTENER_FAILED"
      ));
    }
  }

  #reportEventStreamError(error: CoreErrorPayload): void {
    try {
      this.#input.onError(error);
    } catch {
      // Error presentation cannot suppress updater stream terminality.
    }
  }

  #nativeCommandError(error: unknown): RionBridgeError {
    const failure = nativeUpdaterError(error);
    if (failure.code === "UPDATE_EVENT_STREAM_UNAVAILABLE") {
      this.#failEventStream(failure, "UPDATE_EVENT_STREAM_UNAVAILABLE");
    }
    return failure;
  }

  #commandIngressError(): RionBridgeError | null {
    if (this.#eventStreamFailure) {
      return new RionBridgeError({
        code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED",
        message: "The authoritative updater event stream failed; new updater commands are " +
          `closed (${this.#eventStreamFailure.code}).`
      });
    }
    if (this.#disposed) {
      return new RionBridgeError({
        code: "ELECTRON_UPDATE_STOPPED",
        message: "The Rion Studio updater is stopping or has stopped."
      });
    }
    return null;
  }
}

export async function runMacosUpdaterRelaunchHelper(
  factory: RawChromiumUpdaterFactory,
  options: {
    userDataDir: string;
    attemptId: string;
    currentVersion: string;
    parentProcessId: number;
  }
): Promise<number> {
  if (
    !options.attemptId ||
    !Number.isSafeInteger(options.parentProcessId) ||
    options.parentProcessId <= 0
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_UPDATE_HELPER_INPUT_INVALID",
      message: "The updater relaunch helper input is invalid."
    });
  }
  return factory.runMacosUpdateRelaunchHelperInternal(options)
    .catch((error: unknown) => {
      throw nativeUpdaterError(error);
    });
}

export function verifyMacosUpdaterRecoveryLocator(
  factory: RawChromiumUpdaterFactory,
  options: {
    userDataDir: string;
    attemptId: string;
    currentVersion: string;
  }
): void {
  try {
    factory.verifyMacosUpdateRecoveryLocatorInternal(options);
  } catch (error) {
    throw nativeUpdaterError(error);
  }
}

export function parseMacosUpdaterRelaunchArguments(
  argumentsList: readonly string[]
): { attemptId: string; parentProcessId: number; userDataDir: string } | null {
  const helperCount = argumentsList.filter(
    (argument) => argument === MACOS_UPDATE_RELAUNCH_HELPER_SWITCH
  ).length;
  if (helperCount === 0) {
    if (argumentsList.some((argument) =>
      argument.startsWith(UPDATE_PARENT_PID_ARGUMENT) ||
      argument.startsWith(UPDATE_ATTEMPT_ID_ARGUMENT) ||
      argument.startsWith(UPDATE_USER_DATA_DIR_ARGUMENT)
    )) {
      throw invalidMacosUpdaterArguments("ELECTRON_UPDATE_HELPER_ARGUMENTS_INVALID");
    }
    return null;
  }
  const parentValues = argumentsList
    .filter((argument) => argument.startsWith(UPDATE_PARENT_PID_ARGUMENT))
    .map((argument) => argument.slice(UPDATE_PARENT_PID_ARGUMENT.length));
  const attemptValues = argumentsList
    .filter((argument) => argument.startsWith(UPDATE_ATTEMPT_ID_ARGUMENT))
    .map((argument) => argument.slice(UPDATE_ATTEMPT_ID_ARGUMENT.length));
  const userDataValues = argumentsList
    .filter((argument) => argument.startsWith(UPDATE_USER_DATA_DIR_ARGUMENT))
    .map((argument) => argument.slice(UPDATE_USER_DATA_DIR_ARGUMENT.length));
  const chromiumUserDataValues = argumentsList
    .filter((argument) => argument.startsWith(CHROMIUM_USER_DATA_DIR_ARGUMENT))
    .map((argument) => argument.slice(CHROMIUM_USER_DATA_DIR_ARGUMENT.length));
  if (
    helperCount !== 1 ||
    argumentsList.includes(MACOS_UPDATE_RECOVERY_SWITCH) ||
    argumentsList.some((argument) =>
      argument.startsWith(UPDATE_RECOVERY_ATTEMPT_ID_ARGUMENT) ||
      argument.startsWith(UPDATE_RECOVERY_USER_DATA_DIR_ARGUMENT)
    ) ||
    parentValues.length !== 1 ||
    attemptValues.length !== 1 ||
    userDataValues.length !== 1 ||
    chromiumUserDataValues.length !== 1 ||
    chromiumUserDataValues[0] !== userDataValues[0] ||
    !/^[1-9][0-9]{0,9}$/u.test(parentValues[0] ?? "") ||
    !/^update-install-[0-9a-f-]{36}$/u.test(attemptValues[0] ?? "") ||
    !validHelperUserDataDirectory(userDataValues[0] ?? "")
  ) {
    throw invalidMacosUpdaterArguments("ELECTRON_UPDATE_HELPER_ARGUMENTS_INVALID");
  }
  const parentProcessId = Number(parentValues[0]);
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId > 0xffff_ffff) {
    throw new RionBridgeError({
      code: "ELECTRON_UPDATE_HELPER_ARGUMENTS_INVALID",
      message: "The updater relaunch helper parent identity is invalid."
    });
  }
  return {
    attemptId: attemptValues[0]!,
    parentProcessId,
    userDataDir: userDataValues[0]!
  };
}

export function parseMacosUpdaterRecoveryArguments(
  argumentsList: readonly string[]
): { attemptId: string; userDataDir: string } | null {
  const recoveryCount = argumentsList.filter(
    (argument) => argument === MACOS_UPDATE_RECOVERY_SWITCH
  ).length;
  const attemptValues = argumentsList
    .filter((argument) => argument.startsWith(UPDATE_RECOVERY_ATTEMPT_ID_ARGUMENT))
    .map((argument) => argument.slice(UPDATE_RECOVERY_ATTEMPT_ID_ARGUMENT.length));
  const userDataValues = argumentsList
    .filter((argument) => argument.startsWith(UPDATE_RECOVERY_USER_DATA_DIR_ARGUMENT))
    .map((argument) => argument.slice(UPDATE_RECOVERY_USER_DATA_DIR_ARGUMENT.length));
  if (recoveryCount === 0) {
    if (attemptValues.length > 0 || userDataValues.length > 0) {
      throw invalidMacosUpdaterArguments("ELECTRON_UPDATE_RECOVERY_ARGUMENTS_INVALID");
    }
    return null;
  }
  const chromiumUserDataValues = argumentsList
    .filter((argument) => argument.startsWith(CHROMIUM_USER_DATA_DIR_ARGUMENT))
    .map((argument) => argument.slice(CHROMIUM_USER_DATA_DIR_ARGUMENT.length));
  if (
    recoveryCount !== 1 ||
    argumentsList.includes(MACOS_UPDATE_RELAUNCH_HELPER_SWITCH) ||
    argumentsList.some((argument) =>
      argument.startsWith(UPDATE_PARENT_PID_ARGUMENT) ||
      argument.startsWith(UPDATE_ATTEMPT_ID_ARGUMENT) ||
      argument.startsWith(UPDATE_USER_DATA_DIR_ARGUMENT)
    ) ||
    attemptValues.length !== 1 ||
    userDataValues.length !== 1 ||
    chromiumUserDataValues.length !== 1 ||
    chromiumUserDataValues[0] !== userDataValues[0] ||
    !/^update-install-[0-9a-f-]{36}$/u.test(attemptValues[0] ?? "") ||
    !validHelperUserDataDirectory(userDataValues[0] ?? "")
  ) {
    throw invalidMacosUpdaterArguments("ELECTRON_UPDATE_RECOVERY_ARGUMENTS_INVALID");
  }
  return {
    attemptId: attemptValues[0]!,
    userDataDir: userDataValues[0]!
  };
}

function invalidMacosUpdaterArguments(code: string): RionBridgeError {
  return new RionBridgeError({
    code,
    message: "The internal updater relaunch arguments are invalid."
  });
}

function validHelperUserDataDirectory(value: string): boolean {
  return value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value;
}

function parseStatusEnvelope(value: string): UpdateStatusEnvelope {
  const envelope = parseObject(value, "ELECTRON_UPDATE_STATUS_INVALID");
  if (!Number.isSafeInteger(envelope.revision) || Number(envelope.revision) <= 0) {
    throw invalidPayload("ELECTRON_UPDATE_STATUS_INVALID");
  }
  const status = objectValue(envelope.status, "ELECTRON_UPDATE_STATUS_INVALID");
  if (
    typeof status.currentVersion !== "string" ||
    (status.installMode !== "automatic" && status.installMode !== "manual") ||
    typeof status.isPackaged !== "boolean" ||
    typeof status.autoUpdateEnabled !== "boolean" ||
    typeof status.state !== "string" ||
    !UPDATE_STATES.has(status.state)
  ) {
    throw invalidPayload("ELECTRON_UPDATE_STATUS_INVALID");
  }
  if (status.installAttempt !== undefined) parseAttempt(status.installAttempt);
  return {
    revision: Number(envelope.revision),
    status: status as unknown as AppUpdateStatusRecord
  };
}

function parseInstallAcceptance(value: string): InstallAcceptance {
  const acceptance = parseObject(value, "ELECTRON_UPDATE_INSTALL_ACCEPTANCE_INVALID");
  if (typeof acceptance.leader !== "boolean") {
    throw invalidPayload("ELECTRON_UPDATE_INSTALL_ACCEPTANCE_INVALID");
  }
  return {
    attempt: parseAttempt(acceptance.attempt),
    leader: acceptance.leader
  };
}

function parseAttempt(value: unknown): AppUpdateInstallAttemptRecord {
  const attempt = objectValue(value, "ELECTRON_UPDATE_INSTALL_ATTEMPT_INVALID");
  if (
    typeof attempt.attemptId !== "string" ||
    !attempt.attemptId ||
    typeof attempt.targetVersion !== "string" ||
    !attempt.targetVersion ||
    typeof attempt.phase !== "string" ||
    !INSTALL_PHASES.has(attempt.phase) ||
    typeof attempt.startedAt !== "string" ||
    typeof attempt.updatedAt !== "string"
  ) {
    throw invalidPayload("ELECTRON_UPDATE_INSTALL_ATTEMPT_INVALID");
  }
  return attempt as unknown as AppUpdateInstallAttemptRecord;
}

function parseObject(value: string, code: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value), code);
  } catch (error) {
    if (error instanceof RionBridgeError) throw error;
    throw invalidPayload(code);
  }
}

function parseNativeEventStreamFailure(value: string): CoreErrorPayload {
  const failure = parseObject(
    value,
    "ELECTRON_UPDATE_EVENT_STREAM_FAILURE_INVALID"
  );
  if (
    Object.keys(failure).length !== 2 ||
    !("code" in failure) ||
    !("message" in failure) ||
    typeof failure.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,95}$/u.test(failure.code) ||
    !NATIVE_UPDATE_EVENT_STREAM_FAILURE_CODES.has(failure.code) ||
    typeof failure.message !== "string" ||
    failure.message.trim().length === 0 ||
    failure.message.length > 4096 ||
    failure.message.includes("\0")
  ) {
    throw invalidPayload("ELECTRON_UPDATE_EVENT_STREAM_FAILURE_INVALID");
  }
  return { code: failure.code, message: failure.message };
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPayload(code);
  }
  return value as Record<string, unknown>;
}

function invalidPayload(code: string): RionBridgeError {
  return new RionBridgeError({
    code,
    message: "The native updater returned an invalid contract payload."
  });
}

function nativeUpdaterError(error: unknown): RionBridgeError {
  if (error instanceof RionBridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const start = message.indexOf("{");
  if (start >= 0) {
    try {
      const payload = JSON.parse(message.slice(start)) as Record<string, unknown>;
      if (
        typeof payload.code === "string" &&
        /^[A-Z][A-Z0-9_]{2,127}$/u.test(payload.code)
      ) {
        return new RionBridgeError({
          code: payload.code,
          message: typeof payload.message === "string"
            ? payload.message
            : payload.code
        });
      }
    } catch {
      // The fallback intentionally hides native transport and filesystem detail.
    }
  }
  return new RionBridgeError({
    code: "ELECTRON_NATIVE_UPDATER_FAILED",
    message: "Rion Studio could not complete the verified update operation."
  });
}
