// Fresh-process fixture for Chromium profile compatibility; never opens live data.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');

app.setPath('userData', process.env.RION_DOWNGRADE_USER_DATA);
app.whenReady().then(async () => {
  const store = session.fromPath(path.join(process.env.RION_DOWNGRADE_USER_DATA, 'role'));
  const origin = process.env.RION_DOWNGRADE_ORIGIN;
  const seed = process.env.RION_DOWNGRADE_PHASE === 'seed';
  assert.equal(process.versions.electron, seed ? '44.3.0' : '43.7.0');
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: store, sandbox: true, contextIsolation: true, nodeIntegration: false
  } });
  await window.loadURL(origin);
  if (seed) await store.cookies.set({ url: origin, name: 'downgrade', value: 'preserved',
    expirationDate: Math.floor(Date.now() / 1000) + 86400 });
  const page = await window.webContents.executeJavaScript(`(async () => {
    const seed = ${seed};
    if (seed) localStorage.setItem('downgrade', 'preserved');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('downgrade', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (seed) await new Promise((resolve, reject) => {
      const tx = db.transaction('values', 'readwrite');
      tx.objectStore('values').put('preserved', 'marker');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const indexed = await new Promise((resolve, reject) => {
      const request = db.transaction('values').objectStore('values').get('marker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { local: localStorage.getItem('downgrade'), indexed };
  })()`);
  assert.deepEqual(page, { local: 'preserved', indexed: 'preserved' });
  assert.equal((await store.cookies.get({ url: origin, name: 'downgrade' }))[0]?.value,
    'preserved');
  const extension = await store.extensions.loadExtension(process.env.RION_DOWNGRADE_EXTENSION);
  await window.loadURL(`chrome-extension://${extension.id}/probe.html`);
  const extensionValue = await window.webContents.executeJavaScript(`(async () => {
    if (${seed}) await chrome.storage.local.set({ downgrade: 'preserved' });
    return (await chrome.storage.local.get('downgrade')).downgrade;
  })()`);
  assert.equal(extensionValue, 'preserved');
  await store.cookies.flushStore();
  store.flushStorageData();
  console.log(JSON.stringify({ phase: process.env.RION_DOWNGRADE_PHASE,
    versions: process.versions, page, cookie: 'preserved', extension: extensionValue }));
  // Clean process termination followed by a fresh reader establishes persistence.
  window.destroy();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
