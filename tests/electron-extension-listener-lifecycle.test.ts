import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: { on: vi.fn() }, ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn() }) };
});
import { ipcMain } from 'electron';
import { ExtensionRouter } from '../third_party/electron-chrome-extensions/src/browser/router';

const id = 'a'.repeat(32);
const scope = `chrome-extension://${id}/`;

describe.each(['darwin', 'win32'])('extension listener lifetime (%s)', () => {
  function fixture(type: 'frame' | 'service-worker') {
    let registered = true;
    const workers = new Map<number, object>();
    const session = {
      extensions: Object.assign(new EventEmitter(), { getExtension: () => registered ? { id } : null }),
      serviceWorkers: Object.assign(new EventEmitter(), {
        getWorkerFromVersionID: (version: number) => workers.get(version),
        startWorkerForScope: vi.fn()
      })
    };
    function makeHost() {
      return Object.assign(new EventEmitter(), {
        id: workers.size + 1, session, scope, getURL: () => `${scope}page.html`,
        isDestroyed: () => false, send: vi.fn(),
        ipc: Object.assign(new EventEmitter(), { handle: vi.fn() })
      });
    }
    const router = new ExtensionRouter(session as never);
    function start() {
      const host = makeHost();
      workers.set(host.id, host);
      session.serviceWorkers.emit('running-status-changed', { runningStatus: 'starting', versionId: host.id });
      const event = type === 'frame'
        ? { type, sender: host, senderFrame: { url: host.getURL() } }
        : { type, session, serviceWorker: host };
      const ipc = type === 'frame' ? ipcMain : host.ipc;
      return { host, event, emit: (action: string, extensionId = id) =>
        ipc.emit(`crx-${action}-listener`, event, extensionId, 'tabs.onUpdated') };
    }
    function unload() {
      registered = false;
      session.extensions.emit('extension-unloaded', {}, { id });
    }
    return { router, session, start, unload, reload: () => { registered = true; } };
  }

  it.each(['frame', 'service-worker'] as const)('drops late %s registration after unload without a main-process exception', type => {
    const f = fixture(type);
    const old = f.start();
    old.emit('add');
    old.emit('remove');
    f.unload();
    expect(() => old.emit('add')).not.toThrow();
    f.router.broadcastEvent('tabs.onUpdated', 1);
    expect(old.host.send).not.toHaveBeenCalled();
    expect(f.session.serviceWorkers.startWorkerForScope).not.toHaveBeenCalled();
  });

  it.each(['frame', 'service-worker'] as const)('rejects a foreign %s sender without throwing or mutating listeners', type => {
    const f = fixture(type);
    const sender = f.start();
    expect(() => sender.emit('add', 'b'.repeat(32))).not.toThrow();
    expect(() => sender.emit('remove', 'b'.repeat(32))).not.toThrow();
    f.router.broadcastEvent('tabs.onUpdated', 1);
    expect(sender.host.send).not.toHaveBeenCalled();
    expect(f.session.serviceWorkers.startWorkerForScope).not.toHaveBeenCalled();
  });

  it.each(['frame', 'service-worker'] as const)('does not let a retired %s replace or remove the new load subscription', async type => {
    const f = fixture(type);
    const old = f.start();
    old.emit('add');
    old.emit('remove');
    f.unload();
    f.reload();
    const current = f.start();
    f.session.serviceWorkers.startWorkerForScope.mockResolvedValue(current.host);
    current.emit('add');
    old.emit('add');
    old.emit('remove');
    f.router.broadcastEvent('tabs.onUpdated', 2);
    await Promise.resolve();
    expect(current.host.send).toHaveBeenCalledExactlyOnceWith('crx-tabs.onUpdated', 2);
    expect(old.host.send).not.toHaveBeenCalled();
    current.emit('remove');
    f.router.broadcastEvent('tabs.onUpdated', 3);
    await Promise.resolve();
    expect(current.host.send).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight worker delivery when its exact subscription is unloaded', async () => {
    const f = fixture('service-worker');
    const old = f.start();
    old.emit('add');
    let resolve!: (host: typeof old.host) => void;
    f.session.serviceWorkers.startWorkerForScope.mockReturnValue(new Promise(r => { resolve = r; }));
    f.router.broadcastEvent('tabs.onUpdated', 1);
    f.unload();
    f.reload();
    const current = f.start();
    current.emit('add');
    resolve(current.host);
    await Promise.resolve();
    expect(current.host.send).not.toHaveBeenCalled();
  });
});
