import { contextBridge, ipcRenderer, webFrame } from 'electron'

type Listener = (...args: unknown[]) => void
type IpcListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => void

const listeners = new Map<string, Map<string, IpcListener>>()
let nextListenerId = 0

function addExtensionListener(extensionId: string, eventName: string, callback: Listener) {
  let eventListeners = listeners.get(eventName)
  if (!eventListeners) {
    eventListeners = new Map()
    listeners.set(eventName, eventListeners)
    ipcRenderer.send('crx-add-listener', extensionId, eventName)
  }
  const listenerId = `${eventName}:${++nextListenerId}`
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
  eventListeners.set(listenerId, wrapped)
  ipcRenderer.on(`crx-${eventName}`, wrapped)
  return listenerId
}

function removeExtensionListener(extensionId: string, eventName: string, listenerId: string) {
  const eventListeners = listeners.get(eventName)
  const wrapped = eventListeners?.get(listenerId)
  if (!eventListeners || !wrapped) return
  ipcRenderer.removeListener(`crx-${eventName}`, wrapped)
  eventListeners.delete(listenerId)
  if (eventListeners.size === 0) {
    listeners.delete(eventName)
    ipcRenderer.send('crx-remove-listener', extensionId, eventName)
  }
}

function hasExtensionListener(eventName: string, listenerId?: string) {
  const eventListeners = listeners.get(eventName)
  return listenerId ? Boolean(eventListeners?.has(listenerId)) : Boolean(eventListeners?.size)
}

async function invokeExtension(
  extensionId: string,
  handlerName: string,
  ...inputArguments: unknown[]
) {
  const args = [...inputArguments]
  const callback = typeof args.at(-1) === 'function' ? args.pop() as Listener : undefined
  try {
    const result = await ipcRenderer.invoke('crx-msg', extensionId, handlerName, ...args)
    if (callback) callback(result)
    return result
  } catch (error) {
    if (callback) {
      callback(undefined)
      return undefined
    }
    throw error
  }
}

const electronContext = Object.freeze({
  addExtensionListener,
  hasExtensionListener,
  invokeExtension,
  removeExtensionListener,
})

function injectMainWorld() {
  const bridge = (globalThis as any).rionExtensionBridge
  const chrome = (globalThis as any).chrome || {}
  const extensionId = chrome.runtime?.id
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId)) return

  const manifest = chrome.runtime?.getManifest?.() || {}
  const invoke = (name: string) => (...args: unknown[]) =>
    bridge.invokeExtension(extensionId, name, ...args)
  const event = (name: string) => {
    const listenerIds = new Map<Listener, string>()
    return Object.freeze({
      addListener: (callback: Listener) => {
        if (listenerIds.has(callback)) return
        const listenerId = bridge.addExtensionListener(extensionId, name, callback)
        listenerIds.set(callback, listenerId)
      },
      hasListener: (callback: Listener) => listenerIds.has(callback),
      hasListeners: () => listenerIds.size > 0,
      removeListener: (callback: Listener) => {
        const listenerId = listenerIds.get(callback)
        if (!listenerId) return
        listenerIds.delete(callback)
        bridge.removeExtensionListener(extensionId, name, listenerId)
      },
    })
  }
  const unavailable = (api: string) => (...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) as Listener : undefined
    const error = new Error(`RION_EXTENSION_API_UNAVAILABLE:${api}`)
    if (callback) {
      queueMicrotask(() => callback(undefined))
      return undefined
    }
    return Promise.reject(error)
  }
  const resolved = (value?: unknown) => (...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) as Listener : undefined
    if (callback) queueMicrotask(() => callback(value))
    return callback ? undefined : Promise.resolve(value)
  }

  const permissions = {
    contains: invoke('permissions.contains'),
    getAll: invoke('permissions.getAll'),
    onAdded: event('permissions.onAdded'),
    onRemoved: event('permissions.onRemoved'),
    remove: invoke('permissions.remove'),
    request: invoke('permissions.request'),
  }
  const notifications = {
    clear: invoke('notifications.clear'),
    create: invoke('notifications.create'),
    getAll: invoke('notifications.getAll'),
    getPermissionLevel: invoke('notifications.getPermissionLevel'),
    onButtonClicked: event('notifications.onButtonClicked'),
    onClicked: event('notifications.onClicked'),
    onClosed: event('notifications.onClosed'),
    onPermissionLevelChanged: event('notifications.onPermissionLevelChanged'),
    update: invoke('notifications.update'),
  }
  const webNavigation = {
    getAllFrames: invoke('webNavigation.getAllFrames'),
    getFrame: invoke('webNavigation.getFrame'),
    onBeforeNavigate: event('webNavigation.onBeforeNavigate'),
    onCommitted: event('webNavigation.onCommitted'),
    onCompleted: event('webNavigation.onCompleted'),
    onCreatedNavigationTarget: event('webNavigation.onCreatedNavigationTarget'),
    onDOMContentLoaded: event('webNavigation.onDOMContentLoaded'),
    onErrorOccurred: event('webNavigation.onErrorOccurred'),
    onHistoryStateUpdated: event('webNavigation.onHistoryStateUpdated'),
    onReferenceFragmentUpdated: event('webNavigation.onReferenceFragmentUpdated'),
    onTabReplaced: event('webNavigation.onTabReplaced'),
  }
  const nativeTabs = chrome.tabs || {}
  const tabs = {
    ...nativeTabs,
    TAB_ID_NONE: -1,
    get: invoke('tabs.get'),
    getAllInWindow: invoke('tabs.getAllInWindow'),
    getCurrent: invoke('tabs.getCurrent'),
    goBack: invoke('tabs.goBack'),
    goForward: invoke('tabs.goForward'),
    onActivated: event('tabs.onActivated'),
    onCreated: event('tabs.onCreated'),
    onRemoved: event('tabs.onRemoved'),
    onReplaced: event('tabs.onReplaced'),
    onUpdated: event('tabs.onUpdated'),
    query: invoke('tabs.query'),
    reload: invoke('tabs.reload'),
    captureVisibleTab: unavailable('tabs.captureVisibleTab'),
    create: unavailable('tabs.create'),
    duplicate: unavailable('tabs.duplicate'),
    group: unavailable('tabs.group'),
    highlight: unavailable('tabs.highlight'),
    insertCSS: unavailable('tabs.insertCSS'),
    move: unavailable('tabs.move'),
    remove: unavailable('tabs.remove'),
    ungroup: unavailable('tabs.ungroup'),
    update: unavailable('tabs.update'),
  }
  const alarms = {
    clear: invoke('alarms.clear'),
    clearAll: invoke('alarms.clearAll'),
    create: invoke('alarms.create'),
    get: invoke('alarms.get'),
    getAll: invoke('alarms.getAll'),
    onAlarm: event('alarms.onAlarm'),
  }
  const offscreen = {
    Reason: Object.freeze({
      AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
      BLOBS: 'BLOBS',
      CLIPBOARD: 'CLIPBOARD',
      DOM_PARSER: 'DOM_PARSER',
      DOM_SCRAPING: 'DOM_SCRAPING',
      GEOLOCATION: 'GEOLOCATION',
      IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
      LOCAL_STORAGE: 'LOCAL_STORAGE',
      MATCH_MEDIA: 'MATCH_MEDIA',
      TESTING: 'TESTING',
      USER_MEDIA: 'USER_MEDIA',
      WEB_RTC: 'WEB_RTC',
      WORKERS: 'WORKERS',
    }),
    closeDocument: invoke('offscreen.closeDocument'),
    createDocument: invoke('offscreen.createDocument'),
    hasDocument: invoke('offscreen.hasDocument'),
  }
  const sessionStorage = {
    QUOTA_BYTES: 5 * 1024 * 1024,
    clear: invoke('storage.session.clear'),
    get: invoke('storage.session.get'),
    getBytesInUse: invoke('storage.session.getBytesInUse'),
    remove: invoke('storage.session.remove'),
    set: invoke('storage.session.set'),
    setAccessLevel: unavailable('storage.session.setAccessLevel'),
  }
  const actionEvent = event('action.onClicked')
  const action = {
    disable: resolved(), enable: resolved(), getBadgeBackgroundColor: resolved([0, 0, 0, 0]),
    getBadgeText: resolved(''), getPopup: resolved(''), getTitle: resolved(manifest.name || ''),
    isEnabled: resolved(true), onClicked: actionEvent, openPopup: unavailable('action.openPopup'),
    setBadgeBackgroundColor: resolved(), setBadgeText: resolved(), setIcon: resolved(),
    setPopup: resolved(), setTitle: resolved(),
  }

  Object.defineProperties(chrome, {
    action: { configurable: true, enumerable: true, value: action },
    alarms: { configurable: true, enumerable: true, value: alarms },
    browserAction: { configurable: true, enumerable: true, value: action },
    commands: { configurable: true, enumerable: true, value: {
      getAll: invoke('commands.getAll'), onCommand: event('commands.onCommand'),
    } },
    notifications: { configurable: true, enumerable: true, value: notifications },
    offscreen: { configurable: true, enumerable: true, value: offscreen },
    permissions: { configurable: true, enumerable: true, value: permissions },
    storage: { configurable: true, enumerable: true, value: {
      ...(chrome.storage || {}), session: sessionStorage,
    } },
    tabs: { configurable: true, enumerable: true, value: tabs },
    webNavigation: { configurable: true, enumerable: true, value: webNavigation },
  })

  if (chrome.runtime) {
    try {
      Object.defineProperties(chrome.runtime, {
        connectNative: { configurable: true, value: unavailable('runtime.connectNative') },
        sendNativeMessage: { configurable: true, value: unavailable('runtime.sendNativeMessage') },
      })
    } catch {
      // Some native runtime properties are intentionally non-configurable.
    }
  }

  const boot = async () => {
    const rulesets = Array.isArray(manifest.declarative_net_request?.rule_resources)
      ? manifest.declarative_net_request.rule_resources.filter(
        (rule: any) => rule?.enabled !== false && typeof rule?.id === 'string',
      )
      : []
    let staticRulesetStatus = rulesets.length === 0 ? 'not-declared' : 'unavailable'
    if (rulesets.length > 0 && chrome.declarativeNetRequest?.updateEnabledRulesets) {
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: rulesets.map((rule: any) => rule.id),
        })
        staticRulesetStatus = 'enabled'
      } catch {
        staticRulesetStatus = 'failed'
      }
    }
    await bridge.invokeExtension(extensionId, 'compatibility.ready', {
      availableApis: [
        'action', 'alarms', 'commands', 'notifications', 'offscreen', 'permissions',
        'storage.session', 'tabs', 'webNavigation',
      ],
      staticRulesetCount: rulesets.length,
      staticRulesetStatus,
      unavailableApis: [
        'action.openPopup', 'nativeMessaging', 'storage.session.setAccessLevel', 'tabs.mutate',
        ...(chrome.userScripts ? [] : ['userScripts']),
      ],
    })
  }
  if (typeof document === 'undefined') void boot()
  delete (globalThis as any).rionExtensionBridge
}

const isExtensionContext = process.type === 'service-worker' ||
  globalThis.location?.href.startsWith('chrome-extension://')

if (isExtensionContext) {
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld('rionExtensionBridge', electronContext)
    if ('executeInMainWorld' in contextBridge) {
      ;(contextBridge as any).executeInMainWorld({ func: injectMainWorld })
    } else {
      webFrame.executeJavaScript(`(${injectMainWorld})();`)
    }
  } else {
    Object.defineProperty(globalThis, 'rionExtensionBridge', { value: electronContext })
    injectMainWorld()
  }
}
