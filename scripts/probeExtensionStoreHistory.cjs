// Isolated local SPA: pushState renders pages, but popstate deliberately leaves
// the old DOM in place. The real store's URLs and responses are never rewritten.
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const { navigateStoreHistory } = require(process.argv[4]);
app.setPath("userData", process.argv[3]);

async function probe() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<h1>${new URL(request.url, "http://fixture").pathname}</h1>
      <script>window.visit = path => { history.pushState({}, '', path);
        document.querySelector('h1').textContent = path.split('?')[0]; };</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const contents = window.webContents;
  const events = [];
  contents.on("did-start-navigation", (_event, url, same, main) => {
    if (main) events.push({ url, same });
  });
  const observations = [];
  const capture = async label => {
    const state = {
      label, url: contents.getURL(), index: contents.navigationHistory.getActiveIndex(),
      entries: contents.navigationHistory.getAllEntries().map(entry => entry.url),
      ...await contents.executeJavaScript("({ heading: document.querySelector('h1').textContent, document: performance.timeOrigin })")
    };
    observations.push(state);
    return state;
  };
  const navigate = async action => {
    const result = await navigateStoreHistory(contents, action, new AbortController().signal, () => true);
    assert.equal(result.phase, "completed");
    return capture(action);
  };
  try {
    await contents.loadURL(`${base}/category`);
    await contents.executeJavaScript("visit('/search?q=fixture&hl=en'); visit('/detail?id=fixture&hl=en')", true);
    const detail = await capture("detail");
    const reload = await navigate("reload");
    const back = await navigate("back");
    const forward = await navigate("forward");
    assert.equal(back.heading, "/search");
    assert.equal(forward.heading, "/detail");
    assert.equal(back.index, 1);
    assert.equal(forward.index, 2);
    assert.notEqual(detail.document, reload.document);
    assert.notEqual(reload.document, back.document);
    assert.notEqual(back.document, forward.document);
    for (const state of [reload, back, forward]) assert.deepEqual(state.entries, detail.entries);
    await contents.loadURL(`${base}/other`);
    const beforeFull = events.filter(event => !event.same).length;
    const fullBack = await navigate("back");
    assert.equal(fullBack.heading, "/detail");
    assert.equal(events.filter(event => !event.same).length - beforeFull, 1);
    writeFileSync(process.argv[2], JSON.stringify({ platform: process.platform, observations, events }, null, 2));
  } finally {
    window.destroy();
    server.close();
  }
}

app.whenReady().then(probe).then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
});
