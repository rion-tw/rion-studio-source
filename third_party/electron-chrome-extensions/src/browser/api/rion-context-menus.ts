import { Menu, MenuItem } from 'electron'
import { ExtensionApiError } from '../api-error'
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'

type Props = chrome.contextMenus.CreateProperties & { id: string }
const CONTEXTS = new Set(['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio'])
const TYPES = new Set(['normal', 'separator', 'checkbox', 'radio'])
const FIELDS = new Set(['id', 'type', 'title', 'checked', 'contexts', 'visible', 'enabled', 'parentId', 'documentUrlPatterns', 'targetUrlPatterns'])

function matchesPattern(pattern: string, value: string): boolean {
  try {
    const url = new URL(value)
    if (pattern === '<all_urls>') return ['http:', 'https:', 'file:', 'ftp:'].includes(url.protocol)
    const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/u.exec(pattern)
    if (!match) return false
    const [, scheme, host, path] = match
    if (scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : `${scheme}:` !== url.protocol) return false
    if (host !== '*' && !(host.startsWith('*.')
      ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1))
      : url.host === host)) return false
    const expression = path.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${expression}$`, 'u').test(url.pathname + url.search)
  } catch { return false }
}

/** Session-local document context menus. No toolbar or cross-Role lookup. */
export class RionContextMenusAPI {
  private readonly menus = new Map<string, Map<string, Props>>()
  private readonly tabs = new Map<Electron.WebContents, { dispose: () => void; close: () => void }>()
  constructor(private readonly ctx: ExtensionContext) {
    const handle = ctx.router.apiHandler()
    handle('contextMenus.create', this.create, { permission: 'contextMenus' })
    handle('contextMenus.update', this.update, { permission: 'contextMenus' })
    handle('contextMenus.remove', this.remove, { permission: 'contextMenus' })
    handle('contextMenus.removeAll', ({ extension }) => { this.menus.delete(extension.id) }, { permission: 'contextMenus' })
    ctx.session.extensions.on('extension-unloaded', (_event, extension) => {
      this.menus.delete(extension.id)
      for (const tab of this.tabs.values()) tab.close()
    })
  }

  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    if (this.tabs.has(tab)) return
    let menu: Electron.Menu | undefined
    const close = () => { if (!window.isDestroyed()) menu?.closePopup(window) }
    const listener = (_event: Electron.Event, params: Electron.ContextMenuParams) => {
      close()
      const items = this.buildMenuItems(tab, params)
      if (!items.length || window.isDestroyed()) return
      menu = new Menu()
      for (const item of items) menu.append(item)
      menu.popup({ window, ...(params.frame ? { frame: params.frame } : {}) })
    }
    const dispose = () => {
      tab.removeListener('context-menu', listener)
      tab.removeListener('destroyed', dispose)
      tab.removeListener('did-start-navigation', close)
      close()
      this.tabs.delete(tab)
    }
    this.tabs.set(tab, { dispose, close })
    tab.on('context-menu', listener)
    tab.on('did-start-navigation', close)
    tab.once('destroyed', dispose)
  }

  removeTab(tab: Electron.WebContents) { this.tabs.get(tab)?.dispose() }

  private validate(value: unknown, items: Map<string, Props>): Props {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExtensionApiError('RION_CONTEXT_MENU_INVALID')
    const props = value as Props
    if (Object.keys(props).some(key => !FIELDS.has(key)) ||
      typeof props.id !== 'string' || !props.id.length || props.id.length > 256 ||
      (props.type !== undefined && !TYPES.has(props.type)) ||
      (props.type !== 'separator' && (typeof props.title !== 'string' || !props.title.length || props.title.length > 1024)) ||
      ['checked', 'visible', 'enabled'].some(key => key in props && typeof (props as unknown as Record<string, unknown>)[key] !== 'boolean') ||
      (props.checked !== undefined && props.type !== 'checkbox' && props.type !== 'radio') ||
      (props.contexts !== undefined && (!Array.isArray(props.contexts) || !props.contexts.length || props.contexts.some(c => !CONTEXTS.has(c))))) {
      throw new ExtensionApiError('RION_CONTEXT_MENU_INVALID')
    }
    for (const patterns of [props.documentUrlPatterns, props.targetUrlPatterns]) {
      if (patterns !== undefined && (!Array.isArray(patterns) || patterns.length > 128 ||
        patterns.some(p => typeof p !== 'string' || p.length > 2048 ||
          !/^(?:<all_urls>|(?:\*|https?|file|ftp):\/\/[^/]*\/.*)$/u.test(p)))) throw new ExtensionApiError('RION_CONTEXT_MENU_PATTERN_INVALID')
    }
    let parent = props.parentId
    const seen = new Set([props.id])
    while (parent !== undefined) {
      if (typeof parent !== 'string' || seen.has(parent) || !items.has(parent)) throw new ExtensionApiError('RION_CONTEXT_MENU_PARENT_INVALID')
      seen.add(parent)
      const ancestor = items.get(parent)!
      if (ancestor.type && ancestor.type !== 'normal') throw new ExtensionApiError('RION_CONTEXT_MENU_PARENT_INVALID')
      parent = ancestor.parentId
    }
    return structuredClone(props)
  }

  private create = ({ extension }: ExtensionEvent, value: unknown) => {
    const items = this.menus.get(extension.id) ?? new Map<string, Props>()
    const props = this.validate(value, items)
    if (items.has(props.id)) throw new ExtensionApiError('RION_CONTEXT_MENU_DUPLICATE_ID')
    if (items.size >= 1000) throw new ExtensionApiError('RION_CONTEXT_MENU_LIMIT')
    items.set(props.id, props)
    this.menus.set(extension.id, items)
  }

  private update = ({ extension }: ExtensionEvent, id: string, updates: Partial<Props>) => {
    const items = this.menus.get(extension.id)
    const old = items?.get(id)
    if (!old) throw new ExtensionApiError('RION_CONTEXT_MENU_NOT_FOUND')
    if (!updates || typeof updates !== 'object' || 'id' in updates) throw new ExtensionApiError('RION_CONTEXT_MENU_INVALID')
    items!.set(id, this.validate({ ...old, ...updates, id }, items!))
  }

  private remove = ({ extension }: ExtensionEvent, id: string) => {
    const items = this.menus.get(extension.id)
    if (!items?.has(id)) throw new ExtensionApiError('RION_CONTEXT_MENU_NOT_FOUND')
    const remove = (key: string) => {
      items.delete(key)
      for (const child of items.values()) if (child.parentId === key) remove(child.id)
    }
    remove(id)
  }

  buildMenuItems(tab: Electron.WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[] {
    if (tab.isDestroyed() || tab.session !== this.ctx.session || !this.ctx.store.tabs.has(tab)) return []
    const contexts = new Set(['all', 'page'])
    if (params.frame && params.frame !== tab.mainFrame) contexts.add('frame')
    if (params.linkURL) contexts.add('link')
    if (params.selectionText) contexts.add('selection')
    if (params.isEditable) contexts.add('editable')
    if (params.mediaType !== 'none') contexts.add(params.mediaType)
    const matches = (props: Props) => props.visible !== false &&
      (props.contexts ?? ['page']).some(c => contexts.has(c)) &&
      (!props.documentUrlPatterns?.length || props.documentUrlPatterns.some(p => matchesPattern(p, params.frameURL || params.pageURL))) &&
      (!props.targetUrlPatterns?.length || [params.linkURL, params.srcURL].some(url => url && props.targetUrlPatterns!.some(p => matchesPattern(p, url))))
    const result: Electron.MenuItem[] = []
    for (const [extensionId, items] of this.menus) {
      const extension = this.ctx.session.extensions.getExtension(extensionId)
      if (!extension) continue
      const build = (parentId?: string): Electron.MenuItem[] => [...items.values()]
        .filter(props => props.parentId === parentId && matches(props))
        .map(props => {
          const children = build(props.id)
          const submenu = children.length ? new Menu() : undefined
          children.forEach(child => submenu!.append(child))
          return new MenuItem({
            id: `${extensionId}:${props.id}`, label: (props.title ?? '').split('%s').join(params.selectionText ?? '').slice(0, 1024),
            type: submenu ? 'submenu' : props.type ?? 'normal', submenu,
            enabled: props.enabled !== false, checked: props.checked,
            click: () => this.clicked(extensionId, items, props, tab, params)
          })
        })
      const roots = build()
      if (roots.length > 1) {
        const submenu = new Menu()
        roots.forEach(item => submenu.append(item))
        result.push(new MenuItem({ label: extension.name, submenu }))
      } else result.push(...roots)
    }
    return result
  }

  private clicked(extensionId: string, items: Map<string, Props>, props: Props,
    tab: Electron.WebContents, params: Electron.ContextMenuParams) {
    if (this.menus.get(extensionId) !== items || items.get(props.id) !== props || props.enabled === false ||
      tab.isDestroyed() || tab.session !== this.ctx.session || !this.ctx.store.tabs.has(tab) ||
      !this.ctx.session.extensions.getExtension(extensionId)) return
    const frame = params.frame
    if (!frame || frame.isDestroyed() || frame.top !== tab.mainFrame ||
      tab.getURL() !== params.pageURL || frame.url !== (params.frameURL || params.pageURL)) return
    const tabDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    if (!tabDetails) return
    const wasChecked = Boolean(props.checked)
    if (props.type === 'checkbox') props.checked = !wasChecked
    if (props.type === 'radio') {
      const siblings = [...items.values()].filter(p => p.parentId === props.parentId)
      const index = siblings.indexOf(props)
      let first = index; let last = index
      while (first > 0 && siblings[first - 1].type === 'radio') first--
      while (last + 1 < siblings.length && siblings[last + 1].type === 'radio') last++
      for (const sibling of siblings.slice(first, last + 1)) sibling.checked = sibling === props
    }
    this.ctx.router.sendEvent(extensionId, 'contextMenus.onClicked', {
      menuItemId: props.id, parentMenuItemId: props.parentId,
      frameId: frame === tab.mainFrame ? 0 : frame.frameTreeNodeId,
      pageUrl: params.pageURL, frameUrl: params.frameURL || undefined,
      linkUrl: params.linkURL || undefined, srcUrl: params.srcURL || undefined,
      selectionText: params.selectionText || undefined, editable: params.isEditable,
      mediaType: ['image', 'video', 'audio'].includes(params.mediaType) ? params.mediaType : undefined,
      ...(['checkbox', 'radio'].includes(props.type ?? '') ? { wasChecked, checked: props.checked } : {})
    }, tabDetails)
  }
}
