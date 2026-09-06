// Native integration probe only. No debugger transport or production permission changes.
const { app, BrowserWindow, session } = require("electron");
const { writeFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const reportPath = process.argv[2];
const userData = process.argv[3];
if (!reportPath || !userData || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Use the bundled Electron: probeChromiumLocalFonts.cjs REPORT_PATH ISOLATED_USER_DATA");
}
const root = resolve(__dirname, "..");
const fixture = join(root, "tests", "fixtures", "chromium-local-fonts", "main.html");
const untrustedFixture = join(root, "tests", "fixtures", "chromium-local-fonts", "untrusted.html");
const trustedUrl = pathToFileURL(fixture).href;
app.setPath("userData", resolve(userData, "electron"));
app.on("window-all-closed", () => {});
const query = `(async () => {
  const context = { secure: isSecureContext, visibility: document.visibilityState,
    focus: document.hasFocus(), activation: navigator.userActivation.isActive,
    available: typeof queryLocalFonts };
  try {
    const fonts = await queryLocalFonts();
    return { ...context, faces: fonts.length,
      families: [...new Set(fonts.map(font => font.family))].sort() };
  } catch (error) { return { ...context, error: error.name, families: [] }; }
})()`;

async function probe() {
  const ses = session.fromPartition("local-fonts-compatibility-probe");
  let owner;
  let grant = true;
  const permissionChecks = [];
  const allowed = (contents, permission, details) =>
    grant && permission === "local-fonts" && contents === owner?.webContents &&
    !owner.isDestroyed() && !contents.isDestroyed() &&
    contents.getURL() === trustedUrl && details?.isMainFrame === true &&
    details.requestingUrl === trustedUrl;
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const admitted = allowed(contents, permission, details);
    if (permission === "local-fonts") {
      permissionChecks.push({ admitted, isMainFrame: details.isMainFrame,
        requestingUrl: details.requestingUrl });
    }
    return admitted;
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed(contents, permission, details));
  });
  const options = { show: false, webPreferences: { session: ses,
    sandbox: true, contextIsolation: true, nodeIntegration: false } };
  owner = new BrowserWindow(options);
  const outcomes = {};
  let other;
  let core;
  try {
    await owner.loadFile(fixture);
    outcomes.automatic = await owner.webContents.executeJavaScript(query, false);
    const child = owner.webContents.mainFrame.frames[0];
    if (!child) throw new Error("The subframe security probe was not created.");
    outcomes.subframe = await child.executeJavaScript(query, false);
    owner.show();
    owner.focus();
    outcomes.shown = await owner.webContents.executeJavaScript(query, false);
    grant = false;
    outcomes.denied = await owner.webContents.executeJavaScript(query, false);
    grant = true;
    await owner.loadFile(untrustedFixture);
    outcomes.navigated = await owner.webContents.executeJavaScript(query, false);
    await owner.loadFile(fixture);
    outcomes.reload = await owner.webContents.executeJavaScript(query, false);
    other = new BrowserWindow(options);
    await other.loadFile(fixture);
    outcomes.otherOwner = await other.webContents.executeJavaScript(query, false);
    const addon = require(join(root, "build", "native",
      `${process.platform}-${process.arch}`, "rion-core.node"));
    core = await addon.createAppCore({ userDataDir: resolve(userData, "core"),
      platform: process.platform, appVersion: "23.0.0-font-probe",
      packaged: false, runtimeContractVersion: 23 });
    core.subscribeCoreEvents(() => {}, () => {});
    const native = JSON.parse(await core.invoke(JSON.stringify({ type: "systemFontsList" })));
    const nativeFamilies = native.map(font => font.family).sort();
    const chromiumFamilies = outcomes.automatic.families;
    const nativeSet = new Set(nativeFamilies);
    const chromiumSet = new Set(chromiumFamilies);
    await writeFile(reportPath, JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome,
      outcomes, permissionChecks, nativeFamilies,
      nativeOnly: nativeFamilies.filter(family => !chromiumSet.has(family)),
      chromiumOnly: chromiumFamilies.filter(family => !nativeSet.has(family))
    }, null, 2) + "\n");
  } finally {
    if (core) await core.shutdown();
    other?.destroy();
    owner.destroy();
  }
}

app.whenReady().then(probe).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
