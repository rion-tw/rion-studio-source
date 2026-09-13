import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

export interface CompatibilityReadyRecord {
  availableApis: string[]
  staticRulesetCount: number
  staticRulesetStatus: 'enabled' | 'unavailable' | 'not-declared' | 'failed'
  unavailableApis: string[]
}

const API_NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/u

export class CompatibilityAPI {
  constructor(
    ctx: ExtensionContext,
    onReady: (extensionId: string, record: CompatibilityReadyRecord) => void,
  ) {
    ctx.router.apiHandler()('compatibility.ready', ({ extension }: ExtensionEvent, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('RION_EXTENSION_COMPAT_READY_INVALID')
      }
      const record = value as Partial<CompatibilityReadyRecord>
      if (
        !Array.isArray(record.availableApis) || record.availableApis.length > 32 ||
        !record.availableApis.every((name) => typeof name === 'string' && API_NAME.test(name)) ||
        !Array.isArray(record.unavailableApis) || record.unavailableApis.length > 32 ||
        !record.unavailableApis.every((name) => typeof name === 'string' && API_NAME.test(name)) ||
        !Number.isSafeInteger(record.staticRulesetCount) ||
        record.staticRulesetCount! < 0 || record.staticRulesetCount! > 256 ||
        !['enabled', 'unavailable', 'not-declared', 'failed'].includes(
          record.staticRulesetStatus || '',
        )
      ) {
        throw new Error('RION_EXTENSION_COMPAT_READY_INVALID')
      }
      onReady(extension.id, {
        availableApis: [...record.availableApis],
        staticRulesetCount: record.staticRulesetCount!,
        staticRulesetStatus: record.staticRulesetStatus!,
        unavailableApis: [...record.unavailableApis],
      })
      return true
    })
  }
}
