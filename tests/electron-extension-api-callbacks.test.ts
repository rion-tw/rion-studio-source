import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const code = transformSync(readFileSync('third_party/electron-chrome-extensions/src/rion-preload.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node24'
}).code;
function fixture() {
  const ipc = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  const chrome = { runtime: { id: 'a'.repeat(32), getManifest: () => ({ manifest_version: 3 }) } } as unknown as typeof globalThis.chrome;
  runInNewContext(code, {
    require: () => ({ ipcRenderer: ipc }), process: { type: 'service-worker', contextIsolated: false },
    chrome, document: {}, console, queueMicrotask
  });
  return { chrome, ipc };
}

describe.each(['darwin', 'win32'])('extension API callback errors (%s)', () => {
  it('reports unsupported tab creation through lastError instead of successful undefined', async () => {
    const { chrome } = fixture();
    const result = await new Promise(resolve => chrome.tabs.create({ url: 'https://example.test' }, (tab: unknown) => {
      resolve({ tab, error: chrome.runtime.lastError?.message });
    }));
    expect(result).toEqual({ tab: undefined, error: 'RION_EXTENSION_API_UNAVAILABLE:tabs.create' });
    expect(chrome.runtime.lastError).toBeUndefined();
    await expect(chrome.tabs.create({})).rejects.toThrow('RION_EXTENSION_API_UNAVAILABLE:tabs.create');
  });

  it('delivers expected menu failures to callbacks and promises, preserving successful results', async () => {
    const { chrome, ipc } = fixture();
    ipc.invoke.mockResolvedValueOnce({ rionExtensionApiError: 'RION_CONTEXT_MENU_DUPLICATE_ID' });
    const error = await new Promise(resolve => {
      expect(chrome.contextMenus.create({ id: 'duplicate', title: 'Menu' }, () => {
        resolve(chrome.runtime.lastError?.message);
      })).toBe('duplicate');
    });
    expect(error).toBe('RION_CONTEXT_MENU_DUPLICATE_ID');
    expect(chrome.runtime.lastError).toBeUndefined();
    ipc.invoke.mockResolvedValueOnce({ rionExtensionApiError: 'RION_CONTEXT_MENU_NOT_FOUND' });
    await expect(chrome.contextMenus.remove('absent')).rejects.toThrow('RION_CONTEXT_MENU_NOT_FOUND');
    ipc.invoke.mockResolvedValueOnce([{ id: 17 }]);
    expect(await new Promise(resolve => chrome.tabs.query({}, resolve))).toEqual([{ id: 17 }]);
    expect(ipc.invoke).toHaveBeenLastCalledWith('crx-msg', 'a'.repeat(32), 'tabs.query', {});
    ipc.invoke.mockResolvedValueOnce({ rionExtensionApiError: 'user storage value' });
    await expect(chrome.storage.session.get()).resolves.toEqual({ rionExtensionApiError: 'user storage value' });
  });

  it('preserves a native lastError descriptor after a bridge failure', async () => {
    const { chrome, ipc } = fixture();
    const prior = { configurable: true, get: () => ({ message: 'native' }) };
    Object.defineProperty(chrome.runtime, 'lastError', prior);
    ipc.invoke.mockRejectedValueOnce(new Error('IPC disconnected'));
    const received = await new Promise(resolve => chrome.notifications.getAll(() => resolve(chrome.runtime.lastError?.message)));
    expect(received).toContain('IPC disconnected');
    expect(Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError')?.get).toBe(prior.get);
  });
});
