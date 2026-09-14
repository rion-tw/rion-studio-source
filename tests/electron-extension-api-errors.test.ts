import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { ExtensionRouter } from '../third_party/electron-chrome-extensions/src/browser/router';
import { ExtensionApiError } from '../third_party/electron-chrome-extensions/src/browser/api-error';

describe.each(['darwin', 'win32'])('expected extension API errors (%s)', () => {
  it('returns expected API failures without rejecting IPC, but retains faults and permission rejection', async () => {
    const extension = { id: 'a'.repeat(32), manifest: { permissions: ['contextMenus'] } };
    const session = {
      extensions: Object.assign(new EventEmitter(), { getExtension: () => extension }),
      serviceWorkers: new EventEmitter()
    };
    const router = new ExtensionRouter(session as never, { addObserver: vi.fn() } as never);
    const event = { type: 'service-worker', session, serviceWorker: {} };
    const handle = router.apiHandler();
    handle('contextMenus.create', () => { throw new ExtensionApiError('RION_CONTEXT_MENU_DUPLICATE_ID'); }, { permission: 'contextMenus' });
    await expect(router.onExtensionMessage(event as never, extension.id, 'contextMenus.create')).resolves.toEqual({
      rionExtensionApiError: 'RION_CONTEXT_MENU_DUPLICATE_ID'
    });
    handle('contextMenus.update', () => { throw new Error('unexpected host failure'); });
    await expect(router.onExtensionMessage(event as never, extension.id, 'contextMenus.update')).rejects.toThrow('unexpected host failure');
    extension.manifest.permissions = [];
    await expect(router.onExtensionMessage(event as never, extension.id, 'contextMenus.create')).rejects.toThrow('permissions');
    await expect(router.onExtensionMessage({ ...event, session: {} } as never, extension.id, 'contextMenus.create')).rejects.toThrow('remote session');
  });
});
