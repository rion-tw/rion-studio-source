const { app, BrowserWindow, WebContentsView } = require("electron");

app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: true });
  // Give ChromeDriver a real top-level target before attaching the child page.
  await host.loadURL("data:,host");
  const view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    disableHtmlFullscreenWindowResize: true
  } });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  await view.webContents.loadURL("data:text/html," + encodeURIComponent(
    '<!doctype html><title>Chromium Escape Fixture</title><body>' +
    '<button id="enter" onclick="document.body.requestFullscreen()">Enter fullscreen</button></body>'
  ));
  host.focus();
  view.webContents.focus();
}).catch(error => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
