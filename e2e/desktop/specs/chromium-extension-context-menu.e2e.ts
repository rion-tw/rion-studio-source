import { $, browser } from '@wdio/globals';
import { verifyGenericExtensionContextMenu } from '../support/extensions-context-menu';
import { rendererCall } from '../support/renderer-bridge';
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, waitForRoute } from '../support/ui';
import { electronDesktopE2eProbe } from '../support/electron-driver';
import { selectMacosVisibleRuntimeTabMenuAction } from '../support/macos-appkit-ui';
import { closeVisibleRuntimeTab } from '../support/native-runtime-tabs';

// [journey:CHROMIUM-MACOS-APPKIT-EXTENSION-CONTEXT-MENU-001]
// [journey:CHROMIUM-WINDOWS-EXTENSION-CONTEXT-MENU-001]
describe('Generic extension native context menu', () => {
  it('delivers a visible native menu click only to its managed Role', async () => {
    await ensureEnglishUi(); await acceptLegalAndSkipFirstRun();
    const main = await browser.getWindowHandle();
    const url = `${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/context-menu?nativeContextMenu=1`;
    const games = await rendererCall('listGames');
    // Role creation is setup; opening and the feature actions use visible UI.
    const role = await rendererCall('createRole', { gameId: games[0].id, name: 'Context menu Role', launchUrl: url });
    await $('.app-main-sidebar').$('button*=Roles').click(); await waitForRoute('/roles');
    await $(`[data-selection-id='${role.id}']`).moveTo();
    await $(`[data-selection-id='${role.id}']`).$("button[aria-label='Open']").click();
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => (await rendererCall('listRoleStatuses')).some(status =>
      status.roleId === role.id && status.state === 'running'), { timeout: 30_000 });
    const tab = (await rendererCall('getEmbeddedRuntimeState')).tabs.find(candidate => candidate.sourceId === role.id);
    if (!tab) throw new Error('Context menu Role has no native tab');
    await verifyGenericExtensionContextMenu({ roleId: role.id, windowId: tab.windowId, url, main });
    const { platform } = await electronDesktopE2eProbe();
    if (platform === 'macos') await selectMacosVisibleRuntimeTabMenuAction({
      action: 'stop', tabId: tab.id, tabName: role.name, windowId: tab.windowId
    });
    else await closeVisibleRuntimeTab({ mainWindowHandle: main, platform: 'windows', tabId: tab.id, tabName: role.name, windowId: tab.windowId });
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => !(await rendererCall('listRoleStatuses')).some(status => status.roleId === role.id), { timeout: 30_000 });
  });
});
