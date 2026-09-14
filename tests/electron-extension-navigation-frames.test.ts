import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ webFrameMain: { fromId: vi.fn() } }));
import { WebNavigationAPI } from '../third_party/electron-chrome-extensions/src/browser/api/web-navigation';

describe.each(['darwin', 'win32'])('extension frame queries (%s)', () => {
  it('omits uncommitted and destroyed frames, then exposes the committed URL and exact identity', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const frame = { url: '', isDestroyed: () => false, frameTreeNodeId: 9, top: null as unknown, framesInSubtree: [] as unknown[] };
    frame.top = frame;
    const child = { url: 'about:blank', isDestroyed: () => false, frameTreeNodeId: 10, top: frame, parent: frame };
    frame.framesInSubtree = [frame, child, { isDestroyed: () => true, get url() { throw new Error('disposed'); } }];
    const store = Object.assign(new EventEmitter(), { getTabById: (id: number) => id === 17 ? { mainFrame: frame } : undefined });
    new WebNavigationAPI({ store, router: { apiHandler: () => (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } } as never);
    const call = (name: string, tabId = 17) => handlers.get(`webNavigation.${name}`)!({}, { tabId, frameId: 0 });
    expect(call('getFrame')).toBeNull();
    expect(call('getAllFrames')).toEqual([expect.objectContaining({ url: 'about:blank', frameId: 10, parentFrameId: 0 })]);
    frame.url = 'https://example.test/committed';
    expect(call('getFrame')).toMatchObject({ url: frame.url, frameId: 0 });
    expect(call('getAllFrames')).toHaveLength(2);
    expect(call('getAllFrames', 99)).toEqual([]);
  });
});
