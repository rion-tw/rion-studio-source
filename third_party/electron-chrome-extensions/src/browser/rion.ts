import { session as electronSession } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'

import { AlarmsAPI } from './api/alarms'
import { CommandsAPI } from './api/commands'
import { CompatibilityAPI, CompatibilityReadyRecord } from './api/compatibility'
import { NotificationsAPI } from './api/notifications'
import { OffscreenAPI } from './api/offscreen'
import { PermissionsAPI } from './api/permissions'
import { SessionStorageAPI } from './api/session-storage'
import { TabsAPI } from './api/tabs'
import { WebNavigationAPI } from './api/web-navigation'
import { ExtensionContext } from './context'
import { ChromeExtensionImpl } from './impl'
import { checkLicense, License } from './license'
import { ExtensionRouter } from './router'
import { ExtensionStore } from './store'

export interface RionChromeExtensionOptions extends ChromeExtensionImpl {
  license: License
  preloadPath: string
  session?: Electron.Session
  onCompatibilityReady?: (extensionId: string, record: CompatibilityReadyRecord) => void
}

const sessionMap = new WeakMap<Electron.Session, RionChromeExtensions>()

/**
 * Audited fork entry point. Only the bounded APIs instantiated below enter
 * Rion's compiled graph; the upstream native-messaging and socket transports
 * remain corresponding source, not executable product code.
 */
export class RionChromeExtensions extends EventEmitter {
  static fromSession(session: Electron.Session) {
    return sessionMap.get(session)
  }

  readonly #ctx: ExtensionContext
  readonly #tabs: TabsAPI

  constructor(opts: RionChromeExtensionOptions) {
    super()
    const {
      license,
      onCompatibilityReady = () => undefined,
      preloadPath,
      session = electronSession.defaultSession,
      ...impl
    } = opts
    checkLicense(license)
    if (sessionMap.has(session)) throw new Error('RION_EXTENSION_COMPAT_SESSION_EXISTS')
    if (!existsSync(preloadPath)) throw new Error('RION_EXTENSION_COMPAT_PRELOAD_NOT_FOUND')

    const router = new ExtensionRouter(session)
    const store = new ExtensionStore(impl)
    this.#ctx = { emit: this.emit.bind(this), router, session, store }
    this.#tabs = new TabsAPI(this.#ctx)
    new AlarmsAPI(this.#ctx)
    new CommandsAPI(this.#ctx)
    new CompatibilityAPI(this.#ctx, onCompatibilityReady)
    new NotificationsAPI(this.#ctx)
    new OffscreenAPI(this.#ctx)
    new PermissionsAPI(this.#ctx)
    new SessionStorageAPI(this.#ctx)
    new WebNavigationAPI(this.#ctx)

    const sessionExtensions = session.extensions || session
    sessionExtensions.setMaxListeners?.(100)
    session.registerPreloadScript({
      id: 'rion-crx-frame-v1',
      type: 'frame',
      filePath: preloadPath,
    })
    session.registerPreloadScript({
      id: 'rion-crx-service-worker-v1',
      type: 'service-worker',
      filePath: preloadPath,
    })
    sessionMap.set(session, this)
  }

  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    this.#checkSession(tab)
    this.#ctx.store.addTab(tab, window)
  }

  removeTab(tab: Electron.WebContents) {
    this.#checkSession(tab)
    this.#ctx.store.removeTab(tab)
  }

  selectTab(tab: Electron.WebContents) {
    this.#checkSession(tab)
    if (this.#ctx.store.tabs.has(tab)) this.#tabs.onActivated(tab.id)
  }

  #checkSession(tab: Electron.WebContents) {
    if (this.#ctx.session !== tab.session) {
      throw new TypeError('RION_EXTENSION_COMPAT_TAB_SESSION_MISMATCH')
    }
  }
}
