import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ChromiumCdpInputTransport } from "../main/chromiumCdpInputTransport";
import { WindowsChromiumTrustedInputAdapter } from "../main/windowsChromiumTrustedInputAdapter";

/** Observe original results; persist at shutdown or after a failed terminal result. */
export function installElectronDesktopE2eTrustedInputDiagnostics(
  artifactDirectory: string | undefined,
  onWillQuit: (listener: () => void) => void
): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const output = join(artifactDirectory, "electron-trusted-input-diagnostics.json");
  const records: Readonly<Record<string, unknown>>[] = [];
  const flush = (): void => writeFileSync(output, `${JSON.stringify(records, null, 2)}\n`);
  let sequence = 0;
  const record = (value: Readonly<Record<string, unknown>>): void => {
    records.push(Object.freeze({ ...value, observationClock: "javascript-date-now", sequence: ++sequence }));
    if (records.length > 512) records.shift();
    const receipt = value.receipt;
    if (String(value.kind).endsWith("-rejected") ||
      (value.kind === "adapter-terminal" && receipt && typeof receipt === "object" &&
        Reflect.get(receipt, "status") !== "applied")) flush();
  };
  const describeError = (error: unknown) => ({
    code: error && typeof error === "object" ? Reflect.get(error, "code") : undefined,
    message: error instanceof Error ? error.message : String(error)
  });
  const adapter = WindowsChromiumTrustedInputAdapter.prototype;
  const dispatch = adapter.dispatch;
  adapter.dispatch = function (request) {
    const startedAtMs = Date.now();
    const result = dispatch.call(this, request);
    void result.then(receipt => record({
      kind: "adapter-terminal", request, receipt, startedAtMs, observedAtMs: Date.now()
    }), error => record({
      kind: "adapter-rejected", request, error: describeError(error), startedAtMs,
      observedAtMs: Date.now()
    }));
    return result;
  };
  const transport = ChromiumCdpInputTransport.prototype;
  const key = transport.dispatchKey;
  transport.dispatchKey = function (frame, effect) {
    const startedAtMs = Date.now();
    const result = key.call(this, frame, effect);
    void result.then(receipt => record({ kind: "cdp-key", frame, effect, receipt,
      startedAtMs, observedAtMs: Date.now() }), error => record({
      kind: "cdp-key-rejected", frame, effect, error: describeError(error),
      startedAtMs, observedAtMs: Date.now()
    }));
    return result;
  };
  const mouse = transport.dispatchMouse;
  transport.dispatchMouse = function (frame, input) {
    const startedAtMs = Date.now();
    const result = mouse.call(this, frame, input);
    void result.then(receipt => record({ kind: "cdp-mouse", frame, input, receipt,
      startedAtMs, observedAtMs: Date.now() }), error => record({
      kind: "cdp-mouse-rejected", frame, input, error: describeError(error),
      startedAtMs, observedAtMs: Date.now()
    }));
    return result;
  };
  onWillQuit(flush);
}
