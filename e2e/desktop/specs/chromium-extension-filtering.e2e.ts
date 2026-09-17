import { $, browser, expect } from '@wdio/globals';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rendererCall } from '../support/renderer-bridge';
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, waitForRoute } from '../support/ui';
import { electronDesktopE2eProbe } from '../support/electron-driver';
import { clickMacosVisibleRoleControl, selectMacosVisibleRuntimeTabMenuAction } from '../support/macos-appkit-ui';
import { readVisibleElectronPageElementPoint, withRolePageTarget } from '../support/electron-role-surface';
import { closeVisibleRuntimeTab } from '../support/native-runtime-tabs';

// [journey:CHROMIUM-MACOS-APPKIT-EXTENSION-FILTERING-001]
// [journey:CHROMIUM-WINDOWS-EXTENSION-FILTERING-001]
describe('Native extension filtering in a managed Role', () => {
  it('blocks a request after visible input, hides matched content and preserves an unassigned Role', async () => {
    await ensureEnglishUi(); await acceptLegalAndSkipFirstRun();
    const main = await browser.getWindowHandle();
    const { platform } = await electronDesktopE2eProbe();
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(request.url!);
      response.setHeader('Cache-Control', 'no-store');
      if (request.url!.split('?')[0] !== '/') { response.end('fixture'); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><body><button id="run">Run filtering check</button>
        <div id="ad">Advertisement fixture</div><div id="normal">Normal content</div><pre id="result"></pre>
        <script>document.querySelector('#run').onclick = async event => {
          const request = async path => { try { return (await fetch(path)).ok; } catch { return false; } };
          const result = { trusted: event.isTrusted, allowed: await request('/allowed'),
            blocked: await request('/blocked'), hidden: getComputedStyle(document.querySelector('#ad')).display === 'none' };
          document.querySelector('#result').textContent = JSON.stringify(result);
        };</script></body>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server missing');
    const url = `http://127.0.0.1:${address.port}/`;
    const directory = join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, 'filtering-fixture');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Generic module filtering fixture', version: '1.0',
      background: { service_worker: 'background.js', type: 'module' },
      permissions: ['declarativeNetRequest', 'scripting', 'storage', 'alarms'], host_permissions: [`${url}*`],
      declarative_net_request: { rule_resources: [{ id: 'rules', path: 'rules.json', enabled: true }] }
    }));
    await writeFile(join(directory, 'dependency.js'), `
      export const api = self.browser || self.chrome;
      api.permissions.onRemoved.addListener(() => {});
      api.commands.onCommand.addListener(() => {});
      api.alarms.onAlarm.addListener(() => {});
    `);
    await writeFile(join(directory, 'background.js'), `
      import { api } from './dependency.js';
      api.permissions.onAdded.addListener(() => {});
      void (async () => {
        await api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
        await api.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['rules'] });
        for (const tab of await api.tabs.query({})) {
          await api.scripting.insertCSS({ target: { tabId: tab.id }, css: '#ad { display:none !important }' });
        }
        console.log('RION_FILTERING_FIXTURE_READY');
      })();
    `);
    await writeFile(join(directory, 'rules.json'), JSON.stringify([
      { id: 1, action: { type: 'block' }, condition: { urlFilter: '/blocked' } }
    ]));
    const games = await rendererCall('listGames');
    const filtered = await rendererCall('createRole', { gameId: games[0].id, name: 'Filtered Role', launchUrl: url });
    const unassigned = await rendererCall('createRole', { gameId: games[0].id, name: 'Unassigned Role', launchUrl: url });
    try {
      for (const enabled of [true, false, true]) {
        const role = enabled ? filtered : unassigned;
        await $('.app-main-sidebar').$('button*=Roles').click(); await waitForRoute('/roles');
        await $(`[data-selection-id='${role.id}']`).moveTo();
        await $(`[data-selection-id='${role.id}']`).$("button[aria-label='Open']").click();
        await browser.switchToWindow(main);
        await browser.waitUntil(async () => (await rendererCall('listRoleStatuses')).some(status =>
          status.roleId === role.id && status.state === 'running'), { timeout: 30_000 });
        const tab = (await rendererCall('getEmbeddedRuntimeState')).tabs.find(candidate => candidate.sourceId === role.id);
        if (!tab) throw new Error('Filtering Role tab missing');
        if (enabled) {
          // Deterministic package precondition; the action being tested is the visible page button.
          await browser.electron.execute(async (electron, exactUrl, path) => {
            const matches = electron.webContents.getAllWebContents().filter(w => w.getURL() === exactUrl);
            if (matches.length !== 1) throw new Error('Exact filtering Role missing');
            const session = matches[0].session;
            const ready = new Promise<void>((resolve, reject) => {
              const listener = (_event: unknown, details: { message: string; source: string; level: number }) => {
                if (details.message === 'RION_FILTERING_FIXTURE_READY') { session.serviceWorkers.removeListener('console-message', listener); resolve(); }
                else if (details.source === 'javascript' && details.level === 3) { session.serviceWorkers.removeListener('console-message', listener); reject(new Error(details.message)); }
              };
              session.serviceWorkers.on('console-message', listener);
            });
            await session.extensions.loadExtension(path); await ready;
          }, url, directory);
        }
        const before = received.length;
        if (platform === 'macos') await clickMacosVisibleRoleControl(tab.windowId, role.id,
          await readVisibleElectronPageElementPoint(url, main, '#run'));
        else await withRolePageTarget(url, main, async () => { await $('#run').click(); }, false);
        const result = await withRolePageTarget(url, main, async () => {
          await browser.waitUntil(async () => (await $('#result').getText()).length > 0, { timeout: 10_000 });
          return JSON.parse(await $('#result').getText());
        });
        expect(result).toEqual({ trusted: true, allowed: true, blocked: !enabled, hidden: enabled });
        expect(received.slice(before).includes('/blocked')).toBe(!enabled);
        expect(received.slice(before).includes('/allowed')).toBe(true);
        await browser.switchToWindow(main);
        await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, 'screenshots', `filtering-${enabled}.png`));
        if (platform === 'macos') await selectMacosVisibleRuntimeTabMenuAction({
          action: 'stop', tabId: tab.id, tabName: role.name, windowId: tab.windowId });
        else await closeVisibleRuntimeTab({ mainWindowHandle: main, platform: 'windows', tabId: tab.id, tabName: role.name, windowId: tab.windowId });
        await browser.switchToWindow(main);
        await browser.waitUntil(async () => !(await rendererCall('listRoleStatuses')).some(status => status.roleId === role.id), { timeout: 30_000 });
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
