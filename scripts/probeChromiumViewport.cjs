// Isolated compatibility experiment; never imported by a product entry.
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const [reportPath, userData, throttling] = process.argv.slice(2);
const backgroundThrottling = throttling === "true";
if (!reportPath || !userData || !["true", "false"].includes(throttling) || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Bundled Electron viewport probe requires native report and isolated data paths.");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
const documentState = view => view.webContents.executeJavaScript(`({
  width: innerWidth, height: innerHeight, focused: document.hasFocus(), visibility: document.visibilityState
})`);

async function armViewport(view, expected) {
  await view.webContents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(expected)};
    window.viewportReceipt = new Promise(resolve => {
      let deadline;
      const finish = status => {
        clearTimeout(deadline); removeEventListener("resize", inspect);
        resolve({ status, width: innerWidth, height: innerHeight, visibility: document.visibilityState });
      };
      const inspect = () => {
        if (expected ? innerWidth === expected.width && innerHeight === expected.height
          : innerWidth !== 600 || innerHeight !== 400) finish("applied");
      };
      addEventListener("resize", inspect);
      // Test-only external renderer acknowledgement; expiry remains indeterminate.
      deadline = setTimeout(() => finish("indeterminate"), 3000);
      if (expected) inspect();
    });
  })()`);
  return expected;
}
const receipt = view => view.webContents.executeJavaScript("window.viewportReceipt");

async function probe() {
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling };
  const host = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: preferences });
  const target = new WebContentsView({ webPreferences: { ...preferences, session: session.fromPartition("viewport-target") } });
  const sibling = new WebContentsView({ webPreferences: { ...preferences, session: session.fromPartition("viewport-sibling") } });
  const outcomes = [];
  const nativeState = () => ({ hostFocused: host.isFocused(), hostVisible: host.isVisible(),
    targetVisible: target.getVisible(), targetFocused: target.webContents.isFocused(),
    siblingVisible: sibling.getVisible(), siblingFocused: sibling.webContents.isFocused(),
    targetAttached: host.contentView.children.includes(target), siblingAttached: host.contentView.children.includes(sibling) });
  try {
    host.contentView.addChildView(target);
    target.setBounds({ x: 20, y: 30, width: 600, height: 400 });
    await target.webContents.loadURL("data:text/html,<body>isolated target viewport</body>");
    await new Promise(ready => { host.once("focus", ready); host.show(); host.focus(); });
    target.webContents.focus();
    host.contentView.addChildView(sibling);
    sibling.setBounds({ x: 20, y: 30, width: 600, height: 400 });
    sibling.setVisible(false);
    await sibling.webContents.loadURL("data:text/html,<body>isolated sibling viewport</body>");
    for (const [mode, factor] of [["hidden", 1.25], ["occluded", 1.5]]) {
      sibling.setVisible(false); target.setVisible(true); target.webContents.focus();
      const base = { width: 600, height: 400 };
      await armViewport(target, base); target.webContents.setZoomFactor(1);
      if ((await receipt(target)).status !== "applied") throw new Error("Visible baseline failed.");
      // Calibrate against the renderer, including its actual pixel rounding.
      await armViewport(target, null); target.webContents.setZoomFactor(factor);
      const calibration = await receipt(target);
      if (calibration.status !== "applied" || target.webContents.getZoomFactor() !== factor) {
        throw new Error(`Visible zoom calibration failed: ${JSON.stringify(calibration)}`);
      }
      const expected = { width: calibration.width, height: calibration.height };
      await armViewport(target, base); target.webContents.setZoomFactor(1);
      const baseline = await receipt(target);
      if (baseline.status !== "applied") throw new Error("Visible zoom reset failed.");
      sibling.setVisible(true); sibling.webContents.focus();
      target.setVisible(mode !== "hidden");
      const before = { native: nativeState(), document: await documentState(target) };
      await armViewport(target, expected);
      target.webContents.setZoomFactor(factor);
      // One ordered renderer response, without waiting for resize or a timer.
      const immediateReadback = await documentState(target);
      const whileCovered = await receipt(target);
      const after = { native: nativeState(), document: await documentState(target), browserZoom: target.webContents.getZoomFactor() };
      await armViewport(target, expected);
      sibling.setVisible(false); target.setVisible(true); target.webContents.focus();
      const revealed = await receipt(target);
      outcomes.push({ mode, factor, expected, calibration, baseline, before, immediateReadback, whileCovered, after, revealed });
    }
    return { platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome,
      scope: "isolated View viewport observation; not product zoom completion", backgroundThrottling,
      isolatedSessions: target.webContents.session !== sibling.webContents.session, outcomes };
  } finally {
    target.webContents.close(); sibling.webContents.close(); host.destroy();
  }
}
app.whenReady().then(probe).then(async report => {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n"); app.quit();
}).catch(async error => {
  await writeFile(reportPath, JSON.stringify({ status: "failed", error: String(error) }) + "\n"); app.exit(1);
});
