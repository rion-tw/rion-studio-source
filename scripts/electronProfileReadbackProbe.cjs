// Reads only a stopped profile's disposable copy through bundled Chromium APIs.
const { app, BrowserWindow, session } = require('electron');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.env.RION_PROFILE_COPY_ROOT);
app.whenReady().then(async () => {
  const store = session.fromPath(path.join(process.env.RION_PROFILE_COPY_ROOT, 'role'));
  // An inert document reads the origin's storage without running the real site's code.
  store.protocol.handle('https', () => new Response('<title>Offline profile readback</title>', {
    headers: { 'content-type': 'text/html' }
  }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: store, sandbox: true, contextIsolation: true, nodeIntegration: false
  } });
  await window.loadURL(process.env.RION_PROFILE_COPY_ORIGIN);
  const data = await window.webContents.executeJavaScript(`(async () => {
    const local = Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
    const indexed = [];
    for (const info of (await indexedDB.databases()).sort((a, b) => a.name.localeCompare(b.name))) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(info.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores = [];
      for (const name of Array.from(db.objectStoreNames).sort()) {
        const entries = await new Promise((resolve, reject) => {
          const values = [];
          const request = db.transaction(name).objectStore(name).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve(values);
            values.push([cursor.key, cursor.value]); cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
        stores.push({ name, entries });
      }
      indexed.push({ name: info.name, version: db.version, stores }); db.close();
    }
    return { local, indexed };
  })()`);
  const cookies = (await store.cookies.get({})).sort((a, b) =>
    `${a.domain}/${a.path}/${a.name}`.localeCompare(`${b.domain}/${b.path}/${b.name}`));
  const digest = createHash('sha256').update(JSON.stringify({ cookies, ...data })).digest('hex');
  const proof = { digest, cookies: cookies.length, localKeys: Object.keys(data.local).length,
    databases: data.indexed.length };
  writeFileSync(process.env.RION_PROFILE_COPY_RESULT, JSON.stringify(proof));
  console.log(JSON.stringify({ electron: process.versions.electron, ...proof }));
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
