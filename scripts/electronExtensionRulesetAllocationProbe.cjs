// Standalone native DNR regression: no Rion preload, AdBlock code, or user profile.
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { app, session } = require('electron');

const root = process.env.RION_DNR_ALLOCATION_PROBE_ROOT;
const phase = process.env.RION_DNR_ALLOCATION_PROBE_PHASE;
if (!root || !isAbsolute(root) || !['seed', 'restart'].includes(phase)) {
  throw new Error('The DNR allocation probe requires an isolated absolute root and phase.');
}
app.setPath('userData', join(root, 'app'));
app.on('window-all-closed', () => undefined);
const deadline = setTimeout(() => {
  console.error('DNR allocation probe did not receive a worker result.');
  app.exit(1);
}, 20_000);

void app.whenReady().then(async () => {
  const extensionPath = join(root, 'extension');
  if (phase === 'seed') {
    mkdirSync(extensionPath, { recursive: true });
    writeFileSync(join(extensionPath, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'DNR allocation regression', version: '1.0',
      permissions: ['declarativeNetRequest', 'storage'],
      background: { service_worker: 'background.js' },
      declarative_net_request: { rule_resources: [
        { id: 'large', path: 'large.json', enabled: true },
        { id: 'small', path: 'small.json', enabled: true }
      ] }
    }));
    for (const [name, count] of [['large', 31000], ['small', 1]]) {
      writeFileSync(join(extensionPath, `${name}.json`), JSON.stringify(Array.from({ length: count }, (_, index) => ({
        id: index + 1, action: { type: 'block' },
        condition: { urlFilter: `||example${index}.invalid^`, resourceTypes: ['xmlhttprequest'] }
      }))));
    }
    writeFileSync(join(extensionPath, 'background.js'), `
      void (async () => {
        const dnr = chrome.declarativeNetRequest;
        const seeded = (await chrome.storage.local.get('seeded')).seeded === true;
        await dnr.updateEnabledRulesets({ enableRulesetIds: ['large', 'small'] });
        const result = { phase: seeded ? 'restart' : 'seed', before: await dnr.getEnabledRulesets(),
          availableBefore: await dnr.getAvailableStaticRuleCount() };
        if (seeded) {
          try { await dnr.updateEnabledRulesets({ disableRulesetIds: ['small'] }); }
          catch (error) { result.error = error.message; }
        }
        await chrome.storage.local.set({ seeded: true });
        result.after = await dnr.getEnabledRulesets();
        result.availableAfter = await dnr.getAvailableStaticRuleCount();
        console.log('RION_DNR_ALLOCATION=' + JSON.stringify(result));
      })().catch(error => console.error(String(error)));
    `);
  }
  const rolePath = join(root, 'role');
  mkdirSync(join(rolePath, 'Shared Dictionary', 'cache'), { recursive: true });
  const nativeSession = session.fromPath(rolePath);
  nativeSession.serviceWorkers.on('console-message', (_event, details) => {
    if (!details.message.startsWith('RION_DNR_ALLOCATION=')) return;
    clearTimeout(deadline);
    const result = JSON.parse(details.message.slice('RION_DNR_ALLOCATION='.length));
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, ...result }));
    try {
      assert.equal(result.phase, phase);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.after, phase === 'seed' ? ['large', 'small'] : ['large']);
      app.quit();
    } catch (error) {
      console.error(error.message);
      app.exit(1);
    }
  });
  await nativeSession.extensions.loadExtension(extensionPath);
}).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1); });
