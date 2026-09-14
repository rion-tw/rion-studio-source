/** An expected API failure delivered to the extension, not an IPC transport fault. */
export class ExtensionApiError extends Error {}

export type ExtensionApiFailure = { rionExtensionApiError: string }
