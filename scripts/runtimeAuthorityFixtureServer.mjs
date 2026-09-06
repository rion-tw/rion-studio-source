import { createServer } from "node:http";

const DEFAULT_PORT = 41739;
const portArgument = process.argv.find((value) => value.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? DEFAULT_PORT);
if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
  throw new Error("Fixture port must be zero or an integer between 1024 and 65535.");
}
let activePort = port;

const counters = new Map();
const downloadResponses = new Set();
const eventWaiters = new Set();
const events = [];
const gates = new Map();
const navigationFailures = new Map();
let nextEventSequence = 1;

const EVENT_CAPACITY = 4_096;

function roleCounters(roleId) {
  const current = counters.get(roleId) ?? {
    blur: 0,
    click: 0,
    focus: 0,
    hidden: 0,
    keydown: 0,
    keyup: 0,
    lastEvent: "boot",
    lastEventSequence: 0,
    consumerChordActivations: [],
    consumerPressedCodes: [],
    consumerRevision: 0,
    pressedCodes: [],
    trustedPressedCodes: [],
    visibility: 0
  };
  counters.set(roleId, current);
  return current;
}

function fixtureEventMatches(event, request) {
  return event.sequence > request.afterSequence
    && (!request.roleId || event.roleId === request.roleId)
    && (!request.kind || event.kind === request.kind);
}

function finishEventWaiter(waiter, event) {
  eventWaiters.delete(waiter);
  json(waiter.response, 200, {
    event,
    latestSequence: nextEventSequence - 1
  });
}

function notifyEventWaiters(event) {
  for (const waiter of [...eventWaiters]) {
    if (fixtureEventMatches(event, waiter)) finishEventWaiter(waiter, event);
  }
}

function normalizedCaretSnapshot(input) {
  if (!input || typeof input !== "object") return undefined;
  const index = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    activeElementId: typeof input.activeElementId === "string"
      ? input.activeElementId
      : null,
    requestedEnd: index(input.requestedEnd),
    requestedStart: index(input.requestedStart),
    selectionEnd: index(input.selectionEnd),
    selectionStart: index(input.selectionStart),
    textEditInvocation: Number.isSafeInteger(input.textEditInvocation)
      && input.textEditInvocation >= 0
      ? input.textEditInvocation
      : 0,
    valueLength: index(input.valueLength) ?? 0
  };
}

function normalizedFileUpload(input) {
  if (!input || typeof input !== "object") return undefined;
  if (
    !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 1_048_576 ||
    typeof input.fileName !== "string" || input.fileName.length < 1 ||
    input.fileName.length > 255 || !/^[a-f0-9]{64}$/.test(input.sha256)
  ) {
    return undefined;
  }
  return {
    bytes: input.bytes,
    fileName: input.fileName,
    sha256: input.sha256
  };
}

function recordFixtureEvent(input) {
  const event = {
    button: Number.isInteger(input.button) && input.button >= 0 && input.button <= 2
      ? input.button
      : undefined,
    buttons: Number.isInteger(input.buttons) && input.buttons >= 0
      ? input.buttons
      : undefined,
    caret: normalizedCaretSnapshot(input.caret),
    code: typeof input.code === "string" ? input.code : undefined,
    coordinates: input.coordinates,
    defaultPrevented: typeof input.defaultPrevented === "boolean"
      ? input.defaultPrevented
      : undefined,
    errorCode: typeof input.errorCode === "string" ? input.errorCode : undefined,
    errorMessage: typeof input.errorMessage === "string" ? input.errorMessage : undefined,
    fileUpload: normalizedFileUpload(input.fileUpload),
    hidden: typeof input.hidden === "boolean" ? input.hidden : undefined,
    isTrusted: typeof input.isTrusted === "boolean" ? input.isTrusted : undefined,
    key: typeof input.key === "string" ? input.key : undefined,
    kind: input.kind,
    modifiers: input.modifiers,
    repeat: typeof input.repeat === "boolean" ? input.repeat : undefined,
    fullscreen: input.fullscreen,
    roleId: input.roleId,
    sequence: nextEventSequence++,
    session: input.session,
    targetId: typeof input.targetId === "string" ? input.targetId : undefined,
    timestamp: new Date().toISOString()
  };
  events.push(event);
  process.stderr.write(`fixture-event ${JSON.stringify(event)}\n`);
  while (events.length > EVENT_CAPACITY) events.shift();
  const state = roleCounters(input.roleId);
  if (Object.hasOwn(state, input.kind)) state[input.kind] += 1;
  if (event.code && input.kind === "keydown" && !state.pressedCodes.includes(event.code)) {
    state.pressedCodes.push(event.code);
  }
  if (event.code && input.kind === "keyup") {
    state.pressedCodes = state.pressedCodes.filter((code) => code !== event.code);
  }
  if (
    event.isTrusted === true
    && event.code
    && input.kind === "keydown"
    && !state.trustedPressedCodes.includes(event.code)
  ) {
    state.trustedPressedCodes.push(event.code);
  }
  if (event.isTrusted === true && event.code && input.kind === "keyup") {
    state.trustedPressedCodes = state.trustedPressedCodes.filter((code) => code !== event.code);
  }
  if (
    input.kind.startsWith("consumer-")
    && Number.isInteger(input.consumerRevision)
    && input.consumerRevision > state.consumerRevision
    && Array.isArray(input.consumerPressedCodes)
    && input.consumerPressedCodes.every((code) => typeof code === "string")
    && Array.isArray(input.consumerChordActivations)
    && input.consumerChordActivations.every((activation) => typeof activation === "string")
  ) {
    state.consumerRevision = input.consumerRevision;
    state.consumerPressedCodes = [...input.consumerPressedCodes];
    state.consumerChordActivations = [...input.consumerChordActivations];
  }
  state.lastEvent = input.kind;
  state.lastEventSequence = event.sequence;
  notifyEventWaiters(event);
  return { event, state };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function localRequest(request) {
  const host = request.headers.host?.split(":")[0]?.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) throw new Error("fixture request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function rolePage(roleId, sessionMode, sessionMarker) {
  const safeRoleId = JSON.stringify(roleId).replaceAll("<", "\\u003c");
  const safeSessionMarker = JSON.stringify(sessionMarker).replaceAll("<", "\\u003c");
  const safeSessionMode = JSON.stringify(sessionMode).replaceAll("<", "\\u003c");
  const challengeOrigin = `http://localhost:${activePort}`;
  const safeChallengeOrigin = JSON.stringify(challengeOrigin).replaceAll("<", "\\u003c");
  const safeChallengeUrl = JSON.stringify(`${challengeOrigin}/challenge/${roleId}`)
    .replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>[Runtime QA] ${roleId}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10141d; color: #ecf2ff; }
    main { position: relative; z-index: 1; width: min(760px, calc(100vw - 40px)); padding: 28px; border: 2px solid #5eead4; border-radius: 18px; background: #182131; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0 0 8px; color: #5eead4; }
    p { color: #a9b7ce; }
    button, #blocked-download, #contained-fullscreen-popup { display: block; width: 240px; height: 72px; margin: 28px auto; border: 0; border-radius: 14px; background: #7c3aed; color: white; font: inherit; font-size: 18px; line-height: 72px; text-align: center; text-decoration: none; cursor: pointer; }
    dl { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    div { padding: 12px; border-radius: 10px; background: #0e1522; }
    dt { color: #8ea0bc; font-size: 12px; } dd { margin: 5px 0 0; font-size: 22px; }
    #last-event { color: #fbbf24; }
    #game-input-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; outline: 0; }
    #font-evidence[hidden] { display: none; }
    #font-evidence:not([hidden]) { position: fixed; right: 16px; top: 16px; z-index: 3; margin: 0; }
    #qa-target { position: fixed; left: 50%; top: 50%; z-index: 2; margin: 0; transform: translate(-50%, -50%); }
    #qa-target.contained-fullscreen-layout { position: static; transform: none; }
    #active-navigation-failure { position: fixed; left: 50%; bottom: 24px; z-index: 3; height: 56px; margin: 0; transform: translateX(-50%); line-height: normal; }
    #active-navigation-failure[hidden] { display: none; }
    #contained-fullscreen-controls { padding: 18px; border: 1px solid #5eead4; border-radius: 12px; background: #0e1522; }
    #contained-fullscreen-controls[hidden] { display: none; }
    #contained-fullscreen-controls button, #contained-fullscreen-controls a { position: static; transform: none; }
    #contained-fullscreen-controls #permission-geolocation,
    #contained-fullscreen-controls #blocked-download,
    #contained-fullscreen-controls #file-upload { position: relative; z-index: 3; }
    #file-upload { display: block; width: min(420px, 100%); margin: 28px auto; padding: 16px; border: 2px solid #7c3aed; border-radius: 14px; background: #0e1522; color: white; font: inherit; cursor: pointer; }
    #verification-frame { position: fixed; inset: 0; z-index: 4; width: 100vw; height: 100vh; border: 0; background: #10141d; }
    #verification-frame[hidden] { display: none; }
    #text_input { position: fixed; right: 24px; bottom: 24px; z-index: 3; width: min(420px, calc(100vw - 48px)); padding: 12px; border: 2px solid #fbbf24; border-radius: 10px; background: #0e1522; color: #ecf2ff; font: inherit; }
    #text_input[hidden] { display: none; }
  </style>
</head>
<body>
  <canvas id="game-input-canvas" tabindex="0"></canvas>
  <input id="text_input" type="text" aria-label="Flyff chat caret fixture" hidden>
  <main>
    <h1>[Runtime QA] <span id="role-id"></span></h1>
    <p>Local-only WKWebView/WebView2 lifecycle, focus, input, and macro fixture.</p>
    <button id="font-evidence" type="button" hidden>Read page font evidence</button>
    <button id="qa-target" type="button">Macro click target</button>
    <button id="active-navigation-failure" type="button" hidden>Navigate active page</button>
    <section id="contained-fullscreen-controls" hidden>
      <p>Workspace Web contained fullscreen fixture</p>
      <button id="contained-fullscreen-enter" type="button">Enter contained fullscreen</button>
      <button id="contained-fullscreen-exit" type="button">Exit contained fullscreen</button>
      <a id="contained-fullscreen-popup" href="/role/e2e-workspace-popup" target="_blank" rel="noopener" hidden>Open fullscreen popup</a>
      <button id="permission-geolocation" type="button" hidden>Request denied geolocation</button>
      <a id="blocked-download" href="/download/${roleId}" download hidden>Attempt blocked download</a>
      <input id="file-upload" type="file" accept="text/plain" aria-label="Choose upload fixture" hidden>
    </section>
    <iframe id="verification-frame" title="Robot verification" hidden></iframe>
    <dl>
      <div><dt>click</dt><dd id="click">0</dd></div>
      <div><dt>keydown</dt><dd id="keydown">0</dd></div>
      <div><dt>focus</dt><dd id="focus">0</dd></div>
      <div><dt>visibility</dt><dd id="visibility">0</dd></div>
    </dl>
    <p>Last event: <strong id="last-event">boot</strong></p>
  </main>
  <script>
    const roleId = ${safeRoleId};
    const counts = { click: 0, keydown: 0, focus: 0, visibility: 0 };
    const sessionKey = "rion-e2e-session";
    const sessionMarker = ${safeSessionMarker};
    const sessionMode = ${safeSessionMode};
    const challengeOrigin = ${safeChallengeOrigin};
    const challengeUrl = ${safeChallengeUrl};
    const verificationEnabled = roleId === "macro-input-recovery";
    const flyffCaretDiagnosticsEnabled = roleId === "macro-keyboard-a";
    const activeNavigationFailureEnabled =
      roleId === "chromium-workspaces-recovery-failing"
      || new URL(location.href).searchParams.get("activeNavigationFailure") === "1";
    const containedFullscreenEnabled = roleId === "e2e-workspace-web"
      || roleId === "chromium-workspace-web-fullscreen"
      || roleId === "chromium-controlled-role-reload"
      || roleId === "e2e-workspace-popup";
    const containedFullscreenPopup = roleId === "e2e-workspace-popup";
    let verificationComplete = false;
    document.querySelector("#role-id").textContent = roleId;
    const render = (kind) => {
      for (const [key, value] of Object.entries(counts)) {
        const element = document.querySelector("#" + key);
        if (element) element.textContent = String(value);
      }
      document.querySelector("#last-event").textContent = kind;
    };
    let recordQueue = Promise.resolve();
    const record = (kind, details = {}) => {
      if (kind in counts) counts[kind] += 1;
      render(kind);
      recordQueue = recordQueue.then(() => fetch("/api/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roleId, kind, ...details }),
          keepalive: true
        }))
        .then(() => undefined, () => undefined);
      return recordQueue;
    };
    const qaTarget = document.querySelector("#qa-target");
    if (verificationEnabled) qaTarget.textContent = "Open robot verification";
    else if (sessionMode === "late-write") qaTarget.textContent = "Save role LocalStorage marker";
    qaTarget.addEventListener("mousedown", (event) => event.preventDefault());
    qaTarget.addEventListener("click", async (event) => {
      record("click", {
        button: event.button,
        buttons: event.buttons,
        coordinates: { x: event.clientX, y: event.clientY },
        isTrusted: event.isTrusted,
        targetId: event.currentTarget.id
      });
      if (sessionMode === "late-write") {
        const before = {
          cookie: await readSessionCookie(),
          localStorage: localStorage.getItem(sessionKey)
        };
        localStorage.setItem(sessionKey, sessionMarker);
        const after = {
          cookie: await readSessionCookie(),
          localStorage: localStorage.getItem(sessionKey)
        };
        record("session-local-storage-updated", {
          session: { after, before, marker: sessionMarker, mode: sessionMode }
        });
      }
      if (verificationEnabled && !verificationComplete) {
        const frame = document.querySelector("#verification-frame");
        frame.hidden = false;
        frame.addEventListener("load", () => frame.focus(), { once: true });
        frame.src = challengeUrl;
        record("verification-open");
        return;
      }
      document.querySelector("#game-input-canvas").focus();
    });
    const fontEvidence = document.querySelector("#font-evidence");
    if (roleId === "chromium-font-application") {
      fontEvidence.hidden = false;
      fontEvidence.addEventListener("click", (event) => {
        const context = document.createElement("canvas").getContext("2d");
        context.font = "16px sans-serif";
        fontEvidence.dataset.evidence = JSON.stringify({
          canvasHookInstalled: Object.prototype.hasOwnProperty.call(CanvasRenderingContext2D.prototype, "__rionStudioBrowserFontsCanvasHook"),
          loadedFamilies: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family).sort(),
          bodyFamily: getComputedStyle(document.body).fontFamily,
          canvasFont: context.font,
          wideGlyphWidth: context.measureText("W").width,
          narrowGlyphWidth: context.measureText("i").width,
          style: document.getElementById("rion-studio-browser-fonts")?.textContent ?? "",
          trusted: event.isTrusted
        });
      });
    }
    const activeNavigationFailure = document.querySelector("#active-navigation-failure");
    if (activeNavigationFailureEnabled) {
      activeNavigationFailure.hidden = false;
      activeNavigationFailure.addEventListener("click", async (event) => {
        await record("navigation-requested", {
          isTrusted: event.isTrusted,
          targetId: event.currentTarget.id
        });
        window.location.assign(window.location.href);
      });
    }
    const containedFullscreenControls = document.querySelector("#contained-fullscreen-controls");
    if (containedFullscreenEnabled) {
      qaTarget.classList.add("contained-fullscreen-layout");
      let containedFullscreenExitCount = 0;
      containedFullscreenControls.hidden = false;
      const popupButton = document.querySelector("#contained-fullscreen-popup");
      const permissionButton = document.querySelector("#permission-geolocation");
      const downloadLink = document.querySelector("#blocked-download");
      const fileUpload = document.querySelector("#file-upload");
      const securityPolicyEnabled = roleId === "chromium-workspace-web-fullscreen";
      popupButton.hidden = roleId !== "e2e-workspace-web"
        && roleId !== "chromium-workspace-web-fullscreen"
        && roleId !== "chromium-controlled-role-reload";
      permissionButton.hidden = !securityPolicyEnabled;
      downloadLink.hidden = !securityPolicyEnabled;
      fileUpload.hidden = !securityPolicyEnabled;
      popupButton.addEventListener("click", (event) => {
        record("contained-popup-requested", { isTrusted: event.isTrusted });
      });
      permissionButton.addEventListener("click", (event) => {
        record("permission-requested", {
          isTrusted: event.isTrusted,
          targetId: event.currentTarget.id
        });
        navigator.geolocation.getCurrentPosition(
          () => record("permission-unexpectedly-granted"),
          (error) => record("permission-denied", {
            errorCode: String(error.code),
            errorMessage: error.message
          })
        );
      });
      downloadLink.addEventListener("click", (event) => {
        record("download-requested", {
          isTrusted: event.isTrusted,
          targetId: event.currentTarget.id
        });
      });
      fileUpload.addEventListener("click", (event) => {
        record("file-upload-requested", {
          isTrusted: event.isTrusted,
          targetId: event.currentTarget.id
        });
      });
      fileUpload.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) {
          record("file-upload-empty", { isTrusted: event.isTrusted });
          return;
        }
        const contents = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", contents);
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0")).join("");
        record("file-upload-selected", {
          fileUpload: {
            bytes: contents.byteLength,
            fileName: file.name,
            sha256
          },
          isTrusted: event.isTrusted,
          targetId: input.id
        });
      });
      document.addEventListener("click", (event) => {
        record("contained-control-click", {
          coordinates: { x: event.clientX, y: event.clientY },
          isTrusted: event.isTrusted,
          targetId: event.target instanceof Element ? event.target.id : undefined
        });
      }, true);
      document.querySelector("#contained-fullscreen-enter").addEventListener("click", () => {
        void containedFullscreenControls.requestFullscreen().catch((error) => {
          record("contained-fullscreen-error", {
            errorCode: error?.code ?? error?.error?.code ?? "UNKNOWN",
            errorMessage: error?.message ?? error?.error?.message ?? String(error),
            key: error?.name ?? "Error",
          });
        });
      });
      document.querySelector("#contained-fullscreen-exit").addEventListener("click", () => {
        void document.exitFullscreen();
      });
      document.addEventListener("fullscreenchange", () => {
        const active = document.fullscreenElement === containedFullscreenControls;
        if (!active && (roleId === "e2e-workspace-web"
            || roleId === "chromium-workspace-web-fullscreen")) {
          containedFullscreenExitCount += 1;
          if (containedFullscreenExitCount >= 2) {
            qaTarget.hidden = true;
            popupButton.style.cssText = "position:fixed;inset:0;z-index:5;width:100vw;height:100vh;margin:0;display:grid;place-items:center";
          }
        }
        const rect = containedFullscreenControls.getBoundingClientRect();
        record(active ? "contained-fullscreen-enter" : "contained-fullscreen-exit", {
          fullscreen: {
            active,
            rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y },
            targetId: document.fullscreenElement?.id ?? null,
            toolbarPresent: Boolean(document.querySelector("#__rion_web_toolbar_host")),
            viewport: { height: innerHeight, width: innerWidth }
          }
        });
      });
      if (containedFullscreenPopup) {
        addEventListener("load", () => {
          document.querySelector("#contained-fullscreen-enter").focus();
          record("contained-popup-ready");
        }, { once: true });
      }
    }
    addEventListener("message", (event) => {
      if (!verificationEnabled || event.origin !== challengeOrigin || event.data !== "verification-complete") return;
      const frame = document.querySelector("#verification-frame");
      frame.remove();
      verificationComplete = true;
      qaTarget.textContent = "Return to game";
      record("verification-complete");
    });
    const keyboardDetails = (event) => ({
      code: event.code,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      key: event.key,
      modifiers: { alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
      repeat: event.repeat,
      targetId: event.target instanceof Element ? event.target.id : undefined
    });
    const textInput = document.querySelector("#text_input");
    let textEditInvocation = 0;
    const caretSnapshot = (requestedStart, requestedEnd) => ({
      activeElementId: document.activeElement instanceof Element
        ? document.activeElement.id
        : null,
      requestedEnd,
      requestedStart,
      selectionEnd: textInput.selectionEnd,
      selectionStart: textInput.selectionStart,
      textEditInvocation,
      valueLength: textInput.value.length
    });
    const recordCaret = (kind, event, requestedStart, requestedEnd) => record(kind, {
      ...(event ? keyboardDetails(event) : {}),
      caret: caretSnapshot(requestedStart, requestedEnd)
    });
    const startFlyffTextEdit = (event) => {
      textEditInvocation += 1;
      textInput.hidden = false;
      textInput.value = "seed";
      const requestedCaret = textInput.value.length;
      recordCaret("flyff-caret-selection-before", event, requestedCaret, requestedCaret);
      textInput.setSelectionRange(requestedCaret, requestedCaret);
      recordCaret("flyff-caret-selection-after", event, requestedCaret, requestedCaret);
      recordCaret("flyff-caret-focus-before", event);
      textInput.focus();
      recordCaret("flyff-caret-focus-after", event);
    };
    if (flyffCaretDiagnosticsEnabled) {
      textInput.value = "seed";
      addEventListener("keydown", (event) => {
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          recordCaret("flyff-caret-keydown", event);
        }
      }, true);
      addEventListener("keyup", (event) => {
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          recordCaret("flyff-caret-keyup", event);
        }
      }, true);
      textInput.addEventListener("focusin", (event) => recordCaret("flyff-caret-focusin", event));
      document.querySelector("#game-input-canvas").addEventListener("keydown", (event) => {
        if (event.code === "Enter" || event.code === "NumpadEnter") startFlyffTextEdit(event);
      });
    }
    const consumerPressedCodes = new Set();
    const consumerChordActivations = [];
    let consumerRevision = 0;
    const resetConsumerInputOnContextLoss = new URL(location.href)
      .searchParams.get("resetConsumerInputOnContextLoss") === "1";
    const recordConsumerKeyboard = (kind, event) => {
      if (event.isTrusted) {
        if (kind === "consumer-keydown") {
          consumerPressedCodes.add(event.code);
          const completesShiftChord = event.code.startsWith("Shift") || event.code.startsWith("Digit");
          const shiftPressed = event.shiftKey
            || [...consumerPressedCodes].some((code) => code.startsWith("Shift"));
          if (completesShiftChord && shiftPressed) {
            for (const code of [...consumerPressedCodes].filter((pressed) => pressed.startsWith("Digit"))) {
              consumerChordActivations.push("Shift+" + code);
            }
          }
        } else {
          consumerPressedCodes.delete(event.code);
        }
      }
      record(kind, {
        ...keyboardDetails(event),
        consumerChordActivations: [...consumerChordActivations],
        consumerPressedCodes: [...consumerPressedCodes],
        consumerRevision: ++consumerRevision
      });
    };
    const resetConsumerKeyboard = (reason) => {
      if (!resetConsumerInputOnContextLoss) return;
      consumerPressedCodes.clear();
      record("consumer-input-reset", {
        consumerChordActivations: [...consumerChordActivations],
        consumerPressedCodes: [],
        consumerRevision: ++consumerRevision,
        targetId: reason
      });
    };
    addEventListener("keydown", (event) => record("keydown", keyboardDetails(event)), true);
    addEventListener("keyup", (event) => record("keyup", keyboardDetails(event)), true);
    for (const kind of ["mousedown", "mouseup", "auxclick", "contextmenu"]) {
      addEventListener(kind, (event) => {
        record(kind, {
          button: typeof event.button === "number"
            ? event.button
            : event.which === 1 ? 0 : event.which === 2 ? 1 : event.which === 3 ? 2 : undefined,
          buttons: typeof event.buttons === "number" ? event.buttons : undefined,
          isTrusted: event.isTrusted,
          modifiers: { alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
          targetId: event.target instanceof Element ? event.target.id : undefined
        });
        if (kind === "contextmenu") event.preventDefault();
      });
    }
    addEventListener("keydown", (event) => recordConsumerKeyboard("consumer-keydown", event));
    addEventListener("keyup", (event) => recordConsumerKeyboard("consumer-keyup", event));
    document.querySelector("#game-input-canvas").addEventListener("click", (event) => {
      record("game-click", {
        coordinates: { x: event.clientX, y: event.clientY },
        targetId: event.currentTarget.id
      });
      event.currentTarget.focus();
    });
    addEventListener("focus", () => record("focus"));
    addEventListener("blur", () => {
      resetConsumerKeyboard("blur");
      record("blur");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) resetConsumerKeyboard("hidden");
      record(document.hidden ? "hidden" : "visibility", { hidden: document.hidden });
    });
    const readSessionCookie = async () => {
      const response = await fetch("/api/session-cookie", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Session cookie read failed with " + response.status);
      const body = await response.json();
      return typeof body.cookie === "string" ? body.cookie : null;
    };
    const recordSession = async () => {
      const before = { cookie: await readSessionCookie(), localStorage: localStorage.getItem(sessionKey) };
      if (sessionMode === "seed") {
        localStorage.setItem(sessionKey, sessionMarker);
      }
      if (sessionMode === "seed" || sessionMode === "late-write") {
        const response = await fetch("/api/session-cookie", {
          body: JSON.stringify({ marker: sessionMarker }),
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        if (!response.ok) throw new Error("Session cookie seed failed with " + response.status);
      }
      const after = {
        cookie: sessionMode === "seed" || sessionMode === "late-write"
          ? await readSessionCookie()
          : before.cookie,
        localStorage: localStorage.getItem(sessionKey)
      };
      record("session", { session: { after, before, marker: sessionMarker, mode: sessionMode } });
    };
    addEventListener("load", () => void recordSession(), { once: true });
    document.querySelector("#game-input-canvas").focus();
    record(document.hidden ? "hidden" : "visibility", { hidden: document.hidden });
  </script>
</body>
</html>`;
}

function sendRolePage(response, roleId, sessionMode = "observe", sessionMarker = roleId) {
  const body = rolePage(roleId, sessionMode, sessionMarker);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src http://localhost:${activePort}`,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function sendChallengePage(response, roleId) {
  const safeRoleId = String(roleId).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Verification</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827eF; color: white; }
    button { width: 280px; height: 84px; border: 2px solid #f59e0b; border-radius: 14px; background: #1f2937; color: white; font: inherit; font-size: 18px; cursor: pointer; }
  </style>
</head>
<body>
  <button id="verification-complete" type="button">I’m not a robot · ${safeRoleId}</button>
  <script>
    document.querySelector("#verification-complete").addEventListener("click", () => {
      parent.postMessage("verification-complete", "http://127.0.0.1:${activePort}");
    });
  </script>
</body>
</html>`;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function sessionCookie(request) {
  const encoded = request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("rion-e2e-session="))
    ?.slice("rion-e2e-session=".length);
  if (encoded === undefined) return null;
  try {
    const value = decodeURIComponent(encoded);
    return /^[a-z0-9-]{1,80}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function gateState(roleId) {
  const current = gates.get(roleId) ?? {
    blocked: false,
    observers: new Set(),
    waiters: new Set()
  };
  gates.set(roleId, current);
  return current;
}

function releaseGate(roleId) {
  const gate = gateState(roleId);
  gate.blocked = false;
  for (const waiter of gate.waiters) {
    sendRolePage(waiter.response, roleId, waiter.sessionMode, waiter.marker);
  }
  gate.waiters.clear();
  for (const response of gate.observers) {
    json(response, 200, { released: true, roleId, waiterCount: 0 });
  }
  gate.observers.clear();
}

function notifyGateObservers(roleId, gate) {
  if (gate.waiters.size === 0) return;
  for (const response of gate.observers) {
    json(response, 200, { roleId, waiterCount: gate.waiters.size });
  }
  gate.observers.clear();
}

function navigationFailureState(roleId) {
  const current = navigationFailures.get(roleId) ?? {
    attemptObservers: new Set(),
    enabled: false,
    failedAttempts: 0,
    recoveryObservers: new Set(),
    recoveryWaiters: new Set()
  };
  navigationFailures.set(roleId, current);
  return current;
}

function notifyNavigationFailureAttemptObservers(roleId, failure) {
  if (failure.failedAttempts === 0) return;
  for (const response of failure.attemptObservers) {
    json(response, 200, { failedAttempts: failure.failedAttempts, roleId });
  }
  failure.attemptObservers.clear();
}

function notifyNavigationFailureRecoveryObservers(roleId, failure) {
  if (failure.recoveryWaiters.size === 0) return;
  for (const response of failure.recoveryObservers) {
    json(response, 200, { roleId, waiterCount: failure.recoveryWaiters.size });
  }
  failure.recoveryObservers.clear();
}

function sendTerminalNavigationFailure(response, roleId) {
  const body = `<!doctype html><title>Truncated navigation ${roleId}</title>`;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body) + 4096,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function releaseNavigationFailure(roleId) {
  const failure = navigationFailureState(roleId);
  failure.enabled = false;
  for (const response of failure.recoveryWaiters) sendRolePage(response, roleId);
  failure.recoveryWaiters.clear();
  for (const response of failure.recoveryObservers) {
    json(response, 200, { released: true, roleId, waiterCount: 0 });
  }
  failure.recoveryObservers.clear();
}

const server = createServer(async (request, response) => {
  if (!localRequest(request)) {
    json(response, 403, { error: "localhost-only fixture" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, port: activePort });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, Object.fromEntries([...counters.entries()].sort()));
      return;
    }
    const downloadMatch = request.method === "GET"
      && url.pathname.match(/^\/download\/([a-z0-9-]+)$/);
    if (downloadMatch) {
      const roleId = downloadMatch[1];
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${roleId}.txt"`,
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      response.write("blocked Chromium download fixture\n");
      downloadResponses.add(response);
      recordFixtureEvent({ kind: "download-response-started", roleId });
      response.once("close", () => {
        downloadResponses.delete(response);
        if (!response.writableEnded) {
          recordFixtureEvent({ kind: "download-transport-cancelled", roleId });
        }
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const afterSequence = Number(url.searchParams.get("afterSequence") ?? 0);
      const kind = url.searchParams.get("kind") ?? undefined;
      const roleId = url.searchParams.get("roleId") ?? undefined;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        json(response, 400, { error: "afterSequence must be a non-negative safe integer" });
        return;
      }
      if (kind && !/^[a-z][a-z-]*$/.test(kind)) {
        json(response, 400, { error: "invalid fixture event kind" });
        return;
      }
      if (roleId && !/^[a-z0-9-]+$/.test(roleId)) {
        json(response, 400, { error: "invalid fixture role" });
        return;
      }
      const waitRequest = { afterSequence, kind, response, roleId };
      const existing = events.find((event) => fixtureEventMatches(event, waitRequest));
      if (existing) {
        finishEventWaiter(waitRequest, existing);
        return;
      }
      eventWaiters.add(waitRequest);
      response.once("close", () => eventWaiters.delete(waitRequest));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events/snapshot") {
      const afterSequence = Number(url.searchParams.get("afterSequence") ?? 0);
      const kind = url.searchParams.get("kind") ?? undefined;
      const roleId = url.searchParams.get("roleId") ?? undefined;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        json(response, 400, { error: "afterSequence must be a non-negative safe integer" });
        return;
      }
      if (kind && !/^[a-z][a-z-]*$/.test(kind)) {
        json(response, 400, { error: "invalid fixture event kind" });
        return;
      }
      if (roleId && !/^[a-z0-9-]+$/.test(roleId)) {
        json(response, 400, { error: "invalid fixture role" });
        return;
      }
      const filter = { afterSequence, kind, roleId };
      json(response, 200, {
        events: events.filter((event) => fixtureEventMatches(event, filter)),
        latestSequence: nextEventSequence - 1
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/gates") {
      json(response, 200, Object.fromEntries(
        [...gates.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([roleId, gate]) => [roleId, {
            blocked: gate.blocked,
            waiterCount: gate.waiters.size
          }])
      ));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/navigation-failures") {
      json(response, 200, Object.fromEntries(
        [...navigationFailures.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([roleId, failure]) => [roleId, {
            enabled: failure.enabled,
            failedAttempts: failure.failedAttempts,
            recoveryWaiterCount: failure.recoveryWaiters.size
          }])
      ));
      return;
    }
    const waiterMatch = request.method === "GET"
      && url.pathname.match(/^\/api\/gates\/([a-z0-9-]+)\/waiting$/);
    if (waiterMatch) {
      const roleId = waiterMatch[1];
      const gate = gateState(roleId);
      if (gate.waiters.size > 0) {
        json(response, 200, { roleId, waiterCount: gate.waiters.size });
        return;
      }
      gate.observers.add(response);
      response.once("close", () => gate.observers.delete(response));
      return;
    }
    const failedAttemptMatch = request.method === "GET"
      && url.pathname.match(/^\/api\/navigation-failures\/([a-z0-9-]+)\/attempted$/);
    if (failedAttemptMatch) {
      const roleId = failedAttemptMatch[1];
      const failure = navigationFailureState(roleId);
      if (failure.failedAttempts > 0) {
        json(response, 200, { failedAttempts: failure.failedAttempts, roleId });
        return;
      }
      failure.attemptObservers.add(response);
      response.once("close", () => failure.attemptObservers.delete(response));
      return;
    }
    const recoveryWaiterMatch = request.method === "GET"
      && url.pathname.match(/^\/api\/navigation-failures\/([a-z0-9-]+)\/recovery-waiting$/);
    if (recoveryWaiterMatch) {
      const roleId = recoveryWaiterMatch[1];
      const failure = navigationFailureState(roleId);
      if (failure.recoveryWaiters.size > 0) {
        json(response, 200, { roleId, waiterCount: failure.recoveryWaiters.size });
        return;
      }
      failure.recoveryObservers.add(response);
      response.once("close", () => failure.recoveryObservers.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      counters.clear();
      events.length = 0;
      for (const roleId of gates.keys()) releaseGate(roleId);
      gates.clear();
      for (const roleId of navigationFailures.keys()) releaseNavigationFailure(roleId);
      navigationFailures.clear();
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gate") {
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || !/^[a-z0-9-]+$/.test(body.roleId)) {
        json(response, 400, { error: "invalid fixture gate" });
        return;
      }
      const gate = gateState(body.roleId);
      gate.blocked = true;
      json(response, 200, { blocked: true, roleId: body.roleId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/release") {
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || !/^[a-z0-9-]+$/.test(body.roleId)) {
        json(response, 400, { error: "invalid fixture release" });
        return;
      }
      releaseGate(body.roleId);
      json(response, 200, { blocked: false, roleId: body.roleId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/navigation-failure") {
      const body = await requestBody(request);
      if (
        typeof body.roleId !== "string"
        || !/^[a-z0-9-]+$/.test(body.roleId)
        || typeof body.enabled !== "boolean"
      ) {
        json(response, 400, { error: "invalid fixture navigation failure" });
        return;
      }
      const failure = navigationFailureState(body.roleId);
      if (body.enabled) {
        releaseNavigationFailure(body.roleId);
        failure.enabled = true;
        failure.failedAttempts = 0;
      } else {
        releaseNavigationFailure(body.roleId);
      }
      json(response, 200, {
        enabled: failure.enabled,
        failedAttempts: failure.failedAttempts,
        roleId: body.roleId
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session-cookie") {
      json(response, 200, { cookie: sessionCookie(request) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session-cookie") {
      const body = await requestBody(request);
      if (typeof body.marker !== "string" || !/^[a-z0-9-]{1,80}$/.test(body.marker)) {
        json(response, 400, { error: "invalid fixture session marker" });
        return;
      }
      response.writeHead(204, {
        "cache-control": "no-store",
        "content-length": 0,
        "set-cookie": `rion-e2e-session=${encodeURIComponent(body.marker)}; Path=/; Max-Age=86400; SameSite=Strict`
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/event") {
      const body = await requestBody(request);
      if (
        typeof body.roleId !== "string"
        || !/^[a-z0-9-]+$/.test(body.roleId)
        || typeof body.kind !== "string"
        || !/^[a-z][a-z-]*$/.test(body.kind)
      ) {
        json(response, 400, { error: "invalid fixture event" });
        return;
      }
      const { event, state } = recordFixtureEvent(body);
      json(response, 200, { event, state });
      return;
    }
    const roleMatch = request.method === "GET" && url.pathname.match(/^\/role\/([a-z0-9-]+)$/);
    if (roleMatch) {
      const roleId = roleMatch[1];
      const failure = navigationFailureState(roleId);
      if (failure.enabled) {
        if (failure.failedAttempts === 0) {
          failure.failedAttempts += 1;
          notifyNavigationFailureAttemptObservers(roleId, failure);
          sendTerminalNavigationFailure(response, roleId);
          return;
        }
        failure.recoveryWaiters.add(response);
        notifyNavigationFailureRecoveryObservers(roleId, failure);
        response.once("close", () => failure.recoveryWaiters.delete(response));
        return;
      }
      const requestedMode = url.searchParams.get("mode");
      const sessionMode = requestedMode === "seed" || requestedMode === "late-write"
        ? requestedMode
        : "observe";
      const marker = url.searchParams.get("marker") ?? roleId;
      if (!/^[a-z0-9-]{1,80}$/.test(marker)) {
        json(response, 400, { error: "invalid fixture session marker" });
        return;
      }
      const gate = gateState(roleId);
      if (!gate.blocked) {
        sendRolePage(response, roleId, sessionMode, marker);
        return;
      }
      const waiter = { marker, response, sessionMode };
      gate.waiters.add(waiter);
      notifyGateObservers(roleId, gate);
      response.once("close", () => {
        const cancelledWhileWaiting = gate.waiters.delete(waiter);
        if (cancelledWhileWaiting && !response.writableEnded) {
          recordFixtureEvent({
            kind: "gated-navigation-transport-cancelled",
            roleId
          });
        }
      });
      return;
    }
    const challengeMatch = request.method === "GET"
      && url.pathname.match(/^\/challenge\/([a-z0-9-]+)$/);
    if (challengeMatch) {
      sendChallengePage(response, challengeMatch[1]);
      return;
    }
    json(response, 404, { error: "fixture route not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  activePort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`runtime-authority-fixture http://127.0.0.1:${activePort}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const response of downloadResponses) response.destroy();
    downloadResponses.clear();
    server.close(() => process.exit(0));
  });
}
