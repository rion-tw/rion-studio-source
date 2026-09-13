import type { SystemRuntimeFailureRecord } from '../../shared/generated'

const CAPACITY = 128
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,95}$/u
const SAFE_ID = /^[a-p]{32}$/u
const SAFE_API = /^[A-Za-z][A-Za-z0-9.]{0,95}$/u
const SAFE_ROLE_ID = /^[A-Za-z0-9_-]{1,128}$/u
const SAFE_RELATIVE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./@+ -]{1,256}$/u

export type ChromiumExtensionRuntimeStage =
  | 'classification'
  | 'load'
  | 'bootstrap'
  | 'rulesets'
  | 'unload'

export type ChromiumExtensionRuntimeStatus =
  | 'blocked'
  | 'degraded'
  | 'failed'
  | 'indeterminate'
  | 'loaded'

export interface ChromiumExtensionRuntimeDiagnostic {
  readonly api?: string
  readonly capturedAt: string
  readonly code: string
  readonly column?: number
  readonly extensionId: string
  readonly line?: number
  readonly relativeFile?: string
  readonly roleId: string
  readonly stage: ChromiumExtensionRuntimeStage
  readonly status: ChromiumExtensionRuntimeStatus
}

const journal: ChromiumExtensionRuntimeDiagnostic[] = []

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000
    ? Number(value)
    : undefined
}

export function recordChromiumExtensionRuntimeDiagnostic(
  input: ChromiumExtensionRuntimeDiagnostic,
): ChromiumExtensionRuntimeDiagnostic {
  if (!SAFE_ID.test(input.extensionId) || !SAFE_CODE.test(input.code)) {
    throw new TypeError('ELECTRON_EXTENSION_DIAGNOSTIC_IDENTITY_INVALID')
  }
  const capturedAt = new Date(input.capturedAt)
  const record = Object.freeze({
    capturedAt: Number.isNaN(capturedAt.valueOf())
      ? new Date().toISOString()
      : capturedAt.toISOString(),
    code: input.code,
    extensionId: input.extensionId,
    roleId: SAFE_ROLE_ID.test(input.roleId) ? input.roleId : 'unknown',
    stage: input.stage,
    status: input.status,
    ...(input.api && SAFE_API.test(input.api) ? { api: input.api } : {}),
    ...(input.relativeFile && SAFE_RELATIVE_FILE.test(input.relativeFile)
      ? { relativeFile: input.relativeFile }
      : {}),
    ...(safePositiveInteger(input.line) ? { line: safePositiveInteger(input.line) } : {}),
    ...(safePositiveInteger(input.column) ? { column: safePositiveInteger(input.column) } : {}),
  })
  journal.push(record)
  if (journal.length > CAPACITY) journal.splice(0, journal.length - CAPACITY)
  return record
}

export function recentChromiumExtensionRuntimeDiagnostics(): readonly ChromiumExtensionRuntimeDiagnostic[] {
  return Object.freeze(journal.map((record) => Object.freeze({ ...record })))
}

export function recentChromiumExtensionRuntimeFailures(): SystemRuntimeFailureRecord[] {
  return journal
    .filter((record) => record.status !== 'loaded')
    .map((record) => ({
      action: record.extensionId,
      capturedAt: record.capturedAt,
      code: record.code,
      roleId: record.roleId,
      stage: `extension-${record.stage}`,
      subsystem: 'effect',
    }))
}

export function clearChromiumExtensionRuntimeDiagnosticsForTests(): void {
  journal.splice(0)
}
