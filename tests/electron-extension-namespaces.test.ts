import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const code = transformSync(readFileSync('third_party/electron-chrome-extensions/src/rion-preload.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node24'
}).code;
function fixture(alias: 'distinct' | 'same' | 'absent' = 'distinct') {
  const ipc = { invoke: vi.fn().mockResolvedValue(undefined), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  const namespace = () => ({
    runtime: { id: 'a'.repeat(32), getManifest: () => ({ manifest_version: 3 }) },
    storage: { local: { native: true }, session: { get: vi.fn(), setAccessLevel: vi.fn() } },
    declarativeNetRequest: { native: true }, scripting: { native: true }
  });
  const chrome = namespace() as unknown as typeof globalThis.chrome;
  const browser = alias === 'same' ? chrome : alias === 'absent' ? undefined : namespace() as unknown as typeof chrome;
  const nativeChrome = { ...chrome };
  const nativeBrowser = browser && { ...browser };
  runInNewContext(code, {
    require: () => ({ ipcRenderer: ipc }), process: { type: 'service-worker', contextIsolated: false },
    chrome, browser, document: {}, console, queueMicrotask
  });
  return { chrome, browser, ipc, nativeChrome, nativeBrowser };
}

describe.each(['darwin', 'win32'])('extension namespace compatibility (%s)', () => {
  it.each(['distinct', 'same', 'absent'] as const)('installs APIs with %s browser namespace', alias => {
    const { chrome, browser, ipc, nativeChrome, nativeBrowser } = fixture(alias);
    const listener = vi.fn();
    const selected = browser ?? chrome;
    selected.permissions.onRemoved.addListener(listener);
    expect(chrome.permissions.onRemoved.hasListener(listener)).toBe(true);
    selected.permissions.onRemoved.removeListener(listener);
    expect(chrome.permissions.onRemoved.hasListener(listener)).toBe(false);
    expect(ipc.send).toHaveBeenCalledWith('crx-remove-listener', 'a'.repeat(32), 'permissions.onRemoved');
    for (const [api, original] of [[chrome, nativeChrome], [browser, nativeBrowser]]) {
      if (!api || !original) continue;
      expect(api.storage.session).toBe(original.storage.session);
      expect(api.storage.local).toBe(original.storage.local);
      expect(api.scripting).toBe(original.scripting);
      expect(api.declarativeNetRequest).toBe(original.declarativeNetRequest);
      expect(api.commands.onCommand.addListener).toBeTypeOf('function');
      expect(api.alarms.onAlarm.addListener).toBeTypeOf('function');
    }
  });

  it('scopes callback lastError to both native runtime aliases and restores their descriptors', async () => {
    const { chrome, browser } = fixture();
    const previous = { configurable: true, get: () => ({ message: 'prior browser error' }) };
    Object.defineProperty(browser!.runtime, 'lastError', previous);
    await new Promise<void>(resolve => browser!.tabs.create({}, () => {
      expect(browser!.runtime.lastError?.message).toBe('RION_EXTENSION_API_UNAVAILABLE:tabs.create');
      expect(chrome.runtime.lastError?.message).toBe(browser!.runtime.lastError?.message);
      resolve();
    }));
    expect(chrome.runtime.lastError).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(browser!.runtime, 'lastError')?.get).toBe(previous.get);
    await expect(browser!.tabs.create({})).rejects.toThrow('RION_EXTENSION_API_UNAVAILABLE:tabs.create');
  });
});
