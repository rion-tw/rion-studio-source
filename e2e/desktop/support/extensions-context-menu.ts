import { $, browser, expect } from '@wdio/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runEncodedPowerShellJson } from '../../../scripts/encodedPowerShell.mjs';
import { electronDesktopE2eProbe } from './electron-driver';
import { clickMacosVisibleRoleControl } from './macos-appkit-ui';
import { readVisibleElectronCanvasPoint, withRolePageTarget } from './electron-role-surface';

const LABEL = 'Rion generic extension menu';

export async function verifyGenericExtensionContextMenu(input: {
  roleId: string; windowId: string; url: string; main: string;
}): Promise<void> {
  const directory = join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, 'context-menu-fixture');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Generic context menu fixture', version: '1.0',
    background: { service_worker: 'background.js' },
    permissions: ['contextMenus', 'storage', 'scripting', 'tabs'],
    host_permissions: [`${new URL(input.url).origin}/*`]
  }));
  await writeFile(join(directory, 'background.js'), `
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      void chrome.storage.local.set({ clicked: { menuItemId: info.menuItemId, frameId: info.frameId, tabId: tab.id } });
    });
    void (async () => {
      await chrome.contextMenus.removeAll();
      await new Promise(resolve => chrome.contextMenus.create({ id: 'generic-menu', title: ${JSON.stringify(LABEL)}, contexts: ['all'] }, resolve));
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) if (tab.url === ${JSON.stringify(input.url)}) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }
    })();
  `);
  await writeFile(join(directory, 'content.js'), `
    document.body.dataset.extensionMenuReady = 'true';
    chrome.storage.onChanged.addListener(changes => {
      if (changes.clicked) document.body.dataset.extensionMenuClick = JSON.stringify(changes.clicked.newValue);
    });
  `);
  // Deterministic precondition only: the production host already belongs to the
  // visibly opened Role. The primary actions below are real native menu input.
  const fixture = await browser.electron.execute(async (electron, url, path) => {
    const matches = electron.webContents.getAllWebContents().filter(w => w.getURL() === url);
    if (matches.length !== 1) throw new Error('Exact fixture Role content missing');
    const content = matches[0];
    const extension = await content.session.extensions.loadExtension(path);
    return { contentId: content.id, extensionId: extension.id };
  }, input.url, directory);
  try {
    await browser.waitUntil(async () => browser.electron.execute(async (electron, id) => {
      return electron.webContents.fromId(id)?.executeJavaScript("document.body.dataset.extensionMenuReady === 'true'");
    }, fixture.contentId), { timeout: 45_000, timeoutMsg: 'Generic context menu fixture did not initialize' });
    const probe = await electronDesktopE2eProbe();
    for (const cancel of [true, false]) {
    if (probe.platform === 'macos') {
      const point = await readVisibleElectronCanvasPoint(input.url, input.main);
      await clickMacosVisibleRoleControl(input.windowId, input.roleId, point, 'role', 'right');
      await promisify(execFile)('/usr/bin/xcrun', ['swift', resolve(import.meta.dirname, 'macos-appkit-menu.swift'), JSON.stringify({
        processId: probe.processId, cancel, actionLabels: [LABEL], hideLabels: [LABEL], moveToNewWindowLabels: [LABEL]
      })], { timeout: 15_000 });
    } else {
      await withRolePageTarget(input.url, input.main, async () => { await $('body').click({ button: 2 }); }, false);
      await runEncodedPowerShellJson(String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$payload.processId)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$payload.label))
)
$items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
if ($items.Count -ne 1 -or $items[0].Current.IsOffscreen -or -not $items[0].Current.IsEnabled) { throw 'Exact visible extension menu item missing' }
if ($payload.cancel) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionMenuForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
  [uint32]$owner = 0
  [void][RionMenuForeground]::GetWindowThreadProcessId([RionMenuForeground]::GetForegroundWindow(), [ref]$owner)
  if ($owner -ne $payload.processId) { throw 'Extension menu lost foreground ownership' }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $remaining = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  }
  if ($remaining.Count -ne 0) { throw 'Extension menu did not dismiss' }
} else {
  $invoke = $items[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
}
@{ completed = $true } | ConvertTo-Json -Compress
`, { processId: probe.processId, label: LABEL, cancel }, { timeoutMilliseconds: 15_000 });
    }
    await browser.switchToWindow(input.main);
    if (cancel) {
      expect(await browser.electron.execute(async (electron, id) =>
        electron.webContents.fromId(id)?.executeJavaScript('document.body.dataset.extensionMenuClick ?? null'), fixture.contentId)).toBeNull();
    }
    }
    let clicked: { menuItemId: string; frameId: number; tabId: number } | null = null;
    await browser.waitUntil(async () => {
      clicked = await browser.electron.execute(async (electron, id) => {
        return electron.webContents.fromId(id)?.executeJavaScript('JSON.parse(document.body.dataset.extensionMenuClick || "null")');
      }, fixture.contentId);
      return clicked !== null;
    }, { timeout: 10_000, timeoutMsg: 'Native menu click was not delivered to the extension worker' });
    expect(clicked).toEqual({ menuItemId: 'generic-menu', frameId: 0, tabId: fixture.contentId });
  } finally {
    await browser.electron.execute(async (electron, id, extensionId) => {
      const content = electron.webContents.fromId(id);
      if (!content) return;
      const native = content.session.extensions;
      await new Promise<void>(resolve => {
        const listener = (_event: unknown, extension: { id: string }) => {
          if (extension.id !== extensionId) return;
          native.removeListener('extension-unloaded', listener); resolve();
        };
        native.on('extension-unloaded', listener); native.removeExtension(extensionId);
      });
    }, fixture.contentId, fixture.extensionId);
  }
}
