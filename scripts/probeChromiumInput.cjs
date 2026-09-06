// Native compatibility experiment only; never loaded by the product runtime.
const { app, BrowserWindow, WebContentsView, webContents } = require("electron");
const { writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { sendChromiumKey, sendChromiumClick, ChromiumViewAttachmentCoordinator, ChromiumViewTrustedInputHost } = require("./electronLoadChromiumInputOwner.cjs");

const [reportPath, userData, addonPath] = process.argv.slice(2);
if (!reportPath || !userData || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Use bundled Electron: probeChromiumInput.cjs REPORT_PATH ISOLATED_USER_DATA");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
const fixture = "data:text/html," + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>Input compatibility probe</title>' +
  '<body style="margin:0;height:100vh" tabindex="0">Isolated input fixture</body>'
);
const keyboard = [
  { type: "keyDown", keyCode: "A" },
  { type: "keyUp", keyCode: "A" }
];
const middleButton = [
  { type: "mouseDown", x: 120, y: 90, button: "middle", clickCount: 1 },
  { type: "mouseUp", x: 120, y: 90, button: "middle", clickCount: 1 }
];
const state = contents => contents.executeJavaScript(`({
  focused: document.hasFocus(), visibility: document.visibilityState,
  width: innerWidth, height: innerHeight
})`);

async function sample(view, host, name, inputs, expectedTypes, submit) {
  const contents = view.webContents;
  const before = { hostFocused: host.isFocused(), hostVisible: host.isVisible(),
    contentsFocused: contents.isFocused(), document: await state(contents) };
  // Test-only observation deadline. Expiry is indeterminate, never successful delivery.
  await contents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(expectedTypes)};
    const events = [];
    window.inputProbe = new Promise(resolve => {
      let deadline;
      const finish = status => {
        clearTimeout(deadline);
        for (const type of new Set(expected)) document.removeEventListener(type, receive, true);
        resolve({ status, events });
      };
      const receive = event => {
        events.push({ type: event.type, trusted: event.isTrusted, key: event.key ?? null,
          code: event.code ?? null, button: event.button ?? null, buttons: event.buttons ?? null,
          shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
          repeat: event.repeat ?? false, x: event.clientX ?? null, y: event.clientY ?? null });
        if (events.length === expected.length) finish(
          events.every((event, index) => event.type === expected[index]) ? "received" : "mismatch"
        );
      };
      for (const type of new Set(expected)) document.addEventListener(type, receive, true);
      deadline = setTimeout(() => finish("indeterminate"), 1500);
    });
  })()`);
  const submission = submit ? submit() : undefined;
  if (!submit) for (const input of inputs) contents.sendInputEvent(input);
  const receipt = await contents.executeJavaScript("window.inputProbe");
  return { name, inputs, expectedTypes, before, receipt, submission,
    after: { hostFocused: host.isFocused(), hostVisible: host.isVisible(),
      contentsFocused: contents.isFocused(), document: await state(contents) } };
}

async function applyVisibleViewportZoom(view, factor) {
  const bounds = view.getBounds();
  const width = Math.round(bounds.width / factor);
  const height = Math.round(bounds.height / factor);
  await view.webContents.executeJavaScript(`(() => {
    const width = ${width};
    const height = ${height};
    window.viewportProbe = new Promise(resolve => {
      let deadline;
      const finish = status => {
        clearTimeout(deadline);
        window.removeEventListener("resize", inspect);
        resolve({ status, width: innerWidth, height: innerHeight });
      };
      const inspect = () => {
        if (innerWidth === width && innerHeight === height) finish("applied");
      };
      window.addEventListener("resize", inspect);
      // Test-only external renderer acknowledgement boundary, never a success timer.
      deadline = setTimeout(() => finish("indeterminate"), 3000);
    });
  })()`);
  view.webContents.setZoomFactor(factor);
  const receipt = await view.webContents.executeJavaScript("window.viewportProbe");
  if (receipt.status !== "applied" || view.webContents.getZoomFactor() !== factor) {
    throw new Error(`Renderer viewport did not acknowledge zoom: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

async function focus(host, view) {
  if (!host.isFocused()) {
    await new Promise(resolveFocus => {
      host.once("focus", resolveFocus);
      host.show();
      host.focus();
    });
  }
  view.webContents.focus();
}

async function probe() {
  const options = { show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
  const host = new BrowserWindow(options);
  const other = new BrowserWindow(options);
  const view = new WebContentsView({ webPreferences: { ...options.webPreferences, partition: "rion-input-target" } });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  const sibling = new WebContentsView({ webPreferences: { ...options.webPreferences, partition: "rion-input-sibling" } });
  const outcomes = [];
  try {
    await view.webContents.loadURL(fixture);
    await other.loadURL(fixture);
    await focus(host, view);
    outcomes.push(await sample(view, host, "foreground", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "modifiers-and-repeat", [
      { type: "keyDown", keyCode: "Shift", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "A", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "A", modifiers: ["shift", "isAutoRepeat"] },
      { type: "keyUp", keyCode: "A", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Shift" }
    ], ["keydown", "keydown", "keydown", "keyup", "keyup"]));
    for (const [keyCode, modifier] of [["Control", "control"], ["Alt", "alt"], ["Meta", "meta"]]) {
      outcomes.push(await sample(view, host, `modifier-${modifier}`, [
        { type: "keyDown", keyCode, modifiers: [modifier] },
        { type: "keyDown", keyCode: "A", modifiers: [modifier] },
        { type: "keyUp", keyCode: "A", modifiers: [modifier] },
        { type: "keyUp", keyCode }
      ], ["keydown", "keydown", "keyup", "keyup"]));
    }
    for (const zoom of [1, 1.5]) {
      view.webContents.setZoomFactor(zoom);
      outcomes.push(await sample(view, host, `middle-button-zoom-${zoom}`,
        middleButton, ["mousedown", "mouseup"]));
    }
    view.webContents.setZoomFactor(1);
    outcomes.push(await sample(view, host, "held-before-reload", [keyboard[0]], ["keydown"]));
    await view.webContents.loadURL(fixture);
    await focus(host, view);
    outcomes.push(await sample(view, host, "held-release-after-reload", [keyboard[1]], ["keyup"]));
    outcomes.push(await sample(view, host, "reloaded", keyboard, ["keydown", "keyup"]));
    // Do not focus either target after hiding/backgrounding it to repair delivery.
    view.setVisible(false);
    outcomes.push(await sample(view, host, "hidden-view", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "hidden-view-middle", middleButton, ["mousedown", "mouseup"]));
    view.setVisible(true);
    await focus(host, view);
    view.setBounds({ x: 40, y: 36, width: 300, height: 200 });
    const viewportAcknowledgement = await applyVisibleViewportZoom(view, 1.25);
    // Candidate topology: two views directly owned by one standard host, with
    // no per-Role BaseWindow, SetParent, or native child-handle input adapter.
    host.contentView.addChildView(sibling);
    sibling.setBounds({ x: 0, y: 0, width: 600, height: 400 });
    await sibling.webContents.loadURL(fixture);
    await focus(host, sibling);
    view.setVisible(false);
    const nativeParent = addonPath ? require(resolve(addonPath)) : null;
    const roleId = "direct-view-role";
    let attachments = null;
    let attachmentFailure = null;
    let viewOwner = null;
    if (nativeParent) {
      const binding = { parent: host, nativeGeneration: 1, revision: "1",
        children: () => host.contentView.children,
        contentsFocused: target => target.webContents.isFocused(),
        read: () => {
          const parent = nativeParent.readWindowsRuntimeForeground(host.getNativeWindowHandle());
          return { parentIdentity: parent.parentIdentity, focusIdentity: parent.focusIdentity,
            parentForeground: parent.parentWasForeground, parentVisible: parent.parentVisible,
            parentMinimized: parent.parentMinimized,
            focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null };
        },
        subscribe: listener => {
          const changed = () => listener("changed");
          const closed = () => listener("closed");
          const events = ["focus", "blur", "show", "hide", "resize"];
          for (const event of events) host.on(event, changed);
          host.on("closed", closed);
          return () => {
            for (const event of events) host.removeListener(event, changed);
            host.removeListener("closed", closed);
          };
        }
      };
      attachments = new ChromiumViewAttachmentCoordinator({
        resolveParent: parent => parent === host ? binding : null,
        nowMs: Date.now, onError: error => { attachmentFailure = error; }
      });
      host.contentView.removeChildView(view);
      await attachments.attach({ roleId, generation: 1, parent: host, view,
        isCancelled: () => false, attach: () => host.contentView.addChildView(view),
        attachTo: parent => parent.contentView.addChildView(view),
        detach: () => host.contentView.removeChildView(view) });
      const trustedHosts = new ChromiumViewTrustedInputHost({ attachments,
        focus: () => Promise.reject(new Error("The isolated probe has no Core focus-admission lane.")) });
      const bindingOwner = trustedHosts.resolve(roleId, 1);
      if (!bindingOwner) throw new Error("The direct View attachment did not establish input ownership.");
      viewOwner = {
        key: request => bindingOwner.native.submitNativeBackgroundKey(bindingOwner.identity, request),
        click: request => bindingOwner.native.submitNativeBackgroundMouse(bindingOwner.identity, request)
      };
    }
    let directVisible = false;
    let backgroundParent = false;
    const inputFence = requestId => ({ roleId,
      surfaceGeneration: 1, requestId: `${backgroundParent ? "background-" : ""}${directVisible ? "visible" : "hidden"}-${requestId}`, inputEpoch: "1", deadlineMs: String(Date.now() + 3000),
      deliveryMode: directVisible ? "foreground" : "background" });
    const directSamples = [
      ["direct-hidden-sibling-key", ["keydown", "keyup"], () => {
        const request = { code: "KeyB", ctrl: true, alt: false, shift: true, meta: false, repeat: false };
        return [
          viewOwner ? viewOwner.key({ ...inputFence("direct-key-down"), ...request, eventType: "keyDown" })
            : sendChromiumKey(view.webContents, { ...request, eventType: "keyDown" }),
          viewOwner ? viewOwner.key({ ...inputFence("direct-key-up"), ...request, eventType: "keyUp" })
            : sendChromiumKey(view.webContents, { ...request, eventType: "keyUp" })
        ];
      }],
      ["direct-hidden-sibling-middle", ["mousedown", "mouseup"], () => {
        const request = { clientX: 80, clientY: 96, zoomFactor: 1.25, button: 1 };
        return viewOwner ? viewOwner.click({ ...inputFence("direct-middle"), ...request })
          : sendChromiumClick(view.webContents, request, view.getBounds());
      }]
    ];
    for (const scenario of [
      { visible: false, background: false }, { visible: true, background: false },
      { visible: false, background: true }, { visible: true, background: true }
    ]) {
      const { visible, background } = scenario;
      if (background && !backgroundParent) await focus(other, { webContents: other.webContents });
      backgroundParent = background;
      directVisible = visible;
      if (visible) sibling.setBounds({ x: 350, y: 36, width: 250, height: 200 });
      view.setVisible(visible);
      for (const [name, types, submit] of directSamples) {
        const siblingFocusedBefore = sibling.webContents.isFocused();
        const foregroundContentsBefore = webContents.getFocusedWebContents()?.id ?? null;
        let sampleName = directVisible ? name.replace("hidden", "visible") : name;
        if (backgroundParent) sampleName = sampleName.replace("direct-", "direct-background-");
        const outcome = await sample(view, host, sampleName, [], types, submit);
        outcomes.push({ ...outcome, directHost: {
          nativeParentOwner: viewOwner !== null, backgroundParent,
          foregroundContentsBefore,
          foregroundContentsAfter: webContents.getFocusedWebContents()?.id ?? null,
          otherContentsId: other.webContents.id,
          children: host.contentView.children.length,
          isolatedSessions: view.webContents.session !== sibling.webContents.session,
          zoomFactor: view.webContents.getZoomFactor(), viewportAcknowledgement,
          targetAttached: host.contentView.children.includes(view),
          siblingAttached: host.contentView.children.includes(sibling),
          targetVisible: view.getVisible(), siblingFocusedBefore,
          siblingFocusedAfter: sibling.webContents.isFocused()
        } });
      }
    }
    if (attachmentFailure) throw attachmentFailure;
    if (attachments) {
      await attachments.retire(roleId, 1, host);
      if (attachments.resolve(roleId, 1) !== null) throw new Error("Retired View retained input ownership.");
      await attachments.dispose();
    }
    host.contentView.removeChildView(sibling);
    sibling.webContents.close();
    view.setVisible(true);
    view.webContents.setZoomFactor(1);
    await focus(other, { webContents: other.webContents });
    outcomes.push(await sample(view, host, "background-host", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "background-host-middle", middleButton, ["mousedown", "mouseup"]));
    host.hide();
    outcomes.push(await sample(view, host, "hidden-host", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "hidden-host-middle", middleButton, ["mousedown", "mouseup"]));
    await writeFile(reportPath, JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome,
      scope: "isolated WebContentsView API probe; not a Role/native-adapter receipt", outcomes
    }, null, 2) + "\n");
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome,
      scope: "isolated WebContentsView API probe; not a Role/native-adapter receipt",
      status: "failed", error: error instanceof Error ? error.stack : String(error), outcomes
    }, null, 2) + "\n");
    throw error;
  } finally {
    const siblingContents = sibling.webContents;
    if (siblingContents && !siblingContents.isDestroyed()) siblingContents.close();
    view.webContents.close();
    host.destroy();
    other.destroy();
  }
}

app.whenReady().then(probe).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
