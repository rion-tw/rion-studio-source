/* global DOMException, Document, Element, Event, HTMLVideoElement, MutationObserver, document */

(() => {
  const installationKey = "__rionStudioWorkspaceContainedFullscreen";
  if (Object.prototype.hasOwnProperty.call(globalThis, installationKey)) return;

  const channel = "__RION_CONTAINED_FULLSCREEN_CHANNEL__";
  const activeAttribute = "data-rion-contained-fullscreen";
  const ancestorAttribute = "data-rion-contained-fullscreen-ancestor";
  const rootAttribute = "data-rion-contained-fullscreen-active";
  const styleId = "__rion_contained_fullscreen_style";
  const messageKey = "__rionContainedFullscreen";
  const hostForceExitEvent = "__rionWorkspaceContainedFullscreenForceExit";
  let activeElement = null;
  let activePopover = null;
  let addedPopoverAttribute = false;
  let activeAncestors = [];
  let activeStyleSnapshots = new Map();
  let removalObserver = null;
  let childFrameWindow = null;
  let transitionSequence = 0;
  const pendingParentTransitions = new Map();
  const documentNonce = globalThis.crypto?.randomUUID?.()
    ?? `${channel}-${Math.random().toString(36).slice(2)}`;
  let hostTransitionLane = Promise.resolve();

  const fullscreenStyles = Object.freeze({
    "animation": "none",
    "aspect-ratio": "auto",
    "background": "black",
    "border": "0",
    "box-sizing": "border-box",
    "clip": "auto",
    "clip-path": "none",
    "display": "block",
    "height": "100vh",
    "inset": "0",
    "margin": "0",
    "max-height": "none",
    "max-width": "none",
    "min-height": "0",
    "min-width": "0",
    "object-fit": "contain",
    "padding": "0",
    "position": "fixed",
    "rotate": "none",
    "scale": "none",
    "transform": "none",
    "transition": "none",
    "translate": "none",
    "visibility": "visible",
    "width": "100vw",
    "z-index": "2147483646"
  });
  const ancestorStyles = Object.freeze({
    "backdrop-filter": "none",
    "clip": "auto",
    "clip-path": "none",
    "contain": "none",
    "container-type": "normal",
    "content-visibility": "visible",
    "filter": "none",
    "isolation": "auto",
    "mask": "none",
    "opacity": "1",
    "overflow": "visible",
    "perspective": "none",
    "rotate": "none",
    "scale": "none",
    "transform": "none",
    "translate": "none",
    "visibility": "visible",
    "will-change": "auto"
  });

  const createError = (name, message) => {
    try {
      return new DOMException(message, name);
    } catch {
      const error = new Error(message);
      error.name = name;
      return error;
    }
  };

  const define = (target, property, descriptor) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: false,
        ...descriptor
      });
      return true;
    } catch {
      return false;
    }
  };

  const installStyle = () => {
    if (!document.documentElement || document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      html[${rootAttribute}], html[${rootAttribute}] body {
        overflow: hidden !important;
        overscroll-behavior: none !important;
      }
      [${ancestorAttribute}] {
        contain: none !important;
        filter: none !important;
        overflow: visible !important;
        perspective: none !important;
        transform: none !important;
      }
      [${activeAttribute}] {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483646 !important;
        box-sizing: border-box !important;
        width: 100vw !important;
        height: 100vh !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        border: 0 !important;
        padding: 0 !important;
        transform: none !important;
        object-fit: contain;
        background: black;
      }
      iframe[${activeAttribute}], frame[${activeAttribute}] {
        border: 0 !important;
      }
      [${activeAttribute}]::backdrop {
        background: black;
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  };

  const dispatch = (element, type) => {
    const target = element?.isConnected ? element : document;
    target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    if (type === "fullscreenchange") {
      target.dispatchEvent(new Event("webkitfullscreenchange", {
        bubbles: true,
        composed: true
      }));
    } else if (type === "fullscreenerror") {
      target.dispatchEvent(new Event("webkitfullscreenerror", {
        bubbles: true,
        composed: true
      }));
    }
  };

  const sendToParent = (type, requestId) => {
    if (globalThis.parent === globalThis) return;
    globalThis.parent.postMessage({ [messageKey]: channel, requestId, type }, "*");
  };

  const sendToChild = (type) => {
    childFrameWindow?.postMessage({ [messageKey]: channel, type }, "*");
  };

  const restorePopover = () => {
    if (!activePopover) return;
    try {
      if (activePopover.matches(":popover-open")) activePopover.hidePopover();
    } catch {
      // CSS containment is authoritative when the optional Popover API is unavailable.
    }
    if (addedPopoverAttribute) activePopover.removeAttribute("popover");
    activePopover = null;
    addedPopoverAttribute = false;
  };

  const applyImportantStyles = (element, declarations) => {
    let snapshot = activeStyleSnapshots.get(element);
    if (!snapshot) {
      snapshot = new Map();
      activeStyleSnapshots.set(element, snapshot);
    }
    for (const [property, value] of Object.entries(declarations)) {
      if (!snapshot.has(property)) {
        snapshot.set(property, {
          priority: element.style.getPropertyPriority(property),
          value: element.style.getPropertyValue(property)
        });
      }
      if (element.style.getPropertyValue(property) !== value
          || element.style.getPropertyPriority(property) !== "important") {
        element.style.setProperty(property, value, "important");
      }
    }
  };

  const applyPresentationStyles = () => {
    if (!activeElement) return;
    for (const ancestor of activeAncestors) {
      applyImportantStyles(ancestor, ancestorStyles);
    }
    applyImportantStyles(activeElement, fullscreenStyles);
  };

  const restoreInlineStyles = () => {
    for (const [element, snapshot] of activeStyleSnapshots) {
      for (const [property, original] of snapshot) {
        if (original.value) {
          element.style.setProperty(property, original.value, original.priority);
        } else {
          element.style.removeProperty(property);
        }
      }
      if (!element.getAttribute("style")) element.removeAttribute("style");
    }
    activeStyleSnapshots = new Map();
  };

  const clearPresentation = () => {
    removalObserver?.disconnect();
    removalObserver = null;
    restorePopover();
    activeElement?.removeAttribute(activeAttribute);
    for (const ancestor of activeAncestors) ancestor.removeAttribute(ancestorAttribute);
    restoreInlineStyles();
    activeAncestors = [];
    document.documentElement?.removeAttribute(rootAttribute);
  };

  const exitLocal = ({ notifyChild = true } = {}) => {
    const exiting = activeElement;
    const hadActiveElement = Boolean(exiting);
    if (notifyChild) sendToChild("exit");
    childFrameWindow = null;
    clearPresentation();
    activeElement = null;
    if (hadActiveElement) dispatch(exiting, "fullscreenchange");
    return hadActiveElement;
  };

  const openPopover = (element) => {
    if (typeof element.showPopover !== "function") return;
    try {
      if (element.matches(":popover-open")) return;
    } catch {
      // Older engines can expose popover methods without the matching selector.
    }
    addedPopoverAttribute = !element.hasAttribute("popover");
    if (addedPopoverAttribute) element.setAttribute("popover", "manual");
    try {
      element.showPopover();
      activePopover = element;
    } catch {
      if (addedPopoverAttribute) element.removeAttribute("popover");
      addedPopoverAttribute = false;
    }
  };

  const enterLocal = (element) => {
    if (!(element instanceof Element) || !element.isConnected) {
      throw createError("TypeError", "The fullscreen element must be connected.");
    }
    if (activeElement === element) return;
    if (activeElement) exitLocal({ notifyChild: true });
    installStyle();
    activeElement = element;
    activeAncestors = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === document.documentElement) break;
      ancestor.setAttribute(ancestorAttribute, "");
      activeAncestors.push(ancestor);
    }
    document.documentElement?.setAttribute(rootAttribute, "");
    element.setAttribute(activeAttribute, "");
    applyPresentationStyles();
    openPopover(element);
    removalObserver = new MutationObserver(() => {
      if (activeElement && !activeElement.isConnected) {
        void exitThroughHost().catch(() => exitLocal());
      } else {
        applyPresentationStyles();
      }
    });
    removalObserver.observe(document, {
      attributeFilter: ["class", "style"],
      attributes: true,
      childList: true,
      subtree: true
    });
    dispatch(element, "fullscreenchange");
    // A site's fullscreenchange handler may synchronously rewrite the same
    // geometry (YouTube does this while updating player state). Reassert the
    // contained viewport policy after those handlers return.
    applyPresentationStyles();
  };

  const hostTransition = (phase) => {
    if (globalThis.parent !== globalThis) {
      return Promise.reject(createError("NotAllowedError", "Only the top document can resize the Workspace Web surface."));
    }
    if (globalThis.__rionWorkspaceWebContainedPopup === true) {
      return Promise.resolve({ fullscreen: phase === "enter" });
    }
    const internals = globalThis.__TAURI_INTERNALS__;
    const hostIdentity = globalThis.__rionWorkspaceWebIdentity;
    if (!hostIdentity || !internals || typeof internals.invoke !== "function") {
      return Promise.reject(createError("NotAllowedError", "The Workspace Web fullscreen host policy is unavailable."));
    }
    const sequence = phase === "ready" ? 0 : ++transitionSequence;
    const invoke = () => internals.invoke("rion_workspace_web_fullscreen_transition", {
      transition: {
        capabilityToken: hostIdentity.capabilityToken,
        documentNonce,
        generation: hostIdentity.generation,
        phase,
        sequence
      }
    });
    const result = hostTransitionLane.then(invoke, invoke);
    hostTransitionLane = result.catch(() => undefined);
    return result;
  };

  let hostReady = null;
  const ensureHostReady = () => {
    if (globalThis.parent !== globalThis) return Promise.resolve();
    hostReady ??= hostTransition("ready");
    return hostReady;
  };

  const requestParentTransition = (type) => new Promise((resolve, reject) => {
    const requestId = `${documentNonce}:${++transitionSequence}`;
    pendingParentTransitions.set(requestId, { reject, resolve });
    sendToParent(type, requestId);
  });

  const enterThroughHost = async (element) => {
    if (globalThis.parent === globalThis) {
      await ensureHostReady();
      await hostTransition("enter");
    } else {
      await requestParentTransition("enter");
    }
    try {
      enterLocal(element);
    } catch (error) {
      if (globalThis.parent === globalThis) await hostTransition("exit").catch(() => undefined);
      else await requestParentTransition("exit").catch(() => undefined);
      throw error;
    }
  };

  const exitThroughHost = async () => {
    const hadActiveElement = Boolean(activeElement);
    if (!hadActiveElement) return;
    if (globalThis.parent === globalThis) {
      await ensureHostReady();
      await hostTransition("exit");
    } else {
      await requestParentTransition("exit");
    }
    exitLocal();
  };

  const forceExitFromHost = () => {
    exitLocal();
  };
  document.addEventListener(hostForceExitEvent, forceExitFromHost, true);

  const requestFullscreen = function () {
    return Promise.resolve().then(async () => {
      try {
        await enterThroughHost(this);
      } catch (error) {
        dispatch(this, "fullscreenerror");
        throw error;
      }
    });
  };

  const exitFullscreen = () => Promise.resolve().then(exitThroughHost);

  const locateChildFrame = (source) => Array.from(
    document.querySelectorAll("iframe,frame")
  ).find((frame) => frame.contentWindow === source);

  const frameAllowsFullscreen = (frame, origin) => {
    if (origin === globalThis.location.origin) return true;
    if (frame.hasAttribute("allowfullscreen")) return true;
    return (frame.getAttribute("allow") ?? "")
      .split(";")
      .some((entry) => entry.trim().startsWith("fullscreen"));
  };

  globalThis.addEventListener("message", async (event) => {
    const payload = event.data;
    if (!payload || payload[messageKey] !== channel) return;
    event.stopImmediatePropagation();
    if (payload.type === "ack" || payload.type === "deny") {
      const pending = pendingParentTransitions.get(payload.requestId);
      if (!pending) return;
      pendingParentTransitions.delete(payload.requestId);
      if (payload.type === "ack") pending.resolve();
      else pending.reject(createError("NotAllowedError", "The parent frame denied contained fullscreen."));
      return;
    }
    if (payload.type === "exit") {
      if (event.source !== childFrameWindow) return;
      try {
        if (globalThis.parent === globalThis) await hostTransition("exit");
        else await requestParentTransition("exit");
        exitLocal({ notifyChild: false });
        event.source?.postMessage({ [messageKey]: channel, requestId: payload.requestId, type: "ack" }, "*");
      } catch {
        event.source?.postMessage({ [messageKey]: channel, requestId: payload.requestId, type: "deny" }, "*");
      }
      return;
    }
    if (payload.type !== "enter") return;
    const frame = locateChildFrame(event.source);
    if (!frame || !frameAllowsFullscreen(frame, event.origin)) {
      event.source?.postMessage({ [messageKey]: channel, requestId: payload.requestId, type: "deny" }, "*");
      return;
    }
    childFrameWindow = event.source;
    try {
      if (globalThis.parent === globalThis) {
        await ensureHostReady();
        await hostTransition("enter");
      } else {
        await requestParentTransition("enter");
      }
      enterLocal(frame);
      event.source?.postMessage({ [messageKey]: channel, requestId: payload.requestId, type: "ack" }, "*");
    } catch {
      event.source?.postMessage({ [messageKey]: channel, requestId: payload.requestId, type: "deny" }, "*");
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!activeElement || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void exitThroughHost().catch(() => undefined);
  }, true);
  globalThis.addEventListener("pagehide", () => {
    if (globalThis.parent === globalThis && activeElement) {
      void hostTransition("exit").catch(() => undefined);
    }
    exitLocal();
  }, { once: true });

  const fullscreenElement = { get: () => activeElement };
  const fullscreenEnabled = { get: () => true };
  const fullscreenActive = { get: () => Boolean(activeElement) };
  const installations = [
    define(Element.prototype, "requestFullscreen", { value: requestFullscreen, writable: true }),
    define(Element.prototype, "webkitRequestFullscreen", { value: requestFullscreen, writable: true }),
    define(Element.prototype, "webkitRequestFullScreen", { value: requestFullscreen, writable: true }),
    define(Document.prototype, "exitFullscreen", { value: exitFullscreen, writable: true }),
    define(Document.prototype, "webkitExitFullscreen", { value: exitFullscreen, writable: true }),
    define(Document.prototype, "webkitCancelFullScreen", { value: exitFullscreen, writable: true }),
    define(Document.prototype, "fullscreenElement", fullscreenElement),
    define(Document.prototype, "webkitFullscreenElement", fullscreenElement),
    define(Document.prototype, "webkitCurrentFullScreenElement", fullscreenElement),
    define(Document.prototype, "fullscreenEnabled", fullscreenEnabled),
    define(Document.prototype, "webkitFullscreenEnabled", fullscreenEnabled),
    define(Document.prototype, "fullscreen", fullscreenActive),
    define(Document.prototype, "webkitIsFullScreen", fullscreenActive)
  ];
  if (globalThis.HTMLVideoElement) {
    installations.push(define(HTMLVideoElement.prototype, "webkitEnterFullscreen", {
      value: requestFullscreen,
      writable: true
    }));
    installations.push(define(HTMLVideoElement.prototype, "webkitEnterFullScreen", {
      value: requestFullscreen,
      writable: true
    }));
    installations.push(define(HTMLVideoElement.prototype, "webkitExitFullscreen", {
      value: exitFullscreen,
      writable: true
    }));
    installations.push(define(HTMLVideoElement.prototype, "webkitExitFullScreen", {
      value: exitFullscreen,
      writable: true
    }));
    installations.push(define(HTMLVideoElement.prototype, "webkitDisplayingFullscreen", {
      get() { return activeElement === this; }
    }));
    installations.push(define(
      HTMLVideoElement.prototype,
      "webkitSupportsFullscreen",
      fullscreenEnabled
    ));
  }
  const installed = installations.every((result) => result === true);

  const runPreflight = () => {
    if (globalThis.location.href !== "about:blank" || !installed) return false;
    const videoAliasesInstalled = !globalThis.HTMLVideoElement || [
      "webkitEnterFullscreen",
      "webkitEnterFullScreen",
      "webkitExitFullscreen",
      "webkitExitFullScreen",
      "webkitDisplayingFullscreen",
      "webkitSupportsFullscreen"
    ].every((property) => property in HTMLVideoElement.prototype);
    const wrappersInstalled = Element.prototype.requestFullscreen === requestFullscreen
      && Element.prototype.webkitRequestFullscreen === requestFullscreen
      && Element.prototype.webkitRequestFullScreen === requestFullscreen
      && Document.prototype.exitFullscreen === exitFullscreen
      && Document.prototype.webkitExitFullscreen === exitFullscreen
      && Document.prototype.webkitCancelFullScreen === exitFullscreen
      && videoAliasesInstalled;
    const parent = document.body ?? document.documentElement;
    if (!wrappersInstalled || !parent) return false;
    const target = document.createElement("div");
    parent.appendChild(target);
    try {
      enterLocal(target);
      const entered = document.fullscreenElement === target
        && document.webkitFullscreenElement === target
        && document.fullscreen === true
        && target.hasAttribute(activeAttribute);
      exitLocal();
      return entered
        && document.fullscreenElement === null
        && document.webkitFullscreenElement === null
        && document.fullscreen === false
        && !target.hasAttribute(activeAttribute);
    } catch {
      exitLocal();
      return false;
    } finally {
      target.remove();
    }
  };

  Object.defineProperty(globalThis, "__rionWorkspaceContainedFullscreenForceExit", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: forceExitFromHost
  });

  Object.defineProperty(globalThis, "__rionWorkspaceContainedFullscreenPreflight", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: runPreflight
  });

  Object.defineProperty(globalThis, installationKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ installed, version: 2 })
  });
})();
