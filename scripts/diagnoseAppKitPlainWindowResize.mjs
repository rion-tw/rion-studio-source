import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputLimit = 512 * 1024;
const finite = value => typeof value === "number" && Number.isFinite(value);
const allButtonsUp = buttons => buttons?.hidLeft === false && buttons?.combinedLeft === false && buttons?.appKitLeft === false;
const rect = value => value && ["width", "height", "x", "y"].every(key => finite(value[key])) && value.width > 0 && value.height > 0;
const frame = value => rect(value) && finite(value.windowX) && finite(value.windowY);
const sameRect = (left, right) => rect(left) && rect(right) &&
  ["x", "y", "width", "height"].every(key => left[key] === right[key]);
const contains = (outer, inner) => rect(outer) && rect(inner) && inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

// This validates native evidence before any control input. The control is
// screen-fit; its selected frame is not an exact Rion A/B geometry claim.
export function assertScreenFitControlGeometry(item) {
  const selection = item?.geometrySelection;
  const evidence = selection?.screenEvidence;
  const screens = evidence?.screens;
  const validScreen = value => Number.isSafeInteger(value?.id) && value.id > 0 &&
    rect(value.frame) && rect(value.visibleFrame) && contains(value.frame, value.visibleFrame) &&
    finite(value.scale) && value.scale > 0;
  if (!Array.isArray(screens) || screens.length === 0 || !screens.every(validScreen) ||
      new Set(screens.map(value => value.id)).size !== screens.length ||
      typeof evidence.mainScreenWasNil !== "boolean" ||
      (evidence.mainScreenWasNil ? evidence.mainScreenId !== null :
        !screens.some(value => value.id === evidence.mainScreenId))) {
    throw new Error("Screen-fit control has no authoritative screen inventory");
  }
  const chosen = evidence.mainScreenWasNil ? screens[0] : screens.find(value => value.id === evidence.mainScreenId);
  const visible = chosen.visibleFrame;
  const width = Math.min(960, visible.width), height = Math.min(677, visible.height);
  const selected = { x: visible.x + Math.min(56, Math.max(0, visible.width - width)),
    y: visible.y + visible.height - height, width, height };
  const requested = { x: visible.x + 56, y: visible.y + visible.height - 677, width: 960, height: 677 };
  const input = item.requestedGeometry;
  const currentScreen = item.screenEvidence?.screens?.find(value => value.id === chosen.id);
  if (selection.selectionSource !== (evidence.mainScreenWasNil ? "screens.firstObject" : "mainScreen") ||
      selection.screenId !== chosen.id || item.screenId !== chosen.id || !validScreen(currentScreen) ||
      !sameRect(currentScreen.frame, chosen.frame) || !sameRect(currentScreen.visibleFrame, visible) ||
      currentScreen.scale !== chosen.scale || item.backingScaleFactor !== chosen.scale ||
      !sameRect(item.screenFrame, chosen.frame) || !sameRect(item.visibleFrame, visible) ||
      input?.upperBoundSize?.width !== 960 || input.upperBoundSize.height !== 677 ||
      input.minimumSize?.width !== 640 || input.minimumSize.height !== 512 ||
      input.shrinkDelta?.width !== 48 || input.shrinkDelta.height !== 32 ||
      item.minimumSize?.width !== 640 || item.minimumSize.height !== 512 ||
      width < 640 + 48 || height < 512 + 32 || !contains(visible, selected) ||
      !sameRect(selection.requestedFrame, requested) || !sameRect(selection.selectedFrame, selected) ||
      !sameRect(item.frame, selected) || !sameRect(item.quartzFrame, { ...selected,
        y: screens[0].frame.y + screens[0].frame.height - selected.y - selected.height })) {
    throw new Error("Screen-fit control geometry, native readback or original resize margin was not admitted");
  }
}
const failure = (error, depth = 0) => {
  const value = { message: String(error?.message ?? error).slice(0, 2048), code: error?.code ?? null,
    signal: error?.signal ?? null, killed: error?.killed ?? false };
  if (depth === 4) return { ...value, nestedDetailsTruncated: true };
  if (Array.isArray(error?.errors)) {
    value.errors = error.errors.slice(0, 8).map(item => failure(item, depth + 1));
    value.omittedErrors = Math.max(0, error.errors.length - 8);
  }
  if (error?.cause !== undefined) value.cause = failure(error.cause, depth + 1);
  return value;
};
const processFailure = (stage, result) => new Error(`${stage}: code=${result.code}, signal=${result.signal}, ` +
  `elapsed=${result.elapsedMilliseconds}ms, error=${result.error?.message ?? "none"}; ` + result.stderr.slice(0, 1600));

// Each process has one submission and one actual close outcome. A deadline can
// only fail the diagnostic; exec callbacks or elapsed time never prove success.
function childProcess(file, args, timeout, onLine) {
  const child = spawn(file, args, { timeout, stdio: ["pipe", "pipe", "pipe"] });
  const started = Date.now();
  let stdout = "", stderr = "", remainder = "", error, outputTruncated = false;
  let retirementRequested = false;
  const retire = reason => {
    error ??= reason;
    if (!retirementRequested) {
      retirementRequested = true;
      try { child.kill(); } catch (cause) { error ??= cause; }
    }
  };
  const terminal = new Promise(resolveTerminal => {
    child.on("error", retire);
    child.stdin.on("error", value => { retire(value); });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > outputLimit) {
        outputTruncated = true;
        stdout = Buffer.from(stdout).subarray(0, outputLimit).toString("utf8");
        retire(new Error("stdout exceeded the diagnostic bound")); return;
      }
      if (!onLine) return;
      remainder += chunk.toString("utf8");
      for (;;) {
        const newline = remainder.indexOf("\n");
        if (newline < 0) break;
        const line = remainder.slice(0, newline); remainder = remainder.slice(newline + 1);
        try { onLine(line, child.pid); } catch (cause) { retire(cause); }
      }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > outputLimit) {
        outputTruncated = true;
        stderr = Buffer.from(stderr).subarray(0, outputLimit).toString("utf8");
        retire(new Error("stderr exceeded the diagnostic bound"));
      }
    });
    child.on("close", (code, signal) => resolveTerminal({ code, signal, stdout, stderr,
      elapsedMilliseconds: Date.now() - started, error: error ? failure(error) : null,
      outputTruncated, completeLine: !onLine || !remainder }));
  });
  return { child, terminal, retire };
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The plain Cocoa control requires a native macOS host");
  const allowed = resolve(repository, ".desktop-e2e-artifacts");
  const root = resolve(repository, process.argv[2] ?? ".desktop-e2e-artifacts/native-resize-constraints-witness/plain-control");
  if (!root.startsWith(allowed + sep)) throw new Error("Diagnostic output escaped its owned artifact root");
  await mkdir(allowed, { recursive: true });
  await mkdir(resolve(root, ".."), { recursive: true });
  const actualAllowed = await realpath(allowed);
  const actualParent = await realpath(resolve(root, ".."));
  if (actualParent !== actualAllowed && !actualParent.startsWith(actualAllowed + sep)) throw new Error("Diagnostic output traversed an external symlink");
  await mkdir(root); // Existing output is not overwritten or reused.
  const report = { diagnosticControlOnly: true, behaviorIsNotReleaseQuality: true,
    controlKind: "screen-fit Cocoa sender control", exactRionGeometryComparison: false,
    inputSource: "e2e/desktop/support/workspace-window-resize.swift", infrastructureComplete: false,
    compiles: [], axes: [], failures: [] };
  let control;
  let ready;
  let closedReceipt;
  let controlOutcome;
  let primaryError;
  const pendingCheckpoints = new Map();
  try {
    const binary = resolve(root, "plain-cocoa-control");
    const resize = resolve(root, "workspace-window-resize");
    for (const [name, args] of [
      ["control", ["clang++", "-std=c++20", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
        "-framework", "AppKit", "-framework", "ApplicationServices",
        resolve(repository, "tests/fixtures/appkit-plain-window-resize-control.mm"), "-o", binary]],
      ["resize", ["swiftc", resolve(repository, "e2e/desktop/support/workspace-window-resize.swift"), "-o", resize]],
    ]) {
      const result = await childProcess("/usr/bin/xcrun", args, 120_000).terminal;
      report.compiles.push({ name, ...result });
      await writeFile(resolve(root, `${name}-compile.stdout`), result.stdout);
      await writeFile(resolve(root, `${name}-compile.stderr`), result.stderr);
      if (result.error || result.code !== 0 || result.signal !== null) throw new Error(`${name} compile failed`);
    }
    const nonce = randomUUID(), windowId = `plain-cocoa-resize-${randomUUID()}`;
    let resolveReady, rejectReady;
    const readiness = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
    control = childProcess(binary, [windowId, nonce], 60_000, (line, pid) => {
      const value = JSON.parse(line);
      if (value.nonce !== nonce) throw new Error("Control nonce changed");
      if (value.stage === "ready" && !ready) {
        report.readinessReceipt = value;
        const item = value.snapshot;
        assertScreenFitControlGeometry(item);
        if (item.processId !== pid || !Number.isSafeInteger(pid) || pid <= 0 ||
            item.windowId !== windowId || item.axIdentifier !== `com.rionstudio.runtime.appkit-window.v1:${windowId}` ||
            !Number.isSafeInteger(item.windowNumber) || item.windowNumber <= 0 ||
            item.visible !== true || item.key !== true || item.main !== true || item.applicationActive !== true ||
            item.launchFinished !== true || item.launchTurnObserved !== true ||
            item.ownedVisibleWindowCount !== 1 || item.styleMask !== 15 ||
            !rect(item.frame) || !rect(item.quartzFrame) || !rect(item.screenFrame) || !rect(item.visibleFrame) ||
            !finite(item.backingScaleFactor) || item.backingScaleFactor <= 0 ||
            item.minimumSize?.width !== 640 || item.minimumSize?.height !== 512 || !allButtonsUp(item.buttons)) {
          throw new Error("The control readiness receipt lost its exact visible native owner or initial geometry");
        }
        ready = value; resolveReady(value);
      } else if (value.stage === "checkpoint" && ready && pendingCheckpoints.has(value.name)) {
        const item = value.snapshot;
        if (item.processId !== pid || item.windowId !== ready.snapshot.windowId ||
            item.windowPointer !== ready.snapshot.windowPointer || item.windowNumber !== ready.snapshot.windowNumber ||
            item.axIdentifier !== ready.snapshot.axIdentifier || item.visible !== true || item.key !== true ||
            item.main !== true || item.inLiveResize !== false || !allButtonsUp(item.buttons)) {
          throw new Error("The post-gesture native checkpoint lost its exact neutral owner");
        }
        pendingCheckpoints.get(value.name).resolve(value);
        pendingCheckpoints.delete(value.name);
      } else if (value.stage === "infrastructure-error") {
        report.nativeRejection = value;
        throw new Error(`Native control rejected startup/command: ${value.reason}`);
      } else if (value.stage === "closed" && ready && !closedReceipt) closedReceipt = value;
      else throw new Error(`Unexpected native control stage: ${value.stage}`);
    });
    control.terminal.then(result => {
      controlOutcome = result;
      const error = processFailure("Control terminated before a requested native receipt", result);
      if (!ready) rejectReady(error);
      for (const pending of pendingCheckpoints.values()) pending.reject(error);
      pendingCheckpoints.clear();
    });
    await readiness;
    report.ready = ready;
    let previousEnd;
    for (const edge of ["right", "bottom"]) {
      const axis = { edge, status: "OBSERVED_FAIL", phases: [] };
      report.axes.push(axis);
      const baseline = previousEnd ?? { windowX: ready.snapshot.frame.x,
        windowY: ready.snapshot.quartzFrame.y,
        width: ready.snapshot.frame.width, height: ready.snapshot.frame.height };
      axis.baseline = baseline;
      if (!finite(baseline.windowX) || !finite(baseline.windowY) ||
          !finite(baseline.width) || !finite(baseline.height) ||
          baseline.width < 640 || baseline.height < 512 ||
          (edge === "right" ? baseline.width < 640 + 48 : baseline.height < 512 + 32)) {
        axis.input = "NO_INPUT";
        throw new Error(`${edge} fresh baseline cannot provide the original shrink delta above native minimum`);
      }
      let point = edge === "right" ? { x: baseline.windowX + baseline.width - 1,
        y: baseline.windowY + baseline.height / 2 } : {
        x: baseline.windowX + baseline.width / 2, y: baseline.windowY + baseline.height - 1 };
      const action = async (phase, expected = null) => {
        if (controlOutcome) throw processFailure("Control terminated before the next input phase", controlOutcome);
        const request = { processId: control.child.pid, windowId, phase, edge,
          rapid: false, expected, restoreDragFullWindows: null, ...point };
        const requestPath = resolve(root, `${edge}-${phase}.request.json`);
        await writeFile(requestPath, JSON.stringify(request));
        const result = await childProcess(resize, [requestPath], 30_000).terminal;
        await writeFile(resolve(root, `${edge}-${phase}.stdout`), result.stdout);
        await writeFile(resolve(root, `${edge}-${phase}.stderr`), result.stderr);
        const entry = { request, ...result };
        axis.phases.push(entry);
        if (result.error) throw processFailure(`${edge}/${phase} helper process failed`, result);
        if (result.code !== 0 || result.signal !== null) {
          if (phase === "move" && [null, "SIGILL", "SIGTRAP"].includes(result.signal) &&
              result.stderr.includes("native resize did not reach requested frame:")) {
            axis.mismatch = { classification: "OBSERVED_FAIL", reason: "exact native frame acknowledgement failed", raw: result.stderr };
            return null;
          }
          throw processFailure(`${edge}/${phase} helper failed`, result);
        }
        const native = JSON.parse(result.stdout);
        if (!frame(native)) throw new Error("Resize helper returned malformed native frame evidence");
        entry.native = native;
        return native;
      };
      let axisError;
      try {
        const start = await action("start");
        point = { x: start.x + (edge === "right" ? -48 : 0),
          y: start.y + (edge === "bottom" ? -32 : 0) };
        if (start.width !== baseline.width || start.height !== baseline.height ||
            start.windowX !== baseline.windowX || start.windowY !== baseline.windowY) {
          throw new Error(`${edge} native start changed from its fresh admitted baseline`);
        }
        axis.expected = { x: edge === "right" ? start.width - 48 : start.width,
          y: edge === "bottom" ? start.height - 32 : start.height };
        const moved = await action("move", axis.expected);
        if (moved && Math.abs(moved.width - axis.expected.x) <= 1 && Math.abs(moved.height - axis.expected.y) <= 1) axis.status = "OBSERVED_PASS";
        else if (!axis.mismatch) throw new Error("Successful helper contradicted its exact frame acknowledgement");
      } catch (error) { axisError = error; }
      try {
        previousEnd = await action("end");
        if (controlOutcome) throw processFailure("Control terminated before the neutral native checkpoint", controlOutcome);
        const checkpoint = new Promise((resolve, reject) => pendingCheckpoints.set(edge, { resolve, reject }));
        control.child.stdin.write(JSON.stringify({ command: "checkpoint", name: edge, nonce }) + "\n");
        axis.neutralCheckpoint = await checkpoint;
      }
      catch (error) { axisError = axisError ? new AggregateError([axisError, error], "Input and exact button cleanup failed") : error; }
      if (axisError) throw axisError;
    }
  } catch (error) { primaryError = error; report.failures.push(failure(error)); }
  finally {
    if (control) {
      if (ready && control.child.exitCode === null && control.child.signalCode === null) {
        control.child.stdin.end(JSON.stringify({ command: "close", nonce: ready.nonce }) + "\n");
      } else control.retire(new Error("No admitted control remained for orderly cleanup"));
      const result = await control.terminal;
      report.controlProcess = result;
      report.closed = closedReceipt ?? null;
      await writeFile(resolve(root, "control.stdout"), result.stdout);
      await writeFile(resolve(root, "control.stderr"), result.stderr);
      const after = closedReceipt?.afterClose;
      const before = closedReceipt?.beforeClose;
      const cleanupVerified = !result.error && result.code === 0 && result.signal === null && result.completeLine &&
        before?.processId === control.child.pid && before.windowId === ready?.snapshot.windowId &&
        before.windowPointer === ready?.snapshot.windowPointer && before.windowNumber === ready?.snapshot.windowNumber &&
        before.visible === true && allButtonsUp(before.buttons) &&
        after?.processId === control.child.pid && after.windowId === ready?.snapshot.windowId &&
        after.windowPointer === ready?.snapshot.windowPointer &&
        after.visible === false && after.key === false && after.main === false && after.ownedVisibleWindowCount === 0 &&
        allButtonsUp(after.buttons);
      if (!cleanupVerified) {
        const error = new Error("Exact control window/process/button cleanup was not verified");
        report.failures.push(failure(error)); primaryError ??= error;
      }
      report.infrastructureComplete = cleanupVerified && !primaryError;
    }
    report.behavior = report.infrastructureComplete
      ? (report.axes.every(axis => axis.status === "OBSERVED_PASS") ? "OBSERVED_PASS" : "OBSERVED_FAIL")
      : "INFRASTRUCTURE_FAIL";
    await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (primaryError) throw primaryError;
  console.log(JSON.stringify({ diagnosticControlOnly: true, infrastructureComplete: true,
    behavior: report.behavior, report: resolve(root, "report.json") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
