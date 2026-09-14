import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  Menu: class { items: unknown[] = []; append(item: unknown) { this.items.push(item); } popup = vi.fn(); closePopup = vi.fn(); },
  MenuItem: class { constructor(props: object) { Object.assign(this, props); } }
}));
import { RionContextMenusAPI } from '../third_party/electron-chrome-extensions/src/browser/api/rion-context-menus';
import { CompatibilityAPI } from '../third_party/electron-chrome-extensions/src/browser/api/compatibility';

type Item = { label: string; click: () => void; submenu?: { items: Item[] } };
function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const options = new Map<string, unknown>();
  const sendEvent = vi.fn();
  const extensions = Object.assign(new EventEmitter(), { getExtension: (id: string) => ({ id, name: id }) });
  const session = { extensions };
  const mainFrame = { url: "https://example.com/", top: null as unknown, isDestroyed: () => false, frameTreeNodeId: 30 };
  mainFrame.top = mainFrame;
  const tab = Object.assign(new EventEmitter(), { id: 10, session, mainFrame, getURL: () => "https://example.com/", isDestroyed: () => false });
  const tabs = new Set([tab]);
  const ctx = { session, store: { tabs, tabDetailsCache: new Map([[10, { id: 10 }]]) }, router: {
    sendEvent, apiHandler: () => (name: string, callback: (...args: unknown[]) => unknown, opts?: unknown) => {
      handlers.set(name, callback); options.set(name, opts);
    }
  } };
  const api = new RionContextMenusAPI(ctx as never);
  const call = (name: string, extension: string, ...args: unknown[]) => handlers.get(`contextMenus.${name}`)!({ extension: { id: extension } }, ...args);
  const params = { frame: mainFrame, pageURL: 'https://example.com/', frameURL: '', linkURL: '', srcURL: '', selectionText: '', mediaType: 'none', isEditable: false };
  const build = () => api.buildMenuItems(tab as never, params as never) as unknown as Item[];
  return { api, ctx, handlers, options, extensions, tab, params, tabs, call, build, sendEvent };
}

describe.each(['darwin', 'win32'])('generic extension context menus (%s)', () => {
  it('isolates IDs by extension and enforces declared permission on all mutations', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'same', title: 'A' });
    f.call('create', 'b', { id: 'same', title: 'B' });
    expect(f.build().map(x => x.label)).toEqual(['A', 'B']);
    expect(() => f.call('create', 'a', { id: 'same', title: 'duplicate' })).toThrow('DUPLICATE_ID');
    for (const value of f.options.values()) expect(value).toEqual({ permission: 'contextMenus' });
    f.call('removeAll', 'a');
    expect(f.build().map(x => x.label)).toEqual(['B']);
    f.extensions.emit('extension-unloaded', {}, { id: 'b' });
    expect(f.build()).toEqual([]);
  });

  it('updates hierarchical menus, removes descendants, and rejects cycles and invalid data', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'parent', title: 'Parent' });
    f.call('create', 'a', { id: 'child', parentId: 'parent', title: 'Child' });
    f.call('update', 'a', 'child', { title: 'Updated' });
    expect(f.build()[0].submenu?.items[0].label).toBe('Updated');
    expect(() => f.call('update', 'a', 'parent', { parentId: 'child' })).toThrow('PARENT_INVALID');
    expect(() => f.call('create', 'a', { id: 'bad', title: 'x', contexts: ['bogus'] })).toThrow('INVALID');
    expect(() => f.call('create', 'a', { id: 'bad', title: 'x', documentUrlPatterns: [1] })).toThrow('PATTERN_INVALID');
    f.call('remove', 'a', 'parent'); expect(f.build()).toEqual([]);
    expect(() => f.call('update', 'a', 'child', { title: 'Missing' })).toThrow('NOT_FOUND');
  });

  it('filters by selection, document and target URL, visibility and enabled state', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'selection', title: 'Find %s', contexts: ['selection'], documentUrlPatterns: ['https://example.com/*'] });
    expect(f.build()).toEqual([]);
    f.params.selectionText = 'word'; expect(f.build()[0].label).toBe('Find word');
    f.call('update', 'a', 'selection', { targetUrlPatterns: ['https://target.test/*'] });
    expect(f.build()).toEqual([]);
    f.params.linkURL = 'https://target.test/path'; expect(f.build()).toHaveLength(1);
    f.call('update', 'a', 'selection', { visible: false }); expect(f.build()).toEqual([]);
    f.call('update', 'a', 'selection', { visible: true, enabled: false });
    f.build()[0].click(); expect(f.sendEvent).not.toHaveBeenCalled();
  });

  it('dispatches exact tab/frame and checkbox/radio state, rejecting stale and foreign clicks', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'check', title: 'Check', type: 'checkbox', checked: false });
    const item = f.build()[0]; item.click();
    expect(f.sendEvent).toHaveBeenLastCalledWith('a', 'contextMenus.onClicked', expect.objectContaining({ menuItemId: 'check', frameId: 0, checked: true, wasChecked: false }), { id: 10 });
    f.call('update', 'a', 'check', { title: 'New' }); item.click(); expect(f.sendEvent).toHaveBeenCalledTimes(1);
    const fresh = f.build()[0]; f.tabs.clear(); fresh.click(); expect(f.sendEvent).toHaveBeenCalledTimes(1);
    expect(f.build()).toEqual([]);
  });

  it('keeps radio groups exclusive and uses the authoritative subframe identity', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'one', title: 'One', type: 'radio', checked: true });
    f.call('create', 'a', { id: 'two', title: 'Two', type: 'radio', checked: false });
    f.params.frame = { url: "https://example.com/frame", top: f.tab.mainFrame, isDestroyed: () => false, frameTreeNodeId: 41 };
    f.params.frameURL = 'https://example.com/frame';
    f.build()[0].submenu!.items[1].click();
    expect(f.sendEvent).toHaveBeenLastCalledWith('a', 'contextMenus.onClicked', expect.objectContaining({
      menuItemId: 'two', frameId: 41, checked: true, wasChecked: false
    }), { id: 10 });
    f.build()[0].submenu!.items[0].click();
    expect(f.sendEvent).toHaveBeenLastCalledWith('a', 'contextMenus.onClicked', expect.objectContaining({
      menuItemId: 'one', checked: true, wasChecked: false
    }), { id: 10 });
  });

  it('matches wildcard subdomains including the base host without accepting unrelated schemes', () => {
    const f = fixture();
    f.call('create', 'a', { id: 'pattern', title: 'Pattern', documentUrlPatterns: ['*://*.example.com/*'] });
    expect(f.build()).toHaveLength(1);
    f.params.pageURL = 'https://sub.example.com/path'; expect(f.build()).toHaveLength(1);
    f.params.pageURL = 'https://example.com.evil.test/path'; expect(f.build()).toEqual([]);
    f.params.pageURL = 'ftp://example.com/path'; expect(f.build()).toEqual([]);
  });

  it('owns one native context-menu listener per attached Role and removes it on retirement', () => {
    const f = fixture();
    const window = { isDestroyed: () => false };
    f.api.addTab(f.tab as never, window as never); f.api.addTab(f.tab as never, window as never);
    expect(f.tab.listenerCount('context-menu')).toBe(1);
    f.api.removeTab(f.tab as never); expect(f.tab.listenerCount('context-menu')).toBe(0);
  });
});

it('obtains compatibility worker identity from the native sender and rejects frame receipts', () => {
  const f = fixture(); const onReady = vi.fn();
  new CompatibilityAPI(f.ctx as never, onReady);
  const ready = f.handlers.get('compatibility.ready')!;
  const receipt = { availableApis: [], unavailableApis: [], staticRulesetCount: 0, staticRulesetStatus: 'not-declared', versionId: 999 };
  ready({ type: 'service-worker', extension: { id: 'a' }, sender: { versionId: 42 } }, receipt);
  expect(onReady).toHaveBeenLastCalledWith('a', expect.not.objectContaining({ versionId: 999 }), 42);
  expect(() => ready({ type: 'frame', extension: { id: 'a' }, sender: { versionId: 42 } }, receipt)).toThrow('SENDER_INVALID');
});
