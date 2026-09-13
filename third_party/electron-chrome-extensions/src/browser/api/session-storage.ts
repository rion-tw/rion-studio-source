import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const MAX_SESSION_STORAGE_BYTES = 5 * 1024 * 1024

type JsonRecord = Record<string, unknown>

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** In-memory, role-session-scoped implementation of chrome.storage.session. */
export class SessionStorageAPI {
  readonly #values = new Map<string, Map<string, unknown>>()

  constructor(private ctx: ExtensionContext) {
    const handle = ctx.router.apiHandler()
    handle('storage.session.get', this.get)
    handle('storage.session.getBytesInUse', this.getBytesInUse)
    handle('storage.session.set', this.set)
    handle('storage.session.remove', this.remove)
    handle('storage.session.clear', this.clear)
    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.#values.delete(extension.id)
    })
  }

  #extensionValues(extensionId: string): Map<string, unknown> {
    let values = this.#values.get(extensionId)
    if (!values) {
      values = new Map()
      this.#values.set(extensionId, values)
    }
    return values
  }

  private get = ({ extension }: ExtensionEvent, keys?: null | string | string[] | JsonRecord) => {
    const values = this.#extensionValues(extension.id)
    const result: JsonRecord = Object.create(null)
    if (keys == null) {
      for (const [key, value] of values) result[key] = value
      return result
    }
    const requested = typeof keys === 'string'
      ? [keys]
      : Array.isArray(keys) ? keys : Object.keys(keys)
    for (const key of requested) {
      if (values.has(key)) result[key] = values.get(key)
      else if (typeof keys === 'object' && !Array.isArray(keys)) result[key] = keys[key]
    }
    return result
  }

  private getBytesInUse = (event: ExtensionEvent, keys?: null | string | string[]) => {
    return encodedBytes(this.get(event, keys))
  }

  private set = ({ extension }: ExtensionEvent, items: JsonRecord) => {
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('RION_EXTENSION_STORAGE_VALUE_INVALID')
    }
    const values = this.#extensionValues(extension.id)
    const candidate = Object.fromEntries(values)
    Object.assign(candidate, items)
    if (encodedBytes(candidate) > MAX_SESSION_STORAGE_BYTES) {
      throw new Error('RION_EXTENSION_STORAGE_QUOTA_EXCEEDED')
    }
    const changes: Record<string, chrome.storage.StorageChange> = Object.create(null)
    for (const [key, newValue] of Object.entries(items)) {
      const oldValue = values.get(key)
      values.set(key, newValue)
      changes[key] = { oldValue, newValue }
    }
    this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'session')
  }

  private remove = ({ extension }: ExtensionEvent, keys: string | string[]) => {
    const values = this.#extensionValues(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = Object.create(null)
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!values.has(key)) continue
      changes[key] = { oldValue: values.get(key) }
      values.delete(key)
    }
    if (Object.keys(changes).length > 0) {
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'session')
    }
  }

  private clear = ({ extension }: ExtensionEvent) => {
    const values = this.#extensionValues(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = Object.create(null)
    for (const [key, oldValue] of values) changes[key] = { oldValue }
    values.clear()
    if (Object.keys(changes).length > 0) {
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'session')
    }
  }
}
